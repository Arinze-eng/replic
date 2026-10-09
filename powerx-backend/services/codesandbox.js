// ─────────────────────────────────────────────────────────────────────────────
// codesandbox.js — CodeSandbox SDK client (Together Code Sandbox micro-VM).
//
// Gives the WormGPT Agent a REAL, isolated Linux computer per task — exactly the
// way HopX / Runloop / Daytona / Novita do, but on CodeSandbox's Firecracker
// microVM infrastructure. A CodeSandbox VM is a FULL Linux userland that runs as
// **root** (uid 0) with passwordless everything, apt/pip/npm/go pre-wired, and
// enough CPU/RAM (up to 64 vCPU / 128 GB) to compile heavy toolchains. The agent
// runs every shell command / script INSIDE this sandbox (not on the Render
// host), reads & writes files there, and we download produced files to deliver
// back over Telegram / WhatsApp / the web UI.
//
// Why this backend matters: CodeSandbox provisions in milliseconds, runs as real
// root (no sudo dance needed for apt / dpkg / system writes), and has full
// network + build tooling — ideal for the heavy reverse-engineering work this
// agent does (blutter, apktool, hbctool, ghidra headless, etc.). It's the most
// capable "owns-the-computer" backend and a reliable fallback when the others
// are down/unconfigured.
//
// Auth: CODESANDBOX_API_KEY (a `csb_...` key). Admin can also set it at runtime
// via the DB setting `codesandbox_api_key` (falls back to the env var), so it
// flips on WITHOUT a code change or restart.
//
// Transport: CodeSandbox ships an official Node SDK (`@codesandbox/sdk`). It is
// ESM-only, so we load it once via a cached dynamic import() from this CommonJS
// module (identical pattern to novitaSandbox.js). Verified live end-to-end:
//   • sdk.sandboxes.create()               → { id }
//   • sandbox.connect()                    → client
//   • client.commands.run(cmd)             → COMBINED stdout+stderr STRING (runs as root)
//   • client.commands.runBackground(cmd)   → detached long-running process
//   • client.fs.writeFile/readFile/readdir → binary-safe file R/W (byte-identical)
//   • sdk.sandboxes.hibernate(id)          → pause (disk preserved)
//   • sdk.sandboxes.resume(id)             → wake a hibernated box (files intact)
//
// IMPORTANT SHAPE NOTE: unlike the E2B/Daytona toolboxes, `commands.run()` does
// NOT return an {exitCode,stdout,stderr} object — it returns the merged output
// STRING. To honour the engine's {exitCode, output} contract we append a
// `; echo __CSB_EXIT__$?` sentinel to every command, parse the trailing code,
// and strip it from the output. Everything else mirrors the other backends so
// sandboxAgent.js + agentEngine.js can swap between them with no other changes:
//   enabled, enabledAsync, WORKDIR,
//   createSandbox, deleteSandbox,
//   getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
//   getOrCreateSessionSandbox, endSession, getSessionSandboxId,
//   exec, uploadFile, downloadFile, listFiles,
//   getApiKey, invalidateKeyCache, testKey,
//   dockerSetup, dockerRun
// ─────────────────────────────────────────────────────────────────────────────

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

// CodeSandbox runs the VM as root; home is /root. WORK = /root/work lines up with
// the sandboxAgent path math (home + "/work") like the other backends.
const WORKDIR = process.env.CODESANDBOX_WORKDIR || '/root/work';
// Optional template/VM tier the sandbox is created from. Empty = SDK default
// (a full Ubuntu userland with node/python/git/apt). Overridable for ops.
const TEMPLATE = (process.env.CODESANDBOX_TEMPLATE || '').trim();
// VM tier hints (vCPU) — CodeSandbox picks a sensible default when unset. Heavy
// RE work (compiling Dart for blutter) benefits from more cores.
const VM_VCPU = parseInt(process.env.CODESANDBOX_VCPU || '0', 10); // 0 = default

// ── Lazy ESM SDK loader (cached) ─────────────────────────────────────────────
// `@codesandbox/sdk` is ESM-only; this file is CommonJS. We import() it once and
// cache the promise so every call reuses the same module instance.
let _sdkPromise = null;
async function _sdkClass() {
  if (!_sdkPromise) _sdkPromise = import('@codesandbox/sdk');
  const mod = await _sdkPromise;
  const CodeSandbox = mod.CodeSandbox || (mod.default && mod.default.CodeSandbox);
  if (!CodeSandbox) throw new Error('@codesandbox/sdk missing CodeSandbox export');
  return CodeSandbox;
}

