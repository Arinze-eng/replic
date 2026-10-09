// ─────────────────────────────────────────────────────────────────────────────
// tensorlake.js — Tensorlake Sandbox REST client (MicroVM "owns-the-computer").
//
// Gives the WormGPT Agent a REAL, isolated Linux MicroVM per session — exactly
// like HopX / Novita / Daytona / Runloop / CodeSandbox. A Tensorlake sandbox is
// a full Linux userland (x86_64, user `tl-user`, home /home/tl-user) with
// python3, node, git, curl, pip3, npm, apt-get + PASSWORDLESS sudo, so the agent
// installs and runs whatever it needs (Kali-slim recon tools, pip packages,
// disasm/dex/apk toolchains, etc.) INSIDE the box (not on the Render host).
//
// Auth model (ONE key, two planes — verified live):
//   1. CONTROL PLANE — https://api.tensorlake.ai/sandboxes/*  (Bearer <apiKey>)
//      Create / get / delete / snapshot / suspend / resume sandboxes and read
//      each sandbox's region-specific `sandbox_url`.
//   2. SANDBOX RUNTIME PROXY — https://<id>.sandbox.<region>.tensorlake.ai/api/v1/*
//      (SAME Bearer <apiKey>). Run processes, read/write/list files. The exact
//      runtime host is REGION-SPECIFIC and returned by create/get as
//      `sandbox_url` (e.g. https://<id>.sandbox.gcp-use4.tensorlake.ai), so we
//      cache it per sandbox id and NEVER hard-code the generic domain.
//
// Admin can set the key at runtime (admin panel → DB setting `tensorlake_api_key`,
// env fallback TENSORLAKE_API_KEY), so it flips on WITHOUT a redeploy.
//
// REST contract (verified live against api.tensorlake.ai):
//   POST   /sandboxes                          {timeout_secs, resources:{cpus,memory_mb}, name?, network}
//                                               → {sandbox_id, status, sandbox_url, ingress_endpoint}
//   GET    /sandboxes/{id}                      → {id, status, sandbox_url, ingress_endpoint, timeout_secs, …}
//   DELETE /sandboxes/{id}                      → terminate (idempotent)
//   POST   /sandboxes/{id}/suspend              → suspend a NAMED sandbox (snapshot + stop)
//   POST   /sandboxes/{id}/resume               → resume a NAMED sandbox (files intact)
//   POST   {sandbox_url}/api/v1/processes/run   {command,args,env,working_dir,timeout} → SSE event stream
//   GET    {sandbox_url}/api/v1/files?path=…    → raw bytes (binary-safe)
//   PUT    {sandbox_url}/api/v1/files?path=…    (octet-stream body) → 204
//   DELETE {sandbox_url}/api/v1/files?path=…    → 204
//   GET    {sandbox_url}/api/v1/files/list?path=… → {path, entries:[{name,is_dir,size,modified_at}]}
//
// ⚠️ FREE-PLAN RAM CAP: the platform default requests 2048 MB, which is REJECTED
//    with HTTP 400 "Per-sandbox RAM limit exceeded (max 1024 MB)" on free/
//    unverified projects. So we ALWAYS pass resources.memory_mb (default 1024).
//    Override via TENSORLAKE_MEMORY_MB for a higher committed plan.
//
// ⚠️ SUSPEND/RESUME needs a NAMED sandbox. Ephemeral (un-named) sandboxes can't
//    be suspended, so a session's box would be lost the moment it idles. We
//    therefore create NAMED sandboxes (name derived from the sessionKey) so the
//    chat's box survives across turns via suspend → resume (disk preserved).
//
// This module exposes the SAME interface shape as daytona.js / hopx.js /
// novitaSandbox.js so sandboxAgent.js + agentEngine.js + sandboxPool.js can swap
// between them with no other changes:
//   enabled, enabledAsync, WORKDIR,
//   createSandbox, deleteSandbox,
//   getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
//   getOrCreateSessionSandbox, endSession, getSessionSandboxId,
//   exec, uploadFile, downloadFile, listFiles,
//   getApiKey, invalidateKeyCache, testKey,
//   dockerSetup, dockerRun
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

