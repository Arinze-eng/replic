// sandboxPool.js — ONE unified sandbox facade for the whole app.
//
// WHY: debate.js used to `require('./daytona')` directly, so the Mixture-of-
// Experts panel could ONLY verify code on Daytona. Meanwhile the main agent
// (agentEngine.js) already had a robust admin-switchable cascade
// HopX → Runloop → Daytona → local. That mismatch meant the MoE panel often had
// "no sandbox" even when a backend was perfectly healthy on another provider —
// the experts then "agreed" on un-verified prose. This module closes that gap.
//
// It exposes a single, backend-agnostic surface that every caller (debate,
// bots, routes) can share:
//
//   await sandboxPool.acquire(sessionKey)   -> { id, backend, label, reused } | null
//   await sandboxPool.run(handle, code, opts)-> { code, output, ok, lang, backend }
//   sandboxPool.status()                     -> { hopx, runloop, daytona, local }
//
// SELECTION CONTRACT (mirrors agentEngine.resolveBackendCascade):
//   • SANDBOX_BACKEND=<name>  → use ONLY that backend (honours an admin switch).
//   • SANDBOX_BACKEND=auto    → try HopX → Runloop → Daytona, first healthy wins.
//   • If every remote backend is down we DON'T pretend — acquire() returns null
//     and the caller decides (debate falls back to reason-only, never a fake OK).
//
// CROSS-PLATFORM: language is auto-detected (python3 / node / shell) and every
// command is wrapped so it (a) never hangs forever (timeout) and (b) caps its
// output, so a runaway expert script can't wedge Render.

let hopx = null, runloop = null, daytona = null, novita = null, codesandbox = null, tensorlake = null, githubactions = null, upstashbox = null;
try { hopx = require('./hopx'); } catch (_) {}
try { runloop = require('./runloop'); } catch (_) {}
try { daytona = require('./daytona'); } catch (_) {}
try { novita = require('./novitaSandbox'); } catch (_) {}
try { codesandbox = require('./codesandbox'); } catch (_) {}
try { tensorlake = require('./tensorlake'); } catch (_) {}
try { githubactions = require('./githubActions'); } catch (_) {}
try { upstashbox = require('./upstashBox'); } catch (_) {}

const BACKENDS = { codesandbox, hopx, runloop, daytona, novita, tensorlake, githubactions, upstashbox };
const ORDER = ['codesandbox', 'novita', 'upstashbox', 'tensorlake', 'runloop', 'daytona', 'hopx', 'githubactions'];

let _db = null;
try { _db = require('../db'); } catch (_) { _db = null; }

function selectedName() {
  return (process.env.SANDBOX_BACKEND || 'auto').trim().toLowerCase();
}

// Admin DB setting (sandbox_backend) overrides the env, exactly like the agent.
async function resolveSelection() {
  let sel = '';
  try { if (_db && _db.getSetting) { const v = await _db.getSetting('sandbox_backend'); if (v && v.trim()) sel = v.trim().toLowerCase(); } } catch (_) {}
  if (!sel) sel = selectedName();
  if (sel !== 'auto' && !BACKENDS[sel]) sel = 'auto';
  return sel;
}

function labelOf(name) {
  return ({ codesandbox: 'CodeSandbox', hopx: 'HopX', runloop: 'Runloop', daytona: 'Daytona', novita: 'Novita', upstashbox: 'Upstash Box', tensorlake: 'Tensorlake', githubactions: 'GitHub Actions' })[name] || name;
}

async function isHealthy(mod) {
  if (!mod) return false;
  try {
    if (mod.enabledAsync) return !!(await mod.enabledAsync());
    if (mod.enabled) return !!mod.enabled();
  } catch (_) {}
  return false;
}