// One SDK instance per API key (cached). The SDK is cheap but we avoid rebuilding
// it on every call.
let _sdkInstance = { key: null, sdk: null };
async function _sdk() {
  const key = await getApiKey();
  if (!key) throw new Error('CODESANDBOX_API_KEY not set');
  if (_sdkInstance.sdk && _sdkInstance.key === key) return _sdkInstance.sdk;
  const CodeSandbox = await _sdkClass();
  const sdk = new CodeSandbox(key);
  _sdkInstance = { key, sdk };
  return sdk;
}

// ── Runtime API key resolution ────────────────────────────────────────────
// Admin can change the CodeSandbox key at runtime. Preference:
//   1. DB setting `codesandbox_api_key`,
//   2. env CODESANDBOX_API_KEY.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() {
  return (process.env.CODESANDBOX_API_KEY || process.env.CSB_API_KEY || '').trim();
}

function getApiKeySync() {
  if (_keyCache.value !== undefined && Date.now() - _keyCache.ts < KEY_TTL) {
    return _keyCache.value || envKey();
  }
  return envKey();
}

async function getApiKey() {
  const now = Date.now();
  if (_keyCache.value !== undefined && now - _keyCache.ts < KEY_TTL) {
    return _keyCache.value || envKey();
  }
  let runtime = '';
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting('codesandbox_api_key');
      if (v && String(v).trim()) runtime = String(v).trim();
    }
  } catch (_) {}
  _keyCache = { value: runtime, ts: now };
  return runtime || envKey();
}

function invalidateKeyCache() {
  _keyCache = { value: undefined, ts: 0 };
  _sdkInstance = { key: null, sdk: null }; // force SDK rebuild with the new key
}

// Enabled if EITHER a runtime key (cached) or an env key exists. We refresh the
// cache opportunistically so an admin-set key flips this on without a restart.
function enabled() {
  if (db && db.getSetting && Date.now() - _keyCache.ts >= KEY_TTL) {
    getApiKey().catch(() => {});
  }
  return !!getApiKeySync() || !!(_keyCache.value);
}

async function enabledAsync() { return !!(await getApiKey()); }

// ── Live client handle cache ──────────────────────────────────────────────────
// connect() returns a live client per box (holds the WebSocket to the VM). We
// cache it per sandbox id so repeated exec/file calls in one task reuse the same
// connection. Evicted on kill / on connect refresh.
const _clients = new Map(); // id -> connected client

function _cache(id, client) { if (id && client) _clients.set(String(id), client); return client; }
function _forget(id) { _clients.delete(String(id)); }

// Get a live, connected client for an EXISTING sandbox id. Reuses the cache;
// otherwise resumes (wakes a hibernated box) + connects. Throws if unreachable.
async function _client(id) {
  const cached = _clients.get(String(id));
  if (cached) return cached;
  const sdk = await _sdk();
  // resume() returns a sandbox handle whether it was running or hibernated.
  const sandbox = await sdk.sandboxes.resume(String(id));
  const client = await sandbox.connect();
  return _cache(id, client);
}