// Control-plane base. All lifecycle calls go here with the account Bearer key.
const BASE = (process.env.TENSORLAKE_API_URL || 'https://api.tensorlake.ai').replace(/\/+$/, '');
// Where the agent works inside the sandbox. Home is /home/tl-user (verified),
// so WORK = <home>/work lines up with the sandboxAgent path math exactly like
// the other backends (home + "/work").
const WORKDIR = process.env.TENSORLAKE_WORKDIR || '/home/tl-user/work';
// Per-sandbox lifetime cap before Tensorlake auto-reclaims the box. `0` asks for
// the plan maximum (Free unverified 3600s/1h, Free verified 7200s/2h, On-Demand
// 86400s/24h). We default to 0 (max allowed) so long autonomous tasks aren't cut
// short; the session layer keeps suspending/resuming it while the chat is active.
const SANDBOX_TIMEOUT_SEC = parseInt(process.env.TENSORLAKE_TIMEOUT_SEC || '0', 10);
// RAM (MiB). MUST stay ≤ the plan cap (free = 1024) or create returns HTTP 400.
const MEMORY_MB = parseInt(process.env.TENSORLAKE_MEMORY_MB || '1024', 10);
const CPUS = parseFloat(process.env.TENSORLAKE_CPUS || '1');

// ── Runtime API-key resolution ──────────────────────────────────────────────
// Admin can change the key at runtime (admin panel → DB setting). We read the
// runtime value first (short cache), then fall back to the env var.
let _keyCache = { value: undefined, ts: 0 };
const KEY_TTL = 15000;

function envKey() { return (process.env.TENSORLAKE_API_KEY || '').trim(); }

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
      const v = await db.getSetting('tensorlake_api_key');
      if (v && v.trim()) runtime = v.trim();
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

// ── Per-sandbox runtime-URL cache ────────────────────────────────────────────
// The region-specific runtime proxy host (sandbox_url) is returned by create/
// get. We cache it per sandbox id so exec/file calls don't need a control-plane
// round-trip every time. Refreshed on 404/connection errors (a resumed sandbox
// can land on a different placement → new sandbox_url).
const _runtimeUrl = new Map(); // id -> https://<id>.sandbox.<region>.tensorlake.ai

function _setRuntimeUrl(id, url) { if (id && url) _runtimeUrl.set(String(id), String(url).replace(/\/+$/, '')); }
function _forget(id) { _runtimeUrl.delete(String(id)); }

// ── Control-plane HTTP ───────────────────────────────────────────────────────
async function cp(method, path, { json, query, timeout = 60000 } = {}) {
  const key = await getApiKey();
  if (!key) throw new Error('TENSORLAKE_API_KEY not set');
  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    const err = new Error(`Tensorlake ${method} ${path} → ${resp.status}: ${t.slice(0, 240)}`);
    err.status = resp.status;
    throw err;
  }
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  const txt = await resp.text();
  try { return JSON.parse(txt); } catch (_) { return txt; }
}

// Resolve (and cache) the runtime proxy URL for a sandbox id.
async function _resolveRuntimeUrl(id, { force = false } = {}) {
  if (!force) {
    const cached = _runtimeUrl.get(String(id));
    if (cached) return cached;
  }
  const info = await cp('GET', `/sandboxes/${encodeURIComponent(id)}`, { timeout: 30000 });
  const url = info && (info.sandbox_url || (info.ingress_endpoint && info.id
    ? `${String(info.ingress_endpoint).replace(/\/+$/, '')}`
    : null));
  if (!url) throw new Error('Tensorlake sandbox has no sandbox_url (runtime host)');
  _setRuntimeUrl(id, url);
  return _runtimeUrl.get(String(id));
}

