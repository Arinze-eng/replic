// ─────────────────────────────────────────────────────────────────────────────
// sandboxBrain.js — UNIFIED long-running sandbox fallback for the Capy head.
//
// WHY THIS EXISTS
// ───────────────
// The project already has TWO independent "owns-the-computer" runtimes:
//
//   1. Capy.ai  (services/capy.js)        — runs each task in CAPY'S cloud
//      sandbox, polls up to 15 min, harvests deliverable files. Capy is the
//      configured HEAD (capy_head=1 / CAPY_HEAD=1): every task hits it FIRST.
//
//   2. Self-hosted sandboxes (services/sandboxAgent.js) — run agent_worker/
//      agent.py INSIDE the project's OWN sandbox providers (HopX → Runloop →
//      Daytona cascade), poll for minutes → hours, and return files too.
//
// Until now those two were SEPARATE: when the Capy head failed / timed out /
// came back empty, the brain fell straight back to the SYNCHRONOUS chat chain
// (Sakana → HotBot → Gemini → Cloudflare) — which CANNOT run long or produce
// files. So if Capy (or Render's gateway in front of it) hiccupped, the
// long-running "produce a file" capability was lost.
//
// This module CLOSES that gap exactly as the integration spec asks:
//
//   > "all request hit it [Capy] first then it polls in sandbox until files
//      comes so render alone won't stop it … integrate it to all sandbox
//      (Daytona, hopx etc.)"
//
// So the unified flow becomes:
//
//        ┌──────────── task ────────────┐
//        ▼                              │
//   Capy.ai sandbox (head, 15-min poll) │   ← services/capy.js (unchanged)
//        │  fail / timeout / empty      │
//        ▼                              │
//   SELF-HOSTED sandbox agent ──────────┘   ← THIS module → sandboxAgent.js
//   (HopX → Runloop → Daytona, polls until files come)
//        │  no sandbox configured / all failed
//        ▼
//   synchronous brain chain (Sakana → HotBot → Gemini → Cloudflare)
//
// The self-hosted layer ALSO long-polls and returns files, so "Render alone
// won't stop it": even if Capy is down, the very same task is completed inside
// Daytona/HopX/Runloop and the file is delivered.
//
// SAFETY: this module NEVER throws to its caller for an operational failure —
// it returns null so the caller transparently falls through to the next stage.
// The existing enterprise behaviour is therefore UNCHANGED on the happy path
// (Capy succeeds) and only ADDS a resilient extra layer on the failure path.
//
// CONFIG (runtime DB → env), all admin-settable in the panel:
//   capy_sandbox_fallback / CAPY_SANDBOX_FALLBACK   on/off   (default ON)
//   sandbox_backend        / SANDBOX_BACKEND        which providers to use
//   agent_in_sandbox       / AGENT_IN_SANDBOX       owns-the-computer master switch
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');

let _db = null;
function db() {
  if (_db === null) {
    try { _db = require('../db'); } catch (_) { _db = false; }
  }
  return _db || null;
}

// Lazily required to avoid any require-cycle at module-load time
// (sandboxAgent → agentEngine → … can be heavy).
let _sandboxAgent = null;
function sandboxAgent() {
  if (_sandboxAgent === null) {
    try { _sandboxAgent = require('./sandboxAgent'); } catch (_) { _sandboxAgent = false; }
  }
  return _sandboxAgent || null;
}

let _sandboxPool = null;
function sandboxPool() {
  if (_sandboxPool === null) {
    try { _sandboxPool = require('./sandboxPool'); } catch (_) { _sandboxPool = false; }
  }
  return _sandboxPool || null;
}

function envBool(v, dflt) {
  if (v == null || v === '') return dflt;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return dflt;
}

async function _setting(name) {
  const d = db();
  if (d && typeof d.getSetting === 'function') {
    try {
      const v = await d.getSetting(name);
      if (v != null && String(v).trim() !== '') return String(v).trim();
    } catch (_) { /* fall back to env */ }
  }
  return '';
}

/**
 * Is the self-hosted sandbox fallback enabled? DB setting → env → default ON.
 * Turning this OFF makes the Capy head fall back ONLY to the synchronous brain
 * chain (the pre-integration behaviour).
 */
async function isEnabled() {
  const v = await _setting('capy_sandbox_fallback');
  if (v) return envBool(v, true);
  return envBool(process.env.CAPY_SANDBOX_FALLBACK, true);
}

/**
 * Are ANY self-hosted sandbox providers (HopX / Runloop / Daytona) actually
 * configured & healthy right now? Used so we don't waste time entering the
 * fallback when there is no box to run in. Never throws.
 * Returns { any:boolean, status:{hopx,runloop,daytona,local} }.
 */
