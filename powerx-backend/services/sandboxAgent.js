// ─────────────────────────────────────────────────────────────────────────────
// sandboxAgent.js — Host-side controller for the IN-SANDBOX agent worker.
//
// This is the "agent owns the computer" runtime (option A): instead of running
// the plan→act→observe loop on the Render host, we deploy agent_worker/agent.py
// INTO the user's PERSISTENT sandbox and let it run there long-lived
// (minutes → hours), executing tools locally on that box. The host only:
//   1. provisions / reuses the persistent sandbox (Runloop OR Daytona),
//   2. uploads + (re)starts the worker process inside it,
//   3. drops the task into the worker's inbox,
//   4. streams the worker's status notes back via onStep,
//   5. downloads the final result + any deliverables.
//
// BACKEND-AGNOSTIC: the admin chooses the active sandbox (`sandbox_backend` DB
// setting → 'runloop' | 'daytona' | 'auto'). BOTH Runloop and Daytona "own the
// computer" identically — they expose the SAME interface (createSandbox, exec,
// uploadFile, downloadFile, getOrCreateSessionSandbox, dockerSetup/dockerRun …)
// so this controller works on either. Only the in-box paths differ per backend
// (Daytona user `daytona` → /home/daytona; Runloop user `user` → /home/user).
//
// The worker calls BACK to the host bridge endpoint (mounted in server.js at
// /api/agent-bridge) for the LLM brain and host-only tools (web_search, browse,
// image/doc generation, deploys…). The bridge is authenticated with a
// per-sandbox token so only the worker we started can use it.
//
// PUBLIC CONTRACT — identical to agentEngine.runAgent so callers are unchanged:
//   runAgentInSandbox({ task, attachments, history, onStep, sessionKey, systemPrompt })
//     → { message, files:[{path,name}], steps, workdir }
//
// SAFETY: this module NEVER throws to the caller for an in-sandbox failure — the
// caller (agentEngine.runAgent) catches and falls back to the host loop, so a
// live bot is never left dead.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const daytona = require('./daytona');
const runloop = require('./runloop');
const hopx = require('./hopx');
const novita = require('./novitaSandbox');
const upstashbox = require('./upstashBox');
const codesandbox = require('./codesandbox');
const tensorlake = require('./tensorlake');
const githubactions = require('./githubActions');
const localSandbox = require('./localSandbox');
// One-time "Kali slim" security toolchain bootstrap (pip-first, apt fallback,
// Debian contrib/non-free + Kali repo). Backend-agnostic; sentinel-guarded so it
// installs EXACTLY ONCE per sandbox disk. See services/kaliBootstrap.js.
const kaliBootstrap = require('./kaliBootstrap');

let _db = null;
try { _db = require('../db'); } catch (_) { /* optional */ }

// ── Active backend resolution ────────────────────────────────────────────────
// SIX sandboxes support "owns-the-computer" mode: LocalAlpine (on-machine),
// CodeSandbox, HopX, Runloop, Daytona & Novita. We honour the admin
// `sandbox_backend` setting, then fall back to whichever is actually configured.
// Returns { mod, label, home } or null when none is on. `home` is the in-box
// home dir; the worker paths live under `${home}/work`, which lines up with each
// backend's WORKDIR (LocalAlpine /root/work, HopX /workspace/work, Runloop
// /home/user/work, Daytona /home/daytona/work, Novita /home/user/work,
// CodeSandbox /root/work — CodeSandbox & LocalAlpine run as REAL root).
const BACKENDS = {
  // 🖥️ LOCAL Alpine Linux on the user's OWN machine (desktop .exe/.deb) — NO
  // cloud. Runs the SAME agent worker + FUSION brain, just executes the shell
  // in a local Alpine box (docker/podman/wsl/proot/chroot). Full root/sudo,
  // preinstalled coding toolchain. Enabled via LOCAL_SANDBOX=1 (desktop) or the
  // `local_sandbox_enabled` DB setting; OFF by default so cloud deploys keep
  // using the cloud backends below.
  localsandbox: { mod: localSandbox, label: 'Local Alpine', home: '/root' },
  codesandbox: { mod: codesandbox, label: 'CodeSandbox', home: '/root' },
  hopx:    { mod: hopx,    label: 'HopX',    home: '/workspace' },
  runloop: { mod: runloop, label: 'Runloop', home: '/home/user' },
  daytona: { mod: daytona, label: 'Daytona', home: '/home/daytona' },
  novita:  { mod: novita,  label: 'Novita',  home: '/home/user' },
  // 🗳️ Upstash Box — full Linux durable execution environment with its own
  // filesystem, shell, and network stack. Supports Debian, Node, Python, Go
  // runtimes. State persists across runs; billable per active CPU time.
  // Uses the Upstash Box REST API. Home is /workspace/home/crabbox.
  upstashbox: { mod: upstashbox, label: 'Upstash Box', home: '/workspace/home' },
  // 🧊 Tensorlake MicroVM — user `tl-user`, home /home/tl-user, passwordless
  // sudo + apt + pip. Named sandboxes suspend/resume so a chat's box (and every
  // installed tool) persists across turns.
  tensorlake: { mod: tensorlake, label: 'Tensorlake', home: '/home/tl-user' },
  // 🐙 GitHub Actions runner — the "computer" is a fresh ubuntu-latest CI runner
  // per command (REAL root via passwordless sudo, docker/apt/pip/npm preinstalled).
  // The work tree persists in the runner repo (git) so a chat's files survive
  // across turns. Home maps to the checked-out sandbox dir on the runner.
  //
  // ⚠️ perCommand: true — UNLIKE the always-on VM/container backends, each exec()
  // spins up a BRAND-NEW short-lived runner, so a long-lived in-sandbox worker
  // process (agent.py running a loop) CANNOT persist between commands. GitHub
  // Actions therefore runs via the HOST-LOOP path (the host brain drives; every
  // run_code / shell tool = one workflow dispatch), NOT the owns-the-computer
  // in-sandbox worker. sandboxAgent.enabled() honours this flag (see below).
  githubactions: { mod: githubactions, label: 'GitHub Actions', home: '/home/runner/work/sandbox', perCommand: true },
};
// Preference order for 'auto' mode + the fallback cascade. LocalAlpine is FIRST
// so that when it's enabled (the desktop app) it always wins — the desktop must
// NOT reach for a cloud sandbox. It's OFF by default though, so on the Render
// web deploy the cascade effectively starts at CodeSandbox exactly as before.
// CodeSandbox is next because it provisions in ~1s and runs as REAL root; Novita
// follows (reliable ~1s provisioning); HopX has been returning 503 "no available
// nodes" so it sits last. The admin can still pin any specific backend.
const ORDER = ['localsandbox', 'codesandbox', 'novita', 'upstashbox', 'tensorlake', 'runloop', 'daytona', 'hopx', 'githubactions'];

// Exact live-run registry. A session may be running on an AUTO fallback that is
// different from the backend currently selected in settings. /stop must target
// the sandbox that owns this task, not re-resolve today's preferred backend.
const ACTIVE_TASKS = new Map(); // sessionKey -> { backend, mod, id, work, outbox, taskId }

function clearActiveTask(sessionKey) { ACTIVE_TASKS.delete(String(sessionKey || '')); }

async function getSelectedBackendName() {
  let sel = '';
  try {
    if (_db && _db.getSetting) {
      const v = await _db.getSetting('sandbox_backend');
      if (v && v.trim()) sel = v.trim().toLowerCase();
    }
  } catch (_) {}
  if (!sel) sel = (process.env.SANDBOX_BACKEND || 'auto').trim().toLowerCase();
  // Backends we no longer support for owns-the-computer mode collapse to 'auto'.
  if (sel !== 'auto' && !BACKENDS[sel]) sel = 'auto';
  return sel;
}

// Is a backend module actually usable right now? Prefer the ASYNC check so a
// key that lives only in the DB (admin panel → Integrations) counts even when
// the sync `enabled()` cache is still cold (e.g. right after a cold start or a
// backend switch). Falls back to the sync snapshot if no async probe exists.
async function _isOn(mod) {
  if (!mod) return false;
  try { if (mod.enabledAsync) return !!(await mod.enabledAsync()); } catch (_) {}
  try { return !!mod.enabled(); } catch (_) { return false; }
}

// Resolve the backend to actually use for the in-sandbox worker.
//
// 🔑 SWITCHING CONTRACT (the whole point of the admin selector):
//   • When the admin picks a SPECIFIC backend (hopx | runloop | daytona) we use
//     ONLY that backend. We do NOT silently fall back to a different remote
//     sandbox — doing so was the bug that made a switch look like it "didn't
//     take" (admin chose Daytona, traffic kept landing on HopX). If the chosen
//     backend has no key, we throw a clear error so the admin sees WHY instead
//     of being quietly routed elsewhere.
//   • Only in 'auto' mode do we cascade through the ORDER list and pick the
//     first configured one.
async function resolveActiveBackend() {
  const sel = await getSelectedBackendName();

  if (sel !== 'auto') {
    const b = BACKENDS[sel];
    if (b && await _isOn(b.mod)) return { name: sel, ...b };
    // Admin explicitly chose this backend but it isn't configured — surface a
    // clear error rather than masking the choice with another sandbox.
    throw new Error(`selected sandbox "${sel}" has no API key configured — add its key in the admin Integrations tab (or switch the active sandbox).`);
  }

  // auto → cascade through the configured backends in preference order.
  for (const n of ORDER) {
    const b = BACKENDS[n];
    if (b && await _isOn(b.mod)) return { name: n, ...b };
  }
  return null;
}

