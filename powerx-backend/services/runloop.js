// ─────────────────────────────────────────────────────────────────────────────
// runloop.js — Runloop Devbox REST client (PRIMARY agent sandbox).
//
// Gives the WormGPT Agent a REAL, isolated Linux computer per task: a Runloop
// "devbox" (Debian 12 bookworm, x86_64, user `user`) with python3, node, git,
// curl, pip, npm, sudo apt, etc. The agent runs every shell command / script
// INSIDE this devbox (not on the Render host), reads & writes files there, and
// we download produced files to deliver back over Telegram / the web UI.
//
// This module is the PRIMARY sandbox backend. Daytona (daytona.js) is the
// BACKUP/fallback, and running on the local host is the last resort. The three
// expose the SAME interface shape so agentEngine.js can swap between them.
//
// Auth: RUNLOOP_API_KEY (an `ak_...` key). Admin can also set it at runtime via
// the DB setting `runloop_api_key` (admin panel). When neither is set, the
// engine falls back to Daytona, then to local execution, so nothing breaks.
//
// API verified live against https://api.runloop.ai/v1 :
//   POST   /v1/devboxes                          {name}                       → create (status: provisioning→running)
//   GET    /v1/devboxes/{id}                                                   → { status: running|suspended|shutdown|… }
//   POST   /v1/devboxes/{id}/execute_sync        {command, shell_name?}        → { stdout, stderr, exit_status, shell_name }
//   POST   /v1/devboxes/{id}/write_file_contents {file_path, contents}         → write a text file
//   POST   /v1/devboxes/{id}/read_file_contents  {file_path}                   → raw text body
//   POST   /v1/devboxes/{id}/upload_file         multipart: path + file        → upload binary
//   POST   /v1/devboxes/{id}/download_file       {path}                        → raw bytes body
//   POST   /v1/devboxes/{id}/suspend                                           → suspend (disk preserved)
//   POST   /v1/devboxes/{id}/resume                                            → resume (files intact)
//   POST   /v1/devboxes/{id}/shutdown                                          → destroy
//
// Persistence: suspend keeps the disk; resume restores all files. We suspend
// idle devboxes (cost saving) and resume them on the next turn of the same
// session, so a user's working files survive between turns AND Render restarts
// (the session→devbox mapping is stored in the settings table).
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const FormData = require('form-data');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

const BASE = (process.env.RUNLOOP_API_URL || 'https://api.runloop.ai/v1').replace(/\/+$/, '');
// Where the agent works inside the devbox. The devbox user is `user`.
const WORKDIR = process.env.RUNLOOP_WORKDIR || '/home/user/work';

// ── Runtime API key resolution ────────────────────────────────────────────
// Admin can change the Runloop key at runtime (admin panel → DB setting). We
// read the runtime value first (short cache), then fall back to the env var.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() { return (process.env.RUNLOOP_API_KEY || '').trim(); }

// Synchronous best-effort key (env only) — used by the legacy sync enabled()
// callers. The async resolver below is authoritative and used everywhere a key
// is actually needed.
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
      const v = await db.getSetting('runloop_api_key');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _keyCache = { value: runtime, ts: now };
  return runtime || envKey();
}

function invalidateKeyCache() { _keyCache = { value: undefined, ts: 0 }; }

// Enabled if EITHER a runtime key (cached) or an env key exists. We refresh the
// cache opportunistically so admin-set keys flip this on without a restart.
function enabled() {
  if (db && db.getSetting && Date.now() - _keyCache.ts >= KEY_TTL) {
    getApiKey().catch(() => {});
  }
  return !!getApiKeySync() || !!(_keyCache.value);
}

async function enabledAsync() { return !!(await getApiKey()); }

function authHeaders(key, extra = {}) {
  return { Authorization: `Bearer ${key}`, ...extra };
}