async function providerStatus() {
  const pool = sandboxPool();
  if (!pool || typeof pool.status !== 'function') return { any: false, status: {} };
  try {
    const status = await pool.status();
    const any = !!(status.codesandbox || status.hopx || status.runloop || status.daytona || status.novita);
    return { any, status };
  } catch (_) {
    return { any: false, status: {} };
  }
}

// Provide a stable per-task session key so the in-sandbox worker reuses a warm
// box across retries within one logical task, but doesn't collide between tasks.
function _sessionKeyFor(opts) {
  if (opts && opts.sessionKey) return String(opts.sessionKey);
  return 'capyfallback:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 8);
}

/**
 * Run a task through the SELF-HOSTED sandbox agent (HopX → Runloop → Daytona),
 * long-polling until it produces a final answer + any files. This is the exact
 * same engine the WormGPT web/bot agent uses, so it inherits all of its
 * cascading, stickiness, liveness-guard and file-delivery behaviour.
 *
 * @param {object} args
 *   - message {string}        the task / prompt (required)
 *   - attachments {Array}     optional [{ name, buffer, isImage? }]
 *   - history {Array}         optional [{ role, text }]
 *   - systemPrompt {string}   optional system prompt override
 * @param {object} opts
 *   - sessionKey {string}     optional sticky session key
 *   - onStep {function}       optional progress callback (msg)
 *   - onEvent {function}      optional structured event callback (type, data)
 *
 * @returns {Promise<null | {
 *   reply:string,
 *   files:Array<{ name, buffer, mime }>,
 *   brain:string,           // e.g. 'sandbox:daytona'
 *   steps:number,
 *   backend:string,
 * }>}  null = could not run here (caller should fall through).
 */
async function run(args = {}, opts = {}) {
  const message = String((args && args.message) || '').trim();
  if (!message && !(args.attachments && args.attachments.length)) return null;

  // Gate 1 — admin/env toggle.
  if (!(await isEnabled())) return null;

  const agent = sandboxAgent();
  if (!agent || typeof agent.runAgentInSandbox !== 'function') return null;

  // Gate 2 — owns-the-computer master switch + at least one configured backend.
  let onCpu = false;
  try { onCpu = await agent.enabled(); } catch (_) { onCpu = false; }
  if (!onCpu) return null;

  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const sessionKey = _sessionKeyFor(opts);

  onStep('🛟 Capy unavailable — completing this task inside your own sandbox (Daytona / HopX / Runloop)…');

  let result = null;
  try {
    result = await agent.runAgentInSandbox({
      task: message,
      attachments: Array.isArray(args.attachments) ? args.attachments : [],
      history: Array.isArray(args.history) ? args.history : [],
      systemPrompt: args.systemPrompt || null,
      sessionKey,
      onStep,
      onEvent,
    });
  } catch (e) {
    // The sandbox agent already cascades HopX→Runloop→Daytona internally; if it
    // STILL threw, every provider failed. Fall through to the brain chain.
    onStep('⚠️ self-hosted sandbox could not complete the task — falling back to the chat brain.');
    console.warn('[sandboxBrain] runAgentInSandbox failed:', (e && e.message) || e);
    return null;
  }

  if (!result) return null;

  // Materialise the produced files (the sandbox agent stages them on disk as
  // { path, name }); the Capy/brain contract returns { name, buffer, mime }.
  const files = [];
  for (const f of (result.files || [])) {
    try {
      if (f && f.path && fs.existsSync(f.path)) {
        const buffer = fs.readFileSync(f.path);
        files.push({ name: f.name || _basename(f.path), buffer, mime: _mimeFromName(f.name || f.path) });
      } else if (f && f.buffer && Buffer.isBuffer(f.buffer)) {
        files.push({ name: f.name || 'file', buffer: f.buffer, mime: _mimeFromName(f.name || 'file') });
      }
    } catch (_) { /* skip unreadable deliverable */ }
  }

  const reply = String(result.message || '').trim();

  // Nothing usable → let the caller fall through (mirrors capy.run's contract).
  if (!reply && !files.length) return null;

  const backend = result.backend || (result.brain && /sandbox/i.test(result.brain) ? result.brain : '') || 'sandbox';
  return {
    reply,
    files,
    brain: 'sandbox' + (result.backend ? (':' + String(result.backend).toLowerCase()) : ''),
    steps: result.steps || 0,
    backend,
    sandboxBrainModel: result.brain || null, // the LLM that actually wrote the answer inside the box
  };
}

function _basename(p) {
  return String(p || '').split(/[\\/]/).pop() || 'file';
}

function _mimeFromName(name) {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    yaml: 'application/x-yaml', yml: 'application/x-yaml', xml: 'application/xml',
    html: 'text/html', htm: 'text/html',
    zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip',
    rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
    apk: 'application/vnd.android.package-archive',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = {
  isEnabled,
  providerStatus,
  run,
};