// ── Sandbox-runtime HTTP (same Bearer key; auto-refresh URL on 404) ──────────
async function rt(id, method, path, { body, query, raw, contentType, timeout = 120000, _retry = 0 } = {}) {
  const key = await getApiKey();
  if (!key) throw new Error('TENSORLAKE_API_KEY not set');
  const base = await _resolveRuntimeUrl(id);
  let url = base + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const opts = { method, headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) };
  if (contentType) opts.headers['Content-Type'] = contentType;
  if (body !== undefined) opts.body = body;
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    // Placement may have moved (resume) → re-resolve the runtime URL once.
    if (_retry < 1) { _forget(id); await _resolveRuntimeUrl(id, { force: true }).catch(() => {}); return rt(id, method, path, { body, query, raw, contentType, timeout, _retry: _retry + 1 }); }
    throw e;
  }
  if (!resp.ok) {
    // A 404 on the runtime plane usually means the sandbox moved/was reclaimed —
    // re-resolve the URL once and retry (unless a one-shot body was sent).
    if (resp.status === 404 && _retry < 1 && body === undefined) {
      _forget(id);
      await _resolveRuntimeUrl(id, { force: true }).catch(() => {});
      return rt(id, method, path, { body, query, raw, contentType, timeout, _retry: _retry + 1 });
    }
    const t = await resp.text().catch(() => '');
    const err = new Error(`Tensorlake RT ${method} ${path} → ${resp.status}: ${t.slice(0, 240)}`);
    err.status = resp.status;
    throw err;
  }
  if (raw) return Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) return resp; // SSE — caller reads the stream
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

// ── Explicit connectivity test for the admin "Test" button (never throws) ─────
async function testKey(overrideKey) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No Tensorlake API key configured.' };
  const started = Date.now();
  try {
    // Listing sandboxes validates the key cheaply without provisioning anything.
    const resp = await fetch(`${BASE}/sandboxes?limit=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      let count = '';
      try {
        const d = await resp.json();
        const arr = Array.isArray(d) ? d : (d && Array.isArray(d.sandboxes) ? d.sandboxes : null);
        if (arr) count = ` (${arr.length} live sandbox(es) listed)`;
      } catch (_) {}
      return { ok: true, status: resp.status, ms, message: `✅ Working — Tensorlake Sandbox API reachable${count} in ${ms}ms.` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ Tensorlake returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized Tensorlake API key (401/403).';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach Tensorlake: ${e.message}` };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function posixDirname(p) { const s = String(p || ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); }

// Derive a stable, DNS-safe sandbox NAME from a session key (enables suspend/
// resume). Names must be short & lowercase-alnum; we hash the session key.
function _nameForSession(sessionKey) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1').update(String(sessionKey)).digest('hex').slice(0, 20);
  return `wormgpt-${h}`;
}