// ── Explicit connectivity test for the admin "Test" button (never throws) ─────
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No CodeSandbox API key configured.' };
  const started = Date.now();
  try {
    const CodeSandbox = await _sdkClass();
    const sdk = new CodeSandbox(key);
    // FAST, ZERO-COST validation FIRST: listRunning() authenticates the key
    // WITHOUT consuming a VM slot. This makes the admin "Test" button work even
    // when the account is at its concurrency cap (previously it created a VM,
    // which failed under load and reported a scary "rate limit" error for a
    // perfectly VALID key). A bad key throws here with a 401/403.
    if (sdk.sandboxes.listRunning) {
      const r = await sdk.sandboxes.listRunning();
      const ms = Date.now() - started;
      const used = (r && (r.concurrentVmCount != null ? r.concurrentVmCount : (r.vms || []).length)) || 0;
      const limit = (r && r.concurrentVmLimit) || 0;
      const cap = limit ? ` (${used}/${limit} VMs running)` : '';
      return {
        ok: true, status: 200, ms,
        message: `✅ Working — CodeSandbox API key is valid${cap}. VMs run as REAL root, provision in ~1s.`,
      };
    }
    // Fallback for older SDKs without listRunning: create + hibernate a probe VM.
    const sb = await sdk.sandboxes.create();
    const ms = Date.now() - started;
    try { await sdk.sandboxes.hibernate(sb.id); } catch (_) {}
    return {
      ok: true, status: 200, ms,
      message: `✅ Working — CodeSandbox provisioned VM "${sb.id}" in ${ms}ms (runs as root).`,
    };
  } catch (e) {
    const msg = String(e && e.message || e);
    let out = `❌ CodeSandbox error: ${msg.slice(0, 180)}`;
    if (/401|403|unauthorized|invalid|forbidden|api key/i.test(msg)) {
      out = '❌ Invalid or unauthorized CodeSandbox API key.';
    } else if (_isConcurrencyLimit(e)) {
      // The key IS valid — the account is just at its running-VM cap right now.
      out = '⚠️ Key valid, but all concurrent VM slots are in use right now. Idle sandboxes auto-hibernate to free slots; try again shortly.';
      return { ok: true, status: 200, message: out };
    }
    return { ok: false, status: 0, message: out };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Detect the CodeSandbox concurrency-limit error. The account has a hard cap on
// simultaneously RUNNING VMs (e.g. 10 on the default tier). When every slot is
// occupied by stale/idle sessions, create()/resume() throw a message like
// "0 of 10 concurrently running vms remaining" — which is EXACTLY the symptom
// behind the app's "CodeSandbox timed out → switching to Novita" fallback. We
// recover by hibernating the least-recently-active running VMs (hibernate keeps
// their disk, so no user data is lost) to free slots, then retrying.
function _isConcurrencyLimit(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return /concurrently running vms|concurrent vm|raise your rate limit|running vms remaining/.test(m);
}

// Free up N running-VM slots by hibernating the oldest ones. Returns how many
// we asked to hibernate. Best-effort; never throws.
async function _reapRunningVms(sdk, want = 3) {
  try {
    if (!sdk.sandboxes.listRunning) return 0;
    const r = await sdk.sandboxes.listRunning();
    const vms = (r && r.vms) || [];
    if (!vms.length) return 0;
    // Oldest-active first (lastActiveAt ascending). Fall back to list order.
    vms.sort((a, b) => {
      const ta = Date.parse(a.lastActiveAt || a.sessionStartedAt || 0) || 0;
      const tb = Date.parse(b.lastActiveAt || b.sessionStartedAt || 0) || 0;
      return ta - tb;
    });
    const victims = vms.slice(0, Math.max(1, want));
    let reaped = 0;
    for (const vm of victims) {
      try {
        // Hibernate (not shutdown) so the box's disk/files survive — a resumed
        // session still has everything. This just frees the RUNNING slot.
        if (sdk.sandboxes.hibernate) { await sdk.sandboxes.hibernate(vm.id); reaped++; _forget(vm.id); }
      } catch (_) { /* skip */ }
    }
    return reaped;
  } catch (_) { return 0; }
}

// Create a sandbox and return its id. create() waits until the VM is ready, so
// no extra polling is needed. We ensure the working directory exists before
// handing the id back (best-effort). If the account's concurrency limit is hit,
// we hibernate the oldest running VMs to free slots and retry (fixes the
// "CodeSandbox timed out → fell back to Novita" symptom under load).
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  const sdk = await _sdk();
  const opts = {};
  if (TEMPLATE) opts.id = TEMPLATE; // create from a named template/snapshot
  if (Number.isFinite(VM_VCPU) && VM_VCPU > 0) opts.vmTier = VM_VCPU;
  const createOnce = () => sdk.sandboxes.create(Object.keys(opts).length ? opts : undefined);

  let sandbox;
  try {
    sandbox = await createOnce();
  } catch (e) {
    if (!_isConcurrencyLimit(e)) throw e;
    // Concurrency cap hit → hibernate the oldest boxes to free slots, then retry
    // a couple of times (hibernate takes a moment to release the slot).
    for (let attempt = 0; attempt < 3 && !sandbox; attempt++) {
      const reaped = await _reapRunningVms(sdk, 3);
      if (reaped === 0 && attempt === 0) break; // nothing to reap → give up fast
      await new Promise(r => setTimeout(r, 2500));
      try { sandbox = await createOnce(); } catch (e2) { if (!_isConcurrencyLimit(e2)) throw e2; }
    }
    if (!sandbox) throw e; // still capped → surface the original error to cascade
  }

  const id = sandbox.id;
  if (!id) throw new Error('CodeSandbox create returned no sandbox id');
  const client = await sandbox.connect();
  _cache(id, client);
  // Ensure the working dir exists + export env vars for the session (best-effort).
  try { await client.commands.run(`mkdir -p ${shquote(WORKDIR)}`); } catch (_) {}
  if (envVars && Object.keys(envVars).length) {
    const exports = Object.entries(envVars)
      .map(([k, v]) => `export ${k}=${shquote(String(v))}`).join('\n');
    // Write an env file; exec() sources it on every command so the vars are
    // always present (more reliable than editing .bashrc, which a non-login
    // shell may not read).
    try { await client.fs.writeTextFile('/root/.wormgpt_env', exports + '\n'); } catch (_) {}
  }
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try {
    const sdk = await _sdk();
    if (sdk.sandboxes.shutdown) { await sdk.sandboxes.shutdown(String(id)); }
    else if (sdk.sandboxes.hibernate) { await sdk.sandboxes.hibernate(String(id)); }
  } catch (_) { /* best-effort cleanup */ }
  _forget(id);
}

