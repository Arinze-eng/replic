// ─────────────────────────────────────────────────────────────────────────────
// hopx.js — HopX Sandbox REST client (cloud micro-VM agent backend).
//
// Gives the WormGPT Agent a REAL, isolated Linux computer per task — exactly the
// way Daytona/Runloop do. A HopX sandbox is a FULL micro-VM (Ubuntu 22.04, its
// OWN kernel 5.10, root user with ALL Linux capabilities incl. CAP_SYS_ADMIN)
// with python3, node, git, curl, pip, npm, apt, full outbound internet, etc. The
// agent runs every shell command / script INSIDE this VM (not on the Render
// host), reads & writes files there, and we download produced files to deliver
// them back over Telegram / WhatsApp / the web UI.
//
// "Owns the computer": because the VM runs as REAL root with full caps and its
// own kernel, HopX supports genuine Docker-in-Docker (real dockerd) — see
// dockerSetup/dockerRun below — and long autonomous tasks (the in-sandbox agent
// worker runs there for minutes → hours via the file bridge).
//
// Auth model (two layers):
//   1. CONTROL PLANE — https://api.hopx.dev/v1/* — authenticated with the
//      ACCOUNT API key (`hopx_live_…`). Used to create / inspect / pause /
//      resume / kill sandboxes and to MINT per-sandbox VM tokens.
//   2. VM AGENT — https://<public_host>/* — authenticated with a short-lived
//      per-sandbox JWT (`auth_token`, ~24h). Used to execute code and do file
//      I/O inside that specific VM. We cache the JWT per sandbox id and refresh
//      it via POST /v1/sandboxes/{id}/token/refresh on demand / on 401.
//
// Admin can set the account key at runtime (admin panel → DB setting
// `hopx_api_key`). When unset, the engine falls back to another sandbox backend
// (Runloop/Daytona) or local host execution, so nothing breaks.
//
// REST contract (verified live against api.hopx.dev / *.vms.hopx.dev):
//   POST   /v1/sandboxes                              {template_name|template_id, timeout_seconds, internet_access, env_vars}
//                                                      → {id, public_host, auth_token, token_expires_at, status}
//   GET    /v1/sandboxes/{id}                          → {id, status, public_host, …}
//   POST   /v1/sandboxes/{id}/token/refresh            → {auth_token, token_expires_at}
//   POST   /v1/sandboxes/{id}/pause                    → pause   (disk preserved)
//   POST   /v1/sandboxes/{id}/resume                   → resume  (files intact)
//   DELETE /v1/sandboxes/{id}                          → destroy
//   POST   {public_host}/execute            {code, language:bash|python|node|go, timeout(≤300), working_dir}
//                                                      → {success, stdout, stderr, exit_code, execution_time}
//   POST   {public_host}/files/upload?path=…  multipart "file"   → {success, size}
//   GET    {public_host}/files/download?path=…                   → raw bytes (binary-safe)
//   GET    {public_host}/files/list?path=…                       → {files:[{name,path,size,is_directory,modified_time}]}
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const FormData = require('form-data');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

const BASE = (process.env.HOPX_API_URL || 'https://api.hopx.dev/v1').replace(/\/+$/, '');
// Template the VM is created from. `base` = Ubuntu 22.04 full userland (verified).
const TEMPLATE = (process.env.HOPX_TEMPLATE || 'base').trim();
// Where the agent works inside the VM. The VM agent's FILE API only permits
// paths under /workspace (and /tmp) — /root is REJECTED with "path not allowed".
// So we work under /workspace. We keep WORK = <home>/work so the sandboxAgent
// path math (home + "/work") lines up like the other backends; here home is
// /workspace, giving WORKDIR = /workspace/work (verified writable via files API).
const WORKDIR = process.env.HOPX_WORKDIR || '/workspace/work';
// Auto-kill the VM after this many seconds of TOTAL lifetime (a safety cap; the
// session layer keeps reusing/pausing it while active). Generous for long tasks.
const SANDBOX_TIMEOUT_SEC = parseInt(process.env.HOPX_TIMEOUT_SEC || '86400', 10); // 24h