// Resolve an ORDERED LIST of backends to try for the in-sandbox worker.
//
// 🛟 RESILIENCE CONTRACT (fixes the "HopX is out of capacity → web agent dies"
//    bug): the admin's selected backend is ALWAYS tried FIRST (so its existing
//    persistent sessions are reused and the admin's preference is honoured), but
//    if PROVISIONING a fresh sandbox there fails for a TRANSIENT reason (e.g.
//    HopX returns 503 "no available nodes"), we transparently CASCADE to the
//    OTHER configured backends instead of collapsing to the unreliable host
//    loop. This is different from silently ignoring the admin's choice — the
//    chosen backend still wins whenever it can actually serve the request; the
//    fallbacks only kick in when it literally cannot give us a box.
//
// Returns [{ name, mod, label, home }, …] — first element is the preferred
// backend. Empty array when nothing is configured.
//
// `stickyBackend` (optional) is the backend this chat's persistent sandbox
// ALREADY lives on. In AUTO mode we put it FIRST so a healthy existing session
// is REUSED instead of being torn down and re-provisioned elsewhere just
// because a higher-priority provider sits earlier in ORDER. This is the fix for
// the "session thrashing" bug: when HopX is down (503) but the chat is happily
// running on Daytona, AUTO must NOT keep migrating Daytona→HopX→Runloop on every
// message (which abandoned the box, lost files, and spammed the step feed with
// provisioning noise — the "it just says working in the sandbox" symptom).
// When the admin pins a SPECIFIC backend, that choice still wins (sticky is
// ignored) so an explicit switch still migrates the session.
async function resolveBackendChain(stickyBackend = null) {
  const sel = await getSelectedBackendName();
  const chain = [];
  const seen = new Set();
  const push = (n) => {
    if (!n || seen.has(n)) return;
    const b = BACKENDS[n];
    if (b) { chain.push({ name: n, ...b }); seen.add(n); }
  };

  // 🔒 HARD LOCK (user spec: "if admin chooses a sandbox it MUST use it"):
  // When the admin PINS a specific backend, the chain contains ONLY that
  // backend — NO cross-backend fallback whatsoever. A transient provisioning
  // hiccup on the pinned backend must NOT silently drift the task onto another
  // provider (that was the reported bug: pick GitHub Actions → it runs on
  // CodeSandbox/Novita instead). The pinned backend is retried in-place (see
  // the provisioning loop) but never replaced by a different sandbox. This
  // mirrors the host-loop path in agentEngine.resolveBackendCascade().
  if (sel !== 'auto') {
    push(sel);
    // Return exactly the pinned backend (if configured). If it has no key we
    // return an empty chain so the caller surfaces a clear "configure its key"
    // error instead of quietly routing elsewhere.
    const out = [];
    for (const c of chain) { if (await _isOn(c.mod)) out.push(c); }
    return out;
  }

  // ── AUTO mode only: sticky-first, then cascade through the preference order.
  if (stickyBackend && BACKENDS[stickyBackend]) {
    // Keep the chat on the backend it's already running on (reuse the warm,
    // persistent box) before considering anything else.
    push(stickyBackend);
  }
  // Then every other backend in preference order as a fallback — push any
  // backend that's in a transient-failure COOLDOWN to the BACK, so a brand-new
  // session goes straight to a healthy provider instead of burning the acquire
  // timeout on a known-down one (e.g. HopX 503). The sticky backend already
  // pushed above keeps its position.
  const healthy = [];
  const cooling = [];
  for (const n of ORDER) {
    if (seen.has(n) || !BACKENDS[n]) continue;
    if (_isBackendCoolingDown(n)) cooling.push(n);
    else healthy.push(n);
  }
  for (const n of healthy) push(n);
  for (const n of cooling) push(n);

  // Keep only the ones that are actually configured (have a key) right now.
  const out = [];
  for (const c of chain) {
    if (await _isOn(c.mod)) out.push(c);
  }
  return out;
}

// ── Hard timeout wrapper ─────────────────────────────────────────────────────
// Race a promise against a wall-clock deadline. This is the linchpin of the
// "no more frozen 'Working inside the sandbox…'" fix: a sandbox provider can
// accept our TCP connection and then hang for minutes (observed with HopX when
// a node is wedged). Without a hard ceiling, getOrCreateSessionSandbox /
// ensureWorker can block FOREVER while the SSE keep-alive ping keeps the socket
// open — so the app shows a spinner that never resolves. By bounding each
// provisioning step we guarantee we either (a) get a working box quickly, or
// (b) fail fast and cascade to the next backend / the host loop.
function _withTimeout(promise, ms, label) {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => { try { clearTimeout(t); } catch (_) {} });
}

// How long we allow ONE backend to give us a ready sandbox + running worker
// before we declare it stuck and move on. Tunable via env. Kept tight (45s) so
// the user is never left waiting on a wedged provider — a healthy box comes up
// in a few seconds, so 45s is generous headroom, not a normal wait.
const PROVISION_TIMEOUT_MS = parseInt(process.env.AGENT_PROVISION_TIMEOUT_MS || '45000', 10);
// Sub-budget for just acquiring the sandbox handle (create/resume). The worker
// install gets the remainder of the provisioning budget.
const ACQUIRE_TIMEOUT_MS = parseInt(process.env.AGENT_ACQUIRE_TIMEOUT_MS || '30000', 10);

// Should a provisioning error trigger a fallback to the NEXT backend? We fall
// back on transient/capacity/connectivity failures (503, "no available nodes",
// timeouts, 5xx, ECONN…), but NOT on auth errors (401/403 / "no API key") — a
// bad key won't be fixed by retrying elsewhere and should surface clearly.
function _shouldFallbackProvisionError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  if (!m) return true;
  if (/401|403|unauthorized|forbidden|no api key|invalid.*key|has no api key/.test(m)) return false;
  return true; // default: try the next backend rather than dying
}

// ── Per-session active-backend tracker ───────────────────────────────────────
// Remembers WHICH backend a chat's persistent sandbox currently lives on, so
// that when the admin switches the active sandbox we can detect the change and
// MIGRATE the session: tear down the old backend's sandbox and create a fresh
// one on the newly-selected backend. Without this, `getOrCreateSessionSandbox`
// only ever looks at its OWN backend's session row, so the old sandbox would
// keep running (and the chat could keep using it) after a switch.
const SESSION_BACKEND_PREFIX = 'session_backend:';
function _sessionBackendKey(sessionKey) { return SESSION_BACKEND_PREFIX + String(sessionKey); }

async function _getSessionBackend(sessionKey) {
  if (!_db || !_db.getSetting || !sessionKey) return null;
  try { const v = await _db.getSetting(_sessionBackendKey(sessionKey)); return (v && v.trim().toLowerCase()) || null; }
  catch (_) { return null; }
}
async function _setSessionBackend(sessionKey, name) {
  if (!_db || !_db.setSetting || !sessionKey) return;
  try { await _db.setSetting(_sessionBackendKey(sessionKey), name || ''); } catch (_) {}
}

// ── Short-lived backend-health cooldown (in-memory) ──────────────────────────
// When a backend fails to PROVISION for a transient reason (e.g. HopX returns
// 503 "service_unavailable" for an extended outage), retrying it FIRST on every
// brand-new session wastes the full acquire timeout (~30s) before cascading —
// so new chats feel "stuck connecting". We remember a failing backend for a
// short window and DE-PRIORITISE it (move it to the back of the auto chain) so
// fresh sessions go straight to a healthy provider. This is purely an ordering
// hint: a cooled-down backend is still tried last (never fully dropped), so the
// moment it recovers it's used again. Sticky/admin-pinned backends are NEVER
// cooled down — only the auto fallback ORDER is reshuffled.
const _backendCooldownUntil = Object.create(null);
const BACKEND_COOLDOWN_MS = parseInt(process.env.AGENT_BACKEND_COOLDOWN_MS || String(3 * 60 * 1000), 10); // 3 min
function _markBackendUnhealthy(name) {
  if (!name) return;
  _backendCooldownUntil[name] = Date.now() + BACKEND_COOLDOWN_MS;
}
function _isBackendCoolingDown(name) {
  const until = _backendCooldownUntil[name];
  return !!(until && until > Date.now());
}

// ── Config resolution ────────────────────────────────────────────────────────
// The bridge URL the worker calls back on. Must be PUBLIC (the sandbox can't
// reach the Render host on localhost). Resolve from explicit env → SELF_URL →
// RENDER_EXTERNAL_URL. Returns '' if none is public.
function bridgeUrl() {
  let base = (process.env.AGENT_BRIDGE_URL || '').trim();
  if (base) return base.replace(/\/+$/, '');
  const self = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (self && /^https?:\/\/(?!127\.|localhost)/i.test(self)) return `${self}/api/agent-bridge`;
  return '';
}

// Master token the bridge validates. Tokens handed to workers are derived from
// this + the sandbox id so each sandbox has a distinct, revocable token. The
// bridge MUST be configured explicitly; defaulting to the JWT secret would let
// any caller with a service token open a sandbox session.
function masterToken() {
  return (process.env.AGENT_BRIDGE_SECRET || '').trim();
}

function tokenFor(sandboxId) {
  return crypto.createHmac('sha256', masterToken()).update(String(sandboxId)).digest('hex').slice(0, 48);
}

// Verify a token presented to the bridge belongs to a given sandbox id.
function verifyToken(sandboxId, token) {
  if (!sandboxId || !token) return false;
  const expected = tokenFor(sandboxId);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)));
  } catch (_) { return false; }
}