// Return a coarse lifecycle state ("running" | "hibernated" | null). CodeSandbox
// doesn't always expose a cheap state read, so we probe: a successful connect +
// echo means running; if resume+connect works it's resumable → treat as usable.
async function getSandboxState(id) {
  if (!id) return null;
  const key = await getApiKey();
  if (!key) return null;
  try {
    const sdk = await _sdk();
    // Prefer a lightweight metadata read if the SDK exposes one.
    if (typeof sdk.sandboxes.get === 'function') {
      const info = await sdk.sandboxes.get(String(id)).catch(() => null);
      if (info && info.status) return info.status;
    }
    // Fallback: try to connect (this also resumes) and ping.
    const client = await _client(id);
    const r = await client.commands.run('echo READY').catch(() => '');
    return /READY/.test(r || '') ? 'running' : null;
  } catch (_) { return null; }
}

// Resume a hibernated sandbox and confirm the exec channel works. CodeSandbox
// hibernate KEEPS the disk, so a resumed sandbox still has all the user's files.
async function startSandbox(id) {
  if (!id) return false;
  try {
    _forget(id); // force a fresh connect/resume
    const client = await _client(id);
    const r = await client.commands.run('echo READY').catch(() => '');
    return /READY/.test(r || '');
  } catch (_) {
    _forget(id);
    return false;
  }
}

// Hibernate a running sandbox (cost-saving; disk preserved). Best-effort.
async function pauseSandbox(id) {
  if (!id) return false;
  try {
    const sdk = await _sdk();
    if (sdk.sandboxes.hibernate) { await sdk.sandboxes.hibernate(String(id)); _forget(id); return true; }
    return false;
  } catch (_) { return false; }
}
// Alias used by some callers (parity with runloop.suspendSandbox / novita).
const suspendSandbox = pauseSandbox;

// ── Persistent session → sandbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME sandbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `csb_sb_session:<sessionKey>`.
const SESSION_PREFIX = 'csb_sb_session:';
function _sessionSettingKey(sessionKey) { return SESSION_PREFIX + String(sessionKey); }

async function _readSessionId(sessionKey) {
  if (!db || !db.getSetting) return null;
  try { const v = await db.getSetting(_sessionSettingKey(sessionKey)); return (v && v.trim()) || null; }
  catch (_) { return null; }
}
async function _writeSessionId(sessionKey, id) {
  if (!db || !db.setSetting) return;
  try { await db.setSetting(_sessionSettingKey(sessionKey), id || ''); } catch (_) {}
}

// Read the EXISTING session sandbox id without ever creating one (used by /stop).
async function getSessionSandboxId(sessionKey) {
  return _readSessionId(sessionKey);
}

// Get a LIVE sandbox for this session, reusing the persisted one when possible.
//   • If a mapped sandbox exists and connects → reuse it (files intact).
//   • If it is hibernated → resume it (disk preserved) and reuse it.
//   • Otherwise (gone/error/none) → create a fresh one + remember it.
// Returns { id, reused }.
async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ envVars, labels });
    return { id, reused: false };
  }
  const existing = await _readSessionId(sessionKey);
  if (existing) {
    const ok = await startSandbox(existing);
    if (ok) return { id: existing, reused: true };
    // Dead/unknown/unreachable → forget it and fall through to create.
    _forget(existing);
    await _writeSessionId(sessionKey, '');
  }
  const id = await createSandbox({ envVars, labels: { session: String(sessionKey), ...labels } });
  await _writeSessionId(sessionKey, id);
  return { id, reused: false };
}