async function api(method, path, { json, query, raw, form, timeout = 60000 } = {}) {
  const API_KEY = await getApiKey();
  if (!API_KEY) throw new Error('RUNLOOP_API_KEY not set');
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: authHeaders(API_KEY), signal: AbortSignal.timeout(timeout) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
    Object.assign(opts.headers, form.getHeaders());
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Runloop ${method} ${path} → ${resp.status}: ${t.slice(0, 240)}`);
  }
  if (raw) return Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// Explicit connectivity test for the admin "Test" button (never throws).
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No Runloop API key configured.' };
  const started = Date.now();
  try {
    const resp = await fetch(`${BASE}/devboxes?limit=1`, {
      method: 'GET',
      headers: authHeaders(key),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      let count = '';
      try {
        const d = await resp.json();
        const arr = Array.isArray(d) ? d : (d && Array.isArray(d.devboxes) ? d.devboxes : null);
        if (arr) count = ` (${arr.length} devbox(es) listed)`;
      } catch (_) {}
      return { ok: true, status: resp.status, ms, message: `✅ Working — Runloop API reachable${count} in ${ms}ms.` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ Runloop returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized Runloop API key (401/403).';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach Runloop: ${e.message}` };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Polling cadence for "is the devbox running yet?" — tunable via env so we can
// dial it without a code change. Faster polling = the agent starts working much
// sooner once the devbox flips to "running" (Runloop often goes ready in a few
// seconds; the old 2000ms cadence wasted up to ~2s per check).
const POLL_MS = parseInt(process.env.RUNLOOP_POLL_MS || '700', 10);
const POLL_MAX = parseInt(process.env.RUNLOOP_POLL_MAX || '170', 10); // ~2min ceiling at 700ms
const READY_RETRIES = parseInt(process.env.RUNLOOP_READY_RETRIES || '10', 10);
const READY_MS = parseInt(process.env.RUNLOOP_READY_MS || '600', 10);

// Create a devbox and wait until it is "running".
// Runloop only accepts a `name` (NOT `size`/`language`) on the simple create
// path; the default SMALL devbox (2 CPU / 4 GB, Debian 12) gives a full Linux
// userland. keep_alive_time_seconds controls how long it stays up idle before
// auto-suspend; we set it generously so multi-step tasks don't get cut off.
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  if (!(await getApiKey())) throw new Error('RUNLOOP_API_KEY not set');
  const keepAlive = parseInt(process.env.RUNLOOP_KEEPALIVE_SEC || '3600', 10);
  const body = {
    name: labels && labels.session ? `wormgpt-${String(labels.session).slice(0, 40)}` : 'wormgpt-agent',
    metadata: { app: 'wormgpt-agent', ...labels },
  };
  // Pass env + keep-alive via launch_parameters when supported (ignored fields
  // are harmless). environment_variables seeds the devbox env.
  body.launch_parameters = { keep_alive_time_seconds: Number.isFinite(keepAlive) ? keepAlive : 3600 };
  if (envVars && Object.keys(envVars).length) body.environment_variables = envVars;

  const sb = await api('POST', '/devboxes', { json: body, timeout: 120000 });
  const id = sb.id;
  if (!id) throw new Error('Runloop create returned no devbox id');
  // Poll until "running" (fast cadence).
  let state = sb.status;
  if (state !== 'running') {
    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const cur = await api('GET', `/devboxes/${id}`, { timeout: 30000 }).catch(() => null);
      if (cur && cur.status) state = cur.status;
      if (state === 'running') break;
      if (state === 'failure' || state === 'shutdown') {
        throw new Error(`Devbox entered state "${state}"`);
      }
    }
    if (state !== 'running') throw new Error(`Devbox not ready (last state "${state}")`);
  }
  // Ensure the working directory exists (best-effort; the exec channel may need
  // a moment after "running" before it is reachable, so retry a few times).
  for (let i = 0; i < READY_RETRIES; i++) {
    const r = await exec(id, `mkdir -p ${WORKDIR} && echo READY`).catch(() => null);
    if (r && /READY/.test(r.output || '')) return id;
    await new Promise(r => setTimeout(r, READY_MS));
  }
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try { await api('POST', `/devboxes/${id}/shutdown`, { timeout: 60000 }); }
  catch (e) { /* best-effort cleanup */ }
}

// Return the current lifecycle state of a devbox ("running", "suspended",
// "shutdown", …) or null if it no longer exists / is unreachable.
async function getSandboxState(id) {
  if (!id) return null;
  try {
    const cur = await api('GET', `/devboxes/${id}`, { timeout: 20000 });
    return (cur && cur.status) || null;
  } catch (_) { return null; }
}