// Create a sandbox and wait until it is "running". Returns its id. When `name`
// is provided the sandbox is NAMED (supports suspend/resume); otherwise it is
// ephemeral. We seed the runtime-URL cache from the create response.
async function createSandbox({ envVars = {}, labels = {}, name = null } = {}) {
  if (!(await getApiKey())) throw new Error('TENSORLAKE_API_KEY not set');
  const body = {
    timeout_secs: Number.isFinite(SANDBOX_TIMEOUT_SEC) ? SANDBOX_TIMEOUT_SEC : 0,
    resources: { cpus: CPUS, memory_mb: MEMORY_MB },
    network: { allow_internet_access: true },
  };
  if (name) body.name = String(name);

  let sb;
  try {
    sb = await cp('POST', '/sandboxes', { json: body, timeout: 120000 });
  } catch (e) {
    // A named sandbox that already exists → reuse it by resolving its id. The
    // API returns 409 for a live duplicate, but a SUSPENDED sandbox with the
    // same name can surface as 400 ("already exists"/name conflict) — treat both
    // the same way so a session's box is resumed instead of erroring out.
    const conflict = name && (e.status === 409 || (e.status === 400 && /exist|conflict|name|in use/i.test(String(e.message || ''))));
    if (conflict) {
      const info = await cp('GET', `/sandboxes/${encodeURIComponent(name)}`, { timeout: 30000 }).catch(() => null);
      if (info && info.id) {
        if (info.sandbox_url) _setRuntimeUrl(info.id, info.sandbox_url);
        // Make sure it's running (resume if suspended/suspending/pending).
        if (info.status !== 'running') { await startSandbox(info.id).catch(() => {}); }
        await _ensureWorkdir(info.id).catch(() => {});
        return info.id;
      }
    }
    throw e;
  }
  const id = sb && sb.sandbox_id;
  if (!id) throw new Error('Tensorlake create returned no sandbox_id');
  if (sb.sandbox_url) _setRuntimeUrl(id, sb.sandbox_url);

  // Poll until running if not already.
  let state = sb.status;
  if (state && state !== 'running') {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const cur = await cp('GET', `/sandboxes/${encodeURIComponent(id)}`, { timeout: 30000 }).catch(() => null);
      if (cur && cur.status) state = cur.status;
      if (cur && cur.sandbox_url) _setRuntimeUrl(id, cur.sandbox_url);
      if (state === 'running') break;
      if (state === 'terminated') throw new Error('Tensorlake sandbox entered state "terminated"');
    }
    if (state && state !== 'running') throw new Error(`Tensorlake sandbox not ready (last state "${state}")`);
  }

  // Ensure the working dir exists (the runtime daemon may need a beat after
  // "running" before /processes is reachable, so retry a few times).
  for (let i = 0; i < 6; i++) {
    const r = await exec(id, `mkdir -p ${WORKDIR} && echo READY`).catch(() => null);
    if (r && /READY/.test(r.output || '')) return id;
    await new Promise(r => setTimeout(r, 2000));
  }
  return id;
}

async function _ensureWorkdir(id) {
  await exec(id, `mkdir -p ${WORKDIR} && echo READY`).catch(() => {});
}

async function deleteSandbox(id) {
  if (!id) return;
  try { await cp('DELETE', `/sandboxes/${encodeURIComponent(id)}`, { timeout: 60000 }); }
  catch (_) { /* best-effort cleanup (idempotent) */ }
  _forget(id);
}

// Return the current lifecycle state ("running"/"suspended"/"pending"/… ) or
// null if the sandbox no longer exists / is unreachable. Keeps the runtime-URL
// cache warm as a side effect.
async function getSandboxState(id) {
  if (!id) return null;
  try {
    const cur = await cp('GET', `/sandboxes/${encodeURIComponent(id)}`, { timeout: 20000 });
    if (cur && cur.sandbox_url) _setRuntimeUrl(id, cur.sandbox_url);
    return (cur && cur.status) || null;
  } catch (_) { return null; }
}