// Is the in-sandbox mode enabled? Default ON (option A) when EITHER Runloop or
// Daytona is configured. The FILE bridge needs NO sandbox egress, so a public
// bridge URL is NOT required. Admin can force it off via the `agent_in_sandbox`
// DB setting = "off"/"0"/"false", or env AGENT_IN_SANDBOX=0.
async function enabled() {
  let active = null;
  try { active = await resolveActiveBackend(); } catch (_) { active = null; }
  if (!active) return false;
  // 🐙 PER-COMMAND backends (GitHub Actions) cannot host a persistent in-sandbox
  // worker process — each exec() is a fresh, short-lived runner. Force them onto
  // the HOST-LOOP path (agentEngine builds fsx from the backend and drives the
  // brain on the host, dispatching one workflow per shell/run_code tool). This
  // is the correct execution model for GHA and prevents a wedged/looping worker.
  if (active.perCommand) return false;
  // Env hard switch.
  const env = String(process.env.AGENT_IN_SANDBOX || '').trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(env)) return false;
  if (['1', 'on', 'true', 'yes'].includes(env)) return true;
  // DB setting (runtime, admin-overridable). Default = ON.
  try {
    if (_db && _db.getSetting) {
      const v = (await _db.getSetting('agent_in_sandbox') || '').trim().toLowerCase();
      if (['0', 'off', 'false', 'no'].includes(v)) return false;
      if (['1', 'on', 'true', 'yes'].includes(v)) return true;
    }
  } catch (_) {}
  return true; // default ON
}

// ── Worker lifecycle inside the sandbox ──────────────────────────────────────
const AGENT_PY = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'agent.py'), 'utf-8');
// Companion module: the in-sandbox LaTeX→PDF engine (Tectonic). Uploaded
// alongside agent.py so create_pdf/convert_file produce print-quality,
// VALIDATED PDFs (real math + tables + code + TikZ/PGFPlots charts & diagrams)
// LOCALLY in the sandbox (no host round-trip, light on Render). Best-effort
// read so a checkout without the file still boots the worker (it just falls
// back to the host bridge renderer). Replaces the old pdf_render.py (Chromium).
let LATEX_RENDER_PY = '';
let DATABASE_INTELLIGENCE_PY = '';
let QUALITY_GATE_PY = '';
try { LATEX_RENDER_PY = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'latex_render.py'), 'utf-8'); } catch (_) { LATEX_RENDER_PY = ''; }
try { DATABASE_INTELLIGENCE_PY = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'database_intelligence.py'), 'utf-8'); } catch (_) { DATABASE_INTELLIGENCE_PY = ''; }
try { QUALITY_GATE_PY = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'quality_gate.py'), 'utf-8'); } catch (_) { QUALITY_GATE_PY = ''; }
// Hash every runtime source so persistent sandboxes upgrade atomically.
// Include the enterprise tool tree as well: PDF rendering is also exposed via
// tools/documents, and a tool-only change must invalidate long-lived workers.
function runtimeToolSources() {
  const root = path.join(__dirname, '..', 'agent_worker', 'tools');
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'tool.json' || e.name.endsWith('_tool.py')) {
        out.push(path.relative(root, full), fs.readFileSync(full, 'utf-8'));
      }
    }
  };
  walk(root);
  return out;
}
const RUNTIME_TOOL_SOURCES = runtimeToolSources();
const AGENT_PY_HASH = crypto.createHash('sha1').update(
  [AGENT_PY, LATEX_RENDER_PY, DATABASE_INTELLIGENCE_PY, QUALITY_GATE_PY, ...RUNTIME_TOOL_SOURCES].join('\u0000')
).digest('hex').slice(0, 12);
const EXPECTED_TOOL_MANIFESTS = RUNTIME_TOOL_SOURCES.filter((value, index) => index % 2 === 0 && value.endsWith('tool.json')).length;
function buildRuntimeToolsArchive() {
  const zip = new AdmZip();
  for (let i = 0; i < RUNTIME_TOOL_SOURCES.length; i += 2) {
    zip.addFile(RUNTIME_TOOL_SOURCES[i], Buffer.from(RUNTIME_TOOL_SOURCES[i + 1], 'utf-8'));
  }
  return zip.toBuffer();
}
const RUNTIME_TOOLS_ARCHIVE = buildRuntimeToolsArchive();

function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Compute the per-backend worker paths from its home dir.
function pathsFor(home) {
  const WORK = `${home}/work`;
  return {
    WORKER_DIR: `${home}/agent`,
    WORK,
    INBOX: `${WORK}/.agent_inbox`,
    OUTBOX: `${WORK}/.agent_outbox`,
    BRIDGE_DIR: `${WORK}/.agent_bridge`,
  };
}

// ── One-time toolchain pre-warm (office + OCR + common cyber tooling) ─────────
// The agent's host tools install what they need on demand (LibreOffice, Pandoc,
// Tesseract, ImageMagick…) but doing so DURING a task adds latency and "stress".
// We pre-install the common toolchain ONCE per sandbox, in the BACKGROUND, right
// after the worker comes up — so by the time the user asks to read/convert a
// document or run a pentest tool, the binaries are already there.
//
// Idempotent: a sentinel file marks completion so re-runs are instant. Runs
// fully detached (setsid + nohup) so it NEVER blocks the first task — the task
// proceeds immediately and any tool the agent needs early still self-installs.
const PREWARM_SENTINEL = '.tools_prewarmed';
// Toggle off via env if an operator wants a lean sandbox.
const PREWARM_ENABLED = !['0', 'off', 'false', 'no'].includes(String(process.env.AGENT_PREWARM_TOOLS || '').trim().toLowerCase());

async function prewarmTools(sb, id, P, onStep) {
  if (!PREWARM_ENABLED) return;
  try {
    const sentinel = `${P.WORK}/${PREWARM_SENTINEL}`;
    const probe = await sb.exec(id, `test -f ${sentinel} && echo DONE || echo TODO`, { timeout: 20 }).catch(() => null);
    if (probe && /DONE/.test(probe.output || '')) return;

    // Office/doc conversion + OCR + image + LaTeX + handy CLIs. Cyber tooling is
    // best-effort (names vary by distro/repo); failures are ignored so the core
    // office/OCR set always lands.
    const OFFICE_OCR = [
      'tesseract-ocr', 'poppler-utils',
      'libreoffice', 'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress',
      'pandoc', 'imagemagick', 'ghostscript', 'unzip', 'zip', 'p7zip-full',
      'fonts-liberation', 'fonts-dejavu',
    ].join(' ');
    // ── LaTeX toolchain intentionally REMOVED ─────────────────────────────────
    // The old prewarm apt-installed texlive-* (up to ~1.5 GB) and pre-fetched
    // the Tectonic static binary as a fallback. On restricted sandbox networks
    // both transfers keep RESETTING mid-download ("Connection reset by peer
    // (os error 104)"), leaving the sandbox with NO working LaTeX engine — so
    // create_pdf produced PDFs full of the raw source (`\int \frac{...}{...}`).
    //
    // We now render Markdown+math to PDF with a PURE-PYTHON, ZERO-NETWORK
    // engine (agent_worker/latex_render.py). It has no external dependencies,
    // no sandbox installs, no binary downloads, no host round-trip — the file
    // itself IS the engine. So this prewarm no longer needs a LaTeX section.
    const CYBER = [
      'nmap', 'curl', 'wget', 'git', 'jq', 'whois', 'dnsutils', 'netcat-openbsd',
      'net-tools', 'iputils-ping', 'openssl', 'sqlite3', 'hashcat', 'hydra', 'john',
      'python3-pip', 'build-essential',
    ].join(' ');

    const script =
      `set +e; export DEBIAN_FRONTEND=noninteractive; ` +
      `SU=""; [ "$(id -u)" = "0" ] || SU="sudo"; ` +
      // Enable Debian contrib + non-free FIRST so cyber packages that live
      // outside `main` (sqlmap, nikto, hydra, john, …) actually RESOLVE instead
      // of failing with "E: Unable to locate package" — the exact cause of the
      // agent reporting a tool as "missing". (Verified live on Novita Debian 12.)
      `if [ -f /etc/apt/sources.list.d/debian.sources ]; then $SU sed -i 's/^Components:.*/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; ` +
      `elif [ -f /etc/apt/sources.list ]; then $SU sed -i 's/ main$/ main contrib non-free non-free-firmware/' /etc/apt/sources.list; fi; ` +
      `$SU apt-get update -y >/dev/null 2>&1; ` +
      // Core office/OCR set — install as one batch (most important).
      `$SU apt-get install -y --no-install-recommends ${OFFICE_OCR} >/dev/null 2>&1; ` +
      // Cyber tooling — best-effort, individually so one missing pkg can't abort the rest.
      `for p in ${CYBER}; do $SU apt-get install -y --no-install-recommends "$p" >/dev/null 2>&1; done; ` +
      // pip-installed helpers used by converters (best-effort). pip is the
      // PRIMARY installer in these sandboxes — see kaliBootstrap.js for the full
      // pip-first security arsenal that runs alongside this prewarm.
      `(python3 -m pip install -q --break-system-packages img2pdf >/dev/null 2>&1 || python3 -m pip install -q img2pdf >/dev/null 2>&1) || true; ` +
      `missing=""; for t in tesseract pdftotext soffice pandoc convert unzip zip git curl jq python3; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done; ` +
      `if [ -n "$missing" ]; then rm -f ${sentinel}; echo "PREWARM_INCOMPLETE missing:$missing"; exit 1; fi; ` +
      `touch ${sentinel}; echo PREWARM_DONE`;

    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    // Launch detached: write the script, run it via setsid in the background,
    // log to a file. The exec returns immediately; install continues in the box.
    const launch =
      `cd ${P.WORK} && printf %s ${shquote(b64)} | base64 -d > .prewarm.sh && ` +
      `setsid bash -c 'nohup bash .prewarm.sh > .prewarm.log 2>&1 </dev/null &' ; echo launched`;
    await sb.exec(id, launch, { timeout: 30 }).catch(() => {});
    if (onStep) onStep('🧰 pre-installing office + OCR + cyber tools in your sandbox (background — first time only)…');
  } catch (_) { /* never block the task on pre-warm */ }
}

