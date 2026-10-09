// ─────────────────────────────────────────────────────────────────────────────
// novitaSandbox.js — Novita Agent Sandbox client (E2B-compatible micro-VM).
//
// Gives the WormGPT Agent a REAL, isolated Linux computer per task — exactly the
// way HopX / Runloop / Daytona do. A Novita sandbox is a full Linux userland
// (x86_64, kernel 6.1, user `user`, home /home/user) with python3, node, git,
// curl, pip, npm, apt, etc. The agent runs every shell command / script INSIDE
// this sandbox (not on the Render host), reads & writes files there, and we
// download produced files to deliver back over Telegram / WhatsApp / the web UI.
//
// Why this backend matters: HopX has been returning 503 "no available nodes"
// (provider capacity outage) and Runloop needs a separate `ak_...` key. Novita
// Agent Sandbox is a THIRD real "owns-the-computer" provider the admin can
// switch to so the agent keeps working when the others are down/unconfigured.
//
// Auth: NOVITA_API_KEY (an `sk_...` key — the SAME key used for Novita chat in
// services/novita.js). Admin can also set it at runtime via the DB setting
// `novita_sandbox_api_key` (falls back to `novita_api_key`, then the env var),
// so it flips on WITHOUT a code change or restart.
//
// Transport: Novita Agent Sandbox is E2B-compatible and ships an official Node
// SDK (`novita-sandbox`). The SDK speaks the envd (gRPC-web/Connect) protocol
// under the hood, so we wrap it rather than hand-rolling that protocol over raw
// HTTP. The SDK is ESM-only, so we load it once via a cached dynamic import()
// from this CommonJS module. Verified live: create / exec / file R-W / binary
// round-trip / pause / resume(connect) / kill all work.
//
// This module exposes the SAME interface shape as daytona.js / hopx.js /
// runloop.js so sandboxAgent.js + agentEngine.js can swap between them with no
// other changes:
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

// E2B-compatible control-plane base (used only by testKey's lightweight probe;
// all real work goes through the SDK, which targets sandbox.novita.ai itself).
const CONTROL_BASE = (process.env.NOVITA_SANDBOX_API_URL || 'https://api.sandbox.novita.ai').replace(/\/+$/, '');
// Template a fresh sandbox is created from. `base` = full Linux userland with
// python3/node/git/curl/pip/npm (verified). Overridable for ops.
const TEMPLATE = (process.env.NOVITA_SANDBOX_TEMPLATE || 'base').trim();
// Where the agent works inside the sandbox. The SDK's default user is `user`,
// home /home/user — so WORK = <home>/work lines up with the sandboxAgent path
// math (home + "/work") exactly like the other backends.
const WORKDIR = process.env.NOVITA_SANDBOX_WORKDIR || '/home/user/work';
// Total lifetime cap before Novita auto-reclaims the box (a safety ceiling; the
// session layer keeps pausing/resuming it while the chat is active). Generous
// for long autonomous tasks (installs, builds, pentests, multi-hour runs).
const SANDBOX_TIMEOUT_MS = parseInt(process.env.NOVITA_SANDBOX_TIMEOUT_MS || '3600000', 10); // 1h

// ── Lazy ESM SDK loader (cached) ─────────────────────────────────────────────
// `novita-sandbox` is ESM-only; this file is CommonJS. We import() it once and
// cache the promise so every call reuses the same module instance.
let _sdkPromise = null;
async function _sdk() {
  if (!_sdkPromise) _sdkPromise = import('novita-sandbox');
  const mod = await _sdkPromise;
  const Sandbox = mod.Sandbox || (mod.default && mod.default.Sandbox);
  if (!Sandbox) throw new Error('novita-sandbox SDK missing Sandbox export');
  return { Sandbox };
}

// ── Runtime API key resolution ────────────────────────────────────────────
// Admin can change the Novita sandbox key at runtime. Preference:
//   1. DB setting `novita_sandbox_api_key` (a dedicated key, if the admin wants
//      to bill sandbox usage separately),
//   2. DB setting `novita_api_key` (the shared Novita key used by chat),
//   3. env NOVITA_SANDBOX_API_KEY,
//   4. env NOVITA_API_KEY.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() {
  return (process.env.NOVITA_SANDBOX_API_KEY || process.env.NOVITA_API_KEY || '').trim();
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
      let v = await db.getSetting('novita_sandbox_api_key');
      if (!v || !String(v).trim()) v = await db.getSetting('novita_api_key');
      if (v && String(v).trim()) runtime = String(v).trim();
    }
  } catch (_) {}
  _keyCache = { value: runtime, ts: now };
  return runtime || envKey();
}

function invalidateKeyCache() { _keyCache = { value: undefined, ts: 0 }; }

