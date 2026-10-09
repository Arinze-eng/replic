// ─────────────────────────────────────────────────────────────────────────────
// daytona.js — Daytona Sandbox REST client.
//
// Gives the WormGPT Agent a REAL, isolated Linux computer per task: full Ubuntu
// userland with python3, node, git, curl, pip, npm, etc. The agent runs every
// shell command / script INSIDE this sandbox (not on the Render host), can read
// & write files there, and we download produced files to deliver back over
// Telegram / the web UI.
//
// Auth: DAYTONA_API_KEY (a `dtn_...` key). When unset, the engine falls back to
// running code locally on the host (legacy behaviour) so nothing breaks.
//
// API verified against https://app.daytona.io/api :
//   POST   /api/sandbox                                        → create (+auto start)
//   GET    /api/sandbox/{id}                                   → status
//   DELETE /api/sandbox/{id}?force=true                        → destroy
//   POST   /api/toolbox/{id}/toolbox/process/execute           → {command,cwd,timeout} → {exitCode,result}
//   POST   /api/toolbox/{id}/toolbox/files/upload?path=...     → multipart "file"
//   GET    /api/toolbox/{id}/toolbox/files/download?path=...   → raw bytes
//   GET    /api/toolbox/{id}/toolbox/files?path=...            → [{name,size,isDir,...}]
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const FormData = require('form-data');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

const BASE = (process.env.DAYTONA_API_URL || 'https://app.daytona.io/api').replace(/\/+$/, '');
// Toolbox traffic uses Daytona's dedicated proxy plane. Keep it separate from
// the control-plane API so lifecycle URLs never leak into process/file calls.
// `{sandboxId}` is replaced with encodeURIComponent(id).
const TOOLBOX_URL_TEMPLATE = (
  process.env.DAYTONA_TOOLBOX_URL_TEMPLATE || 'https://proxy.app.daytona.io/toolbox/{sandboxId}'
).replace(/\/+$/, '');
const DEFAULT_TARGET = process.env.DAYTONA_TARGET || 'us';
// Daytona organization id — required by the REST API as the X-Daytona-Organization-ID
// header. Without it the API rejects sandbox creation / toolbox calls for org-scoped keys.
const ORG_ID = (process.env.DAYTONA_ORG_ID || '').trim();
// Where the agent works inside the sandbox.
const WORKDIR = '/home/daytona/work';

// ── Runtime API key resolution ────────────────────────────────────────────
// Admin can change the Daytona key at runtime (admin panel → DB setting). We
// read the runtime value first (short cache), then fall back to the env var.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() { return (process.env.DAYTONA_API_KEY || '').trim(); }

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
      const v = await db.getSetting('daytona_api_key');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _keyCache = { value: runtime, ts: now };
  return runtime || envKey();
}

function invalidateKeyCache() { _keyCache = { value: undefined, ts: 0 }; }

// Resolve the org id (DB setting → env). Short cache shared with the key cache TTL.
let _orgCache = { value: undefined, ts: 0 };
async function getOrgId() {
  const now = Date.now();
  if (_orgCache.value !== undefined && now - _orgCache.ts < KEY_TTL) {
    return _orgCache.value || ORG_ID;
  }
  let runtime = '';
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting('daytona_org_id');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _orgCache = { value: runtime, ts: now };
  return runtime || ORG_ID;
}

// Enabled if EITHER a runtime key (cached) or an env key exists. We refresh the
// cache opportunistically so admin-set keys flip this on without a restart.
function enabled() {
  // Kick an async refresh (fire-and-forget) so the cache stays warm.
  if (db && db.getSetting && Date.now() - _keyCache.ts >= KEY_TTL) {
    getApiKey().catch(() => {});
  }
  return !!getApiKeySync() || !!(_keyCache.value);
}

async function enabledAsync() { return !!(await getApiKey()); }

function authHeaders(key, extra = {}, orgId) {
  const h = { Authorization: `Bearer ${key}`, ...extra };
  if (orgId) h['X-Daytona-Organization-ID'] = orgId;
  return h;
}

async function requestUrl(method, url, { json, query, raw, form, timeout = 60000, label = url, apiKey } = {}) {
  const API_KEY = (apiKey && String(apiKey).trim()) || await getApiKey();
  if (!API_KEY) throw new Error('DAYTONA_API_KEY not set');
  const orgId = await getOrgId();
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: authHeaders(API_KEY, {}, orgId), signal: AbortSignal.timeout(timeout) };
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
    throw new Error(`Daytona ${method} ${label} → ${resp.status}: ${t.slice(0, 240)}`);
  }
  if (raw) return Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