// Resume a previously-suspended devbox and wait until it is "running" again.
// Runloop auto-suspends idle devboxes but KEEPS the disk, so a suspended devbox
// still has all the user's files — we just need to wake it.
async function startSandbox(id) {
  if (!id) return false;
  try { await api('POST', `/devboxes/${id}/resume`, { timeout: 120000 }); } catch (_) {}
  for (let i = 0; i < POLL_MAX; i++) {
    const state = await getSandboxState(id);
    if (state === 'running') {
      // Wait until the exec channel is actually reachable again.
      for (let j = 0; j < READY_RETRIES; j++) {
        const r = await exec(id, 'echo READY').catch(() => null);
        if (r && /READY/.test(r.output || '')) return true;
        await new Promise(r => setTimeout(r, READY_MS));
      }
      return true;
    }
    if (state === 'failure' || state === 'shutdown' || state === null) return false;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return false;
}

// Suspend a running devbox (cost-saving; disk preserved). Best-effort.
async function suspendSandbox(id) {
  if (!id) return false;
  try { await api('POST', `/devboxes/${id}/suspend`, { timeout: 60000 }); return true; }
  catch (_) { return false; }
}

// ── Persistent session → devbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME devbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `rl_session:<sessionKey>`.
const SESSION_PREFIX = 'rl_session:';
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

// Get a LIVE devbox for this session, reusing the persisted one when possible.
//   • If a mapped devbox exists and is "running"   → reuse it (files intact).
//   • If it is "suspended"/"suspending"            → resume it (disk preserved).
//   • Otherwise (gone/shutdown/failure/none)       → create a fresh one + remember it.
// Returns { id, reused }.
async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ envVars, labels });
    return { id, reused: false };
  }
  const existing = await _readSessionId(sessionKey);
  if (existing) {
    const state = await getSandboxState(existing);
    if (state === 'running') return { id: existing, reused: true };
    if (state === 'suspended' || state === 'suspending' || state === 'resuming') {
      const ok = await startSandbox(existing);
      if (ok) return { id: existing, reused: true };
    }
    // Dead/shutdown/failure/unreachable → forget it and fall through to create.
    await _writeSessionId(sessionKey, '');
  }
  const id = await createSandbox({ envVars, labels: { session: String(sessionKey), ...labels } });
  await _writeSessionId(sessionKey, id);
  return { id, reused: false };
}

// Explicitly end a session: shut down its devbox and clear the mapping.
async function endSession(sessionKey) {
  if (!sessionKey) return;
  const existing = await _readSessionId(sessionKey);
  if (existing) { await deleteSandbox(existing); }
  await _writeSessionId(sessionKey, '');
}

// ── Process execution ─────────────────────────────────────────────────────────

// Run a shell command inside the devbox. Returns { exitCode, output }.
// We embed `cd <dir> &&` into the command itself (Runloop's execute_sync runs
// the command with the default shell). stdout+stderr are merged into `output`
// to match the daytona.js contract the agent engine expects.
async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const full = cwd ? `cd ${shquote(cwd)} 2>/dev/null; ${command}` : command;
  const data = await api('POST', `/devboxes/${id}/execute_sync`, {
    json: { command: full },
    timeout: (timeout + 30) * 1000,
  });
  const out = [data.stdout || '', data.stderr || ''].filter(Boolean).join('');
  return { exitCode: typeof data.exit_status === 'number' ? data.exit_status : 0, output: out };
}

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations ───────────────────────────────────────────────────────────

// Upload arbitrary bytes to destPath inside the devbox (multipart: path + file).
async function uploadFile(id, destPath, buffer, filename = 'file') {
  const form = new FormData();
  form.append('path', destPath);
  form.append('file', buffer, { filename });
  await api('POST', `/devboxes/${id}/upload_file`, { form, timeout: 120000 });
  return destPath;
}

// Download a file from the devbox as raw bytes (POST {path} → binary body).
async function downloadFile(id, srcPath) {
  return api('POST', `/devboxes/${id}/download_file`, {
    json: { path: srcPath }, raw: true, timeout: 120000,
  });
}