// Enabled if EITHER a runtime key (cached) or an env key exists. We refresh the
// cache opportunistically so an admin-set key flips this on without a restart.
function enabled() {
  if (db && db.getSetting && Date.now() - _keyCache.ts >= KEY_TTL) {
    getApiKey().catch(() => {});
  }
  return !!getApiKeySync() || !!(_keyCache.value);
}

async function enabledAsync() { return !!(await getApiKey()); }

// ── Live sandbox handle cache ─────────────────────────────────────────────────
// The SDK returns a live Sandbox object per box. We cache it per sandbox id so
// repeated exec/file calls in one task reuse the same connected handle (avoids
// re-resolving the envd host each call). Evicted on kill / on connect refresh.
const _handles = new Map(); // id -> Sandbox

function _cache(id, sbx) { if (id && sbx) _handles.set(String(id), sbx); return sbx; }
function _forget(id) { _handles.delete(String(id)); }

// Get a live, connected handle for an EXISTING sandbox id. Reuses the cache;
// otherwise connects (which also resumes a paused box). Throws if unreachable.
async function _handle(id) {
  const cached = _handles.get(String(id));
  if (cached) return cached;
  const key = await getApiKey();
  if (!key) throw new Error('NOVITA_API_KEY not set');
  const { Sandbox } = await _sdk();
  const sbx = await Sandbox.connect(String(id), { apiKey: key });
  return _cache(id, sbx);
}

// ── Explicit connectivity test for the admin "Test" button (never throws) ─────
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No Novita API key configured.' };
  const started = Date.now();
  try {
    // E2B-compatible control endpoint: listing sandboxes validates the key
    // cheaply without provisioning anything.
    const fetch = require('node-fetch');
    const resp = await fetch(`${CONTROL_BASE}/sandboxes`, {
      method: 'GET',
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      let count = '';
      try {
        const d = await resp.json();
        if (Array.isArray(d)) count = ` (${d.length} sandbox(es) listed)`;
      } catch (_) {}
      return { ok: true, status: resp.status, ms, message: `✅ Working — Novita Sandbox API reachable${count} in ${ms}ms.` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ Novita Sandbox returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized Novita API key (401/403).';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach Novita Sandbox: ${e.message}` };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Create a sandbox and return its id. The SDK's create() waits until the box is
// ready (running) before resolving, so no extra polling is needed. We ensure the
// working directory exists before handing the id back (best-effort).
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  const key = await getApiKey();
  if (!key) throw new Error('NOVITA_API_KEY not set');
  const { Sandbox } = await _sdk();
  const opts = { apiKey: key, timeoutMs: Number.isFinite(SANDBOX_TIMEOUT_MS) ? SANDBOX_TIMEOUT_MS : 3600000 };
  if (TEMPLATE) opts.template = TEMPLATE;
  if (envVars && Object.keys(envVars).length) opts.envs = envVars;
  if (labels && Object.keys(labels).length) opts.metadata = labels;
  const sbx = await Sandbox.create(opts);
  const id = sbx.sandboxId;
  if (!id) throw new Error('Novita create returned no sandbox id');
  _cache(id, sbx);
  // Ensure the working dir exists so the first `cd WORKDIR` doesn't fail.
  try { await sbx.commands.run(`mkdir -p ${shquote(WORKDIR)}`, { timeoutMs: 30000 }); } catch (_) {}
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try {
    const sbx = await _handle(id).catch(() => null);
    if (sbx && sbx.kill) await sbx.kill();
  } catch (_) { /* best-effort cleanup */ }
  _forget(id);
}

// Return the current lifecycle state of a sandbox ("running", "paused", …) or
// null if it no longer exists / is unreachable. Uses the SDK's static getInfo so
// it works even for a paused box (no need to resume just to read the state).
async function getSandboxState(id) {
  if (!id) return null;
  const key = await getApiKey();
  if (!key) return null;
  try {
    const { Sandbox } = await _sdk();
    if (typeof Sandbox.getInfo === 'function') {
      const info = await Sandbox.getInfo(String(id), { apiKey: key });
      return (info && info.state) || null;
    }
    // Fallback: connect (resumes) then read info.
    const sbx = await _handle(id);
    const info = await sbx.getInfo();
    return (info && info.state) || null;
  } catch (_) { return null; }
}

// Resume a paused sandbox and wait until it is "running" again. Novita pause
// KEEPS the disk, so a paused sandbox still has all the user's files — connect()
// wakes it and returns a live handle. Returns true on success.
async function startSandbox(id) {
  if (!id) return false;
  try {
    const key = await getApiKey();
    if (!key) return false;
    const { Sandbox } = await _sdk();
    const sbx = await Sandbox.connect(String(id), { apiKey: key });
    _cache(id, sbx);
    // Confirm the exec channel is reachable.
    const r = await sbx.commands.run('echo READY', { timeoutMs: 20000 }).catch(() => null);
    return !!(r && /READY/.test(r.stdout || ''));
  } catch (_) {
    _forget(id);
    return false;
  }
}

// Pause a running sandbox (cost-saving; disk preserved). Best-effort.
async function pauseSandbox(id) {
  if (!id) return false;
  try {
    const sbx = await _handle(id);
    if (sbx && sbx.pause) { await sbx.pause(); return true; }
    return false;
  } catch (_) { return false; }
}
// Alias used by some callers (parity with runloop.suspendSandbox).
const suspendSandbox = pauseSandbox;

// ── Persistent session → sandbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME sandbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `novita_sb_session:<sessionKey>`.
const SESSION_PREFIX = 'novita_sb_session:';
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

// Read the EXISTING session sandbox id without ever creating one (used by /stop
// so we don't spin up a sandbox just to halt a task that isn't running).
async function getSessionSandboxId(sessionKey) {
  return _readSessionId(sessionKey);
}

// Get a LIVE sandbox for this session, reusing the persisted one when possible.
//   • If a mapped sandbox exists and is "running"        → reuse it (files intact).
//   • If it is "paused"/"pausing"/"resuming"             → resume it (disk preserved).
//   • Otherwise (gone/stopped/error/none)                → create a fresh one + remember it.
// Returns { id, reused }.
async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ envVars, labels });
    return { id, reused: false };
  }
  const existing = await _readSessionId(sessionKey);
  if (existing) {
    const state = await getSandboxState(existing);
    if (state === 'running') {
      // Make sure we hold a usable live handle before reusing.
      try { await _handle(existing); return { id: existing, reused: true }; }
      catch (_) { /* fall through to resume/create */ }
    }
    if (state === 'paused' || state === 'pausing' || state === 'resuming' || state === 'suspended' || state === 'stopped') {
      const ok = await startSandbox(existing);
      if (ok) return { id: existing, reused: true };
    }
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
// is stdout+stderr merged, matching the daytona/runloop/hopx contract the engine
// expects. We embed `cd <dir> &&` into the command (like the other backends)
// because the SDK rejects a non-existent `cwd` option; embedding cd is tolerant
// (the `2>/dev/null` swallows a missing dir and we mkdir -p first at create).
async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const full = cwd ? `cd ${shquote(cwd)} 2>/dev/null; ${command}` : command;
  const sbx = await _handle(id);
  const data = await sbx.commands.run(full, {
    timeoutMs: (Math.max(5, timeout) + 30) * 1000,
  });
  const out = [data.stdout || '', data.stderr || ''].filter(Boolean).join('');
  return { exitCode: typeof data.exitCode === 'number' ? data.exitCode : 0, output: out };
}

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations ───────────────────────────────────────────────────────────