// Explicitly end a session: destroy its sandbox and clear the mapping.
async function endSession(sessionKey) {
  if (!sessionKey) return;
  const existing = await _readSessionId(sessionKey);
  if (existing) { await deleteSandbox(existing); }
  await _writeSessionId(sessionKey, '');
}

// ── Process execution ─────────────────────────────────────────────────────────

// Run a shell command inside the sandbox. Returns { exitCode, output } — output
// is stdout+stderr merged, matching the daytona/runloop/hopx/novita contract.
// commands.run() returns the merged output STRING (no exit code), so we append a
// sentinel `; echo __CSB_EXIT__$?`, parse the trailing code, strip it from the
// output, and normalise CRLF → LF. We embed `cd <dir> &&` into the command (like
// the other backends) because there is no reliable cwd option.
const _EXIT_RE = /__CSB_EXIT__(\d+)\s*$/;

async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const prelude = '[ -f /root/.wormgpt_env ] && . /root/.wormgpt_env 2>/dev/null;';
  const inner = cwd ? `${prelude} cd ${shquote(cwd)} 2>/dev/null; ${command}` : `${prelude} ${command}`;
  const wrapped = `{ ${inner}; }; printf '\\n__CSB_EXIT__%s' "$?"`;
  const client = await _client(id);
  let raw = '';
  try {
    raw = await client.commands.run(wrapped);
  } catch (e) {
    // The SDK's commands.run() THROWS a CommandError when the command's FINAL
    // exit status is non-zero (verified live: e.g. a script that ends in a
    // failing command, or one that calls `exit N` before the sentinel printf
    // can run). The error carries BOTH the real exit code (e.exitCode) and the
    // real combined stdout+stderr (e.output). We surface those faithfully — the
    // previous code hardcoded exitCode:1 and returned e.message, which (a) lost
    // the true exit code and (b) replaced the program's real output with the
    // generic "Command failed with exit code N" string, blinding the agent to
    // WHY a build/tool actually failed.
    const code = Number.isFinite(e && e.exitCode) ? e.exitCode : 1;
    const body = (e && typeof e.output === 'string' && e.output.length)
      ? e.output
      : String((e && e.message) || e);
    const cleaned = _clean(body);
    return { exitCode: cleaned.hadSentinel ? cleaned.exitCode : code, output: cleaned.output };
  }
  const { exitCode, output } = _clean(raw);
  return { exitCode, output };
}

// Parse the sentinel we append to every command, normalise CRLF→LF, and strip
// the trailing newline printf added. Returns { exitCode, output, hadSentinel }.
function _clean(s) {
  let raw = String(s == null ? '' : s).replace(/\r\n/g, '\n');
  let exitCode = 0;
  const m = raw.match(_EXIT_RE);
  if (m) { exitCode = parseInt(m[1], 10) || 0; raw = raw.replace(_EXIT_RE, ''); }
  raw = raw.replace(/\n$/, '');
  return { exitCode, output: raw, hadSentinel: !!m };
}

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations ───────────────────────────────────────────────────────────

// Upload arbitrary bytes to destPath inside the sandbox (binary-safe — verified
// byte-identical round-trip). We ensure the parent dir exists first.
async function uploadFile(id, destPath, buffer, _filename = 'file') {
  const client = await _client(id);
  const dir = posixDirname(destPath);
  if (dir && dir !== '/' && dir !== '.') {
    // NOTE: the SDK's fs.mkdir takes a BOOLEAN recursive flag as its 2nd arg,
    // NOT an options object. Passing { recursive: true } throws
    // `invalid type: map, expected a boolean` (verified live). Use `true`.
    try { await client.fs.mkdir(dir, true); }
    catch (_) { try { await client.commands.run(`mkdir -p ${shquote(dir)}`); } catch (__) {} }
  }
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await client.fs.writeFile(destPath, data);
  return destPath;
}

// Download a file from the sandbox as raw bytes (binary-safe).
async function downloadFile(id, srcPath) {
  const client = await _client(id);
  const bytes = await client.fs.readFile(srcPath);
  return Buffer.from(bytes);
}