// The ordered list of healthy backends to try for THIS acquire().
async function cascade() {
  const sel = await resolveSelection();
  const names = sel === 'auto' ? ORDER.slice() : [sel];
  const out = [];
  for (const n of names) {
    const mod = BACKENDS[n];
    if (mod && (await isHealthy(mod))) out.push({ name: n, mod });
  }
  return out;
}

// Snapshot of which backends are currently usable (for /status & logging).
async function status() {
  const s = {};
  for (const n of ORDER) s[n] = await isHealthy(BACKENDS[n]);
  s.local = true; // host fallback is always there for the agent (not for MoE verify)
  return s;
}

const PROVISION_MS = parseInt(process.env.SANDBOX_PROVISION_TIMEOUT_MS || '60000', 10);
function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); if (t.unref) t.unref(); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/**
 * Acquire a sandbox for a session, trying each healthy backend in order.
 * Returns a handle { id, backend, label, reused } or null when none is available.
 * The handle is what you pass to run().
 */
async function acquire(sessionKey) {
  const key = sessionKey || `moe:${Date.now()}`;
  const tried = await cascade();
  for (const { name, mod } of tried) {
    try {
      const r = await withTimeout(
        mod.getOrCreateSessionSandbox(key, {}),
        PROVISION_MS,
        `${labelOf(name)} provisioning`,
      );
      const id = (r && (r.id || r)) || null;
      if (id) return { id, backend: name, label: labelOf(name), reused: !!(r && r.reused), mod };
    } catch (_) { /* try next backend */ }
  }
  return null;
}

// Heuristic language pick so an expert can emit Python, Node, or shell freely.
function detectLang(code) {
  const c = String(code || '');
  if (/^\s*(ls|cat|echo|cd|pwd|grep|sed|awk|curl|wget|chmod|mkdir|rm |cp |mv |apt|pip |pip3 |npm |npx |node |python3? |bash |sh )/m.test(c)
      && !/\b(def |import |console\.log|require\()/.test(c)) return 'shell';
  if (/\b(console\.log|require\(|=>|const |let |document\.)\b/.test(c) && !/\b(def |print\(|import )\b/.test(c)) return 'node';
  if (/\b(print\(|import |def |range\(|len\(|for .* in )\b/.test(c)) return 'python';
  return 'shell';
}

function wrapCommand(code, lang) {
  const tail = ' 2>&1 | head -c 6000';
  if (lang === 'python') {
    const b64 = Buffer.from(String(code), 'utf-8').toString('base64');
    return `python3 -c "import base64;exec(base64.b64decode('${b64}').decode())"${tail}`;
  }
  if (lang === 'node') {
    const b64 = Buffer.from(String(code), 'utf-8').toString('base64');
    return `node -e "eval(Buffer.from('${b64}','base64').toString())"${tail}`;
  }
  return `${code}${tail}`;
}

/**
 * Run code in a previously-acquired sandbox handle. Backend-agnostic.
 * @param handle  the object returned by acquire()
 * @param code    raw code/command string
 * @param opts    { lang?: 'python'|'node'|'shell', timeout?: seconds }
 * @returns { code, output, ok, lang, backend } or null when handle/backend invalid
 */
async function run(handle, code, opts = {}) {
  if (!handle || !handle.id || !handle.mod) return null;
  const lang = opts.lang || detectLang(code);
  const cmd = wrapCommand(code, lang);
  const timeout = opts.timeout || 60;
  try {
    const res = await withTimeout(
      handle.mod.exec(handle.id, cmd, { timeout }),
      (timeout + 10) * 1000,
      `${handle.label} exec`,
    );
    const out = (res && (res.result || res.stdout || res.output)) || '';
    return { code, output: String(out).slice(0, 6000), ok: true, lang, backend: handle.backend };
  } catch (e) {
    return { code, output: `(sandbox error on ${handle.label}: ${e.message})`, ok: false, lang, backend: handle.backend };
  }
}

module.exports = { acquire, run, status, cascade, detectLang, labelOf, BACKENDS, ORDER };