// Upload arbitrary bytes to destPath inside the sandbox. The SDK's files.write
// accepts a Buffer/Uint8Array directly (binary-safe — verified byte-identical
// round-trip). We ensure the parent dir exists first.
async function uploadFile(id, destPath, buffer, _filename = 'file') {
  const sbx = await _handle(id);
  const dir = posixDirname(destPath);
  if (dir && dir !== '/' && dir !== '.') {
    try { await sbx.commands.run(`mkdir -p ${shquote(dir)}`, { timeoutMs: 30000 }); } catch (_) {}
  }
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await sbx.files.write(destPath, data);
  return destPath;
}

// Download a file from the sandbox as raw bytes (binary-safe).
async function downloadFile(id, srcPath) {
  const sbx = await _handle(id);
  const bytes = await sbx.files.read(srcPath, { format: 'bytes' });
  return Buffer.from(bytes);
}

// List files in a directory → normalized [{name,size,isDir,modTime}] (same shape
// daytona/runloop/hopx return).
async function listFiles(id, dir = WORKDIR) {
  const sbx = await _handle(id);
  let arr = [];
  try { arr = await sbx.files.list(dir); } catch (_) { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(f => ({
    name: f.name,
    size: parseInt(f.size, 10) || 0,
    isDir: (f.type === 'dir' || f.type === 'directory' || !!f.isDir),
    modTime: f.modifiedTime ? (Date.parse(f.modifiedTime) || 0) : 0,
  })).filter(f => f.name && f.name !== '.' && f.name !== '..');
}

function posixDirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// PARITY WITH runloop.js / daytona.js: give the in-sandbox / host agent a working
// `docker` command INSIDE a Novita sandbox so "owns-the-computer" mode can BUILD
// and RUN containers. Novita sandboxes are unprivileged containers (no
// CAP_SYS_ADMIN), so we use the SAME proven rootless-root recipe as Runloop:
// `sudo podman` with chroot isolation + the vfs storage driver + host namespaces
// + cgroups disabled, and a `docker` symlink → podman.
//
// Idempotent: a sentinel file marks completion so re-runs are instant.
const DOCKER_SETUP_SENTINEL = '/home/user/.dind_ready';

async function dockerSetup(id, { onStep } = {}) {
  if (!id) throw new Error('dockerSetup: no sandbox id');
  const probe = await exec(id, `test -f ${DOCKER_SETUP_SENTINEL} && command -v podman >/dev/null 2>&1 && echo READY || echo MISSING`, { cwd: null, timeout: 30 }).catch(() => null);
  if (probe && /READY/.test(probe.output || '')) {
    const v = await exec(id, 'podman --version 2>/dev/null', { cwd: null, timeout: 30 }).catch(() => null);
    return { ok: true, version: (v && v.output || '').trim(), log: 'already configured' };
  }
  if (onStep) onStep('🐳 setting up Docker-in-Docker (podman + buildah, rootless-root)…');

  const setup = `
set -e
sudo apt-get update -y >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman buildah fuse-overlayfs uidmap slirp4netns crun >/dev/null 2>&1 || true
sudo mkdir -p /etc/containers /var/lib/containers/storage /var/lib/containers/runroot
sudo tee /etc/containers/storage.conf >/dev/null <<'EOF'
[storage]
driver = "vfs"
runroot = "/var/lib/containers/runroot"
graphroot = "/var/lib/containers/storage"
EOF
sudo tee /etc/containers/containers.conf >/dev/null <<'EOF'
[containers]
default_sysctls = []
netns = "host"
userns = "host"
ipcns = "host"
utsns = "host"
cgroupns = "host"
cgroups = "disabled"
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
EOF
sudo tee /etc/containers/registries.conf >/dev/null <<'EOF'
unqualified-search-registries = ["docker.io"]
EOF
sudo ln -sf /usr/bin/podman /usr/local/bin/docker
sudo tee /usr/local/bin/dind >/dev/null <<'EOF'
#!/usr/bin/env bash
exec sudo BUILDAH_ISOLATION=chroot podman --cgroup-manager=cgroupfs "$@"
EOF
sudo chmod +x /usr/local/bin/dind
touch ${DOCKER_SETUP_SENTINEL}
echo "DIND_SETUP_DONE"
podman --version
`;
  const b64 = Buffer.from(setup, 'utf-8').toString('base64');
  const r = await exec(id, `printf %s '${b64}' | base64 -d > /tmp/_dind_setup.sh && bash /tmp/_dind_setup.sh 2>&1; rm -f /tmp/_dind_setup.sh`, { cwd: null, timeout: 280 });
  const out = r.output || '';
  const ok = /DIND_SETUP_DONE/.test(out);
  const v = out.match(/podman version [^\n]+/i);
  if (onStep) onStep(ok ? '🐳 Docker-in-Docker ready.' : '⚠️ Docker setup may have failed — see log.');
  return { ok, version: v ? v[0] : '', log: out.slice(-2000) };
}

// Run a docker/podman command inside the sandbox using the verified root+chroot
// invocation. `dockerArgs` is the part AFTER `podman` (e.g. `run --rm alpine echo hi`).
async function dockerRun(id, dockerArgs, { timeout = 280 } = {}) {
  const cmd = `sudo BUILDAH_ISOLATION=chroot podman --cgroup-manager=cgroupfs ${dockerArgs}`;
  return exec(id, cmd, { cwd: null, timeout });
}

// ── 💓 Keepalive ─────────────────────────────────────────────────────────────
// Called periodically during a long task so the box isn't reclaimed mid-flight.
// The Novita SDK lets us EXTEND a running sandbox's lifetime via setTimeout, so
// we push the deadline out on every tick. Best-effort — never throws.
async function keepAlive(id) {
  if (!id) return false;
  try {
    const sbx = await _handle(id).catch(() => null);
    if (sbx && typeof sbx.setTimeout === 'function') {
      await sbx.setTimeout(Number.isFinite(SANDBOX_TIMEOUT_MS) ? SANDBOX_TIMEOUT_MS : 3600000);
      return true;
    }
    // No extend API → at least confirm it's still reachable (resume if paused).
    const state = await getSandboxState(id);
    if (state === 'running') return true;
    if (state === 'paused' || state === 'suspended' || state === 'pausing') return await startSandbox(id);
    return false;
  } catch (_) { return false; }
}

module.exports = {
  enabled, enabledAsync, WORKDIR,
  createSandbox, deleteSandbox,
  getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
  keepAlive,
};