// List files in a directory → normalized [{name,size,isDir,modTime}] (same shape
// daytona/runloop/hopx/novita return).
async function listFiles(id, dir = WORKDIR) {
  const client = await _client(id);
  let arr = [];
  try { arr = await client.fs.readdir(dir); } catch (_) { arr = []; }
  if (!Array.isArray(arr)) return [];
  // readdir returns [{name,type,isSymlink}]; stat each for size/modTime lazily
  // would be slow, so we return size 0 unless the entry carries it. Size is not
  // required by the engine's listing UI (it re-stats when it needs details).
  return arr.map(f => ({
    name: f.name,
    size: parseInt(f.size, 10) || 0,
    isDir: (f.type === 'directory' || f.type === 'dir' || !!f.isDir),
    modTime: f.modifiedTime ? (Date.parse(f.modifiedTime) || 0) : 0,
  })).filter(f => f.name && f.name !== '.' && f.name !== '..');
}

function posixDirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// CodeSandbox VMs run as REAL root with broad capabilities, so — unlike the
// unprivileged Daytona/Novita boxes — we can install and run Docker natively via
// the official convenience script, falling back to the same rootless-root podman
// recipe if the daemon can't start. Idempotent via a sentinel file.
const DOCKER_SETUP_SENTINEL = '/root/.dind_ready';

async function dockerSetup(id, { onStep } = {}) {
  if (!id) throw new Error('dockerSetup: no sandbox id');
  const probe = await exec(id, `test -f ${DOCKER_SETUP_SENTINEL} && (command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1) && echo READY || echo MISSING`, { cwd: null, timeout: 30 }).catch(() => null);
  if (probe && /READY/.test(probe.output || '')) {
    const v = await exec(id, 'docker --version 2>/dev/null || podman --version 2>/dev/null', { cwd: null, timeout: 30 }).catch(() => null);
    return { ok: true, version: (v && v.output || '').trim(), log: 'already configured' };
  }
  if (onStep) onStep('🐳 setting up Docker (native daemon → podman fallback)…');

  const setup = `
set -e
# Try the official Docker install first (we are root).
if ! command -v docker >/dev/null 2>&1; then
  (curl -fsSL https://get.docker.com | sh) >/dev/null 2>&1 || true
fi
# Start dockerd if we have it; give it a few seconds.
if command -v dockerd >/dev/null 2>&1; then
  (dockerd >/var/log/dockerd.log 2>&1 &) || true
  for i in $(seq 1 10); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
# If docker still isn't usable, fall back to rootless-root podman (works anywhere).
if ! docker info >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y podman buildah fuse-overlayfs uidmap slirp4netns crun >/dev/null 2>&1 || true
  mkdir -p /etc/containers /var/lib/containers/storage /var/lib/containers/runroot
  cat > /etc/containers/storage.conf <<'EOF'
[storage]
driver = "vfs"
runroot = "/var/lib/containers/runroot"
graphroot = "/var/lib/containers/storage"
EOF
  cat > /etc/containers/registries.conf <<'EOF'
unqualified-search-registries = ["docker.io"]
EOF
  ln -sf "$(command -v podman)" /usr/local/bin/docker 2>/dev/null || true
fi
touch ${DOCKER_SETUP_SENTINEL}
echo "DIND_SETUP_DONE"
docker --version 2>/dev/null || podman --version 2>/dev/null
`;
  const b64 = Buffer.from(setup, 'utf-8').toString('base64');
  const r = await exec(id, `printf %s '${b64}' | base64 -d > /tmp/_dind_setup.sh && bash /tmp/_dind_setup.sh 2>&1; rm -f /tmp/_dind_setup.sh`, { cwd: null, timeout: 300 });
  const out = r.output || '';
  const ok = /DIND_SETUP_DONE/.test(out);
  const v = out.match(/(?:Docker|podman) version [^\n]+/i);
  if (onStep) onStep(ok ? '🐳 Docker ready.' : '⚠️ Docker setup may have failed — see log.');
  return { ok, version: v ? v[0] : '', log: out.slice(-2000) };
}

// Run a docker command inside the sandbox. On CodeSandbox we prefer the native
// `docker` (real root daemon); if only podman is present the `docker` symlink
// created in dockerSetup routes there transparently.
async function dockerRun(id, dockerArgs, { timeout = 300 } = {}) {
  const cmd = `docker ${dockerArgs}`;
  return exec(id, cmd, { cwd: null, timeout });
}

module.exports = {
  enabled, enabledAsync, WORKDIR,
  createSandbox, deleteSandbox,
  getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
};