async function api(method, path, options = {}) {
  return requestUrl(method, BASE + path, { ...options, label: path });
}

function toolboxBase(id) {
  if (!id) throw new Error('Daytona toolbox call requires a sandbox id');
  if (!TOOLBOX_URL_TEMPLATE.includes('{sandboxId}')) {
    throw new Error('DAYTONA_TOOLBOX_URL_TEMPLATE must contain {sandboxId}');
  }
  return TOOLBOX_URL_TEMPLATE.replace('{sandboxId}', encodeURIComponent(String(id)));
}

async function toolboxApi(method, id, path, options = {}) {
  const url = toolboxBase(id) + (path.startsWith('/') ? path : `/${path}`);
  return requestUrl(method, url, { ...options, label: `toolbox:${path}` });
}

// Explicit connectivity test for the admin "Test" button (never throws).
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No Daytona API key configured.' };
  const started = Date.now();
  try {
    const orgId = await getOrgId();
    const resp = await fetch(`${BASE}/sandbox`, {
      method: 'GET',
      headers: authHeaders(key, {}, orgId),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      let count = '';
      try { const d = await resp.json(); if (Array.isArray(d)) count = ` (${d.length} sandbox(es))`; } catch (_) {}
      return { ok: true, status: resp.status, ms, message: `✅ Working — Daytona API reachable${count} in ${ms}ms.` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ Daytona returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized Daytona API key (401/403).';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach Daytona: ${e.message}` };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Create a sandbox and wait until it is "started".
// NOTE: the Daytona REST CreateSandbox schema has NO `language` field — it is an
// SDK-only convenience. Sending it is harmless (ignored) but we omit it and let
// the default snapshot (full Ubuntu w/ python3, node, git, curl, pip, npm, zip,
// tar …) be used. We keep `target`, lifecycle intervals, env and labels.
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  if (!(await getApiKey())) throw new Error('DAYTONA_API_KEY not set');
  // Persistence-friendly lifecycle (overridable via env):
  //   • autoStopInterval: stop the sandbox after N min idle to save cost; the
  //     DISK IS PRESERVED, so we can start it back up with all files intact.
  //   • autoDeleteInterval: only after the sandbox has been STOPPED for N min is
  //     it permanently deleted. We keep this generous (24h) so a user's working
  //     files survive between sessions instead of vanishing an hour later.
  const autoStop = parseInt(process.env.DAYTONA_AUTO_STOP_MIN || '30', 10);
  const autoDelete = parseInt(process.env.DAYTONA_AUTO_DELETE_MIN || '1440', 10);
  const body = {
    target: DEFAULT_TARGET,
    env: envVars,
    labels: { app: 'wormgpt-agent', ...labels },
    autoStopInterval: Number.isFinite(autoStop) ? autoStop : 30,
    autoDeleteInterval: Number.isFinite(autoDelete) ? autoDelete : 1440,
  };
  const sb = await api('POST', '/sandbox', { json: body, timeout: 120000 });
  const id = sb.id;
  if (!id) throw new Error('Daytona create returned no sandbox id');
  // Usually already "started"; poll until ready otherwise.
  let state = sb.state;
  if (state !== 'started') {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const cur = await api('GET', `/sandbox/${id}`, { timeout: 30000 }).catch(() => null);
      if (cur && cur.state) state = cur.state;
      if (state === 'started') break;
      if (state === 'error' || state === 'destroyed' || state === 'build_failed') {
        throw new Error(`Sandbox entered state "${state}": ${(cur && cur.errorReason) || ''}`);
      }
    }
    if (state !== 'started') throw new Error(`Sandbox not ready (last state "${state}")`);
  }
  // Ensure the working directory exists (best-effort; the toolbox may need a
  // moment after "started" before exec is reachable, so retry a couple times).
  for (let i = 0; i < 5; i++) {
    const r = await exec(id, `mkdir -p ${WORKDIR} && echo READY`).catch(() => null);
    if (r && /READY/.test(r.output || '')) return id;
    await new Promise(r => setTimeout(r, 2000));
  }
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try { await api('DELETE', `/sandbox/${id}`, { query: { force: true }, timeout: 60000 }); }
  catch (e) { /* best-effort cleanup */ }
}

// Return the current lifecycle state of a sandbox ("started", "stopped",
// "destroyed", …) or null if it no longer exists / is unreachable.
async function getSandboxState(id) {
  if (!id) return null;
  try {
    const cur = await api('GET', `/sandbox/${id}`, { timeout: 20000 });
    return (cur && cur.state) || null;
  } catch (_) { return null; }
}

// Start a previously-stopped sandbox and wait until it is "started" again.
// Daytona auto-stops idle sandboxes (autoStopInterval) but KEEPS the disk, so a
// stopped sandbox still has all the user's files — we just need to wake it.
async function startSandbox(id) {
  if (!id) return false;
  try { await api('POST', `/sandbox/${id}/start`, { timeout: 120000 }); } catch (_) {}
  for (let i = 0; i < 40; i++) {
    const state = await getSandboxState(id);
    if (state === 'started') {
      // Wait until the toolbox process endpoint is actually reachable again.
      for (let j = 0; j < 5; j++) {
        const r = await exec(id, 'echo READY').catch(() => null);
        if (r && /READY/.test(r.output || '')) return true;
        await new Promise(r => setTimeout(r, 2000));
      }
      return true;
    }
    if (state === 'error' || state === 'destroyed' || state === 'build_failed' || state === null) return false;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// ── Persistent session → sandbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME sandbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `sbx_session:<sessionKey>`.
const SESSION_PREFIX = 'sbx_session:';
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
//   • If a mapped sandbox exists and is "started" → reuse it (files intact).
//   • If it is "stopped" → start it back up (disk preserved) and reuse it.
//   • Otherwise (gone/error/none) → create a fresh sandbox and remember it.
// Returns { id, reused }.
async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ envVars, labels });
    return { id, reused: false };
  }
  const existing = await _readSessionId(sessionKey);
  if (existing) {
    const state = await getSandboxState(existing);
    if (state === 'started') return { id: existing, reused: true };
    if (state === 'stopped' || state === 'stopping') {
      const ok = await startSandbox(existing);
      if (ok) return { id: existing, reused: true };
    }
    // Dead/destroyed/unreachable → forget it and fall through to create.
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

// Run a shell command inside the sandbox. Returns { exitCode, output }.
// NOTE: we deliberately DON'T pass the `cwd` field — on some runner images that
// makes the toolbox try to invoke a shell (zsh) that isn't installed and fails
// with "fork/exec /usr/bin/zsh: no such file". Instead we embed `cd <dir> &&`
// into the command itself and let the toolbox run it with the default shell.
async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const full = cwd ? `cd ${shquote(cwd)} 2>/dev/null; ${command}` : command;
  // NOTE (2026-07 fix): the toolbox proxy path is `{proxy}/toolbox/{id}/process/execute`.
  // The proxy URL template already ends in `/toolbox`, so the per-call path must
  // NOT repeat `/toolbox` again — the old `/toolbox/process/execute` produced a
  // double `/toolbox/toolbox/...` and Daytona returned 404 for every exec.
  const data = await toolboxApi('POST', id, '/process/execute', {
    json: { command: full, timeout },
    timeout: (timeout + 30) * 1000,
  });
  return { exitCode: data.exitCode, output: data.result || '' };
}

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations ───────────────────────────────────────────────────────────

async function uploadFile(id, destPath, buffer, filename = 'file') {
  const form = new FormData();
  form.append('file', buffer, { filename });
  await toolboxApi('POST', id, '/files/upload', {
    form, query: { path: destPath }, timeout: 120000,
  });
  return destPath;
}

async function downloadFile(id, srcPath) {
  return toolboxApi('GET', id, '/files/download', {
    query: { path: srcPath }, raw: true, timeout: 120000,
  });
}

async function listFiles(id, dir = WORKDIR) {
  const data = await toolboxApi('GET', id, '/files', {
    query: { path: dir }, timeout: 30000,
  });
  return Array.isArray(data) ? data : [];
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// Daytona's container-class sandboxes are UNPRIVILEGED (no CAP_SYS_ADMIN) and
// block writing /proc/PID/uid_map, so neither a privileged dockerd nor standard
// rootless podman work. However the sandbox user has PASSWORDLESS SUDO, user
// namespaces are enabled and /dev/fuse exists — so we run containers as REAL
// root via `sudo podman` with chroot isolation + the vfs storage driver. This
// is the empirically-verified recipe that successfully builds & runs containers
// (alpine, etc.) inside the sandbox. A `docker` symlink → podman is created so
// the agent can use familiar `docker ...` commands.
//
// `dockerSetup(id)` is idempotent: it marks completion with a sentinel file so
// re-runs are instant. Returns { ok, version, log }.
const DOCKER_SETUP_SENTINEL = '/home/daytona/.dind_ready';

async function dockerSetup(id, { onStep } = {}) {
  if (!id) throw new Error('dockerSetup: no sandbox id');
  // Fast path: already set up?
  const probe = await exec(id, `test -f ${DOCKER_SETUP_SENTINEL} && command -v podman >/dev/null 2>&1 && echo READY || echo MISSING`, { timeout: 30 }).catch(() => null);
  if (probe && /READY/.test(probe.output || '')) {
    const v = await exec(id, 'podman --version 2>/dev/null', { timeout: 30 }).catch(() => null);
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
# Familiar 'docker' command -> podman (also a 'docker-real' note).
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
  const r = await exec(id, `printf %s '${b64}' | base64 -d > /tmp/_dind_setup.sh && bash /tmp/_dind_setup.sh 2>&1; rm -f /tmp/_dind_setup.sh`, { timeout: 280 });
  const out = r.output || '';
  const ok = /DIND_SETUP_DONE/.test(out);
  const vm = out.match(/podman version [^\n]+/i);
  if (onStep) onStep(ok ? '🐳 Docker-in-Docker ready.' : '⚠️ Docker setup may have failed — see log.');
  return { ok, version: vm ? vm[0] : '', log: out.slice(-2000) };
}

// Run a docker/podman command inside the sandbox using the verified root+chroot
// invocation. `dockerArgs` is the part AFTER `podman` (e.g. `run --rm alpine echo hi`).
// Returns { exitCode, output }.
async function dockerRun(id, dockerArgs, { timeout = 280 } = {}) {
  const cmd = `sudo BUILDAH_ISOLATION=chroot podman --cgroup-manager=cgroupfs ${dockerArgs}`;
  return exec(id, cmd, { timeout });
}

// ── 🔴 LIVE preview URL (the RELIABLE live-screen path) ──────────────────────
// Daytona exposes ANY port a sandbox is listening on as a public HTTPS preview
// URL — no port declaration at create time, no tunnel setup. We use this to make
// the in-sandbox noVNC server (port 6080) reachable from the mobile APK as a
// plain WebView, which is FAR more reliable on mobile/proxy networks than the
// base64-JPEG-over-SSE frame pump.
//
//   GET /api/sandbox/{id}/ports/{port}/preview-url
//     → { url, token, legacyProxyUrl? }
//
// We return a "signed" URL with the token embedded as a query param so the
// WebView needs no custom headers, plus noVNC auto-connect/scale params so the
// remote desktop fills the screen and connects without a click. Best-effort:
// returns null on any failure so callers degrade to the frame pump.
const _previewCache = new Map(); // `${id}:${port}` -> { url, token, ts }
const _PREVIEW_TTL_MS = 5 * 60 * 1000;

async function getPreviewUrl(id, port = 6080, { novnc = true } = {}) {
  if (!id) return null;
  const cacheKey = `${id}:${port}`;
  const cached = _previewCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < _PREVIEW_TTL_MS) {
    return _decoratePreview(cached.url, cached.token, novnc);
  }
  try {
    const data = await api('GET', `/sandbox/${id}/ports/${port}/preview-url`, { timeout: 30000 });
    const base = data && (data.url || data.previewUrl || data.legacyProxyUrl);
    const token = data && (data.token || data.previewToken || '');
    if (!base) return null;
    _previewCache.set(cacheKey, { url: String(base), token: String(token || ''), ts: Date.now() });
    return _decoratePreview(String(base), String(token || ''), novnc);
  } catch (_) {
    return null;
  }
}

// Build the final, click-free live URL. For noVNC we point at /vnc.html with
// autoconnect + scaling so the agent's desktop fills the viewer immediately,
// and embed the preview token so no auth header is needed in a WebView.
function _decoratePreview(base, token, novnc) {
  let u = String(base).replace(/\/+$/, '');
  if (novnc) u += '/vnc.html';
  const params = [];
  if (novnc) {
    params.push('autoconnect=true', 'resize=scale', 'reconnect=true', 'reconnect_delay=2000', 'show_dot=true');
  }
  if (token) params.push('DAYTONA_SANDBOX_AUTH_KEY=' + encodeURIComponent(token));
  if (params.length) u += (u.includes('?') ? '&' : '?') + params.join('&');
  return { url: u, token: token || '' };
}

module.exports = {
  enabled, enabledAsync, WORKDIR,
  // Exported for contract tests and diagnostics; callers should use exec/file APIs.
  toolboxBase,
  createSandbox, deleteSandbox,
  getSandboxState, startSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, getOrgId, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
  getPreviewUrl,
};