// Resume a suspended NAMED sandbox and wait until it is "running" again.
// Tensorlake suspend snapshots the disk, so a resumed sandbox keeps all files.
async function startSandbox(id) {
  if (!id) return false;
  // If the box is still mid-suspend, resume would 400 — wait for a terminal
  // suspend state (or running) before issuing resume.
  for (let i = 0; i < 20; i++) {
    const s = await getSandboxState(id);
    if (s === 'running') return true;                 // already up
    if (s === 'suspended' || s === null) break;        // ready to resume (or gone)
    if (s === 'terminated') return false;
    await new Promise(r => setTimeout(r, 1500));       // suspending/snapshotting/pending → wait
  }
  try { await cp('POST', `/sandboxes/${encodeURIComponent(id)}/resume`, { timeout: 120000 }); } catch (_) {}
  for (let i = 0; i < 40; i++) {
    const state = await getSandboxState(id);
    if (state === 'running') {
      // Re-resolve the runtime URL (a resumed box may move placement) and
      // confirm the exec channel is reachable.
      await _resolveRuntimeUrl(id, { force: true }).catch(() => {});
      for (let j = 0; j < 6; j++) {
        const r = await exec(id, 'echo READY').catch(() => null);
        if (r && /READY/.test(r.output || '')) return true;
        await new Promise(r => setTimeout(r, 2000));
      }
      return true;
    }
    if (state === 'terminated' || state === null) return false;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

// Suspend a running NAMED sandbox (cost-saving; disk preserved). Best-effort.
async function pauseSandbox(id) {
  if (!id) return false;
  try { await cp('POST', `/sandboxes/${encodeURIComponent(id)}/suspend`, { timeout: 60000 }); return true; }
  catch (_) { return false; }
}
// Alias used by some callers (parity with runloop.suspendSandbox).
const suspendSandbox = pauseSandbox;

// ── Persistent session → sandbox mapping ──────────────────────────────────────
// A "session" (e.g. a Telegram chat = "tg:<chatId>") keeps the SAME sandbox
// across turns so files/state persist. The mapping is stored in the settings
// table so it survives Render restarts. Key: `tensorlake_session:<sessionKey>`.
const SESSION_PREFIX = 'tensorlake_session:';
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
//   • If it is "suspended"/"suspending"/"pending"        → resume it (disk preserved).
//   • Otherwise (gone/terminated/unreachable)            → create a fresh one + remember it.
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
      return { id: existing, reused: true };
    }
    if (state === 'suspended' || state === 'suspending' || state === 'pending' || state === 'snapshotting') {
      const ok = await startSandbox(existing);
      if (ok) return { id: existing, reused: true };
    }
    // Dead/terminated/unreachable → forget it and fall through to create.
    _forget(existing);
    await _writeSessionId(sessionKey, '');
  }
  // Create a NAMED sandbox so this session supports suspend/resume across turns.
  const id = await createSandbox({ envVars, labels: { session: String(sessionKey), ...labels }, name: _nameForSession(sessionKey) });
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
// expects. We embed `cd <dir>` into the command (like the other backends) rather
// than relying on working_dir, so a missing dir is tolerated.
//
// Transport: POST /api/v1/processes/run streams captured output as Server-Sent
// Events (`data: {handle,pid}` / `data: {line,stream}` / `data: {exit_code}`),
// so we parse the stream to reconstruct combined output + the exit code. This is
// the SINGLE most important primitive — the whole "owns-the-computer" loop and
// the file-bridge poll every command through here.
async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const full = cwd ? `cd ${shquote(cwd)} 2>/dev/null; ${command}` : command;
  const stream = await rt(id, 'POST', '/api/v1/processes/run', {
    contentType: 'application/json',
    body: JSON.stringify({
      command: 'bash',
      args: ['-lc', full],
      // Give the process the full budget; +30s network headroom on our side.
      timeout: Math.max(5, timeout),
    }),
    timeout: (Math.max(5, timeout) + 30) * 1000,
  });

  // `stream` is a node-fetch Response with a readable body (text/event-stream).
  let exitCode = 0;
  const lines = [];
  const oomOrSignal = { oom: false, signal: null };
  await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = raw.replace(/\r$/, '').trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (_) { continue; }
        if (typeof ev.line === 'string') {
          lines.push(ev.line);
        } else if (ev.exit_code !== undefined || ev.signal !== undefined || ev.oom_killed !== undefined) {
          if (typeof ev.exit_code === 'number') exitCode = ev.exit_code;
          else if (ev.signal != null) { exitCode = 128 + (ev.signal || 0); oomOrSignal.signal = ev.signal; }
          if (ev.oom_killed) oomOrSignal.oom = true;
        }
      }
    };
    try {
      stream.body.on('data', onData);
      stream.body.on('end', resolve);
      stream.body.on('error', resolve);
    } catch (_) {
      // Fallback: if body isn't a stream (unexpected), resolve immediately.
      resolve();
    }
  });

  let output = lines.join('\n');
  if (oomOrSignal.oom) output += '\n[process OOM-killed]';
  return { exitCode: typeof exitCode === 'number' ? exitCode : 0, output };
}