// List files in a directory. Runloop has no dedicated list endpoint, so we run
// `ls` and parse it into the same {name,size,isDir} shape daytona.js returns.
async function listFiles(id, dir = WORKDIR) {
  const r = await exec(id, `ls -lA --time-style=+%s ${shquote(dir)} 2>/dev/null || true`, { cwd: null, timeout: 30 }).catch(() => null);
  if (!r || !r.output) return [];
  const out = [];
  for (const line of r.output.split('\n')) {
    const t = line.trim();
    if (!t || /^total\s/i.test(t)) continue;
    // perms links owner group size mtime name…
    const m = t.match(/^([dlbcps\-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    let name = m[4];
    // Strip symlink target "name -> target".
    const arrow = name.indexOf(' -> ');
    if (arrow !== -1) name = name.slice(0, arrow);
    if (name === '.' || name === '..') continue;
    out.push({
      name,
      size: parseInt(m[2], 10) || 0,
      isDir: m[1] === 'd',
      modTime: (parseInt(m[3], 10) || 0) * 1000,
    });
  }
  return out;
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// PARITY WITH daytona.js: gives the in-sandbox / host agent a working `docker`
// command INSIDE a Runloop devbox so the "owns-the-computer" mode can BUILD and
// RUN containers exactly like it does on Daytona.
//
// Runloop devboxes (Debian 12 bookworm, user `user`) are UNPRIVILEGED containers
// (no CAP_SYS_ADMIN), so neither a privileged dockerd nor standard rootless
// podman work reliably. The empirically-verified recipe — identical to the one
// proven on Daytona — runs containers as REAL root via `sudo podman` with chroot
// isolation + the vfs storage driver, sharing host namespaces and disabling
// cgroups (which we cannot write). A `docker` symlink → podman is created so the
// agent can use familiar `docker …` commands.
//
// `dockerSetup(id)` is idempotent: it marks completion with a sentinel file so
// re-runs are instant. Returns { ok, version, log }.
const DOCKER_SETUP_SENTINEL = '/home/user/.dind_ready';

async function dockerSetup(id, { onStep } = {}) {
  if (!id) throw new Error('dockerSetup: no devbox id');
  // Fast path: already set up?
  const probe = await exec(id, `test -f ${DOCKER_SETUP_SENTINEL} && command -v podman >/dev/null 2>&1 && echo READY || echo MISSING`, { cwd: null, timeout: 30 }).catch(() => null);
  if (probe && /READY/.test(probe.output || '')) {
    const v = await exec(id, 'podman --version 2>/dev/null', { cwd: null, timeout: 30 }).catch(() => null);
    return { ok: true, version: (v && v.output || '').trim(), log: 'already configured' };
  }
  if (onStep) onStep('🐳 setting up Docker-in-Docker (podman + buildah, rootless-root)…');

  // One script that installs the engine and writes the proven config. Run with a
  // generous timeout — first install pulls packages.
  const setup = `
set -e
sudo apt-get update -y >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman buildah fuse-overlayfs uidmap slirp4netns crun >/dev/null 2>&1 || true
sudo mkdir -p /etc/containers /var/lib/containers/storage /var/lib/containers/runroot
# Root storage: vfs with explicit roots (overlay needs caps we don't have).
sudo tee /etc/containers/storage.conf >/dev/null <<'EOF'
[storage]
driver = "vfs"
runroot = "/var/lib/containers/runroot"
graphroot = "/var/lib/containers/storage"
EOF
# Container runtime config: drop default sysctls (ping_group_range is blocked),
# share host namespaces, disable cgroups (no cgroup write access).
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
# registries: default to docker.io so short names resolve.
sudo tee /etc/containers/registries.conf >/dev/null <<'EOF'
unqualified-search-registries = ["docker.io"]
EOF
# Familiar 'docker' command -> podman.
sudo ln -sf /usr/bin/podman /usr/local/bin/docker
# Helper wrapper so the agent can just call 'dind <args>' = the verified invocation.
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
  const vm = out.match(/podman version [^\n]+/i);
  if (onStep) onStep(ok ? '🐳 Docker-in-Docker ready.' : '⚠️ Docker setup may have failed — see log.');
  return { ok, version: vm ? vm[0] : '', log: out.slice(-2000) };
}

// Run a docker/podman command inside the devbox using the verified root+chroot
// invocation. `dockerArgs` is the part AFTER `podman` (e.g. `run --rm alpine echo hi`).
// Returns { exitCode, output }.
async function dockerRun(id, dockerArgs, { timeout = 280 } = {}) {
  const cmd = `sudo BUILDAH_ISOLATION=chroot podman --cgroup-manager=cgroupfs ${dockerArgs}`;
  return exec(id, cmd, { cwd: null, timeout });
}

module.exports = {
  enabled, enabledAsync, WORKDIR,
  createSandbox, deleteSandbox,
  getSandboxState, startSandbox, suspendSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
};