// ── Runtime account-key resolution ─────────────────────────────────────────
// Admin can change the HopX account key at runtime (admin panel → DB setting).
// We read the runtime value first (short cache), then fall back to the env var.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() { return (process.env.HOPX_API_KEY || '').trim(); }

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
      const v = await db.getSetting('hopx_api_key');
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

// ── Per-sandbox VM token cache ──────────────────────────────────────────────
// The VM agent endpoints need a short-lived JWT scoped to ONE sandbox. We cache
// {token, expiresAt, host} per sandbox id and refresh shortly before expiry (or
// on a 401). The host is the VM agent base URL (public_host).
const _vmTok = new Map(); // id -> { token, expiresAt: ms, host }

function _setVmTok(id, token, expiresAtIso, host) {
  let exp = 0;
  try { exp = expiresAtIso ? new Date(expiresAtIso).getTime() : (Date.now() + 23 * 3600 * 1000); }
  catch (_) { exp = Date.now() + 23 * 3600 * 1000; }
  const cur = _vmTok.get(id) || {};
  _vmTok.set(id, { token, expiresAt: exp, host: host || cur.host });
}

// ── Control-plane HTTP ───────────────────────────────────────────────────────
async function cp(method, path, { json, query, timeout = 60000 } = {}) {
  const API_KEY = await getApiKey();
  if (!API_KEY) throw new Error('HOPX_API_KEY not set');
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(timeout) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HopX ${method} ${path} → ${resp.status}: ${t.slice(0, 240)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// Mint / refresh the VM JWT for a sandbox via the control plane. Stores it in the
// cache and returns { token, host }. `knownHost` lets callers seed the host when
// the refresh response omits public_host (it usually does).
async function refreshVmToken(id, knownHost) {
  const d = await cp('POST', `/sandboxes/${id}/token/refresh`, { timeout: 30000 });
  const token = d && d.auth_token;
  if (!token) throw new Error('HopX token refresh returned no auth_token');
  let host = (d && d.public_host) || knownHost || (_vmTok.get(id) || {}).host;
  if (!host) {
    // Last resort: look up the sandbox to learn its public_host.
    const info = await cp('GET', `/sandboxes/${id}`, { timeout: 20000 }).catch(() => null);
    host = info && (info.public_host || info.direct_url);
  }
  _setVmTok(id, token, d && d.token_expires_at, host);
  return { token, host };
}

// Get a valid VM token + host for a sandbox, refreshing if missing/near expiry.
async function vmAuth(id) {
  const cur = _vmTok.get(id);
  if (cur && cur.token && cur.host && cur.expiresAt - Date.now() > 5 * 60 * 1000) {
    return { token: cur.token, host: cur.host };
  }
  return refreshVmToken(id, cur && cur.host);
}

// ── VM-agent HTTP (per-sandbox JWT, auto-refresh on 401) ─────────────────────
async function vm(id, method, path, { json, query, raw, form, timeout = 120000, _retry = 0 } = {}) {
  const { token, host } = await vmAuth(id);
  if (!host) throw new Error('HopX sandbox has no VM host (public_host)');
  let url = host.replace(/\/+$/, '') + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
    Object.assign(opts.headers, form.getHeaders());
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    // Token expired / rotated → refresh once and retry. ONLY on 401 (auth), and
    // NOT when a multipart `form` was sent — its stream is already consumed, so a
    // retry would hang/send an empty body. (403 here means "path not allowed",
    // which a token refresh cannot fix — surface it immediately.)
    if (resp.status === 401 && !form && _retry < 1) {
      await refreshVmToken(id, host).catch(() => {});
      return vm(id, method, path, { json, query, raw, form, timeout, _retry: _retry + 1 });
    }
    const t = await resp.text().catch(() => '');
    throw new Error(`HopX VM ${method} ${path} → ${resp.status}: ${t.slice(0, 240)}`);
  }
  if (raw) return Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// Explicit connectivity test for the admin "Test" button (never throws).
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No HopX API key configured.' };
  const started = Date.now();
  try {
    const resp = await fetch(`${BASE}/sandboxes`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      let count = '';
      try {
        const d = await resp.json();
        const arr = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : null);
        if (arr) count = ` (${arr.length} sandbox(es) listed)`;
      } catch (_) {}
      return { ok: true, status: resp.status, ms, message: `✅ Working — HopX API reachable${count} in ${ms}ms.` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ HopX returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized HopX API key (401/403).';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach HopX: ${e.message}` };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

// Create a sandbox (micro-VM) and wait until it is "running". HopX usually
// returns status:"running" immediately with a public_host + auth_token; we poll
// defensively otherwise. We seed the VM token cache from the create response so
// the first exec needs no extra round-trip.
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  if (!(await getApiKey())) throw new Error('HOPX_API_KEY not set');
  const body = {
    template_name: TEMPLATE,
    timeout_seconds: Number.isFinite(SANDBOX_TIMEOUT_SEC) ? SANDBOX_TIMEOUT_SEC : 86400,
    internet_access: true,
  };
  if (envVars && Object.keys(envVars).length) body.env_vars = envVars;

  const sb = await cp('POST', '/sandboxes', { json: body, timeout: 120000 });
  const id = sb && sb.id;
  if (!id) throw new Error('HopX create returned no sandbox id');
  const host = sb.public_host || sb.direct_url;
  if (sb.auth_token) _setVmTok(id, sb.auth_token, sb.token_expires_at, host);
  else if (host) _setVmTok(id, '', null, host); // host known, token minted on first use

  // Poll until running if not already.
  let state = sb.status;
  if (state && state !== 'running') {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const cur = await cp('GET', `/sandboxes/${id}`, { timeout: 30000 }).catch(() => null);
      if (cur && cur.status) state = cur.status;
      if (cur && (cur.public_host || cur.direct_url)) _setVmTok(id, (_vmTok.get(id) || {}).token || '', null, cur.public_host || cur.direct_url);
      if (state === 'running') break;
      if (state === 'error' || state === 'failed' || state === 'stopped' || state === 'killed') {
        throw new Error(`HopX sandbox entered state "${state}"`);
      }
    }
    if (state && state !== 'running') throw new Error(`HopX sandbox not ready (last state "${state}")`);
  }

  // Ensure the working directory exists (the VM agent may need a moment after
  // "running" before /execute is reachable, so retry a few times).
  for (let i = 0; i < 6; i++) {
    const r = await exec(id, `mkdir -p ${WORKDIR} && echo READY`).catch(() => null);
    if (r && /READY/.test(r.output || '')) return id;
    await new Promise(r => setTimeout(r, 2000));
  }
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try { await cp('DELETE', `/sandboxes/${id}`, { timeout: 60000 }); }
  catch (e) { /* best-effort cleanup */ }
  _vmTok.delete(id);
}

// Return the current lifecycle state of a sandbox ("running", "paused",
// "stopped", …) or null if it no longer exists / is unreachable. Keeps the VM
// host cache warm as a side effect.
async function getSandboxState(id) {
  if (!id) return null;
  try {
    const cur = await cp('GET', `/sandboxes/${id}`, { timeout: 20000 });
    if (cur && (cur.public_host || cur.direct_url)) {
      const c = _vmTok.get(id) || {};
      _setVmTok(id, c.token || '', null, cur.public_host || cur.direct_url);
    }
    return (cur && cur.status) || null;
  } catch (_) { return null; }
}

// Resume a paused sandbox and wait until it is "running" again. HopX pause KEEPS
// the disk, so a paused sandbox still has all the user's files — we wake it and
// refresh its VM token (which the resume invalidates).
async function startSandbox(id) {
  if (!id) return false;
  try { await cp('POST', `/sandboxes/${id}/resume`, { timeout: 120000 }); } catch (_) {}
  for (let i = 0; i < 40; i++) {
    const state = await getSandboxState(id);
    if (state === 'running') {
      // Refresh the VM token (resume rotates it) and confirm exec is reachable.
      await refreshVmToken(id).catch(() => {});
      for (let j = 0; j < 6; j++) {
        const r = await exec(id, 'echo READY').catch(() => null);
        if (r && /READY/.test(r.output || '')) return true;
        await new Promise(r => setTimeout(r, 2000));
      }
      return true;
    }
    if (state === 'error' || state === 'failed' || state === 'killed' || state === 'stopped' || state === null) return false;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// Pause a running sandbox (cost-saving; disk preserved). Best-effort.
async function pauseSandbox(id) {
  if (!id) return false;
  try { await cp('POST', `/sandboxes/${id}/pause`, { timeout: 60000 }); return true; }
  catch (_) { return false; }
}
// Alias used by some callers (parity with runloop.suspendSandbox).
const suspendSandbox = pauseSandbox;

// ── Persistent session → sandbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME sandbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `hopx_session:<sessionKey>`.
const SESSION_PREFIX = 'hopx_session:';
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
      // Make sure we hold a usable VM token before reusing.
      await vmAuth(existing).catch(() => {});
      return { id: existing, reused: true };
    }
    if (state === 'paused' || state === 'pausing' || state === 'resuming' || state === 'suspended') {
      const ok = await startSandbox(existing);
      if (ok) return { id: existing, reused: true };
    }
    // Dead/stopped/killed/unreachable → forget it and fall through to create.
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

// Run a shell command inside the VM. Returns { exitCode, output } — output is
// stdout+stderr merged, matching the daytona/runloop contract the engine
// expects. We embed `cd <dir> &&` into the command (like the other backends)
// instead of relying on working_dir, for identical behaviour.
//
// HopX /execute caps a SINGLE sync call at 300s. For longer commands we
// transparently fall back to a BACKGROUND process and poll it to completion, so
// callers can pass any timeout (long installs, builds, pentests, etc.).
async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const full = cwd ? `cd ${shquote(cwd)} 2>/dev/null; ${command}` : command;
  if (timeout <= 290) {
    const data = await vm(id, 'POST', '/execute', {
      json: { code: full, language: 'bash', timeout: Math.max(5, Math.min(300, timeout)) },
      timeout: (timeout + 30) * 1000,
    });
    const out = [data.stdout || '', data.stderr || ''].filter(Boolean).join('');
    return { exitCode: typeof data.exit_code === 'number' ? data.exit_code : (data.success ? 0 : 1), output: out };
  }
  return execLong(id, full, timeout);
}

// Long-running exec for commands that may exceed the 300s sync ceiling. The
// background process API does NOT return captured stdout in its process list,
// so we instead run the command DETACHED (setsid + nohup) with its combined
// output redirected to a per-call log file, an exit-code marker file at the end,
// then POLL the marker and finally READ the log via the file API. This reliably
// captures full output for long installs / builds / pentests. Returns
// { exitCode, output }. Output dir is under /workspace (the file API's allowed
// path) so we can download the log.
async function execLong(id, command, timeout) {
  const tag = 'lt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const dir = '/workspace/.wormgpt_longexec';
  const logPath = `${dir}/${tag}.log`;
  const rcPath = `${dir}/${tag}.rc`;
  // Build a detached launcher. The inner command runs with bash -c; we capture
  // combined stdout+stderr to the log, then write the exit code to the rc file.
  const b64 = Buffer.from(command, 'utf-8').toString('base64');
  const launcher =
    `mkdir -p ${dir}; ` +
    `printf %s '${b64}' | base64 -d > ${dir}/${tag}.sh; ` +
    `setsid bash -c '{ bash ${dir}/${tag}.sh > ${logPath} 2>&1; echo $? > ${rcPath}; } </dev/null >/dev/null 2>&1 &'; ` +
    `echo LAUNCHED`;
  // Launch via a short sync exec (returns immediately).
  const lr = await vm(id, 'POST', '/execute', {
    json: { code: launcher, language: 'bash', timeout: 60 },
    timeout: 90000,
  }).catch(() => null);
  if (!lr || !/LAUNCHED/.test(((lr.stdout || '') + (lr.stderr || '')))) {
    // Could not launch detached → best-effort single capped sync run.
    const data = await vm(id, 'POST', '/execute', { json: { code: command, language: 'bash', timeout: 300 }, timeout: 330000 }).catch(() => null);
    if (!data) return { exitCode: 1, output: '[hopx] long-exec launch failed' };
    const out = [data.stdout || '', data.stderr || ''].filter(Boolean).join('');
    return { exitCode: typeof data.exit_code === 'number' ? data.exit_code : (data.success ? 0 : 1), output: out };
  }
  // Poll for the rc marker (completion).
  const deadline = Date.now() + (timeout + 60) * 1000;
  let exitCode = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const chk = await vm(id, 'POST', '/execute', {
      json: { code: `test -f ${rcPath} && cat ${rcPath} || echo __RUNNING__`, language: 'bash', timeout: 30 },
      timeout: 45000,
    }).catch(() => null);
    const body = chk ? ((chk.stdout || '') + (chk.stderr || '')).trim() : '';
    if (body && !body.includes('__RUNNING__')) {
      const n = parseInt(body, 10);
      exitCode = Number.isFinite(n) ? n : 0;
      break;
    }
  }
  // Read the full log via the file API (binary-safe → utf-8).
  let output = '';
  try {
    const buf = await downloadFile(id, logPath);
    output = buf.toString('utf-8');
  } catch (_) {
    // Fallback: cat the log via exec (may be truncated by the 12k caller cap).
    const cat = await vm(id, 'POST', '/execute', { json: { code: `cat ${logPath} 2>/dev/null`, language: 'bash', timeout: 60 }, timeout: 90000 }).catch(() => null);
    output = cat ? ((cat.stdout || '') + (cat.stderr || '')) : '';
  }
  // Cleanup the temp files (best-effort).
  vm(id, 'POST', '/execute', { json: { code: `rm -f ${dir}/${tag}.sh ${logPath} ${rcPath}`, language: 'bash', timeout: 20 }, timeout: 30000 }).catch(() => {});
  return { exitCode: exitCode == null ? 0 : exitCode, output };
}

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations ───────────────────────────────────────────────────────────

// Upload arbitrary bytes to destPath inside the VM (multipart "file"; the dest
// is given as a ?path= query). Binary-safe (verified byte-identical round-trip).
async function uploadFile(id, destPath, buffer, filename = 'file') {
  // Ensure parent dir exists (the upload endpoint won't mkdir -p for deep paths).
  const dir = posixDirname(destPath);
  if (dir && dir !== '/' && dir !== '.') {
    await exec(id, `mkdir -p ${shquote(dir)}`, { cwd: null, timeout: 30 }).catch(() => {});
  }
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'file' });
  await vm(id, 'POST', '/files/upload', { form, query: { path: destPath }, timeout: 180000 });
  return destPath;
}