// Ensure agent.py is present (current version) and the worker process is alive.
// Idempotent + fast on the common "already running" path.
async function ensureWorker(sb, id, P, onStep) {
  // 1) Is the right version already uploaded AND a worker already running?
  const probe = await sb.exec(
    id,
    `mkdir -p ${P.WORKER_DIR} ${P.INBOX} ${P.OUTBOX}; ` +
    `cat ${P.WORKER_DIR}/.version 2>/dev/null; echo '::'; ` +
    `test -s ${P.WORKER_DIR}/tool_registry.py && ` +
    `test "$(find ${P.WORKER_DIR}/tools -name tool.json -type f 2>/dev/null | wc -l)" -eq ${EXPECTED_TOOL_MANIFESTS} ` +
    `&& echo REGISTRY_OK || echo REGISTRY_BROKEN; ` +
    `pgrep -f 'agent.py' >/dev/null 2>&1 && echo RUNNING || echo DEAD`,
    { timeout: 30 }
  ).catch(() => null);
  const out = (probe && probe.output) || '';
  const versionOk = out.includes(AGENT_PY_HASH) && /REGISTRY_OK/.test(out);
  const running = /RUNNING/.test(out);
  if (versionOk && running) return true;

  // 2) (Re)upload agent.py if version mismatched or missing.
  if (!versionOk) {
    if (onStep) onStep('🧠 installing the in-sandbox agent (agent.py)…');
    // FAST + ROBUST path: upload agent.py in ONE native multipart call (works on
    // Runloop's upload_file and Daytona's files/upload). This avoids dozens of
    // chunked `printf` exec round-trips that can stall/abort on slower links.
    let uploaded = false;
    try {
      await sb.uploadFile(id, `${P.WORKER_DIR}/agent.py`, Buffer.from(AGENT_PY, 'utf-8'), 'agent.py');
      // Verify the upload landed with the right size before trusting it.
      const chk = await sb.exec(id, `wc -c < ${P.WORKER_DIR}/agent.py 2>/dev/null || echo 0`, { timeout: 30 }).catch(() => null);
      const got = parseInt(((chk && chk.output) || '0').trim(), 10) || 0;
      if (got === Buffer.byteLength(AGENT_PY, 'utf-8')) uploaded = true;
    } catch (_) { /* fall back to chunked write below */ }

    if (!uploaded) {
      // Fallback: chunked base64 write via exec (legacy path) to avoid the
      // 128KiB single-arg limit. Used only when native upload is unavailable.
      const b64 = Buffer.from(AGENT_PY, 'utf-8').toString('base64');
      const CHUNK = 60000;
      await sb.exec(id, `: > ${P.WORKER_DIR}/agent.py.b64`, { timeout: 30 });
      for (let i = 0; i < b64.length; i += CHUNK) {
        const part = b64.slice(i, i + CHUNK);
        await sb.exec(id, `printf %s ${shquote(part)} >> ${P.WORKER_DIR}/agent.py.b64`, { timeout: 60 });
      }
      await sb.exec(
        id,
        `base64 -d ${P.WORKER_DIR}/agent.py.b64 > ${P.WORKER_DIR}/agent.py && rm -f ${P.WORKER_DIR}/agent.py.b64`,
        { timeout: 60 }
      );
    }
    // Upload all companion runtime modules with size verification. These imports
    // are required by agent.py inside persistent sandboxes; omitting one would
    // make local tests pass but silently disable the feature in Daytona/Novita.
    const companions = [
      ['latex_render.py', LATEX_RENDER_PY],
      ['database_intelligence.py', DATABASE_INTELLIGENCE_PY],
      ['quality_gate.py', QUALITY_GATE_PY],
    ];
    for (const [filename, source] of companions) {
      if (!source) continue;
      let companionUp = false;
      try {
        await sb.uploadFile(id, `${P.WORKER_DIR}/${filename}`, Buffer.from(source, 'utf-8'), filename);
        const chk2 = await sb.exec(id, `wc -c < ${P.WORKER_DIR}/${filename} 2>/dev/null || echo 0`, { timeout: 30 }).catch(() => null);
        companionUp = (parseInt(((chk2 && chk2.output) || '0').trim(), 10) || 0) === Buffer.byteLength(source, 'utf-8');
      } catch (_) { /* fall back to chunked write */ }
      if (!companionUp) {
        const pb64 = Buffer.from(source, 'utf-8').toString('base64');
        const CHUNK = 60000;
        await sb.exec(id, `: > ${P.WORKER_DIR}/${filename}.b64`, { timeout: 30 });
        for (let i = 0; i < pb64.length; i += CHUNK) {
          await sb.exec(id, `printf %s ${shquote(pb64.slice(i, i + CHUNK))} >> ${P.WORKER_DIR}/${filename}.b64`, { timeout: 60 });
        }
        await sb.exec(id, `base64 -d ${P.WORKER_DIR}/${filename}.b64 > ${P.WORKER_DIR}/${filename} && rm -f ${P.WORKER_DIR}/${filename}.b64`, { timeout: 60 });
      }
    }
    // Remove the retired Chromium renderer during rolling upgrades.
    await sb.exec(id, `rm -f ${P.WORKER_DIR}/pdf_render.py 2>/dev/null; true`, { timeout: 20 }).catch(() => {});
  }

  // ── ENTERPRISE TOOL REGISTRY ──────────────────────────────────────────────
  // Deploy the tool_registry.py + all tools/ into the sandbox worker directory.
  // The agent worker can then use run_tool() to execute any registered tool.
  // This is done on every version mismatch so tools stay in sync with code.
  if (!versionOk) {
    if (onStep) onStep('🔧 deploying enterprise tool registry and tools…');
    const TOOLS_SRC = path.join(__dirname, '..', 'agent_worker');
    const REGISTRY_FILES = [
      { src: path.join(TOOLS_SRC, 'tool_registry.py'), dst: `${P.WORKER_DIR}/tool_registry.py` },
    ];
    // Upload tool_registry.py and prove the exact bytes landed. A persistent
    // sandbox is never stamped current until the complete registry is usable.
    for (const f of REGISTRY_FILES) {
      if (!fs.existsSync(f.src)) throw new Error(`required runtime file missing: ${f.src}`);
      const buf = fs.readFileSync(f.src);
      await sb.uploadFile(id, f.dst, buf, path.basename(f.dst));
      const verified = await sb.exec(id, `test "$(wc -c < ${shquote(f.dst)} 2>/dev/null)" -eq ${buf.length} && echo OK || echo BAD`, { timeout: 30 });
      if (!/OK/.test((verified && verified.output) || '')) throw new Error(`runtime upload verification failed: ${path.basename(f.dst)}`);
      if (onStep) onStep(`📦 uploaded ${path.basename(f.src)}`);
    }
    // Upload the complete tools tree as ONE archive, extract to a staging
    // directory, validate it, then atomically swap it into place. This avoids
    // dozens of provider round-trips and makes interruption self-healing.
    const TOOLS_DIR_DST = `${P.WORKER_DIR}/tools`;
    try {
      const archivePath = `${P.WORKER_DIR}/.tools-${AGENT_PY_HASH}.zip`;
      await sb.uploadFile(id, archivePath, RUNTIME_TOOLS_ARCHIVE, 'tools.zip');
      const archiveCheck = await sb.exec(id, `test "$(wc -c < ${shquote(archivePath)} 2>/dev/null)" -eq ${RUNTIME_TOOLS_ARCHIVE.length} && echo OK || echo BAD`, { timeout: 30 });
      if (!/OK/.test((archiveCheck && archiveCheck.output) || '')) throw new Error('tool archive upload verification failed');
      const extract = await sb.exec(id, `WORKER_DIR=${shquote(P.WORKER_DIR)} ARCHIVE=${shquote(archivePath)} EXPECTED=${EXPECTED_TOOL_MANIFESTS} python3 - <<'PY'\nimport os, shutil, zipfile\nroot=os.environ['WORKER_DIR']; archive=os.environ['ARCHIVE']; expected=int(os.environ['EXPECTED'])\nstage=os.path.join(root, '.tools-stage')\nshutil.rmtree(stage, ignore_errors=True); os.makedirs(stage, exist_ok=True)\nwith zipfile.ZipFile(archive) as z:\n    for info in z.infolist():\n        target=os.path.realpath(os.path.join(stage, info.filename))\n        if not target.startswith(os.path.realpath(stage)+os.sep): raise SystemExit('unsafe archive path')\n    z.extractall(stage)\ncount=sum(1 for b,_,fs in os.walk(stage) for f in fs if f=='tool.json')\nif count != expected: raise SystemExit('manifest count %d != %d' % (count, expected))\nold=os.path.join(root, '.tools-old'); live=os.path.join(root, 'tools')\nshutil.rmtree(old, ignore_errors=True)\nif os.path.exists(live): os.rename(live, old)\nos.rename(stage, live); shutil.rmtree(old, ignore_errors=True); os.unlink(archive)\nprint('TOOLS_ATOMIC_OK=%d' % count)\nPY`, { timeout: 90 });
      if (!extract || extract.exitCode !== 0 || !new RegExp(`TOOLS_ATOMIC_OK=${EXPECTED_TOOL_MANIFESTS}(?:\\s|$)`).test(extract.output || '')) {
        throw new Error(`tool archive extraction failed: ${String((extract && extract.output) || '').slice(-500)}`);
      }
      if (onStep) onStep(`🔧 tool registry deployed (${EXPECTED_TOOL_MANIFESTS} tools)`);
    } catch (e) {
      throw new Error(`enterprise tool registry deployment failed: ${e.message}`);
    }
    const registryProbe = await sb.exec(
      id,
      `cd ${P.WORKER_DIR} && python3 - <<'PY'\nimport os, sys\nsys.path.insert(0, '.')\nfrom tool_registry import ToolRegistry\nr=ToolRegistry(tools_dir='tools', work_dir=${JSON.stringify(P.WORK)})\nr.discover()\nn=len(r.list_tools())\nprint('REGISTRY_COUNT=%d' % n)\nraise SystemExit(0 if n == ${EXPECTED_TOOL_MANIFESTS} else 1)\nPY`,
      { timeout: 60 }
    );
    if (!registryProbe || registryProbe.exitCode !== 0 || !new RegExp(`REGISTRY_COUNT=${EXPECTED_TOOL_MANIFESTS}(?:\\s|$)`).test(registryProbe.output || '')) {
      throw new Error(`enterprise tool registry smoke test failed: ${String((registryProbe && registryProbe.output) || '').slice(-500)}`);
    }
    // Atomic commit marker: written last, only after every worker/runtime/tool
    // byte and the registry discovery smoke test have succeeded.
    await sb.exec(id, `printf %s ${shquote(AGENT_PY_HASH)} > ${P.WORKER_DIR}/.version.tmp && mv ${P.WORKER_DIR}/.version.tmp ${P.WORKER_DIR}/.version`, { timeout: 30 });
  }

  // 3) (Re)start the worker. On ANY version change we FORCE a clean restart so
  // persistent sandboxes never keep running stale agent.py code (this is the
  // root cause of "my delivery fix didn't take effect" — the old long-lived
  // worker kept serving tasks). We kill unconditionally on mismatch: `pkill`
  // is a no-op when nothing matches, and `running` can be a false-negative if
  // the probe raced a starting/zombie process.
  if (!versionOk) {
    await sb.exec(id, `pkill -9 -f 'agent.py' 2>/dev/null; sleep 1; true`, { timeout: 30 }).catch(() => {});
  }
  if (onStep) onStep('🖥️ starting the agent worker inside your persistent sandbox…');
  const token = tokenFor(id);
  // FILE bridge by default — works on ALL tiers (no sandbox egress needed). The
  // host services brain/tool requests via the backend's exec/file channel.
  // Set AGENT_BRIDGE_MODE=http only if the sandbox has outbound network AND a
  // public bridge URL is configured.
  const mode = (String(process.env.AGENT_BRIDGE_MODE || 'file').trim().toLowerCase() === 'http' && bridgeUrl()) ? 'http' : 'file';
  const env =
    `AGENT_WORK=${shquote(P.WORK)} ` +
    `AGENT_BRIDGE_MODE=${shquote(mode)} ` +
    `AGENT_BRIDGE_URL=${shquote(bridgeUrl())} ` +
    `AGENT_TOKEN=${shquote(token)} ` +
    `AGENT_SANDBOX_ID=${shquote(id)} ` +
    `AGENT_MAX_STEPS=${shquote(String(process.env.AGENT_MAX_STEPS || '250'))} ` +
    `AGENT_MAX_ITERATIONS=${shquote(String(process.env.AGENT_MAX_ITERATIONS || '270'))} ` +
    // Never pass application/database credentials into the agent worker. The
    // worker only needs its bridge token and runtime metadata; user code runs
    // with a separately scrubbed child environment (see agent.py).
    `AGENT_SECRETS_DISABLED=1 ` +
    `TOOL_REGISTRY_DIR=${shquote(P.WORKER_DIR)}`;
  // nohup + setsid so the worker survives the exec call returning, and writes a
  // log we can inspect. python3 is guaranteed on both backend images.
  // Launch the worker FULLY DETACHED so the synchronous exec channel returns
  // immediately. The critical detail for Runloop's execute_sync (which blocks
  // until ALL inherited file descriptors close): wrap the launch in
  // `setsid bash -c '… &'` with stdin from /dev/null and stdout/stderr to a log
  // FILE — this closes the exec pipe right away while the worker keeps running
  // in its own session. Works identically on Daytona. python3 is guaranteed on
  // both backend images.
  const launch = `${env} nohup python3 agent.py > ${P.WORKER_DIR}/worker.log 2>&1 </dev/null &`;
  await sb.exec(
    id,
    `cd ${P.WORKER_DIR} && setsid bash -c ${shquote(launch)} ; echo started`,
    { timeout: 30 }
  );
  // Verify it came up.
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1200));
    const c = await sb.exec(id, `pgrep -f 'agent.py' >/dev/null 2>&1 && echo UP || echo NO`, { timeout: 20 }).catch(() => null);
    if (c && /UP/.test(c.output || '')) return true;
  }
  // Surface the worker log to help diagnose a failed start.
  const log = await sb.exec(id, `tail -n 20 ${P.WORKER_DIR}/worker.log 2>/dev/null`, { timeout: 20 }).catch(() => null);
  throw new Error('worker did not start: ' + ((log && log.output) || 'no log').slice(0, 300));
}