// ── File operations ───────────────────────────────────────────────────────────

// Upload arbitrary bytes to destPath inside the sandbox (PUT raw octet-stream;
// the dest is given as a ?path= query). Binary-safe. We ensure the parent dir
// exists first (the write endpoint won't mkdir -p a deep path).
async function uploadFile(id, destPath, buffer, _filename = 'file') {
  const dir = posixDirname(destPath);
  if (dir && dir !== '/' && dir !== '.') {
    await exec(id, `mkdir -p ${shquote(dir)}`, { cwd: null, timeout: 30 }).catch(() => {});
  }
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await rt(id, 'PUT', '/api/v1/files', {
    query: { path: destPath },
    contentType: 'application/octet-stream',
    body: data,
    timeout: 180000,
  });
  return destPath;
}

// Download a file from the sandbox as raw bytes (GET /files?path=…).
async function downloadFile(id, srcPath) {
  return rt(id, 'GET', '/api/v1/files', { query: { path: srcPath }, raw: true, timeout: 180000 });
}

// List files in a directory → normalized [{name,size,isDir,modTime}] (same shape
// daytona/runloop/hopx return).
async function listFiles(id, dir = WORKDIR) {
  const data = await rt(id, 'GET', '/api/v1/files/list', { query: { path: dir }, timeout: 30000 }).catch(() => null);
  const arr = (data && (data.entries || data.files)) || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(f => ({
    name: f.name,
    size: parseInt(f.size, 10) || 0,
    isDir: !!(f.is_dir || f.is_directory || f.isDir),
    modTime: f.modified_at ? (Number(f.modified_at) || Date.parse(f.modified_at) || 0) : 0,
  })).filter(f => f.name && f.name !== '.' && f.name !== '..');
}

// ── Docker-in-Docker (container engine) setup ────────────────────────────────
// PARITY WITH novitaSandbox.js / daytona.js / runloop.js: give the agent a
// working `docker` command INSIDE a Tensorlake sandbox so "owns-the-computer"
// mode can BUILD and RUN containers. Tensorlake sandboxes run as an unprivileged
// user (tl-user + passwordless sudo, no CAP_SYS_ADMIN by default), so we use the
// SAME proven rootless-root recipe as Novita/Runloop: `sudo podman` with chroot
// isolation + the vfs storage driver + host namespaces + cgroups disabled, and a
// `docker` symlink → podman. Idempotent: a sentinel file marks completion.
const DOCKER_SETUP_SENTINEL = '/home/tl-user/.dind_ready';

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
touch ${DOCKER_SETUP_SENTINEL}
echo "DIND_SETUP_DONE"
podman --version
`;
  const r = await exec(id, setup, { cwd: null, timeout: 280 });
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
// Called periodically by sandboxAgent.js during a long task to keep the box
// from being reclaimed mid-flight (the "sandbox not found" bug). Tensorlake has
// no explicit "extend timeout" endpoint, so we (a) confirm the box is still
// running (re-resolving its runtime URL if placement moved), and (b) resume it
// if it somehow slipped into a suspended/pending state. This keeps the runtime
// channel warm and self-heals a transient placement change without ever losing
// the session. Best-effort — never throws.
async function keepAlive(id) {
  if (!id) return false;
  try {
    const state = await getSandboxState(id);
    if (state === 'running') {
      await _resolveRuntimeUrl(id).catch(() => {});
      return true;
    }
    if (state === 'suspended' || state === 'suspending' || state === 'pending' || state === 'snapshotting') {
      return await startSandbox(id);
    }
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