// Download a file from the VM as raw bytes (GET /files/download?path=…).
async function downloadFile(id, srcPath) {
  return vm(id, 'GET', '/files/download', { query: { path: srcPath }, raw: true, timeout: 180000 });
}

// List files in a directory → normalized [{name,size,isDir,modTime}] (same shape
// daytona/runloop return).
async function listFiles(id, dir = WORKDIR) {
  const data = await vm(id, 'GET', '/files/list', { query: { path: dir }, timeout: 30000 }).catch(() => null);
  const arr = (data && (data.files || data.data)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(f => ({
    name: f.name,
    size: parseInt(f.size, 10) || 0,
    isDir: !!(f.is_directory || f.isDir || f.is_dir),
    modTime: f.modified_time ? (Date.parse(f.modified_time) || 0) : 0,
  })).filter(f => f.name && f.name !== '.' && f.name !== '..');
}

function posixDirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// HopX sandboxes are REAL micro-VMs: root + ALL Linux capabilities (incl.
// CAP_SYS_ADMIN) + their own kernel with overlayfs & cgroup v2. So unlike the
// unprivileged-container backends (Daytona/Runloop, which need a rootless
// podman+chroot+vfs workaround), HopX runs the GENUINE Docker engine (dockerd).
//
// The micro-VM kernel ships WITHOUT the netfilter modules Docker uses for its
// default bridge NAT (xt_addrtype / nat / raw tables), so we start dockerd with
// `--iptables=false --bridge=none` (overlayfs storage, which the kernel DOES
// support). Containers then run with HOST networking, giving them full outbound
// internet (verified: apk/apt installs + HTTPS from inside a container work).
//
// `dockerSetup(id)` is idempotent (sentinel file + daemon liveness check) and
// installs Docker once via get.docker.com, then ensures dockerd is up. A `docker`
// command is the real Docker CLI. Returns { ok, version, log }.
const DOCKER_SETUP_SENTINEL = '/root/.dind_ready';

async function dockerSetup(id, { onStep } = {}) {
  if (!id) throw new Error('dockerSetup: no sandbox id');
  // Fast path: docker installed AND daemon already responding?
  const probe = await exec(
    id,
    `command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && echo UP || echo DOWN`,
    { cwd: null, timeout: 40 }
  ).catch(() => null);
  if (probe && /UP/.test(probe.output || '')) {
    const v = await exec(id, 'docker --version 2>/dev/null', { cwd: null, timeout: 30 }).catch(() => null);
    return { ok: true, version: (v && v.output || '').trim(), log: 'already running' };
  }
  if (onStep) onStep('🐳 setting up Docker-in-Docker (real dockerd on a privileged micro-VM)…');

  // One script: install Docker if missing, then (re)start dockerd with the
  // kernel-compatible flags and wait for it to come up. Generous timeout — the
  // first install pulls packages (exec() auto-uses the background API > 290s).
  const setup = `
set +e
export DEBIAN_FRONTEND=noninteractive
if ! command -v dockerd >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh > /var/log/dind_install.log 2>&1
fi
# (Re)start dockerd if not already responding. The micro-VM kernel lacks the
# netfilter modules for bridge NAT, so disable iptables + the default bridge and
# use overlayfs storage; containers use --network=host for egress.
if ! docker info >/dev/null 2>&1; then
  pkill dockerd 2>/dev/null; sleep 2
  nohup dockerd --iptables=false --ip6tables=false --bridge=none --storage-driver=overlay2 > /var/log/dockerd.log 2>&1 &
  for i in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi
if docker info >/dev/null 2>&1; then
  touch ${DOCKER_SETUP_SENTINEL}
  echo "DIND_SETUP_DONE"
  docker --version
else
  echo "DIND_SETUP_FAILED"
  tail -n 8 /var/log/dockerd.log 2>/dev/null
fi
`;
  const r = await exec(id, setup, { cwd: null, timeout: 420 });
  const out = r.output || '';
  const ok = /DIND_SETUP_DONE/.test(out);
  const vm = out.match(/Docker version [^\n]+/i);
  if (onStep) onStep(ok ? '🐳 Docker-in-Docker ready.' : '⚠️ Docker setup may have failed — see log.');
  return { ok, version: vm ? vm[0] : '', log: out.slice(-2000) };
}

// Run a docker command inside the VM. `dockerArgs` is the part AFTER `docker`
// (e.g. `run --rm alpine echo hi`). For `run`/`create` we auto-inject
// `--network=host` (unless the caller already set a --network) so containers get
// outbound internet on the netfilter-light micro-VM kernel. Returns { exitCode, output }.
async function dockerRun(id, dockerArgs, { timeout = 300 } = {}) {
  let args = String(dockerArgs || '').trim();
  if (/^(run|create)\b/.test(args) && !/--network[ =]/.test(args) && !/--net[ =]/.test(args)) {
    args = args.replace(/^(run|create)\b/, `$1 --network=host`);
  }
  return exec(id, `docker ${args}`, { cwd: null, timeout });
}

// ── 💓 Keepalive ─────────────────────────────────────────────────────────────
// Called periodically during a long task so the VM isn't reclaimed mid-flight.
// HopX has a generous 24h cap, so this is mainly a liveness/self-heal check:
// confirm the VM is still running (refresh its token) and resume it if it
// slipped into a paused state. Best-effort — never throws.
async function keepAlive(id) {
  if (!id) return false;
  try {
    const state = await getSandboxState(id);
    if (state === 'running') { await vmAuth(id).catch(() => {}); return true; }
    if (state === 'paused' || state === 'pausing' || state === 'suspended' || state === 'resuming') return await startSandbox(id);
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
  refreshVmToken,
  dockerSetup, dockerRun,
  keepAlive,
};