// ── Main entry: run a task inside the sandbox worker ─────────────────────────
async function runAgentInSandbox(opts) {
  const { task, onStep, history = [], sessionKey = null } = opts;
  const onEvent = (typeof opts.onEvent === 'function') ? opts.onEvent : () => {};
  const attachments = opts.attachments || [];
  const systemPrompt = opts.systemPrompt || null;
  const throwIfStopped = () => {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error('Task stopped by user');
      e.code = 'AGENT_STOPPED';
      throw e;
    }
  };

  if (!sessionKey) throw new Error('in-sandbox mode requires a sessionKey');
  throwIfStopped();

  // 0) Resolve the ORDERED backend chain. In AUTO mode we keep the chat on the
  //    backend its persistent sandbox ALREADY lives on (sticky reuse) so a
  //    healthy session is never torn down just because a higher-priority
  //    provider sits earlier in ORDER. We still cascade to the other configured
  //    backends if PROVISIONING fails for a TRANSIENT reason (e.g. HopX "503 no
  //    available nodes" — a real, observed outage) instead of collapsing to the
  //    unreliable host loop. This is what keeps the WEB agent alive when one
  //    sandbox provider runs out of capacity AND stops the per-message
  //    HopX→Daytona→Runloop thrashing that made the agent look "stuck in the
  //    sandbox" (no real work shown). An explicit admin backend switch still
  //    overrides stickiness (see resolveBackendChain).
  const stickyBackend = await _getSessionBackend(sessionKey);
  const chain = await resolveBackendChain(stickyBackend);
  if (!chain.length) throw new Error('no sandbox backend configured for owns-the-computer mode (configure CodeSandbox, HopX, Runloop, Daytona or Novita)');

  // 🔒 Is a specific backend PINNED by the admin? When pinned, the chain has
  // exactly ONE entry and we must NEVER drift to another provider. Instead we
  // RETRY the pinned backend in-place on transient provisioning errors so it
  // actually gets a chance to serve the request (capacity blips clear quickly),
  // then — only if it truly cannot — bubble up to the host loop.
  const pinnedName = await getSelectedBackendName();
  const isPinned = pinnedName !== 'auto';
  const PINNED_PROVISION_RETRIES = parseInt(process.env.AGENT_PINNED_RETRIES || '2', 10);
  const PINNED_RETRY_BACKOFF_MS = parseInt(process.env.AGENT_PINNED_BACKOFF_MS || '2500', 10);

  let active = null, sb = null, P = null, id = null, reused = false;
  let lastErr = null;

  for (let ci = 0; ci < chain.length; ci++) {
    throwIfStopped();
    const cand = chain[ci];
    const candSb = cand.mod;
    const candP = pathsFor(cand.home);
    const isFallback = ci > 0;
    // How many attempts do we make on THIS backend? A pinned backend gets
    // several in-place retries (it must be used); an auto-cascade entry gets a
    // single attempt before moving to the next provider.
    const maxAttempts = isPinned ? (1 + Math.max(0, PINNED_PROVISION_RETRIES)) : 1;
    let backendSucceeded = false;

    for (let attempt = 1; attempt <= maxAttempts && !backendSucceeded; attempt++) {
    try {
      throwIfStopped();
      // 0b) 🔀 BACKEND-SWITCH MIGRATION. If this chat's sandbox lives on a
      //     DIFFERENT backend than the one we're about to use, release the old
      //     box + clear its mapping so we provision cleanly on the new backend.
      try {
        const prevBackend = await _getSessionBackend(sessionKey);
        if (prevBackend && prevBackend !== cand.name && BACKENDS[prevBackend]) {
          if (onStep) onStep(`🔀 moving your session to ${cand.label} (releasing the old ${prevBackend} sandbox).`);
          try { await BACKENDS[prevBackend].mod.endSession(sessionKey); } catch (_) { /* best-effort cleanup */ }
        }
      } catch (_) { /* never block a run on migration bookkeeping */ }

      // 1) Provision / reuse the PERSISTENT sandbox for this chat on this backend.
      if (onStep) {
        const retryTag = attempt > 1 ? ` (retry ${attempt - 1}/${maxAttempts - 1})` : '';
        onStep(isFallback
          ? `🛟 ${cand.label} is next in line — connecting to a Linux sandbox there…`
          : `🖥️ connecting to your persistent Linux sandbox (${cand.label})${retryTag}…`);
      }
      const got = await _withTimeout(
        candSb.getOrCreateSessionSandbox(sessionKey, {}),
        ACQUIRE_TIMEOUT_MS,
        `${cand.label} sandbox acquire`
      );
      const candId = got.id;
      const candReused = got.reused;
      throwIfStopped();

      // 2) Ensure agent.py is installed & the worker is running (provision-ish:
      //    a failure here on a brand-new box is also a reason to try the next
      //    backend rather than give up). Hard-bounded so a wedged provider can't
      //    hang us forever (the root cause of the frozen "Working…" spinner).
      await _withTimeout(
        ensureWorker(candSb, candId, candP, onStep),
        Math.max(15000, PROVISION_TIMEOUT_MS - ACQUIRE_TIMEOUT_MS),
        `${cand.label} worker start`
      );

      // Success — lock this backend in for the rest of the run.
      active = cand; sb = candSb; P = candP; id = candId; reused = candReused;
      await _setSessionBackend(sessionKey, cand.name);
      if (onStep) onStep(candReused ? '🔁 reusing your existing sandbox — your files are still here.' : '🆕 created a fresh sandbox for this session.');
      backendSucceeded = true;
      break;
    } catch (e) {
      lastErr = e;
      console.error(`[sandboxAgent] backend ${cand.name} provisioning failed (attempt ${attempt}/${maxAttempts}):`, e.message);
      // Clear any half-made session mapping for this backend so the next attempt
      // (or the next run) starts clean instead of pinning to a dead box.
      try { await candSb.endSession(sessionKey); } catch (_) {}

      const retryable = _shouldFallbackProvisionError(e);

      // ── PINNED backend: retry IN-PLACE (never switch providers). ──────────
      if (isPinned) {
        const moreAttempts = attempt < maxAttempts;
        if (moreAttempts && retryable) {
          const wait = PINNED_RETRY_BACKOFF_MS * attempt;
          if (onStep) onStep(`⚠️ ${cand.label} (your selected sandbox) hiccuped (${String(e.message).slice(0, 90)}) — retrying it in ${Math.round(wait / 1000)}s (it will NOT switch to another sandbox)…`);
          await new Promise(r => setTimeout(r, wait));
          continue; // retry the SAME pinned backend
        }
        // Out of retries, or a non-retryable (auth) error → bubble up. The
        // caller falls back to the HOST loop, NOT to a different sandbox, so
        // the admin's choice is never silently overridden.
        if (onStep) onStep(`⛔ ${cand.label} (your selected sandbox) could not be provisioned after ${attempt} attempt(s) — running on the host engine instead (your pinned sandbox choice is NOT swapped for another provider).`);
        throw e;
      }

      // ── AUTO mode: cascade to the next configured backend. ────────────────
      const more = ci < chain.length - 1;
      if (more && retryable) {
        // Remember this backend as transiently unhealthy so the NEXT new
        // session skips straight past it (avoids re-burning the acquire
        // timeout on e.g. a persistent HopX 503). Auto-expires after the
        // cooldown window; recovers instantly once the provider is back.
        _markBackendUnhealthy(cand.name);
        if (onStep) onStep(`⚠️ ${cand.label} couldn't provide a sandbox (${String(e.message).slice(0, 90)}) — trying another provider…`);
        break; // leave the attempt loop, cascade to the next backend
      }
      // No more backends, or a non-retryable (auth) error → bubble up so the
      // caller (agentEngine) decides whether to use the host loop.
      throw e;
    }
    } // end attempt loop

    if (backendSucceeded) break;
  }

  if (!active || !sb || !id) {
    throw lastErr || new Error('all sandbox backends failed to provision');
  }

  const { WORK, INBOX, OUTBOX, WORKER_DIR } = P;
  ACTIVE_TASKS.set(sessionKey, { backend: active.name, mod: sb, id, work: WORK, outbox: OUTBOX, taskId: null });
  throwIfStopped();

  // 2b) Pre-warm the office/OCR/cyber toolchain ONCE per sandbox (background,
  //     non-blocking) so document/image/conversion tasks don't stall installing
  //     LibreOffice/Tesseract/etc. during the task itself.
  prewarmTools(sb, id, P, onStep).catch(() => {});

  // 2c) Bootstrap the "Kali slim" security arsenal ONCE per sandbox (background,
  //     non-blocking, pip-first). Enables Debian contrib/non-free + the Kali repo
  //     and installs a slim recon/web/password/wordlist toolset so the agent can
  //     do vulnerability testing WITHOUT ever reporting a tool as "missing".
  //     Sentinel-guarded → instant on every subsequent turn (no sandbox stress).
  //     Skipped for LocalAlpine (Alpine uses apk, not apt — its own toolchain
  //     is preinstalled) but runs on every apt/Debian-based cloud backend.
  try {
    if (active && active.name !== 'localsandbox' && kaliBootstrap && kaliBootstrap.bootstrap) {
      kaliBootstrap.bootstrap(sb, id, active.home, { background: true, onStep }).catch(() => {});
    }
  } catch (_) { /* never block the task on the security prewarm */ }

  // 3) Upload attachments into the work dir (so local tools can use them).
  for (const a of attachments) {
    try {
      const safe = String(a.name || 'input').replace(/[^\w.\-]/g, '_');
      await sb.uploadFile(id, `${WORK}/${safe}`, a.buffer, safe);
      if (/\.zip$/i.test(safe)) {
        const dir = safe.replace(/\.zip$/i, '') + '_extracted';
        await sb.exec(id, `cd ${WORK} && mkdir -p ${shquote(dir)} && (command -v unzip >/dev/null 2>&1 || (sudo apt-get update -y >/dev/null 2>&1 && sudo apt-get install -y unzip >/dev/null 2>&1)); unzip -o ${shquote(safe)} -d ${shquote(dir)} >/dev/null 2>&1; true`, { timeout: 120 }).catch(() => {});
      }
    } catch (e) {
      if (onStep) onStep(`⚠️ could not upload ${a && a.name}: ${e.message}`);
    }
  }

  // 3b) REGISTER the attachment buffers on the host, keyed by this sandbox id,
  //     so the bridge content-tools (analyze_image / read_document / solve_math)
  //     get the REAL bytes when the in-sandbox worker proxies them back to the
  //     host. Without this, image/document analysis returns "no attached file"
  //     in owns-the-computer mode (the worker has no way to send file bytes).
  try {
    const agentEngine = require('./agentEngine');
    if (agentEngine.registerSandboxAttachments) {
      agentEngine.registerSandboxAttachments(id, attachments);
    }
  } catch (_) { /* non-fatal — bridge has a sandbox-download fallback */ }

  // 4) Build the seed conversation with the same hard turn boundary as the
  //    host engine. Historical user messages are completed context, never live
  //    instructions. This prevents a persistent worker from resuming the prior
  //    task when a new request arrives.
  let priorAnalysisMemory = '';
  try {
    const mem = await sb.exec(id, `cat ${WORK}/.agent_memory.md 2>/dev/null | head -c 24000`, { timeout: 20 }).catch(() => null);
    priorAnalysisMemory = mem && (mem.output || '').trim() ? mem.output.trim() : '';
  } catch (_) {}

  const attachLine = attachments.length
    ? `\n\nATTACHED FILES FOR THIS TASK (already in your working dir): ${attachments.map(a => a.isImage ? `${a.name} (image — use analyze_image)` : a.name).join(', ')}\n\nThese are the current task's authoritative inputs. Inspect them with list_files / read_file / analyze_image, never ask the user to re-send them, and ignore older workspace files unless the CURRENT TASK explicitly requests them.`
    : '';
  const conversation = buildTaskConversation({ history, priorAnalysisMemory, task, attachLine });

  // 5) Drop the task into the worker inbox.
  const taskId = 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  ACTIVE_TASKS.set(sessionKey, { backend: active.name, mod: sb, id, work: WORK, outbox: OUTBOX, taskId });
  const clampTaskBudget = (value, fallback) => Math.max(1, Math.min(1000, parseInt(value, 10) || fallback));
  const payload = {
    system: systemPrompt || '__DEFAULT__', conversation, task,
    max_iterations: clampTaskBudget(opts.maxIterations, 270),
    max_tool_steps: clampTaskBudget(opts.maxToolSteps, 270),
  };
  // ⏱️ TIME-BOX PASS-THROUGH: if the caller asked the agent to think for a set
  // duration ("use 5 minutes"), forward the absolute deadline / min-duration so
  // the worker keeps exploring new angles until the time is up (see agent.py).
  if (opts.thinkUntilMs && Number.isFinite(opts.thinkUntilMs)) payload.think_until_ms = Math.round(opts.thinkUntilMs);
  if (opts.minDurationMs && Number.isFinite(opts.minDurationMs)) payload.min_duration_ms = Math.round(opts.minDurationMs);
  // Mark default so the bridge supplies the canonical system prompt (keeps the
  // huge prompt on the host; the worker just references it).
  // ROBUST path: upload the payload in ONE native multipart call, then atomically
  // mv it into the inbox so the watcher never reads a partial file. Falls back to
  // a chunked base64 write only if the native upload is unavailable.
  {
    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf-8');
    const tmpJson = `${INBOX}/${taskId}.json.tmp`;
    let uploaded = false;
    try {
      await sb.uploadFile(id, tmpJson, payloadBuf, `${taskId}.json`);
      const chk = await sb.exec(id, `wc -c < ${shquote(tmpJson)} 2>/dev/null || echo 0`, { timeout: 20 }).catch(() => null);
      if ((parseInt(((chk && chk.output) || '0').trim(), 10) || 0) === payloadBuf.length) uploaded = true;
    } catch (_) { /* fall back to chunked write */ }

    if (!uploaded) {
      const payloadB64 = payloadBuf.toString('base64');
      const CHUNK = 60000;
      const tmp = `${INBOX}/${taskId}.json.b64`;
      await sb.exec(id, `: > ${tmp}`, { timeout: 20 });
      for (let i = 0; i < payloadB64.length; i += CHUNK) {
        await sb.exec(id, `printf %s ${shquote(payloadB64.slice(i, i + CHUNK))} >> ${tmp}`, { timeout: 60 });
      }
      await sb.exec(id, `base64 -d ${tmp} > ${tmpJson} && rm -f ${tmp}`, { timeout: 30 });
    }
    // Atomic publish into the inbox.
    await sb.exec(id, `mv ${tmpJson} ${INBOX}/${taskId}.json`, { timeout: 20 });
  }

  if (onStep) onStep('🤖 the agent is now working inside the sandbox…');

  // 6) Poll loop: SERVICE the file-bridge (brain/tool requests the worker drops),
  //    stream status lines, and wait for the result. Supports very long tasks
  //    (minutes → hours). All communication uses the backend's exec/file channel —
  //    no sandbox egress required.
  const BRIDGE_DIR = P.BRIDGE_DIR;
  const statusPath = `${OUTBOX}/${taskId}.status`;
  const terminalPath = `${OUTBOX}/${taskId}.terminal`;
  const resultPath = `${OUTBOX}/${taskId}.result`;
  const HARD_CEILING_MS = parseInt(process.env.AGENT_TASK_CEILING_MS || String(3 * 60 * 60 * 1000), 10); // 3h
  const POLL_MS = 1500;
  const started = Date.now();
  let sentLines = 0;
  // Live-terminal streaming: forward NEW lines from the worker's .terminal file
  // so the user watches the real sandbox terminal scroll by (not a static
  // screen). Lines are flushed in small batches as one ```terminal``` block so
  // chat clients render them as a monospace console without flooding the chat.
  let sentTermLines = 0;
  // Toggleable so an operator can mute the raw terminal feed if it's too chatty.
  const STREAM_TERMINAL = !['0', 'off', 'false', 'no'].includes(String(process.env.AGENT_STREAM_TERMINAL || '').trim().toLowerCase());
  let lastProgressAt = Date.now();
  let resultJson = null;
  // Track consecutive backend-probe failures. If the sandbox's exec channel goes
  // unresponsive (e.g. the backend VM hangs — the "HopX has hanged" scenario),
  // every probe returns null. Rather than loop silently until the hard ceiling,
  // we bail after a run of failures so the caller can fall back to another
  // backend / local execution and the chat lock is released promptly.
  let consecProbeFails = 0;
  const MAX_PROBE_FAILS = parseInt(process.env.AGENT_MAX_PROBE_FAILS || '8', 10); // ~ 8 polls

  // ── 💓 Sandbox keepalive ────────────────────────────────────────────────────
  // ROOT-CAUSE FIX for "⚠️ bridge write-back failed: The sandbox was not found
  // (sandbox timeout)". A provider auto-reclaims a box after its `timeout_secs`
  // of TOTAL lifetime; on a long autonomous task (multi-minute installs, scans,
  // builds) the box can expire WHILE the worker is still running, after which
  // every host exec/upload/download 404s and the whole task dies with files
  // lost. We periodically re-assert the sandbox's lifetime so an ACTIVE task
  // never loses its box. Providers expose an optional `keepAlive(id, secs)` (a
  // no-op for those with no lifetime cap). Interval kept well under the smallest
  // plan cap (Tensorlake free = 1h) so the extension always lands in time.
  const KEEPALIVE_MS = parseInt(process.env.AGENT_KEEPALIVE_MS || String(60 * 1000), 10); // every 60s
  let lastKeepAliveAt = Date.now();
  const _keepAlive = async () => {
    try { if (sb && typeof sb.keepAlive === 'function') await sb.keepAlive(id); } catch (_) {}
  };

  while (Date.now() - started < HARD_CEILING_MS) {
    if (opts.signal && opts.signal.aborted) {
      await sb.exec(id, `mkdir -p ${shquote(P.WORK)} ${shquote(P.OUTBOX)} && date +%s > ${shquote(P.WORK + '/.agent_stop')} && ${taskId ? `date +%s > ${shquote(P.OUTBOX + '/' + taskId + '.stop')}` : 'true'}`, { timeout: 10 }).catch(() => {});
      if (ACTIVE_TASKS.get(sessionKey)?.taskId === taskId) ACTIVE_TASKS.delete(sessionKey);
      return { message: '🛑 Task stopped.', files: [], steps: 0, workdir: null, brain: 'stopped', stopped: true };
    }
    // 💓 Re-assert the sandbox lifetime on a fixed cadence so a long-running
    //    task never loses its box mid-flight (the "sandbox not found" bug).
    if (Date.now() - lastKeepAliveAt >= KEEPALIVE_MS) {
      lastKeepAliveAt = Date.now();
      _keepAlive().catch(() => {});
    }
    // a) SERVICE any pending bridge requests FIRST (this is what unblocks the
    //    worker's brain()/host_tool() calls). Returns how many we handled.
    let serviced = 0;
    try { serviced = await serviceBridgeOnce(sb, id, BRIDGE_DIR, onStep, onEvent); } catch (_) {}

    // b) Check for the final result.
    const got = await sb.exec(id, `test -f ${resultPath} && cat ${resultPath} || echo __PENDING__`, { timeout: 30 }).catch(() => null);
    if (got === null) consecProbeFails++; else consecProbeFails = 0;
    const body = (got && got.output) || '';
    if (body && !body.includes('__PENDING__')) {
      try { resultJson = JSON.parse(body.trim()); } catch (_) { resultJson = null; }
      if (resultJson) break;
    }

    // c) Stream any new status lines.
    const st = await sb.exec(id, `cat ${statusPath} 2>/dev/null`, { timeout: 20 }).catch(() => null);
    const lines = ((st && st.output) || '').split('\n').filter(Boolean);
    if (lines.length > sentLines) {
      for (let i = sentLines; i < lines.length; i++) {
        const ln = lines[i];
        if (onStep) onStep(ln);
        // 🔎 ADMIN LOOP VISIBILITY: when the worker reports a loop, record it so
        // the admin panel can see WHICH sandbox/chat looped and when.
        if (/LOOP_DETECTED|possible loop/i.test(ln)) {
          recordLoopEvent({ sessionKey, sandboxId: id, backend: active.label, note: ln }).catch(() => {});
        }
      }
      sentLines = lines.length;
      lastProgressAt = Date.now();
    }

    // c-term) Stream new LIVE TERMINAL lines so the user sees the real sandbox
    //   console output as it happens (the WHOLE point of "see the terminal").
    if (STREAM_TERMINAL && onStep) {
      const tt = await sb.exec(id, `cat ${terminalPath} 2>/dev/null`, { timeout: 20 }).catch(() => null);
      const tlines = ((tt && tt.output) || '').split('\n');
      // The trailing element after split may be a partial line; only forward
      // complete lines (everything before the last newline).
      const completeCount = tlines.length > 0 ? tlines.length - 1 : 0;
      if (completeCount > sentTermLines) {
        const fresh = tlines.slice(sentTermLines, completeCount).filter(l => l.length);
        if (fresh.length) {
          // Cap how much we emit per tick so a noisy build can't flood chat.
          const MAX_PER_TICK = 24;
          const shown = fresh.slice(-MAX_PER_TICK);
          const omitted = fresh.length - shown.length;
          const head = omitted > 0 ? `🖥️ terminal (…${omitted} earlier line(s) omitted):\n` : '🖥️ terminal:\n';
          onStep(head + '```\n' + shown.join('\n').slice(0, 3500) + '\n```');
        }
        sentTermLines = completeCount;
        lastProgressAt = Date.now();
      }
    }

    if (serviced > 0) lastProgressAt = Date.now();

    // c2) Backend-unresponsive guard: if the exec channel keeps failing, the VM
    //     is hung/unreachable — fail fast so the caller can fall back.
    if (consecProbeFails >= MAX_PROBE_FAILS) {
      throw new Error('sandbox backend became unresponsive (' + consecProbeFails + ' consecutive probe failures) — falling back.');
    }

    // d) Liveness guard: if no progress for a while AND the worker died with no
    //    result, bail so the caller can fall back instead of hanging forever.
    if (Date.now() - lastProgressAt > 120000) {
      const alive = await sb.exec(id, `pgrep -f 'agent.py' >/dev/null 2>&1 && echo UP || echo NO`, { timeout: 20 }).catch(() => null);
      if (alive && /NO/.test(alive.output || '')) {
        const log = await sb.exec(id, `tail -n 15 ${WORKER_DIR}/worker.log 2>/dev/null`, { timeout: 20 }).catch(() => null);
        throw new Error('worker process exited without a result. log: ' + ((log && log.output) || '').slice(0, 300));
      }
      lastProgressAt = Date.now();
    }

    // Only sleep when there was nothing to do (keep brain latency low while busy).
    if (serviced === 0) await new Promise(r => setTimeout(r, POLL_MS));
  }

  if (!resultJson) {
    // Stop any auto-started live screen before bailing so the UI flips to ENDED.
    try { require('./autoLiveScreen').stopSandbox(id); } catch (_) {}
    throw new Error('in-sandbox task timed out after ' + Math.round((Date.now() - started) / 1000) + 's');
  }

  // 7) Materialize deliverables onto the host (the worker base64-encoded them).
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxagent_'));
  const files = [];
  const used = new Set();
  for (const f of (resultJson.files || [])) {
    try {
      let name = String(f.name || 'file').replace(/[^\w.\-]/g, '_');
      let unique = name, n = 1;
      while (used.has(unique)) { unique = name.replace(/(\.[^.]+)?$/, m => `_${n}${m || ''}`); n++; }
      used.add(unique);
      const hostPath = path.join(stageDir, unique);
      fs.writeFileSync(hostPath, Buffer.from(f.b64, 'base64'));
      files.push({ path: hostPath, name: unique });
    } catch (_) {}
  }

  // 8) Cleanup the task's inbox/outbox markers (keep the sandbox + work files).
  // Also stop any auto-started LIVE screen so the UI flips LIVE → ENDED.
  try { require('./autoLiveScreen').stopSandbox(id); } catch (_) {}
  await sb.exec(id, `rm -f ${INBOX}/${taskId}.json ${OUTBOX}/${taskId}.status ${OUTBOX}/${taskId}.terminal ${OUTBOX}/${taskId}.result ${OUTBOX}/${taskId}.lock 2>/dev/null; true`, { timeout: 20 }).catch(() => {});
  if (ACTIVE_TASKS.get(sessionKey)?.taskId === taskId) ACTIVE_TASKS.delete(sessionKey);

  return {
    message: resultJson.message || '✅ Task complete.',
    files,
    steps: resultJson.steps || 0,
    workdir: stageDir,
    // Which AI model produced the final reply (set on the host while servicing
    // the worker's brain requests through the bridge). Lets the bots label it.
    brain: (() => { try { return require('./agentEngine').getLastBrain(); } catch (_) { return null; } })(),
  };
}

// ── File-bridge service: fulfil brain/tool requests the worker dropped ───────
// Lists ready `.req` files in the sandbox bridge dir, and for each: downloads
// it, runs the brain or host tool ON THE HOST (reusing agentEngine), then writes
// the `.resp` back into the sandbox atomically. Returns how many were serviced.
// Uses ONLY the backend's exec/file channel — no sandbox egress required.
//
// `sb` is the active backend module (runloop.js or daytona.js); both expose the
// same exec/uploadFile/downloadFile interface, so the bridge is backend-agnostic.
async function serviceBridgeOnce(sb, id, bridgeDir, onStep, onEvent) {
  // List request files (atomic `.req` only — never the `.req.tmp` being written).
  const ls = await sb.exec(id, `ls -1 ${bridgeDir}/*.req 2>/dev/null | head -20`, { timeout: 20 }).catch(() => null);
  const paths = ((ls && ls.output) || '').split('\n').map(s => s.trim()).filter(p => p && p.endsWith('.req'));
  if (!paths.length) return 0;

  const agentEngine = require('./agentEngine');
  let handled = 0;
  // Service sequentially (the worker issues one brain call at a time per task;
  // multiple tasks would each have their own .req — handling in order is fine).
  for (const reqPath of paths) {
    let payload = null;
    try {
      const buf = await sb.downloadFile(id, reqPath);
      payload = JSON.parse(buf.toString('utf-8'));
    } catch (_) { continue; } // not fully written yet / unreadable → try next cycle

    let out;
    try {
      if (payload.op === 'brain') {
        const text = await agentEngine.brainComplete(payload.system, payload.messages || []);
        out = { text };
      } else if (payload.op === 'tool') {
        out = await agentEngine.runHostTool(payload.tool, payload.args || {}, id, {
          onStep: (n) => { try { if (onStep) onStep(n); } catch (_) {} },
          onEvent: (t, d) => { try { if (onEvent) onEvent(t, d); } catch (_) {} },
        });
      } else {
        out = { error: 'unknown op' };
      }
    } catch (e) {
      out = { error: (e && e.message) || 'bridge service error' };
    }

    // Write the response back atomically: upload to a temp then mv to `.resp`.
    const base = reqPath.replace(/\.req$/, '');
    const writeBack = async () => {
      const respBuf = Buffer.from(JSON.stringify(out), 'utf-8');
      await sb.uploadFile(id, `${base}.resp.tmp`, respBuf, 'resp.json');
      await sb.exec(id, `mv ${base}.resp.tmp ${base}.resp && rm -f ${reqPath}`, { timeout: 20 });
    };
    try {
      await writeBack();
      handled++;
    } catch (e) {
      // SELF-HEAL the "sandbox not found (timeout)" case: the box was reclaimed
      // mid-task, so upload/exec 404s. If the provider can resume/keep it alive,
      // wake it and retry the write-back ONCE before giving up. This turns a
      // fatal "bridge write-back failed" into a transparent recovery so the
      // task keeps running and the worker's result isn't lost.
      const msg = String((e && e.message) || e || '').toLowerCase();
      const reclaimed = /not found|no longer|timeout|404|terminated|suspend|reclaim/.test(msg);
      let recovered = false;
      if (reclaimed) {
        try {
          if (typeof sb.keepAlive === 'function') await sb.keepAlive(id);
          else if (typeof sb.startSandbox === 'function') await sb.startSandbox(id);
          await writeBack();
          recovered = true;
          handled++;
          if (onStep) onStep('🔧 sandbox was reclaimed mid-task — resumed it and recovered.');
        } catch (_) { /* fall through to the warning below */ }
      }
      if (!recovered && onStep) onStep(`⚠️ bridge write-back failed: ${e.message}`);
    }
  }
  return handled;
}

// ── 🔁 Loop-event recording (admin visibility) ───────────────────────────────
// When a sandbox enters a loop, the worker emits a LOOP_DETECTED status line.
// We persist a compact rolling log (last 50 events) to the DB setting
// `agent_loop_events` so an admin can see WHICH chat/sandbox looped and when,
// without trawling the Render logs. Best-effort; never throws.
const LOOP_EVENTS_KEY = 'agent_loop_events';
const LOOP_EVENTS_MAX = 50;

async function recordLoopEvent({ sessionKey, sandboxId, backend, note }) {
  if (!_db || !_db.getSetting || !_db.setSetting) return;
  try {
    let list = [];
    try { list = JSON.parse((await _db.getSetting(LOOP_EVENTS_KEY)) || '[]'); } catch (_) { list = []; }
    if (!Array.isArray(list)) list = [];
    list.unshift({
      at: new Date().toISOString(),
      session: String(sessionKey || ''),
      sandbox: String(sandboxId || ''),
      backend: String(backend || ''),
      note: String(note || '').slice(0, 240),
      aborted: /LOOP_DETECTED/i.test(String(note || '')),
    });
    if (list.length > LOOP_EVENTS_MAX) list = list.slice(0, LOOP_EVENTS_MAX);
    await _db.setSetting(LOOP_EVENTS_KEY, JSON.stringify(list));
  } catch (_) { /* best-effort */ }
}

// Read the recorded loop events (newest first) for the admin panel.
async function getLoopEvents() {
  if (!_db || !_db.getSetting) return [];
  try {
    const list = JSON.parse((await _db.getSetting(LOOP_EVENTS_KEY)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

// ── /stop support: ask a running in-sandbox task to halt ─────────────────────
// Writes a `.agent_stop` flag into the chat's persistent sandbox. The worker
// checks this flag between steps AND mid-shell-command, so it stops promptly
// (a long-running command is killed, the loop exits cleanly). Best-effort: if
// the sandbox can't be reached we just report it so the caller can still clear
// its busy lock. Returns true if the flag was written.
function buildTaskConversation({ history = [], priorAnalysisMemory = '', task = '', attachLine = '' } = {}) {
  const conversation = [];
  const hist = Array.isArray(history) ? history.slice(-12).filter(h => h && h.text) : [];
  if (hist.length) {
    conversation.push({
      role: 'user',
      text: '=== COMPLETED CONVERSATION HISTORY (context only) ===\nEvery request in this block was handled in an earlier turn. Do NOT execute, resume, or redo any of it unless the CURRENT TASK explicitly asks you to.',
    });
    for (const h of hist) {
      const isModel = h.role === 'assistant' || h.role === 'model';
      conversation.push({
        role: isModel ? 'model' : 'user',
        text: `${isModel ? '[past reply]' : '[past request — ALREADY COMPLETED]'} ${String(h.text).slice(0, 4000)}`,
      });
    }
    conversation.push({
      role: 'model',
      text: '[Acknowledged: the history above is completed context only. I will execute only the CURRENT TASK below.]',
    });
  }
  if (String(priorAnalysisMemory || '').trim()) {
    conversation.push({
      role: 'user',
      text: `=== PRIOR ANALYSIS MEMORY (reference facts only; not a task) ===\nUse this only when relevant to the CURRENT TASK. Do not resume any old work from it.\n\n${String(priorAnalysisMemory).slice(0, 24000)}`,
    });
  }
  conversation.push({
    role: 'user',
    text: `=== CURRENT TASK (the one and only request to execute now) ===\nIgnore and do not redo completed requests above. Focus exclusively on this instruction:\n\n${String(task || '')}${String(attachLine || '')}`,
  });
  return conversation;
}

async function requestStop(sessionKey) {
  if (!sessionKey) return false;

  // First target the exact sandbox/task recorded when the run started. This is
  // essential in AUTO mode, where provisioning may have fallen through from
  // Novita to Daytona (or another provider) after the setting was resolved.
  const live = ACTIVE_TASKS.get(sessionKey);
  if (live && live.mod && live.id) {
    try {
      const perTask = live.taskId && live.outbox ? `; date +%s > ${shquote(live.outbox + '/' + live.taskId + '.stop')}` : '';
      await live.mod.exec(live.id, `mkdir -p ${shquote(live.work)} ${shquote(live.outbox || live.work)}; date +%s > ${shquote(live.work + '/.agent_stop')}${perTask}`, { timeout: 20 });
      return true;
    } catch (_) { /* fall through to persisted mapping recovery */ }
  }

  // Recovery path for a host restart or an older run that predates the live
  // registry. Try every configured backend's existing session mapping without
  // creating any sandbox. Do not rely on the current selector.
  for (const name of ORDER) {
    const b = BACKENDS[name];
    if (!b || !b.mod || typeof b.mod.getSessionSandboxId !== 'function') continue;
    try {
      const id = await b.mod.getSessionSandboxId(sessionKey).catch(() => null);
      if (!id) continue;
      const work = pathsFor(b.home).WORK;
      await b.mod.exec(id, `mkdir -p ${shquote(work)} && date +%s > ${shquote(work + '/.agent_stop')}`, { timeout: 20 });
      return true;
    } catch (_) { /* try the next existing mapping */ }
  }
  return false;
}

module.exports = {
  enabled,
  runAgentInSandbox,
  serviceBridgeOnce,
  resolveActiveBackend,
  requestStop,
  clearActiveTask,
  getLoopEvents,
  __test__: { ACTIVE_TASKS, BACKENDS, pathsFor, ensureWorker, buildTaskConversation, expectedToolManifests: EXPECTED_TOOL_MANIFESTS },
  // exposed for the bridge endpoint in server.js:
  verifyToken,
  bridgeUrl,
};
