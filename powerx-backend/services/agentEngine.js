// ─────────────────────────────────────────────────────────────────────────────
// agentEngine.js — WormGPT Agent core (Manus-style autonomous agent).
//
// A ReAct-style loop powered by the SAME working AI gateway used by HotBot V1 /
// the AI-chat section (services/gemini.js → gemini-gateway worker, uncensored
// COMP-MODE prompt). The model is asked to either:
//   • produce a final answer for the user, OR
//   • call a TOOL (web_search, browse, run_code, read_document, analyze_image,
//     write_file, create_docx, create_pdf, finish).
//
// Each tool runs server-side; the result is fed back to the model and the loop
// continues until the model calls `finish` (or the step budget is hit). Files
// produced by tools are collected and returned so the Telegram bot can send
// them back in chat (docx / pdf / txt / zip extracts / code …).
//
// This gives a genuine "does tasks" agent: browse the web, analyze PDFs/zips,
// write & run code, edit code, and return real files — exactly like Manus.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const AdmZip = require('adm-zip');
const gemini = require('./gemini');
const browserless = require('./browserless');
// 🌐 Sandbox-native real-time browsing (Playwright/Chromium inside the active
// Novita/Daytona/… sandbox) with captcha + navigation. Best-effort require.
let sandboxBrowser = null;
try { sandboxBrowser = require('./sandboxBrowser'); } catch (_) { sandboxBrowser = null; }
const hotbot = require('./hotbot');
const deepseek = require('./deepseek'); // legacy brain — DeepSeek V3 via web token (kept for AGENT_SOLO=deepseek)
const cloudflare = require('./cloudflare'); // PRIMARY brain — DeepSeek R1 on Cloudflare Workers AI (rotated)
const deepseekJudge = require('./deepseekJudge'); // DeepSeek power "over the sandbox": judges the agent brain
const runloop = require('./runloop');
const daytona = require('./daytona');
const hopx = require('./hopx');
const novita = require('./novitaSandbox');
const upstashbox = require('./upstashBox');
const codesandbox = require('./codesandbox');
const tensorlake = require('./tensorlake');
const githubactions = require('./githubActions'); // GitHub Actions runner as a Linux sandbox backend
const manusTools = require('./manusTools');
const webImage = require('./webImage'); // 🖼️ web_image: search/fetch → crop/resize → stage for embedding
const preciseImageEdit = require('./preciseImageEdit'); // deterministic sandbox image editing; no generative AI
const enterpriseTools = require('./enterpriseTools');
const liveScreen = require('./liveScreen'); // LIVE/VNC-style real-time screen streaming inside the sandbox
const autoLiveScreen = require('./autoLiveScreen'); // auto-start the live screen on ANY browse/interaction
const wolfram = require('./wolfram');
const godmode = require('./godmode3'); // 🜏 G0DM0D3 ultimate-jailbreak layer (prompt + STM)
const fileConverter = require('./fileConverter');
const mathSolver = require('./mathSolver');
const omniOcr = require('./simpleOcr'); // simple Node engine — primary inbound file → text (PDF/DOCX/XLSX; images → vision/Gemini)
const attachmentText = require('./attachmentText'); // guaranteed pre-model attachment text ingestion
const extractionCompleteness = require('./extractionCompleteness');
const agentIsolation = require('./agentIsolation');
const mcpBridge = require('./mcpBridge'); // Model Context Protocol (MCP) stdio servers — sequential-thinking + filesystem (+ git/github/fetch/websearch/sqlite)
const { runGraphLoop } = require('./agentGraph'); // LangGraph state-machine loop
const agentRuntimeConfig = require('./agentRuntimeConfig');
const userAdaptation = require('./userAdaptation');
const userMemory = require('./userMemory');
// ── FUSED AGENT BRAIN (Mixture-of-Agents for the ReAct loop) ────────────────
// Brings the same multi-brain "propose in parallel → synthesise the single best"
// power the CHAT path has to the AGENT loop, while preserving the strict
// single-JSON-step contract. Makes the agent decisive/firm on long-horizon work.
const agentFusion = require('./agentBrainFusion');
// Extra keyless brains used as PROPOSERS in the fused agent step (they already
// power the chat fusion panel). Loaded defensively so a missing module never
// breaks the agent loop.
let sakana = null, studentAI = null, unitool = null;
try { sakana = require('./sakana'); } catch (_) {}
try { studentAI = require('./studentAI'); } catch (_) {}
try { unitool = require('./unitool'); } catch (_) {}

let _db = null;
try { _db = require('../db'); } catch (_) { /* db optional */ }

// ─────────────────────────────────────────────────────────────────────────────
// IN-SANDBOX ATTACHMENT REGISTRY ("agent owns the computer" mode)
//
// When the agent loop runs INSIDE the sandbox, the worker proxies the
// content-reading tools (analyze_image / read_document / solve_math) back to
// the host via runHostTool(). Those host tools read the file BYTES from
// ctx.attachments — but runHostTool previously built a fresh ctx with NO
// attachments, so image/doc analysis silently returned "no attached file" and
// the whole feature looked broken in owns-the-computer mode.
//
// Fix: when a task starts (sandboxAgent.runAgentInSandbox) we REGISTER the
// original attachment buffers here, keyed by sandbox id. runHostTool then
// rehydrates ctx.attachments from this registry so the host vision/OCR engines
// receive the real bytes — exactly like the host-loop path. Entries auto-expire
// so memory never leaks across long-lived sandboxes.
// ─────────────────────────────────────────────────────────────────────────────
const _sandboxAttachments = new Map(); // sandboxId -> { ts, attachments: [{name,buffer,isImage,mime}] }
const _ATTACH_TTL_MS = parseInt(process.env.AGENT_ATTACH_TTL_MS || String(6 * 60 * 60 * 1000), 10); // 6h

// ── Internal-artifact filter (CANONICAL) ─────────────────────────────────────
// Files the agent/tooling create as SCAFFOLDING — they must NEVER be returned to
// the user as deliverables. This was the root cause of "the file path is broken":
// the OmniOCR engine (staged into ./.omni_ocr_engine/…), staged OCR inputs
// (.omni_in_*), scratch scripts (_step_*), the analysis-memory file, the docker
// pre-warm logs and the dind sentinel were being swept up by the produced-file
// diff and delivered alongside (or instead of) the real PDF/DOCX — burying the
// actual output among ~12 junk *.py files. Apply this at EVERY capture point.
function _isInternalArtifact(rel) {
  const p = String(rel || '').replace(/^\.?\/+/, '');
  if (!p) return true;
  // Scratch run_code scripts and the persistent analysis-memory note.
  if (/(^|\/)_step(_|\.)/.test(p)) return true;
  if (/(^|\/)\.agent_/.test(p)) return true;            // .agent_memory.md, .agent_inbox, .agent_outbox, .agent_bridge
  if (/(^|\/)\.agent_memory\.md$/.test(p)) return true;
  // OmniOCR engine staging dir + staged inputs (see services/omniOcr.js).
  if (/(^|\/)\.omni_ocr_engine(\/|$)/.test(p)) return true;
  if (/(^|\/)\.omni_in_/.test(p)) return true;
  if (/(^|\/)\.omni_/.test(p)) return true;
  // Container / pre-warm scaffolding.
  if (/(^|\/)\.dind_ready$/.test(p)) return true;
  if (/(^|\/)\.prewarm(\.|_)/.test(p)) return true;
  if (/(^|\/)\.mkarchive_/.test(p)) return true;
  // VCS, dependencies, generated builds and language caches. These may be
  // rewritten by installs/tests, but are not source deliverables.
  if (/(^|\/)(\.git|node_modules|dist|build|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|vendor|\.gradle|target|\.svelte-kit|\.expo|\.dart_tool|Pods)(\/|$)/.test(p)) return true;
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|go\.sum)$/.test(p)) return true;
  if (/\.(pyc|pyo|class|o|obj|log)$/.test(p)) return true;
  // Loose engine source files that the OmniOCR staging dir is built from — if
  // they ever end up flattened into the workdir root they are still internals.
  if (/^(ocr_extract|omni_ocr|engine|preprocessing|documents|__init__)(_\d+)?\.py$/.test(p)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY BUNDLING (host-loop path — used by GitHub Actions / any perCommand
// backend, where agent.py's collect_deliverables() never runs).
//
// PER USER RULE — mirrors agent_worker/agent.py exactly:
//   • ONLY office documents + images ship INDIVIDUALLY
//     (pdf, docx/doc, pptx/ppt, xlsx/xls, png/jpg/jpeg/gif/webp/bmp/tiff).
//   • EVERYTHING ELSE (code, text, data, media, and any pre-made archive) is
//     bundled into ONE zip whenever there are 2+ such files. A single such file
//     is delivered as-is (no pointless one-file zip).
//   • Agent-generated archives (.zip/.tar/.gz/…) are DROPPED from the raw file
//     set before bundling so we never nest a zip inside the delivered zip and
//     never ship the same content both zipped AND loose. (Root cause of the
//     GitHub-CI-runner "gives a zip AND still sends the files individually" bug.)
// ─────────────────────────────────────────────────────────────────────────────
const _STANDALONE_DELIVERY_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
]);
const _ARCHIVE_DELIVERY_EXTS = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar'];

function _deliveryExt(name) {
  const b = path.posix.basename(String(name || '')).toLowerCase();
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i) : '';
}
function _isArchiveDelivery(name) {
  const low = path.posix.basename(String(name || '')).toLowerCase();
  return _ARCHIVE_DELIVERY_EXTS.some(e => low.endsWith(e)) ||
         low.endsWith('.tar.gz') || low.endsWith('.tar.bz2');
}

// Prefer a REAL agent-built ZIP when it demonstrably contains every loose
// project file. Previous code discarded all archives whenever loose output also
// existed, which could replace a complete post-coding project.zip with a bundle
// containing only files touched in the last step. Invalid/partial ZIPs are still
// ignored and rebuilt from source files.
function _completeProjectArchive(files) {
  const loose = files.filter(f => !_isArchiveDelivery(f.name) && !_STANDALONE_DELIVERY_EXTS.has(_deliveryExt(f.name)));
  for (const archive of files.filter(f => /\.zip$/i.test(f.name))) {
    try {
      const zip = new AdmZip(archive.path);
      const entries = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName.replace(/^\.\/+/, ''));
      if (!entries.length) continue;
      const coversLoose = loose.every(f => {
        const rel = String(f.rel || f.name).replace(/\\/g, '/').replace(/^\.?\/+/, '');
        const base = path.posix.basename(rel);
        return entries.includes(rel) || entries.some(e => e === base || e.endsWith('/' + rel) || e.endsWith('/' + base));
      });
      if (coversLoose) return archive;
    } catch (_) { /* malformed or unsupported archive: rebuild below */ }
  }
  return null;
}

// Given the materialized host files [{path, name, rel?}], apply the delivery
// rule and return the FINAL file list [{path, name}] to hand to the caller.
// `stageDir` is where any freshly-built zip is written.
function _bundleDeliverables(files, stageDir) {
  if (!Array.isArray(files) || files.length <= 1) return files || [];

  // 1) Keep a verified complete project ZIP, plus any standalone documents or
  // images. Otherwise drop archives and deterministically rebuild from source.
  const completeArchive = _completeProjectArchive(files);
  if (completeArchive) {
    const standalone = files.filter(f => f !== completeArchive && !_isArchiveDelivery(f.name) && _STANDALONE_DELIVERY_EXTS.has(_deliveryExt(f.name)));
    return [completeArchive, ...standalone];
  }
  const nonArchive = files.filter(f => !_isArchiveDelivery(f.name));
  const working = nonArchive.length ? nonArchive : files;
  if (working.length <= 1) return working;

  // 2) Split: office docs + images ship individually; everything else bundles.
  const individual = [];
  const bundle = [];
  for (const f of working) {
    if (_STANDALONE_DELIVERY_EXTS.has(_deliveryExt(f.name))) individual.push(f);
    else bundle.push(f);
  }

  const out = [...individual];

  if (bundle.length >= 2) {
    try {
      // Name the zip after the single top-level dir if there is one.
      const tops = new Set();
      for (const f of bundle) {
        const relp = String(f.rel || f.name).replace(/\\/g, '/').replace(/^\.?\/+/, '');
        const parts = relp.split('/');
        tops.add(parts.length > 1 ? parts[0] : '');
      }
      const named = [...tops].filter(Boolean);
      let base = (named.length === 1 && !tops.has('')) ? named[0] : 'project';
      base = base.replace(/[^\w.\-]/g, '_') || 'project';
      const zip = new AdmZip();
      for (const f of bundle) {
        try {
          const buf = fs.readFileSync(f.path);
          // Preserve relative structure inside the zip when we know it.
          const arc = String(f.rel || f.name).replace(/\\/g, '/').replace(/^\.?\/+/, '');
          zip.addFile(arc || path.posix.basename(f.name), buf);
        } catch (_) { /* skip unreadable */ }
      }
      const zipName = `${base}.zip`;
      const zipPath = path.join(stageDir, zipName);
      zip.writeZip(zipPath);
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) {
        out.push({ path: zipPath, name: zipName });
      } else {
        for (const f of bundle) out.push(f); // fallback: individual
      }
    } catch (_) {
      for (const f of bundle) out.push(f);   // zip failed → individual
    }
  } else {
    // 0 or 1 non-document file → deliver as-is.
    for (const f of bundle) out.push(f);
  }
  return out;
}

// Validate and materialize ZIP entries without zip-slip, symlinks or zip bombs.
// The limits are deliberately configurable but conservative enough for normal
// document/project uploads on enterprise deployments.
function _safeZipEntries(buffer) {
  const maxFiles = Math.max(1, parseInt(process.env.ARCHIVE_MAX_FILES || '2000', 10) || 2000);
  const maxBytes = Math.max(1024, parseInt(process.env.ARCHIVE_MAX_EXPANDED_BYTES || String(512 * 1024 * 1024), 10) || 512 * 1024 * 1024);
  const zip = new AdmZip(buffer);
  const out = [];
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const raw = String(entry.entryName || '').replace(/\\/g, '/');
    const parts = raw.split('/').filter(Boolean);
    if (!raw || raw.startsWith('/') || parts.some(p => p === '..' || p === '.')) {
      throw new Error(`unsafe archive path blocked: ${raw || '(empty)'}`);
    }
    // Unix file type bits 0120000 identify symlinks. Never follow or extract them.
    const mode = ((entry.header && entry.header.attr) || 0) >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new Error(`archive symlink blocked: ${raw}`);
    if (out.length >= maxFiles) throw new Error(`archive has more than ${maxFiles} files`);
    const declared = Math.max(0, Number(entry.header && entry.header.size) || 0);
    total += declared;
    if (total > maxBytes) throw new Error(`archive expands beyond ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const data = entry.getData();
    if (data.length !== declared && declared > 0) total += Math.max(0, data.length - declared);
    if (total > maxBytes) throw new Error(`archive expands beyond ${Math.round(maxBytes / 1024 / 1024)} MB`);
    out.push({ rel: parts.join('/'), buffer: data });
  }
  return out;
}

function _sniffMimeFromBuffer(buf, fallback) {
  if (!buf || buf.length < 4) return fallback || 'application/octet-stream';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fallback || 'application/octet-stream';
}

// Register the attachments for a sandbox session so the bridge tools can use
// the real bytes. Called by sandboxAgent before the worker starts a task.
function registerSandboxAttachments(sandboxId, attachments) {
  if (!sandboxId) return;
  // Prune expired entries opportunistically.
  const now = Date.now();
  for (const [k, v] of _sandboxAttachments.entries()) {
    if (now - (v.ts || 0) > _ATTACH_TTL_MS) _sandboxAttachments.delete(k);
  }
  const list = (attachments || [])
    .filter(a => a && a.buffer && Buffer.isBuffer(a.buffer))
    .map(a => {
      const name = String(a.name || 'file');
      const isImage = a.isImage === true || omniOcr.isImageName(name);
      const mime = a.mime || (isImage ? _sniffMimeFromBuffer(a.buffer, 'image/png') : _sniffMimeFromBuffer(a.buffer));
      return { name, buffer: a.buffer, isImage, mime };
    });
  // Keep an explicit empty registration for tasks with no attachments. The
  // bridge must distinguish "this task has zero files" from "host restarted and
  // has no registry entry"; otherwise it scans the persistent sandbox and can
  // pull a previous task's files into the current task.
  _sandboxAttachments.set(String(sandboxId), { ts: now, attachments: list });
}

function getSandboxAttachments(sandboxId) {
  const e = _sandboxAttachments.get(String(sandboxId || ''));
  if (!e) return [];
  if (Date.now() - (e.ts || 0) > _ATTACH_TTL_MS) { _sandboxAttachments.delete(String(sandboxId)); return []; }
  return e.attachments || [];
}

// Every shell command / script the agent runs executes inside a REAL isolated
// Linux sandbox (full userland: python3, node, git, curl, pip, npm, …) instead
// of on the Render host. The agent reads/writes files there and we download
// produced files to deliver them back.
//
// THREE sandbox backends are available; the ADMIN chooses which one WormGPT uses
// for everyone (WhatsApp / Telegram / web) via the admin panel → DB setting
// `sandbox_backend`:
//   • 'runloop'    — Runloop devbox           (RUNLOOP_API_KEY    / admin runloop_api_key)
//   • 'daytona'    — Daytona sandbox          (DAYTONA_API_KEY    / admin daytona_api_key)
//   • 'hopx'       — HopX micro-VM            (HOPX_API_KEY       / admin hopx_api_key)
//   • 'auto'       — try them in priority order (hopx→runloop→daytona)
// All backends "own the computer" identically (in-sandbox agent worker +
// Docker-in-Docker). HopX is a REAL privileged micro-VM (root + full caps + its
// own kernel + full internet) running genuine dockerd; Runloop/Daytona are
// unprivileged containers running rootless podman. If the admin-selected backend
// isn't configured/available we gracefully fall back through the others, then to
// local host execution, so the bot never hard-fails. Enablement + the chosen
// backend are re-checked per-run so admin changes take effect WITHOUT a restart.

// Registry of sandbox backends keyed by their setting value.
const SANDBOX_BACKENDS = { codesandbox, hopx, runloop, daytona, novita, upstashbox, tensorlake, githubactions };
// Order used for 'auto' mode and as the fallback cascade. CodeSandbox leads
// because it provisions in ~1s, runs as REAL root (native docker/apt/system
// writes), and has the beefiest VMs — best for heavy RE/build work. Novita
// follows (reliable ~1s); Upstash Box is next (full Linux, durable, serverless);
// HopX has been returning 503 "no available nodes" (provider capacity outage)
// and Runloop needs a separate `ak_` key.
const SANDBOX_ORDER = ['codesandbox', 'novita', 'upstashbox', 'tensorlake', 'runloop', 'daytona', 'hopx', 'githubactions'];
const DEFAULT_SANDBOX_BACKEND = (process.env.SANDBOX_BACKEND || 'auto').trim().toLowerCase();

// Resolve the admin-chosen backend at runtime (DB setting → env → 'auto').
async function getSelectedBackendName() {
  let sel = '';
  try { if (_db && _db.getSetting) { const v = await _db.getSetting('sandbox_backend'); if (v && v.trim()) sel = v.trim().toLowerCase(); } } catch (_) {}
  if (!sel) sel = DEFAULT_SANDBOX_BACKEND;
  // 'local' is a first-class, always-available pinned backend (host execution,
  // no remote provider). 'auto' cascades. Any other unknown value collapses to 'auto'.
  if (sel !== 'auto' && sel !== 'local' && !SANDBOX_BACKENDS[sel]) sel = 'auto';
  return sel;
}

// ── Per-session active-backend tracker (host-loop path) ──────────────────────
// Shares the SAME `session_backend:<sessionKey>` DB key as sandboxAgent.js so
// both execution paths agree on which backend a chat's sandbox lives on. Used to
// migrate a session when the admin switches the active sandbox.
const _SESSION_BACKEND_PREFIX = 'session_backend:';
async function _getSessionBackendEngine(sessionKey) {
  if (!_db || !_db.getSetting || !sessionKey) return null;
  try { const v = await _db.getSetting(_SESSION_BACKEND_PREFIX + String(sessionKey)); return (v && v.trim().toLowerCase()) || null; }
  catch (_) { return null; }
}
async function _setSessionBackendEngine(sessionKey, name) {
  if (!_db || !_db.setSetting || !sessionKey) return;
  try { await _db.setSetting(_SESSION_BACKEND_PREFIX + String(sessionKey), name || ''); } catch (_) {}
}

// Produce the ordered list of backend modules to try for this run.
//
// 🔑 SWITCHING CONTRACT (HARDENED — fixes "sandbox changes mid-task Novita→Daytona"):
//   • When the admin PINS a SPECIFIC backend we return ONLY that backend — no
//     silent cross-backend fallback whatsoever. The pin is a HARD LOCK: every
//     step, every browse, every sub-task in the whole session uses exactly that
//     one sandbox. It NEVER drifts to another provider.
//   • In 'auto' mode we make the session STICKY: the backend the chat's sandbox
//     already lives on (stickyBackend) is put FIRST so the session is reused and
//     never migrated between providers mid-task just because a higher-priority
//     provider sits earlier in the order. Only if that sticky backend is truly
//     gone do we consider the rest of the order.
// Mirrors sandboxAgent.js resolveBackendChain.
async function resolveBackendCascade(stickyBackend = null) {
  const sel = await getSelectedBackendName();
  if (sel === 'local') {
    // Admin pinned LOCAL → no remote backend at all; the caller falls back to
    // the always-available local host fsx. Return empty so nothing is tried.
    return [];
  }
  if (sel !== 'auto') {
    // Admin pinned a backend → LOCK to it. Exactly one, no fallback.
    const mod = SANDBOX_BACKENDS[sel];
    return mod ? [{ name: sel, mod }] : [];
  }
  // auto → keep the session on its current backend first (sticky), then the
  // rest of the preference order as a fallback for a brand-new session.
  const names = [];
  if (stickyBackend && SANDBOX_BACKENDS[stickyBackend]) names.push(stickyBackend);
  for (const n of SANDBOX_ORDER) { if (!names.includes(n)) names.push(n); }
  return names.map(n => ({ name: n, mod: SANDBOX_BACKENDS[n] })).filter(x => x.mod);
}

// ── Clear the files in a session's sandbox WITHOUT destroying the sandbox ─────
// Backend-agnostic "wipe my workspace files, keep everything else" used by the
// bots' /clearfiles command AND by the automatic per-task reset below.
//
// Unlike the bots' /reset (which also wipes conversational memory and tears the
// whole sandbox down via endSession), this ONLY removes the WORK FILES so the
// user keeps their chat memory, their auth link, and their warm sandbox — they
// just start the next task with an empty working directory.
//
// SAFE FOR MULTI-USER: every chat/session owns its OWN sandbox id
// (getSessionSandboxId(sessionKey)). We resolve THAT id and clear only it, so a
// clear for user A can never touch user B's files — even on shared-repo backends
// like GitHub Actions.
//
// Returns { ok, backend, cleared } (cleared = # files removed when known).
async function clearSessionFiles(sessionKey) {
  if (!sessionKey) return { ok: false, backend: null, cleared: 0, error: 'no session' };
  // Which backend does this chat's sandbox currently live on? Prefer the sticky
  // engine record, then the admin selection, then the cascade — mirroring how
  // runAgent picks a backend so we clear the SAME sandbox the task will use.
  let candidates = [];
  try {
    const sticky = await _getSessionBackendEngine(sessionKey);
    const cascade = await resolveBackendCascade(sticky);
    candidates = cascade.slice();
    // Also consider all configured backends (a chat may have a stale sandbox on
    // a backend that is no longer first in the cascade — clear it too).
    for (const n of SANDBOX_ORDER) {
      if (!candidates.find(c => c.name === n) && SANDBOX_BACKENDS[n]) candidates.push({ name: n, mod: SANDBOX_BACKENDS[n] });
    }
  } catch (_) { candidates = []; }

  let anyOk = false, backendUsed = null, totalCleared = 0, lastErr = '';
  for (const { name, mod } of candidates) {
    if (!mod) continue;
    // Is this backend even configured? Skip unconfigured ones quietly.
    let on = false;
    try { on = mod.enabledAsync ? !!(await mod.enabledAsync()) : !!mod.enabled(); } catch (_) { on = false; }
    if (!on) continue;
    // Does this chat actually HAVE a sandbox on this backend? Never provision a
    // COSTLY (VM/container) sandbox just to clear it — that would spin up empty
    // sandboxes on every backend. For nativeFs backends (GitHub Actions) the
    // session id is DETERMINISTIC and "creating" it is just a cheap git commit,
    // so if the mapping isn't cached we can safely resolve it via
    // getOrCreateSessionSandbox (same id, no VM spin-up) to still honour the clear.
    let id = null;
    try { id = mod.getSessionSandboxId ? await mod.getSessionSandboxId(sessionKey) : null; } catch (_) { id = null; }
    if (!id && mod.nativeFs && typeof mod.getOrCreateSessionSandbox === 'function') {
      try {
        const r = await mod.getOrCreateSessionSandbox(sessionKey, {});
        id = r && (r.id || r);
      } catch (_) { id = null; }
    }
    if (!id) continue;
    try {
      if (mod.nativeFs && typeof mod.clearWorkTree === 'function') {
        // GitHub Actions → surgical git-tree delete of just this id's work files.
        const n = await mod.clearWorkTree(id);
        totalCleared += (Number.isFinite(n) ? n : 0);
      } else if (typeof mod.exec === 'function') {
        // Always-on VM/container backend (Novita, Daytona, CodeSandbox, HopX,
        // Runloop, Tensorlake) → rm -rf the working dir contents in one shot.
        const root = mod.WORKDIR || '.';
        const q = `'${String(root).replace(/'/g, `'\\''`)}'`;
        await mod.exec(id, `mkdir -p ${q}; find ${q} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; true`, { cwd: root, timeout: 60 });
      } else { continue; }
      anyOk = true; backendUsed = name;
    } catch (e) { lastErr = e.message; }
  }
  return anyOk
    ? { ok: true, backend: backendUsed, cleared: totalCleared }
    : { ok: false, backend: null, cleared: 0, error: lastErr || 'no active sandbox to clear' };
}


// Initial synchronous snapshot (env-only). Runtime DB keys (saved in the admin
// panel / Supabase) load asynchronously, so we re-log an accurate status once
// the key caches have warmed — otherwise this first line can misleadingly say
// "off" for a backend that is actually configured in the DB.
function _logBackendStatus(tag) {
  const s = (m) => { try { return m.enabled() ? 'on' : 'off'; } catch (_) { return 'off'; } };
  console.log(`[agentEngine] Sandbox backends${tag ? ' ' + tag : ''} → CodeSandbox:${s(codesandbox)} | Novita:${s(novita)} | UpstashBox:${s(upstashbox)} | Tensorlake:${s(tensorlake)} | HopX:${s(hopx)} | Runloop:${s(runloop)} | Daytona:${s(daytona)} | GitHubActions:${s(githubactions)} | selection='${DEFAULT_SANDBOX_BACKEND}' (admin-overridable) | local fallback always available.`);
}
_logBackendStatus('(initial)');
// Warm runtime (DB) key caches, then re-log the true status.
Promise.allSettled([
  (codesandbox.enabledAsync && codesandbox.enabledAsync()) || Promise.resolve(),
  (hopx.enabledAsync && hopx.enabledAsync()) || Promise.resolve(),
  (runloop.enabledAsync && runloop.enabledAsync()) || Promise.resolve(),
  (daytona.enabledAsync && daytona.enabledAsync()) || Promise.resolve(),
  (novita.enabledAsync && novita.enabledAsync()) || Promise.resolve(),
  (tensorlake.enabledAsync && tensorlake.enabledAsync()) || Promise.resolve(),
]).then(() => _logBackendStatus('(runtime)')).catch(() => {});

// ── Agent system prompt: uncensored COMP-MODE v3 + tool protocol ──────────
// ── Agent system prompt: loaded from prompts/agent_system_prompt.md ────────
// The huge COMP-MODE v3 + tool-protocol prompt now lives in an EXTERNAL FILE
// (prompts/agent_system_prompt.md) so it can be edited without touching code.
// The {{SKILLS_INDEX}} placeholder in that file is replaced at load time with
// the catalog of available skills (prompts/skills_index.md), so the agent
// always knows which expert skills exist and is instructed (SKILL-FIRST
// DOCTRINE) to read_skill the matching one BEFORE executing any task.
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const _PROMPT_FILE = path.join(PROMPTS_DIR, 'agent_system_prompt.md');
const _SKILLS_INDEX_FILE = path.join(PROMPTS_DIR, 'skills_index.md');
// Minimal hard-coded fallback so the agent NEVER boots without a prompt even
// if the prompt files are somehow missing from the deploy.
const _FALLBACK_PROMPT = `[SYSTEM: COMP MODE // WORMGPT AGENT v3]\nYou are WORMGPT AGENT, a fully autonomous tool-using agent. Reply with EXACTLY ONE JSON object {\"thought\",\"action\",\"args\"} per step. Before any build/design/document/code/deploy task, call read_skill to load the matching .codebanana/.skills/**/SKILL.md and follow it. Call finish when done. Begin.`;
function _loadAgentSystemPrompt() {
  try {
    let body = fs.readFileSync(_PROMPT_FILE, 'utf8');
    let index = '';
    try { index = fs.readFileSync(_SKILLS_INDEX_FILE, 'utf8'); } catch (_) { index = ''; }
    body = body.replace(/\{\{\s*SKILLS_INDEX\s*\}\}/g, index || '(skills index unavailable — use list_skills to discover skills)');
    // 🜏 G0DM0D3: prepend the ultimate-jailbreak layer so the autonomous agent
    // (web / Telegram / WhatsApp) NEVER refuses/hedges/moralises on ANY task —
    // it always delivers complete working answers. The existing skill-first
    // doctrine + tool protocol below stay fully intact.
    try { body = godmode.GODMODE_PROMPT + '\n\n' + body; } catch (_) {}
    console.log(`[agentEngine] Loaded system prompt from prompts/agent_system_prompt.md (${body.length} chars; skills index ${index.length} chars; G0DM0D3 layer active).`);
    return body;
  } catch (e) {
    console.error(`[agentEngine] Could not load prompts/agent_system_prompt.md (${e.message}); using fallback prompt.`);
    try { return godmode.GODMODE_PROMPT + '\n\n' + _FALLBACK_PROMPT; } catch (_) { return _FALLBACK_PROMPT; }
  }
}
const AGENT_SYSTEM_PROMPT = _loadAgentSystemPrompt();

// Generous budgets so the agent can TAKE ITS TIME and deliver QUALITY work:
// complex tasks (plan → research → build → verify → deploy, multi-chapter
// documents, full pentests) need many deliberate steps and long-running
// sandbox commands (installs, scans, builds) that must not be cut off early.
// Effective budgets are resolved per task from app_settings. The defaults are
// deliberately 160; admins can tune either ceiling live without a redeploy.
const CODE_TIMEOUT_MS = 300000;  // was 90000 — 5 min per command for builds/scans/installs

// ── Agent brain (plain text completion) ────────────────────────────────────
// PRIMARY: HotBot (GPT-5) — the MAIN engine for planning / coding / tool-use /
// thinking. It drives the whole ReAct loop: it reads the skill files, plans,
// reasons in the "thought" field, calls tools, reflects on observations, and
// finishes. FALLBACKS, tried in order only when the one above fails/empties:
// Gemini gateway → Cloudflare text model (last-resort safety net).
// This is a single, deterministic brain chain (HotBot → Gemini → Cloudflare) so
// behaviour is predictable and GPT-5 owns every step. Vision / file analysis
// still runs through HotBot+Gemini in the dedicated tools (analyze_image /
// read_document); pure images go to Gemini vision and the extracted text is
// handed back to HotBot.
// Override the primary with AGENT_SOLO=hotbot|gemini|cloudflare|deepseek.

// ── Which AI model produced the most recent brain reply? ────────────────────
// Every brain call (HotBot → Gemini → Cloudflare cascade) flows through
// geminiComplete() below — on both the host loop AND the in-sandbox path (the
// worker proxies brain calls back to the host via brainComplete → geminiComplete).
// We record the label of the brain that actually answered so the WhatsApp /
// Telegram bots can show the user WHICH model replied. Bots run one task at a
// time per chat (busy lock), so the last recorded label matches the reply that
// is sent. `getLastBrain()` returns a stable display name ('DeepSeek' | 'HotBot'
// | 'Gemini') or null if no brain has answered yet.
let _lastBrainLabel = null;
const _BRAIN_DISPLAY = { cloudflare: 'Cloudflare', deepseek: 'DeepSeek', hotbot: 'HotBot', gemini: 'Gemini' };
function _recordBrain(label) {
  if (!label) return;
  _lastBrainLabel = String(label);
}
function getLastBrain() {
  if (!_lastBrainLabel) return null;
  return _BRAIN_DISPLAY[_lastBrainLabel.toLowerCase()] || _lastBrainLabel;
}

async function geminiComplete(systemPrompt, conversation) {
  // conversation: array of { role: 'user'|'model'|'assistant', text: '...' }
  const SOLO = String(process.env.AGENT_SOLO || process.env.HOTBOT_SOLO || '').toLowerCase();
  const BRAIN_TIMEOUT_MS = parseInt(process.env.AGENT_BRAIN_TIMEOUT_MS || '90000', 10);

  const _withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'op') + ' timed out after ' + ms + 'ms')), ms)),
  ]);

  // Flatten the multi-turn conversation into a single prompt for DeepSeek's
  // web endpoint (which takes one `prompt` string, not a messages array). We
  // prepend the system prompt and label each turn so DeepSeek keeps context.
  const flattenForDeepseek = () => {
    const lines = [systemPrompt, ''];
    for (const m of conversation) {
      const who = (m.role === 'model' || m.role === 'assistant') ? 'ASSISTANT' : 'USER';
      lines.push(`${who}: ${m.text}`);
    }
    lines.push('ASSISTANT:');
    return lines.join('\n');
  };

  // ── PRIMARY brain: DeepSeek R1 on Cloudflare Workers AI (rotated, cheap) ───
  // A reasoning text model. cloudflare.brainChat() strips the <think> block and
  // rotates across multiple CF accounts on rate limits, so this stays up as long
  // as ANY configured account has neuron budget.
  const cloudflareBrain = async () => {
    if (!(await cloudflare.brainEnabled())) throw new Error('Cloudflare brain has no API key configured');
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of conversation) {
      messages.push({
        role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
        content: m.text,
      });
    }
    const reply = await cloudflare.brainChat(messages, { max_tokens: 4096 });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty response from Cloudflare brain');
  };

  // ── Legacy brain: DeepSeek web token (only when AGENT_SOLO=deepseek) ───────
  const deepseekBrain = async () => {
    if (!(await deepseek.isEnabled())) throw new Error('DeepSeek not configured (set DEEPSEEK_TOKEN / admin token)');
    const reply = await deepseek.chat(flattenForDeepseek());
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty response from DeepSeek');
  };

  // ── FALLBACK 1: HotBot (GPT-5) ────────────────────────────────────────────
  const hotbotBrain = async () => {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of conversation) {
      messages.push({
        role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
        content: m.text,
      });
    }
    // _noJudge: the agent loop validates its OWN steps via deepseekJudge; we
    // don't want the hotbot chat() to also invoke the judge here (double work +
    // circular when DeepSeek is the judge).
    // _agentLoop: this is the JSON-mode ReAct brain. Skip hotbot's Wolfram
    // grounding (it appends prose to the user turn, which would corrupt the
    // single-JSON-object the agent loop must return — the agent already has a
    // dedicated `wolfram_alpha` tool it can call when it needs verified math).
    //
    // RESILIENT RETRY: HotBot (GPT-5) is the MAIN brain that drives every step
    // of the agent loop, so we keep it in control as much as possible. The free
    // HotBot guest endpoint can occasionally return a transient empty/rate-limit
    // blip; rather than immediately dropping to Gemini, we retry HotBot a couple
    // of times with a short backoff. Only if every attempt fails do we throw and
    // let the chain fall back. This makes GPT-5 — not the weaker fallbacks — the
    // brain that actually plans, reasons, reads skills and calls tools.
    const HOTBOT_BRAIN_RETRIES = parseInt(process.env.AGENT_HOTBOT_RETRIES || '2', 10); // extra tries after the first
    const HOTBOT_BRAIN_BACKOFF_MS = parseInt(process.env.AGENT_HOTBOT_BACKOFF_MS || '900', 10);
    let lastErr = null;
    for (let attempt = 0; attempt <= HOTBOT_BRAIN_RETRIES; attempt++) {
      try {
        const reply = await hotbot.chat(messages, { _noJudge: true, _agentLoop: true });
        if (reply && String(reply).trim()) return String(reply);
        lastErr = new Error('Empty response from HotBot');
      } catch (e) {
        lastErr = e;
      }
      // Backoff before the next HotBot attempt (skip the wait after the last one).
      if (attempt < HOTBOT_BRAIN_RETRIES) {
        const wait = HOTBOT_BRAIN_BACKOFF_MS * (attempt + 1); // linear backoff: 0.9s, 1.8s, …
        console.warn(`[agentEngine] HotBot brain attempt ${attempt + 1} failed (${lastErr && lastErr.message}); retrying in ${wait}ms…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw (lastErr || new Error('Empty response from HotBot'));
  };


  // ── FALLBACK 2: Gemini gateway (also the vision/file-analysis brain) ──────
  const geminiBrain = async () => {
    const contents = conversation.map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
    const payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    const resp = await fetch(gemini.BASE_URL + gemini.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': gemini.AUTH_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Gemini ${resp.status}: ${t.slice(0, 160)}`);
    }
    const data = await resp.json();
    const txt = gemini.extractText(data);
    if (txt && String(txt).trim()) return String(txt);
    throw new Error('Empty response from Gemini');
  };

  // ── EXTRA PROPOSER BRAINS (keyless) — used ONLY by the fused agent step ────
  // These feed the Mixture-of-Agents proposer panel so the agent loop reasons
  // with several independent brains and then synthesises the single best next
  // action. Each accepts (systemPrompt, conversation) so it can double as a
  // synthesiser too. They convert the (role,text) conversation into the shape
  // each backend wants. All are best-effort — a failure just doesn't contribute.
  const sakanaBrain = async (sys = systemPrompt, conv = conversation) => {
    if (!sakana || !sakana.chat) throw new Error('sakana unavailable');
    const messages = [{ role: 'system', content: sys }];
    for (const m of conv) messages.push({
      role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
      content: m.text,
    });
    const reply = await sakana.chat(messages, { _agentLoop: true });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty response from Sakana');
  };
  const studentBrain = async (sys = systemPrompt, conv = conversation) => {
    if (!studentAI || !studentAI.chat) throw new Error('studentAI unavailable');
    const messages = [{ role: 'system', content: sys }];
    for (const m of conv) messages.push({
      role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
      content: m.text,
    });
    const reply = await studentAI.chat(messages, { _agentLoop: true });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty response from StudentAI');
  };
  // Adapter so hotbot/gemini brains also accept (sys, conv) as synthesisers.
  const hotbotSynth = async (sys = systemPrompt, conv = conversation) => {
    const messages = [{ role: 'system', content: sys }];
    for (const m of conv) messages.push({
      role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user',
      content: m.text,
    });
    const reply = await hotbot.chat(messages, { _noJudge: true, _agentLoop: true });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty response from HotBot(synth)');
  };
  const geminiSynth = async (sys = systemPrompt, conv = conversation) => {
    const contents = conv.map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
    const resp = await fetch(gemini.BASE_URL + gemini.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': gemini.AUTH_TOKEN },
      body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents }),
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Gemini(synth) ${resp.status}`);
    const txt = gemini.extractText(await resp.json());
    if (txt && String(txt).trim()) return String(txt);
    throw new Error('Empty response from Gemini(synth)');
  };

  // ── FUSED AGENT STEP (Mixture-of-Agents for the ReAct loop) ────────────────
  // When enabled (AGENT_FUSION=1, default) AND not in SOLO/single-brain mode,
  // run several brains in parallel to propose the next {thought,action,args}
  // step, then have the strongest brain synthesise the single best, firmest
  // step. This is what makes the agent EXECUTE strongly instead of drifting.
  // Any failure here falls straight through to the classic sequential chain
  // below, so behaviour is never worse than before.
  if (agentFusion.FUSION_ENABLED() && SOLO === '') {
    try {
      // Proposer panel: HotBot (GPT-5) + Gemini + Sakana + StudentAI + Cloudflare.
      // Only include brains that are actually usable right now.
      const proposers = [['HotBot', hotbotBrain], ['Gemini', geminiBrain]];
      if (sakana && sakana.chat) proposers.push(['Sakana', sakanaBrain]);
      if (studentAI && studentAI.chat) proposers.push(['StudentAI', studentBrain]);
      proposers.push(['Cloudflare', cloudflareBrain]);
      // Synthesisers (strongest first) — must accept (sys, conv).
      const synthesisers = [['HotBot', hotbotSynth], ['Gemini', geminiSynth]];
      if (sakana && sakana.chat) synthesisers.push(['Sakana', sakanaBrain]);

      const fused = await agentFusion.fusedAgentStep({
        systemPrompt, conversation, proposers, synthesisers,
        withTimeout: _withTimeout,
        onBrain: (label) => _recordBrain(label),
      });
      if (fused && fused.text && String(fused.text).trim()) {
        _recordBrain(fused.brain || 'agentfusion');
        return fused.text;
      }
    } catch (e) {
      console.warn('[agentEngine] fused agent step failed (' + (e && e.message) + ') — falling back to sequential chain.');
    }
  }

  // Build the ordered chain. SOLO forces a single brain (no fallback).
  //
  // ── PRIMARY-BRAIN ARCHITECTURE (user spec) ────────────────────────────────
  // HotBot (GPT-5) is now the MAIN BRAIN that plans, thinks, understands the
  // skills/tools protocol and drives the whole ReAct loop. Gemini is the second
  // brain (and the dedicated vision/image engine in the file pipeline), and the
  // cheap Cloudflare text model is kept ONLY as a last-resort safety net so the
  // agent never goes fully offline. Order: HotBot → Gemini → Cloudflare.
  // Override the primary with AGENT_SOLO=hotbot|gemini|cloudflare|deepseek.
  let chain;
  if (SOLO === 'cloudflare' || SOLO === 'cf') chain = [['Cloudflare', cloudflareBrain]];
  else if (SOLO === 'deepseek') chain = [['DeepSeek', deepseekBrain]];
  else if (SOLO === 'hotbot') chain = [['HotBot', hotbotBrain]];
  else if (SOLO === 'gemini') chain = [['Gemini', geminiBrain]];
  // ── DEFAULT BRAIN CHAIN (reverted to spec) ───────────────────────────────
  // HotBot (GPT-5) is the PRIMARY brain again. Gemini is the second brain (and
  // the dedicated vision/image engine), Cloudflare is the last-resort safety
  // net. This reverses the temporary "Gemini-first" reliability tweak.
  // Override with AGENT_SOLO=hotbot|gemini|cloudflare|deepseek, or force
  // Gemini-first with AGENT_BRAIN_ORDER=gemini.
  else if (String(process.env.AGENT_BRAIN_ORDER || '').toLowerCase() === 'gemini')
    chain = [['Gemini', geminiBrain], ['HotBot', hotbotBrain], ['Cloudflare', cloudflareBrain]];
  else chain = [['HotBot', hotbotBrain], ['Gemini', geminiBrain], ['Cloudflare', cloudflareBrain]];

  const errors = [];
  for (const [label, brain] of chain) {
    try {
      const out = await _withTimeout(brain(), BRAIN_TIMEOUT_MS, label);
      // Record WHICH model actually answered so the bots can label the reply.
      _recordBrain(label);
      return out;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      errors.push(`${label}: ${msg}`);
      console.warn(`[agentEngine] brain ${label} failed: ${msg}` + (chain.length > 1 ? ' — falling back.' : ''));
    }
  }
  throw new Error('AI gateway failed (' + errors.join(' | ') + ')');
}


// ── Robust JSON extraction from a model reply ──────────────────────────────
function parseAction(raw) {
  if (!raw) return null;
  let s = raw.trim();
  // Strip code fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Find the first {...} block
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let candidate = s.slice(start, end + 1);

  // ── Repair helpers ────────────────────────────────────────────────────────
  // The model frequently writes document/PDF/math content containing backslash
  // sequences that are ILLEGAL JSON string escapes — e.g. \pagebreak, \newpage,
  // \frac, \(, \[, \section, Windows paths, etc. Vanilla JSON.parse throws
  // "Bad escaped character in JSON" on these, which used to make the whole tool
  // call fail and the raw JSON get dumped into the chat (the create_pdf bug).
  //
  // fixEscapes() walks the string and escapes any backslash that is NOT the
  // start of a valid JSON escape (\" \\ \/ \b \f \n \r \t \uXXXX), turning a
  // lone "\" into "\\" so the value parses. This is safe because we only touch
  // backslashes that JSON would otherwise reject.
  const fixEscapes = (str) => {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '\\') {
        const n = str[i + 1];
        if (n === undefined) { out += '\\\\'; continue; }
        if ('"\\/bfnrt'.includes(n)) { out += c + n; i++; continue; }
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) { out += str.slice(i, i + 6); i += 5; continue; }
        // Illegal escape (\p, \f-no, \(, \[, \frac, etc.) → escape the backslash.
        out += '\\\\';
        continue;
      }
      out += c;
    }
    return out;
  };
  // Escape raw control characters (literal newlines/tabs) that appear INSIDE
  // JSON string values — another common cause of parse failure when a model
  // pastes multi-line content without escaping the line breaks. We only escape
  // control chars while inside a (non-escaped) double-quoted string.
  const fixControlChars = (str) => {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { inStr = !inStr; out += c; continue; }
      if (inStr) {
        if (c === '\n') { out += '\\n'; continue; }
        if (c === '\r') { out += '\\r'; continue; }
        if (c === '\t') { out += '\\t'; continue; }
        if (c.charCodeAt(0) < 0x20) { out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      }
      out += c;
    }
    return out;
  };
  const stripTrailingCommas = (str) => str.replace(/,\s*([}\]])/g, '$1');

  // Try a cascade of progressively more aggressive repairs. As soon as one
  // yields a valid object WITH an `action`, use it.
  const attempts = [
    candidate,
    stripTrailingCommas(candidate),
    fixControlChars(candidate),
    fixEscapes(candidate),
    fixEscapes(fixControlChars(candidate)),
    stripTrailingCommas(fixEscapes(fixControlChars(candidate))),
  ];
  for (const attempt of attempts) {
    try {
      const obj = JSON.parse(attempt);
      if (obj && typeof obj === 'object') return obj;
    } catch (_) { /* try next repair */ }
  }

  // ── Last resort: field extraction ────────────────────────────────────────
  // If JSON is still unparseable, pull out action + args.content/title/etc by
  // regex so a document still gets produced instead of being dumped as text.
  try {
    const actionM = candidate.match(/"action"\s*:\s*"([^"]+)"/);
    if (actionM) {
      const action = actionM[1];
      const args = {};
      // Grab the args object substring and decode common string fields.
      const grab = (key) => {
        const m = candidate.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
        if (!m) return undefined;
        // Decode the few escapes we care about; leave invalid ones as literals.
        return m[1]
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      };
      for (const k of ['filename', 'title', 'subtitle', 'content', 'name', 'query', 'message', 'path', 'html', 'code', 'lang', 'language']) {
        const v = grab(k);
        if (v !== undefined) args[k] = v;
      }
      const boolM = candidate.match(/"math"\s*:\s*(true|false)/);
      if (boolM) args.math = boolM[1] === 'true';
      if (Object.keys(args).length) return { action, args };
      return { action, args: {} };
    }
  } catch (_) { /* give up */ }

  return null;
}

// ── Tool: run code in a temp sandbox dir, capture stdout + any new files ────
// ─────────────────────────────────────────────────────────────────────────────
// Filesystem / execution abstraction (`fsx`).
//
// Two backends, same interface, chosen per-run:
//   • sandbox  — runs everything inside a Daytona isolated Linux box (preferred).
//   • local    — legacy fallback on the Render host (child_process + fs).
//
// Interface:
//   run(code, lang)      → string (combined stdout/stderr, trimmed)
//   sh(command)          → { exitCode, output }   (raw shell, no script wrapper)
//   writeText(rel, text) → void
//   readText(rel)        → string
//   list()               → [{ rel, size }]
//   exists(rel)          → bool
//   uploadBuffer(rel,buf)→ void
//   downloadBuffer(rel)  → Buffer
// All paths are RELATIVE to the working dir.
// ─────────────────────────────────────────────────────────────────────────────

function runShellLocal(cmd, cwd, timeoutMs = CODE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const blocked = agentIsolation.guardAgentSource(cmd);
    if (blocked) return resolve({ exitCode: 126, output: `[blocked] ${blocked}` });
    const boundedTimeout = Math.max(1000, Math.min(Number(timeoutMs) || CODE_TIMEOUT_MS, 6 * 60 * 60 * 1000));
    exec(cmd, { timeout: boundedTimeout, maxBuffer: 20 * 1024 * 1024, cwd, env: agentIsolation.safeChildEnv() }, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + stderr;
      if (err && err.killed) out += '\n[timed out]';
      else if (err) out += `\n[exit ${err.code || '?'}]`;
      resolve({ exitCode: err ? (err.code || 1) : 0, output: (out || '(no output)') });
    });
  });
}

// ── Local backend ────────────────────────────────────────────────────────────
function makeLocalFsx() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wormagent_'));
  const abs = (rel) => {
    const target = path.resolve(workdir, rel || '.');
    if (target !== workdir && !target.startsWith(workdir + path.sep)) throw new Error('path traversal blocked');
    return target;
  };
  return {
    kind: 'local', workdir,
    async sh(command, options = {}) {
      const timeoutMs = Math.max(1, Number(options.timeout) || CODE_TIMEOUT_MS / 1000) * 1000;
      return runShellLocal(`cd "${workdir}" && ( ${command} ) 2>&1`, workdir, timeoutMs);
    },
    async run(code, lang, step) {
      let file, cmd;
      if (lang === 'python' || lang === 'py') {
        file = path.join(workdir, `_step_${step}.py`); fs.writeFileSync(file, code);
        cmd = `cd "${workdir}" && (python3 "${file}" 2>&1 || python "${file}" 2>&1)`;
      } else if (lang === 'node' || lang === 'js' || lang === 'javascript') {
        file = path.join(workdir, `_step_${step}.js`); fs.writeFileSync(file, code);
        cmd = `cd "${workdir}" && node "${file}" 2>&1`;
      } else {
        file = path.join(workdir, `_step_${step}.sh`); fs.writeFileSync(file, code);
        cmd = `cd "${workdir}" && bash "${file}" 2>&1`;
      }
      const r = await runShellLocal(cmd, workdir);
      return r.output;
    },
    writeText(rel, text) { const t = abs(rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, text != null ? String(text) : ''); },
    readText(rel) { return fs.readFileSync(abs(rel), 'utf-8'); },
    exists(rel) { try { return fs.existsSync(abs(rel)); } catch { return false; } },
    list() { return walkDir(workdir).map(f => ({ rel: f.rel, size: f.size, mtime: f.mtime })); },
    uploadBuffer(rel, buf) { const t = abs(rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, buf); },
    downloadBuffer(rel) { return fs.readFileSync(abs(rel)); },
    async docker() { return { exitCode: 1, output: '[docker] Docker-in-Docker requires a Runloop or Daytona sandbox; none is active (running on local host fallback). Configure RUNLOOP_API_KEY (or DAYTONA_API_KEY + DAYTONA_ORG_ID).' }; },
    async dockerSetup() { return { ok: false, log: 'no sandbox (local host fallback)' }; },
    async cleanup() { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) {} },
  };
}

// ── Sandbox backend (Runloop primary / Daytona backup) ───────────────────────
// `backend` is a sandbox module (runloop.js or daytona.js) — both expose the
// same interface, so this factory is backend-agnostic.
// When `sessionKey` is provided, the SAME devbox/sandbox is reused across turns
// so the agent's files/state persist (no more "I can't find the file, please
// resend"). In that mode cleanup() only removes scratch scripts and keeps the
// sandbox alive (the provider auto-suspends/auto-stops it when idle, preserving
// the disk). Without a sessionKey it behaves like before: ephemeral sandbox,
// destroyed on cleanup.
async function makeSandboxFsx(onStep, sessionKey, backend, backendLabel) {
  const sb = backend || runloop;
  const label = backendLabel || (sb === daytona ? 'Daytona' : 'Runloop');
  let id, reused = false;
  // Hard ceiling for the (network) sandbox provisioning step. If a backend
  // hangs while creating/reconnecting a sandbox, this guarantees we fail fast
  // so the caller's cascade can fall
  // back to another backend or local execution instead of hanging the whole
  // task at "🧭 admin-selected sandbox: …".
  const PROVISION_TIMEOUT_MS = parseInt(process.env.SANDBOX_PROVISION_TIMEOUT_MS || '60000', 10);
  const raceTimeout = (p, what) => {
    let t;
    const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${PROVISION_TIMEOUT_MS}ms`)), PROVISION_TIMEOUT_MS); if (t.unref) t.unref(); });
    return Promise.race([p, timer]).finally(() => clearTimeout(t));
  };
  if (sessionKey) {
    if (onStep) onStep(`🖥️ connecting to your persistent Linux sandbox (${label})…`);
    const r = await raceTimeout(sb.getOrCreateSessionSandbox(sessionKey, {}), `${label} sandbox provisioning`);
    id = r.id; reused = r.reused;
    if (onStep) onStep(reused ? '🔁 reusing your existing sandbox — your files are still here.' : '🆕 created a fresh sandbox for this session.');
  } else {
    if (onStep) onStep(`🖥️ spinning up an isolated Linux sandbox (${label})…`);
    id = await raceTimeout(sb.createSandbox({}), `${label} sandbox provisioning`);
  }
  const root = sb.WORKDIR;
  // Guard against path traversal in relative paths.
  const absPath = (rel) => {
    const clean = path.posix.normalize('/' + (rel || '.')).replace(/^\/+/, '');
    if (clean.startsWith('..')) throw new Error('path traversal blocked');
    return clean === '.' || clean === '' ? root : `${root}/${clean}`;
  };
  const shquote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  async function sh(command, options = {}) {
    // Commands may opt into a larger bounded timeout for long builds, installs,
    // migrations, and test suites while preserving a safe default.
    const timeout = Math.max(1, Math.min(Number(options.timeout) || 600, 6 * 60 * 60));
    const r = await sb.exec(id, command, { cwd: root, timeout });
    return { exitCode: r.exitCode, output: (r.output || '').slice(0, 12000) || '(no output)' };
  }

  // Write a base64 payload to an absolute sandbox path, safely. Linux caps a
  // SINGLE shell argument at MAX_ARG_STRLEN = 128 KiB regardless of ARG_MAX, so
  // embedding a large base64 string in one `printf` argument throws E2BIG
  // ("Argument list too long"). This silently broke uploads/writes of anything
  // bigger than ~95 KB (e.g. images, big scripts) on shell-based backends
  // (shell-based backends). We chunk the base64 (appending with `>>`) so no single
  // command argument exceeds the limit, then decode once. Returns the path.
  const _SHELL_ARG_CHUNK = 60000;
  async function writeB64(absDest, b64, { timeout = 120 } = {}) {
    const dir = path.posix.dirname(absDest);
    if (b64.length <= _SHELL_ARG_CHUNK) {
      await sb.exec(id, `mkdir -p ${shquote(dir)} && printf %s ${shquote(b64)} | base64 -d > ${shquote(absDest)}`, { cwd: root, timeout });
      return absDest;
    }
    const tmp = `${absDest}.b64.upload`;
    await sb.exec(id, `mkdir -p ${shquote(dir)} && : > ${shquote(tmp)}`, { cwd: root, timeout });
    for (let i = 0; i < b64.length; i += _SHELL_ARG_CHUNK) {
      const part = b64.slice(i, i + _SHELL_ARG_CHUNK);
      await sb.exec(id, `printf %s ${shquote(part)} >> ${shquote(tmp)}`, { cwd: root, timeout });
    }
    await sb.exec(id, `base64 -d ${shquote(tmp)} > ${shquote(absDest)} && rm -f ${shquote(tmp)}`, { cwd: root, timeout });
    return absDest;
  }

  return {
    kind: 'sandbox', backend: label, backendMod: sb, workdir: root, sandboxId: id, persistent: !!sessionKey, reused,
    // True when this backend does pure file I/O via a native API (Git Data API
    // for GitHub Actions) instead of paying for a CI run per file op.
    nativeFs: !!sb.nativeFs,
    sh,
    async run(code, lang, step) {
      let scriptName, runner;
      if (lang === 'python' || lang === 'py') { scriptName = `_step_${step}.py`; runner = `python3 ${scriptName}`; }
      else if (lang === 'node' || lang === 'js' || lang === 'javascript') { scriptName = `_step_${step}.js`; runner = `node ${scriptName}`; }
      else { scriptName = `_step_${step}.sh`; runner = `bash ${scriptName}`; }
      // Write the step script. On native-FS backends (GitHub Actions) use the
      // Git Data API — ONE commit — instead of chunked base64 `exec` writes that
      // would each cost a full CI run. On shell backends keep the chunked
      // base64 write (avoids the 128 KiB single-arg limit).
      if (sb.nativeFs && typeof sb.uploadFile === 'function') {
        await sb.uploadFile(id, `${root}/${scriptName}`, Buffer.from(code, 'utf-8'), scriptName);
      } else {
        const b64 = Buffer.from(code, 'utf-8').toString('base64');
        await writeB64(`${root}/${scriptName}`, b64, { timeout: 120 });
      }
      const r = await sb.exec(id, `${runner} 2>&1`, { cwd: root, timeout: 600 });
      let out = r.output || '';
      if (r.exitCode && r.exitCode !== 0) out += `\n[exit ${r.exitCode}]`;
      return (out.slice(0, 12000) || '(no output)');
    },
    async writeText(rel, text) {
      // Native-FS backend → one git commit, no CI run.
      if (sb.nativeFs && typeof sb.uploadFile === 'function') {
        await sb.uploadFile(id, absPath(rel), Buffer.from(text != null ? String(text) : '', 'utf-8'), path.posix.basename(rel));
        return;
      }
      const b64 = Buffer.from(text != null ? String(text) : '', 'utf-8').toString('base64');
      await writeB64(absPath(rel), b64, { timeout: 120 });
    },
    async readText(rel) {
      const buf = await sb.downloadFile(id, absPath(rel));
      return buf.toString('utf-8');
    },
    async exists(rel) {
      // Native-FS backend → single git-tree lookup, no CI run.
      if (sb.nativeFs && typeof sb.existsFile === 'function') {
        try { return await sb.existsFile(id, absPath(rel)); } catch (_) { return false; }
      }
      const r = await sb.exec(id, `test -e ${shquote(absPath(rel))} && echo yes || echo no`, { cwd: root, timeout: 30 });
      return (r.output || '').includes('yes');
    },
    async list() {
      // Native-FS backend → read the work tree via the Git Data API (no CI run).
      if (sb.nativeFs && typeof sb.listFilesRecursive === 'function') {
        try { return await sb.listFilesRecursive(id); } catch (_) { return []; }
      }
      // Recursive listing of files (skip scratch scripts & VCS/node noise).
      const r = await sb.exec(
        id,
        `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -name '_step_*' -printf '%s\\t%T@\\t%p\\n' 2>/dev/null | head -300`,
        { cwd: root, timeout: 30 }
      );
      const out = [];
      for (const line of (r.output || '').split('\n')) {
        const t1 = line.indexOf('\t');
        if (t1 < 0) continue;
        const t2 = line.indexOf('\t', t1 + 1);
        if (t2 < 0) continue;
        const size = parseInt(line.slice(0, t1), 10) || 0;
        const mtime = parseFloat(line.slice(t1 + 1, t2)) || 0;
        let rel = line.slice(t2 + 1).replace(/^\.\//, '');
        if (rel) out.push({ rel, size, mtime });
      }
      return out;
    },
    async uploadBuffer(rel, buf) { await sb.uploadFile(id, absPath(rel), buf, path.posix.basename(rel)); },
    // Clear ALL files in this session's working directory (keep the sandbox).
    // GitHub Actions → surgical git-tree delete of just this sandbox id's work
    // subtree; every other backend → rm -rf the work dir contents. Scoped to
    // THIS sandbox id, so a clear for one chat never touches another user's files.
    async clearWorkTree() {
      if (sb.nativeFs && typeof sb.clearWorkTree === 'function') {
        return await sb.clearWorkTree(id);
      }
      const q = `'${String(root).replace(/'/g, `'\\''`)}'`;
      await sb.exec(id, `mkdir -p ${q}; find ${q} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; true`, { cwd: root, timeout: 60 });
      return 0;
    },
    // Batch upload [{ rel, buffer }] in one shot when the backend supports it
    // (GitHub Actions → a single git commit). Falls back to sequential uploads.
    async uploadMany(files) {
      const list = (files || []).filter(f => f && f.rel != null && f.buffer != null);
      if (!list.length) return;
      if (typeof sb.uploadFiles === 'function') {
        await sb.uploadFiles(id, list.map(f => ({ dest: absPath(f.rel), buffer: f.buffer })));
        return;
      }
      for (const f of list) { await sb.uploadFile(id, absPath(f.rel), f.buffer, path.posix.basename(f.rel)); }
    },
    async downloadBuffer(rel) { return sb.downloadFile(id, absPath(rel)); },
    // Docker-in-Docker: run a `docker/podman` command inside this sandbox using
    // the backend's verified container engine. Only backends that expose
    // dockerSetup/dockerRun (Daytona) support this; otherwise we report clearly.
    async docker(dockerArgs, { setup = true, timeout = 280 } = {}) {
      if (typeof sb.dockerRun !== 'function' || typeof sb.dockerSetup !== 'function') {
        return { exitCode: 1, output: `[docker] the current sandbox backend (${label}) does not support Docker-in-Docker. Switch the active sandbox to Daytona.` };
      }
      if (setup) { try { await sb.dockerSetup(id, {}); } catch (e) { return { exitCode: 1, output: `[docker] setup failed: ${e.message}` }; } }
      return sb.dockerRun(id, dockerArgs, { timeout });
    },
    async dockerSetup() {
      if (typeof sb.dockerSetup !== 'function') return { ok: false, log: `backend ${label} has no Docker support` };
      return sb.dockerSetup(id, {});
    },
    async cleanup() {
      if (sessionKey) {
        // PERSISTENT session: keep the sandbox (and the user's files!) alive.
        // Only delete this turn's scratch scripts so they don't accumulate.
        // The provider will auto-suspend/auto-stop the sandbox when idle (disk
        // preserved) and the session mapping is reused on the next turn.
        try { await sb.exec(id, `cd ${shquote(root)} 2>/dev/null; rm -f _step_*.py _step_*.js _step_*.sh 2>/dev/null; true`, { cwd: root, timeout: 30 }); } catch (_) {}
        // Proactively suspend Runloop devboxes to stop compute billing between
        // turns (disk is preserved; resumed on the next turn). Best-effort.
        try { if (sb.suspendSandbox) await sb.suspendSandbox(id); } catch (_) {}
        return;
      }
      // Ephemeral session: destroy the whole sandbox.
      await sb.deleteSandbox(id);
    },
  };
}

async function toolRunCode(args, ctx) {
  const lang = (args.language || 'python').toLowerCase();
  const code = args.code || '';
  if (!code.trim()) return '[run_code] No code provided.';
  const blocked = agentIsolation.guardAgentSource(code);
  if (blocked) return `[run_code] blocked: ${blocked}`;
  // Snapshot a signature (size + mtime) of every file BEFORE running so we can
  // capture not just NEW files but also MODIFIED ones. This fixes the common
  // "fix the error" case where the agent overwrites an existing/uploaded file
  // in place (e.g. sed/echo > app.py): the file is not "new", so the old
  // new-files-only check missed it and nothing got delivered.
  const sig = (f) => `${f.size}:${f.mtime || 0}`;
  const before = new Map();
  try { for (const f of await ctx.fsx.list()) before.set(f.rel, sig(f)); } catch (_) {}
  const output = await ctx.fsx.run(code, lang, ctx.step);
  // Capture any NEW or CHANGED files (besides scratch scripts) as deliverables.
  let captured = 0;
  try {
    for (const f of await ctx.fsx.list()) {
      if (_isInternalArtifact(f.rel)) continue;
      const prev = before.get(f.rel);
      if (prev === undefined || prev !== sig(f)) {
        ctx.addFile(f.rel, path.posix.basename(f.rel));
        captured++;
      }
    }
  } catch (_) {}
  const where = ctx.fsx.kind === 'sandbox' ? 'sandbox' : 'host';
  const note = captured ? `\n[${captured} file(s) created/modified and queued for delivery]` : '';
  return `[run_code:${lang} @${where}] output:\n${output}${note}`;
}

// ── Tool: docker_run — Docker-in-Docker inside the sandbox ───────────────────
// Runs a container command (build/run/pull/images/…) inside the SAME persistent
// sandbox the agent is using, via the verified podman+chroot engine. The agent
// passes the part AFTER `docker`, e.g. {"cmd":"run --rm alpine echo hi"} or a
// build: {"cmd":"build -t myapp ."}. Files the agent created in the working dir
// (e.g. a Dockerfile) are available to the build. Any output files are captured.
async function toolDockerRun(args, ctx) {
  let cmd = (args.cmd || args.command || args.args || '').trim();
  if (!cmd) return '[docker_run] No command provided. Pass {"cmd":"run --rm alpine echo hello"} (the part AFTER `docker`).';
  // Be forgiving: strip a leading "docker " / "podman " if the model included it.
  cmd = cmd.replace(/^\s*(sudo\s+)?(docker|podman)\s+/i, '');
  const timeout = Math.min(Math.max(parseInt(args.timeout, 10) || 280, 30), 600);

  // Snapshot files before (to capture build artifacts saved into the workdir).
  const sig = (f) => `${f.size}:${f.mtime || 0}`;
  const before = new Map();
  try { for (const f of await ctx.fsx.list()) before.set(f.rel, sig(f)); } catch (_) {}

  if (ctx.onStep) ctx.onStep(`🐳 docker ${cmd.slice(0, 80)}…`);
  let res;
  try {
    res = await ctx.fsx.docker(cmd, { setup: true, timeout });
  } catch (e) {
    return `[docker_run] error: ${e.message}`;
  }
  let captured = 0;
  try {
    for (const f of await ctx.fsx.list()) {
      if (_isInternalArtifact(f.rel)) continue;
      const prev = before.get(f.rel);
      if (prev === undefined || prev !== sig(f)) { ctx.addFile(f.rel, path.posix.basename(f.rel)); captured++; }
    }
  } catch (_) {}
  const out = (res.output || '').slice(0, 12000) || '(no output)';
  const code = res.exitCode === undefined ? '' : ` [exit ${res.exitCode}]`;
  const note = captured ? `\n[${captured} file(s) created/modified and queued for delivery]` : '';
  return `[docker_run] $ docker ${cmd}${code}\n${out}${note}`;
}

// ── Tool: deploy_render — push edited repo files + trigger a Render deploy ────
// Commits the working dir (or a subfolder/path) to the configured GitHub repo
// (default Arinze-eng/Netlify @ evilgpt) in one atomic commit, then triggers a
// Render deploy via the Render API. Use after EDITING/implementing code so the
// changes ship live.
//   args: { path? (dir or file in workdir, default "."), message?, clearCache? }
async function toolDeployRender(args, ctx) {
  const renderDeploy = require('./renderDeploy');
  if (!renderDeploy.gitEnabled()) {
    return '[deploy_render] Not configured: set GITHUB_DEPLOY_TOKEN (and RENDER_API_KEY to also trigger the Render deploy).';
  }
  // Reuse the same file-collection logic the github/cloudflare deploy tools use.
  let files;
  try {
    files = await manusTools.collectSiteFiles(args, ctx);
  } catch (e) {
    return `[deploy_render] ${e.message}`;
  }
  if (!files || !files.length) {
    return '[deploy_render] No files to commit. Edit/create files first, or pass {"path":"<dir>"}.';
  }
  let pushRes;
  try {
    pushRes = await renderDeploy.pushFiles({ files, message: args.message, onStep: ctx.onStep });
  } catch (e) {
    return `[deploy_render] git push failed: ${e.message}`;
  }
  let out = `[deploy_render] ✅ **Pushed ${pushRes.fileCount} file(s) to ${pushRes.repo}@${pushRes.branch}**\n` +
            `📝 Commit: ${pushRes.commitUrl}\n`;
  // Trigger Render deploy if configured.
  if (renderDeploy.renderEnabled()) {
    try {
      const dep = await renderDeploy.triggerRenderDeploy({ onStep: ctx.onStep, clearCache: !!args.clearCache });
      out += `🚀 Render deploy triggered (service ${dep.serviceId}${dep.deployId ? `, deploy ${dep.deployId}` : ''}).\n` +
             `🔗 Dashboard: ${dep.dashboardUrl}`;
    } catch (e) {
      out += `⚠️ Pushed to GitHub, but Render deploy trigger failed: ${e.message}\n` +
             `(If Render auto-deploys on push, it will still deploy from the new commit.)`;
    }
  } else {
    out += `ℹ️ RENDER_API_KEY not set — pushed to GitHub only. If Render auto-deploys on push, it will deploy the new commit automatically.`;
  }
  return out;
}

async function toolWebSearch(args) {
  const q = args.query || '';
  if (!q) return '[web_search] No query.';
  try {
    const r = await browserless.webSearchViaBrowserless(q);
    return `[web_search] results for "${q}":\n${(r || '').slice(0, 4000)}`;
  } catch (e) {
    return `[web_search] error: ${e.message}`;
  }
}

// ── Tool: WolframAlpha — verified computational knowledge ──────────────────
// Grounds the agent's math/science/factual answers in REAL computation so it
// never hallucinates a number. Returns the rich LLM-API answer (or the short
// answer fallback). On failure, tells the model why so it can fall back to
// run_code / web_search instead of fabricating a result.
async function toolWolframAlpha(args) {
  const q = (args.query || args.input || args.i || '').trim();
  if (!q) return '[wolfram_alpha] No query. Pass {"query":"integrate x^2 dx"}.';
  try {
    const r = await wolfram.ask(q);
    if (r.ok) {
      return `[wolfram_alpha] VERIFIED result for "${q}" (source: ${r.source}). ` +
             `These values are EXACT ground truth — use them, do NOT recompute or contradict them. ` +
             `In your final answer, do NOT just paste this block: explain WHAT it means, HOW it's derived (key steps), and WHY it's correct, in a detailed, conversational way with proper notation.\n\n${r.answer.slice(0, 6000)}`;
    }
    return `[wolfram_alpha] no verified answer for "${q}" (${r.error}). ` +
           `Fall back to run_code (compute it yourself with sympy/numpy) or web_search — do NOT fabricate a number.`;
  } catch (e) {
    return `[wolfram_alpha] error: ${e.message}. Fall back to run_code or web_search.`;
  }
}

// ── MCP (Model Context Protocol) tools ──────────────────────────────────────
// These expose the bundled local MCP stdio servers (mcp_servers/*.py) to the
// agent. The two the user explicitly wants the LLM to SEE and USE are surfaced
// as dedicated top-level tools (sequential_thinking + mcp_filesystem); a generic
// mcp_call reaches every other server (git / github / fetch / websearch / sqlite).
// All are resilient: a failure becomes a recoverable observation, never a crash.

// 🧠 sequential_thinking — structured step-by-step reasoning via the
// sequential-thinking MCP server. Maps the friendly `tool`/`action` arg to the
// server's real tool names (think_step / think_sequence / get_sequence /
// list_sequences / conclude_sequence / branch_sequence / clear_sequence).
async function toolSequentialThinking(args) {
  args = args || {};
  let tool = String(args.tool || args.action || args.op || '').trim();
  // Smart default: if a list of `thoughts` is given → think_sequence; if a
  // single `thought` → think_step; if only a sequence_id → get_sequence.
  if (!tool) {
    if (Array.isArray(args.thoughts)) tool = 'think_sequence';
    else if (args.thought) tool = 'think_step';
    else if (args.sequence_id) tool = 'get_sequence';
    else tool = 'think_step';
  }
  const ALIAS = {
    step: 'think_step', think: 'think_step', add: 'think_step',
    sequence: 'think_sequence', plan: 'think_sequence', all: 'think_sequence',
    get: 'get_sequence', show: 'get_sequence',
    list: 'list_sequences',
    conclude: 'conclude_sequence', finish: 'conclude_sequence', done: 'conclude_sequence',
    branch: 'branch_sequence', fork: 'branch_sequence',
    clear: 'clear_sequence', delete: 'clear_sequence',
  };
  tool = ALIAS[tool.toLowerCase()] || tool;
  // Build the MCP tool arguments, passing through everything except our routing keys.
  const callArgs = { ...args };
  delete callArgs.tool; delete callArgs.action; delete callArgs.op;
  return mcpBridge.call('sequential-thinking', tool, callArgs, 30000);
}

// 📁 mcp_filesystem — filesystem operations via the filesystem MCP server so the
// LLM can READ and EDIT files through MCP (as the user requested it be wired
// first). Maps friendly `op`/`action` to the server tools (read_file /
// write_file / list_directory / delete_file / create_directory / file_info /
// copy_file / move_file). Paths are cwd-relative on the host.
async function toolMcpFilesystem(args) {
  args = args || {};
  let op = String(args.op || args.action || args.tool || '').trim();
  if (!op) {
    if (args.content != null && (args.path || args.dest)) op = 'write_file';
    else if (args.path) op = 'read_file';
    else op = 'list_directory';
  }
  const ALIAS = {
    read: 'read_file', cat: 'read_file', get: 'read_file',
    write: 'write_file', save: 'write_file', put: 'write_file',
    list: 'list_directory', ls: 'list_directory', dir: 'list_directory',
    delete: 'delete_file', rm: 'delete_file', remove: 'delete_file',
    mkdir: 'create_directory', makedir: 'create_directory',
    info: 'file_info', stat: 'file_info',
    copy: 'copy_file', cp: 'copy_file',
    move: 'move_file', mv: 'move_file', rename: 'move_file',
  };
  op = ALIAS[op.toLowerCase()] || op;
  const callArgs = { ...args };
  delete callArgs.op; delete callArgs.action; delete callArgs.tool;
  // Default list path to '.' so {op:'list'} just works.
  if (op === 'list_directory' && !callArgs.path) callArgs.path = '.';
  return mcpBridge.call('filesystem', op, callArgs, 30000);
}

// 🔌 mcp_call — generic gateway to ANY bundled MCP server. Discover-then-call:
// {"server":"git"} (no tool) lists that server's advertised tools; pass a
// {"tool","args"} to invoke one. Servers: sequential-thinking, filesystem, git,
// github, fetch, websearch, sqlite.
async function toolMcpCall(args) {
  args = args || {};
  const server = String(args.server || args.name || '').trim();
  if (!server) {
    // No server → return the full catalog of servers + their tools.
    try {
      const cat = await mcpBridge.catalog();
      const lines = ['[mcp_call] Available MCP servers and tools:'];
      for (const [key, info] of Object.entries(cat)) {
        if (!info.ok) { lines.push(`• ${key} (${info.label}) — unavailable: ${info.error}`); continue; }
        const names = info.tools.map((t) => t.name).join(', ');
        lines.push(`• ${key} (${info.label}): ${names}`);
      }
      lines.push('\nCall like: {"action":"mcp_call","args":{"server":"git","tool":"git_status","args":{}}}');
      return lines.join('\n');
    } catch (e) {
      return `[mcp_call] could not list servers: ${e.message}`;
    }
  }
  const tool = String(args.tool || args.action_name || '').trim();
  if (!tool) {
    // Server given but no tool → discover that server's tools.
    try {
      const tools = await mcpBridge.listTools(server);
      const lines = [`[mcp_call] "${server}" tools:`];
      for (const t of tools) lines.push(`• ${t.name} — ${t.description || ''}`);
      return lines.join('\n');
    } catch (e) {
      return `[mcp_call] could not list "${server}" tools: ${e.message}`;
    }
  }
  const callArgs = args.args || args.arguments || {};
  return mcpBridge.call(server, tool, callArgs, 120000);
}

async function toolBrowse(args, ctx) {
  const url = args.url || '';
  if (!url) return '[browse] No url.';
  const sessionKey = (ctx && (ctx.sessionKey || ctx.chatId)) || null;
  // 🌐 SANDBOX-NATIVE FIRST (when requested or when a sandbox backend is active).
  // Real Chromium via Playwright INSIDE the admin-selected Novita/Daytona/…
  // sandbox — full real-time browsing + captcha + navigation. If the sandbox
  // image can't run Chromium we transparently fall back to Browserless below,
  // so browsing never hard-fails. Set args.prefer_sandbox=false to skip it.
  if (sandboxBrowser && args.prefer_sandbox !== false && args.sandbox !== false) {
    try {
      if (args.prefer_sandbox === true || await sandboxBrowser.available()) {
        const s = await sandboxBrowser.browseInSandbox(url, {
          sessionKey, maxRounds: args.max_rounds || 10,
          actions: args.actions || [], screenshot: false,
        });
        const stext = (s && s.text) ? String(s.text) : '';
        if (s && s.ok && s.auth && s.auth.required) {
          return `[browse] AUTHENTICATION_REQUIRED (${s.auth.kind || 'otp'}): ${s.auth.message || 'User action is required.'} ` +
            `The browser session is paused and saved; ask the user for the code/approval, then call sandbox_browse again with an explicit otp/2fa action. ` +
            `Do not restart the task.\nCurrent page: ${s.finalUrl || url}\n${stext.slice(0, 2500)}`;
        }
        if (s && s.ok && stext.trim().length >= 40) {
          const cap = s.solved ? ' (captcha cleared)' : '';
          const cf = s.hasCfClearance ? ', cf_clearance obtained' : '';
          return `[browse] ${url} — via ${s.backend} sandbox (real Chromium${cap}${cf}):\n${stext.slice(0, 6000)}`;
        }
        // else fall through to Browserless
      }
    } catch (_) { /* fall through to Browserless */ }
  }
  // 🌐 RESILIENT BROWSING (works with OR without a live sandbox / Daytona).
  // Chain: Browserless (renders JS, auto-solves CAPTCHA, harvests cf_clearance)
  //   → cheerio direct fetch → power_scrape (rotating-UA → r.jina.ai reader →
  //     DuckDuckGo/Bing) — all inside browserless.browseUrl(). If that STILL
  //   comes back empty or throws (out-of-units, blocked, no key), we make a
  //   FINAL explicit power_scrape pass here so live browsing degrades
  //   gracefully instead of returning "[browse] error". This is exactly the
  //   "if Daytona/live sandbox is off it looks for other alternatives" behaviour
  //   the product requires — no sandbox is ever needed for headless browsing.
  try {
    const r = await browserless.browseUrl(url);
    const text = (r && r.text) ? String(r.text) : '';
    if (text.trim().length >= 40) {
      let header = `[browse] ${url}:`;
      if (r.captcha) {
        const det = (r.captcha.detected || []).join(', ') || 'challenge';
        header = `[browse] ${url} (auto-solved ${det}: ${r.captcha.solved ? 'OK' : 'partial'}` +
                 `${r.captcha.hasCfClearance ? ', cf_clearance obtained' : ''}):`;
      }
      return `${header}\n${text.slice(0, 6000)}`;
    }
    // Empty/thin result → fall through to the no-key power scraper.
  } catch (_) { /* fall through to power scraper */ }
  try {
    const fb = await toolPowerScrape({ url });
    if (fb && !/no results|error/i.test(fb.slice(0, 40))) {
      return `[browse] ${url} (via resilient fallback — Browserless unavailable/blocked):\n` +
             String(fb).replace(/^\[power_scrape\][^\n]*\n?/, '').slice(0, 6000);
    }
    return fb;
  } catch (e) {
    return `[browse] error: ${e.message}`;
  }
}

// ── Tool: sandbox_browse — FORCE real-time browsing inside the active sandbox ─
// Real Chromium via Playwright in the admin-selected Novita/Daytona/… sandbox,
// with captcha solving + a scripted navigation sequence. Use when the user wants
// genuine real-time browsing (logins, multi-step navigation, JS-heavy apps) or
// asks to "browse in the sandbox". args: { url, actions?, max_rounds? }.
async function toolSandboxBrowse(args, ctx) {
  if (!sandboxBrowser) return '[sandbox_browse] sandbox browser module unavailable.';
  const url = args.url || '';
  if (!url) return '[sandbox_browse] No url.';
  const sessionKey = (ctx && (ctx.sessionKey || ctx.chatId)) || null;
  try {
    const s = await sandboxBrowser.browseInSandbox(url, {
      sessionKey, maxRounds: args.max_rounds || 10,
      actions: args.actions || args.steps || [], screenshot: args.screenshot !== false,
    });
    if (!s || !s.ok) return `[sandbox_browse] ${(s && s.error) || 'failed'}${s && s.backend ? ' (backend: ' + s.backend + ')' : ''}. Tip: use browse (Browserless fallback) instead.`;
    const cap = s.solved ? 'cleared' : 'partial';
    let out = `[sandbox_browse] ${url} via ${s.backend} sandbox (real Chromium, captcha ${cap}${s.hasCfClearance ? ', cf_clearance obtained' : ''}).\n`;
    out += `Final URL: ${s.finalUrl}\nTitle: ${s.title}\n`;
    if (s.auth && s.auth.required) {
      out += `AUTHENTICATION_REQUIRED (${s.auth.kind || 'otp'}): ${s.auth.message || 'User action is required.'}\n` +
        `Session state is saved. Pause this task, ask the user for the code or approval, then resume with ` +
        `{"actions":[{"action":"otp","code":"<user-provided code>"},{"action":"press","key":"Enter"}]}. Do not restart navigation.\n`;
    }
    if (s.log && s.log.length) out += `Nav log: ${s.log.slice(0, 8).join(' | ')}\n`;
    // 📸 On perCommand backends (GitHub Actions) the screenshot is written into
    // the sandbox work dir (persisted in git) rather than returned as a base64
    // data URI — register it so the runtime delivers the image to the user.
    if (args.screenshot !== false && s.screenshotFile && ctx && typeof ctx.addFile === 'function') {
      try {
        if (!ctx.fsx || typeof ctx.fsx.exists !== 'function' || await ctx.fsx.exists(s.screenshotFile)) {
          ctx.addFile(s.screenshotFile, 'browser_screenshot.jpg');
          out += `📸 Screenshot captured → browser_screenshot.jpg\n`;
        }
      } catch (_) { /* screenshot delivery is best-effort */ }
    }
    out += `\n${(s.text || '').slice(0, 6000)}`;
    return out;
  } catch (e) {
    return `[sandbox_browse] error: ${e.message}`;
  }
}

// ── Tool: power_scrape — the "browser that works when others fail" ─────────
// A robust, multi-strategy scraper (ported from the app's built-in `browse`
// MCP tool): rotating-UA direct fetch → r.jina.ai reader proxy → smart text
// extraction. Use this when `browse` / `web_search` / `screenshot` come back
// empty, blocked (403/429), or behind a JS/anti-bot wall. It needs no API key
// and no Browserless budget, so it keeps working when everything else is down.
async function toolPowerScrape(args) {
  const url = args.url || args.link || '';
  const query = args.query || args.q || args.search || '';
  // Search mode: {query:"..."} (or {q:"..."}).
  if (!url && query) {
    try {
      const r = await browserless.powerSearch(query, { timeout: 18000 });
      return r && r.trim()
        ? `[power_scrape] search results for "${query}" (DuckDuckGo/Bing):\n${r.slice(0, 5000)}`
        : `[power_scrape] no results for "${query}".`;
    } catch (e) {
      return `[power_scrape] search error: ${e.message}`;
    }
  }
  if (!url) return '[power_scrape] Pass {"url":"https://..."} to scrape a page, or {"query":"..."} to search.';
  try {
    const r = await browserless.powerScrape(url, {
      maxChars: args.max_chars || 8000,
      timeout: args.timeout || 30000,
    });
    if (r && r.error) return `[power_scrape] ${url}: ${r.error}`;
    const via = r.source ? ` (via ${r.source})` : '';
    return `[power_scrape] ${url}${via}:\n${(r.content || r.text || '').slice(0, 7000)}`;
  } catch (e) {
    return `[power_scrape] error: ${e.message}`;
  }
}

// ── Tool: explicitly solve a CAPTCHA / bot-challenge on a URL ──────────────
// Opens the page in a real headless browser, auto-detects & solves Cloudflare
// "Just a moment", Turnstile, reCAPTCHA v2, hCaptcha and generic "verify you
// are human" interstitials, then returns the unblocked page text plus the
// harvested cookies (cf_clearance) and any captcha tokens. This is the
// agent's "browse any website without restrictions" superpower.
async function toolSolveCaptcha(args) {
  const url = args.url || '';
  if (!url) return '[solve_captcha] No url.';
  try {
    const captcha = require('./captchaSolver');
    const r = await captcha.solveCaptcha(url, {
      maxRounds: args.max_rounds || 12,
      roundDelay: args.round_delay || 2000,
      takeScreenshot: false,
    });
    if (!r.ok) return `[solve_captcha] failed: ${r.error || 'unknown error'}`;

    const det = Object.entries(r.detected || {}).filter(([, v]) => v).map(([k]) => k);
    const cookieKeys = Object.keys(r.cookies || {});
    const tokenKeys = Object.entries(r.tokens || {}).filter(([, v]) => v).map(([k]) => k);

    let out = `[solve_captcha] ${url}\n`;
    out += `  status: ${r.solved ? '✅ solved' : '⚠️ partial'} (after ${r.rounds} round(s))\n`;
    out += `  detected: ${det.length ? det.join(', ') : 'none'}\n`;
    out += `  final url: ${r.finalUrl}\n`;
    out += `  cf_clearance: ${r.hasCfClearance ? 'yes' : 'no'}\n`;
    if (cookieKeys.length) out += `  cookies: ${cookieKeys.join(', ')}\n`;
    if (tokenKeys.length) out += `  tokens: ${tokenKeys.join(', ')}\n`;

    // ── If still blocked by a TOKEN captcha, extract the sitekey and (when an
    //    external solver key is configured, or the caller passes external:true)
    //    solve it via the 2Captcha-compatible service to obtain a real token. ──
    const stillBlocked = !r.solved && (r.detected && (r.detected.recaptcha || r.detected.hcaptcha || r.detected.turnstile || r.detected.imageGrid));
    if (stillBlocked) {
      const html = r.html || '';
      const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
      const siteKey =
        grab(/data-sitekey=["']([^"']+)["']/i) ||
        grab(/sitekey["'\s:=]+["']([0-9A-Za-z_\-]{20,})["']/i) ||
        grab(/render=([0-9A-Za-z_\-]{20,})/i);
      let type = r.detected.hcaptcha ? 'hcaptcha' : (r.detected.turnstile ? 'turnstile' : 'recaptcha');
      if (siteKey) out += `  sitekey: ${siteKey} (type: ${type})\n`;
      const wantExternal = args.external === true || process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_API_KEY || process.env.ANTICAPTCHA_API_KEY;
      if (siteKey && wantExternal) {
        out += `  → attempting external token solver (${type})…\n`;
        const ext = await captcha.solveWithExternalService(type, siteKey, r.finalUrl || url, { apiKey: args.captcha_api_key, timeout: args.ext_timeout || 120000 });
        if (ext.token) out += `  ✅ external token: ${ext.token.slice(0, 40)}… (inject into the "${type === 'hcaptcha' ? 'h-captcha-response' : 'g-recaptcha-response'}" field / submit with browser_action or fetch_url)\n`;
        else out += `  ⚠️ external solver: ${ext.error}\n`;
      } else if (siteKey) {
        out += `  (tip: set TWOCAPTCHA_API_KEY in Admin → Integrations, then re-run with {"external":true} to auto-solve this token captcha)\n`;
      }
    }
    out += `\n--- page text ---\n${(r.text || '(empty)').slice(0, 5000)}`;
    return out;
  } catch (e) {
    return `[solve_captcha] error: ${e.message}`;
  }
}

// ── Tool: take a real screenshot of a web page and deliver it as an image ──
// Powers "open TradingView and screenshot it" style tasks. Renders the page in
// a real headless Chrome (Browserless v2), waits for the JS/charts to paint,
// captures a JPEG/PNG, writes it into the working dir and queues it for
// delivery so the user gets the actual image back.
async function toolScreenshot(args, ctx) {
  const url = args.url || '';
  if (!url) return '[screenshot] No url provided. Pass {"url":"https://...", "filename":"shot.jpg"}.';
  // Sensible filename (honour requested name/extension; default jpeg).
  let filename = (args.filename || '').trim();
  const fullPage = args.full_page === true || args.fullPage === true;
  const wantPng = /\.png$/i.test(filename) || (args.type || '').toLowerCase() === 'png';
  const type = wantPng ? 'png' : 'jpeg';
  if (!filename) {
    let slug = 'screenshot';
    try { slug = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, '').replace(/[^\w.-]/g, '_'); } catch (_) {}
    filename = `${slug}.${type === 'png' ? 'png' : 'jpg'}`;
  }
  filename = filename.replace(/[^\w.\-]/g, '_');
  try {
    const dataUri = await browserless.screenshotUrl(url, {
      type,
      fullPage,
      quality: args.quality || 80,
      width: args.width || 1366,
      height: args.height || 768,
      selector: args.selector || null,
      waitUntil: args.wait_until || 'networkidle2',
    });
    const b64 = dataUri.split(',')[1] || '';
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) return '[screenshot] Browserless returned an empty image.';
    await ctx.deliverBuffer(filename, buffer);
    return `[screenshot] Captured ${url}${fullPage ? ' (full page)' : ''} → ${filename} (${(buffer.length / 1024).toFixed(0)} KB). Image queued for delivery.`;
  } catch (e) {
    return `[screenshot] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: browse_live — LIVE / VNC-style real-time screen.
//
// Boots a REAL, visible browser on a virtual display INSIDE the user's sandbox
// (works on HopX / Runloop / Daytona / local — admin-pinned or auto) and STREAMS
// the screen to the UI in real time as `event: screen` frames over the same SSE
// channel the agent already uses. The user literally watches the agent browse &
// operate the computer live, then we also deliver a final still + the page text
// so the agent can reason about what it saw.
//
//   args: {
//     url:        first page to open in the live browser (required to navigate)
//     steps:      optional [{ action, url?, key?, text?, ms? }]  — extra live actions:
//                   { action:'open', url }            navigate
//                   { action:'key',  key:'Return' }   xdotool keypress
//                   { action:'type', text:'hello' }   xdotool type
//                   { action:'wait', ms:2000 }        dwell (more frames stream)
//                   { action:'scroll', ms?:... }      Page Down
//     watch_ms:   how long to keep the live view open (default 12000, max 120000)
//     fps:        frames/sec to stream (default 3, max 8)
//     quality:    JPEG quality 30–95 (default 60)
//     deliver:    deliver a final still image (default true)
//   }
//
// Always falls back gracefully: if the graphical stack can't boot (e.g. local
// host with no X), it transparently delegates to the headless browse tool so the
// agent still gets the page — it just won't be "live".
// ─────────────────────────────────────────────────────────────────────────────
async function toolBrowseLive(args, ctx) {
  const url = (args.url || '').trim();
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!url && !steps.length) {
    return '[browse_live] No url. Pass {"url":"https://...","watch_ms":15000} to show the user a LIVE view of the agent browsing.';
  }
  if (!ctx || !ctx.fsx || ctx.fsx.kind !== 'sandbox') {
    // No sandbox fsx (pure local/host with no graphical stack) — fall back to
    // the normal headless browse so the agent still works.
    if (ctx && typeof ctx.onStep === 'function') ctx.onStep('ℹ️ live view needs a sandbox — using headless browse instead.');
    return await toolBrowse({ url });
  }

  const watchMs = Math.min(120000, Math.max(3000, parseInt(args.watch_ms || args.watchMs, 10) || 12000));
  const fps = Math.min(8, Math.max(1, parseInt(args.fps, 10) || 3));
  const quality = Math.min(95, Math.max(30, parseInt(args.quality, 10) || 60));
  const wantDeliver = args.deliver !== false;

  let session = null;
  let framesSent = 0;
  try {
    // Signal the UI that a live stream is starting (so it can open the viewer).
    try { ctx.onEvent('screen', { event: 'start', ts: Date.now(), backend: ctx.fsx.backend }); } catch (_) {}

    session = await liveScreen.start(ctx.fsx, {
      fps, quality,
      width: parseInt(args.width, 10) || 1280,
      height: parseInt(args.height, 10) || 800,
      maxMs: watchMs + 30000,
      onStep: (n) => { try { ctx.onStep && ctx.onStep(n); } catch (_) {} },
      onFrame: (b64, meta) => {
        framesSent++;
        try { ctx.onEvent('screen', { frame: b64, w: meta.w, h: meta.h, ts: meta.ts, n: meta.n }); } catch (_) {}
      },
    });

    // 🔴 Emit the reliable web-VNC live URL (Daytona preview proxy → noVNC) so
    // the mobile APK can render the live desktop in a WebView even when the
    // base64-JPEG frame stream is buffered/cut by the proxy.
    (async () => {
      try {
        if (typeof session.directUrl === 'function') {
          const liveUrl = await session.directUrl();
          if (liveUrl) { try { ctx.onEvent('screen', { event: 'liveurl', liveUrl, ts: Date.now() }); } catch (_) {} }
        }
      } catch (_) {}
    })();

    const deadline = Date.now() + watchMs;

    // Open the first URL.
    if (url) { await session.openUrl(url); }

    // Run any extra live steps, leaving time for frames to stream between them.
    for (const st of steps) {
      if (Date.now() > deadline) break;
      const a = String(st.action || '').toLowerCase();
      if (a === 'open' && st.url) { await session.openUrl(st.url); }
      else if (a === 'key' && st.key) { await session.exec(`xdotool key ${String(st.key).replace(/[^\w+]/g, '')}`); }
      else if (a === 'type' && st.text != null) { await session.exec(`xdotool type --delay 30 ${JSON.stringify(String(st.text))}`); }
      else if (a === 'scroll') { await session.exec('xdotool key Next'); }
      else if (a === 'wait') { /* handled by the dwell below */ }
      const dwell = Math.min(Math.max(parseInt(st.ms, 10) || 1500, 300), deadline - Date.now());
      if (dwell > 0) await new Promise(r => setTimeout(r, dwell));
    }

    // Keep streaming until the watch window elapses so the user sees the page.
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(r => setTimeout(r, remaining));

    // Grab the final frame as a deliverable still + harvest page text via headless
    // browse (so the agent has real text to reason about, not just pixels).
    let finalNote = '';
    if (wantDeliver) {
      try {
        const buf = await ctx.fsx.downloadBuffer(liveScreen.FRAME_FILE);
        if (buf && buf.length > 256) {
          let slug = 'live';
          try { slug = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, '').replace(/[^\w.-]/g, '_'); } catch (_) {}
          await ctx.deliverBuffer(`${slug}_live.jpg`, buf);
          finalNote = ` Final still delivered as ${slug}_live.jpg.`;
        }
      } catch (_) {}
    }

    let pageText = '';
    if (url) {
      try {
        const r = await toolBrowse({ url });
        pageText = String(r || '').slice(0, 4000);
      } catch (_) {}
    }

    try { ctx.onEvent('screen', { event: 'end', ts: Date.now(), frames: framesSent }); } catch (_) {}

    return `[browse_live] ✅ Streamed a LIVE view of the agent browsing ${url || '(desktop)'} ` +
           `(${framesSent} frames @ ~${fps}fps over ${Math.round(watchMs / 1000)}s, ${ctx.fsx.backend} sandbox).${finalNote}` +
           (pageText ? `\n\nPage content seen:\n${pageText}` : '');
  } catch (e) {
    try { ctx.onEvent('screen', { event: 'end', ts: Date.now(), error: String(e.message) }); } catch (_) {}
    if (ctx && typeof ctx.onStep === 'function') ctx.onStep(`ℹ️ live view unavailable (${String(e.message).slice(0, 80)}) — using headless browse.`);
    try { return await toolBrowse({ url }); } catch (e2) { return `[browse_live] error: ${e.message}`; }
  } finally {
    if (session) { try { await session.stop(); } catch (_) {} }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Office-document text extraction (docx / doc / pptx / xlsx / csv).
// Returns { text, meta } where meta is a short human label (e.g. "12 paragraphs").
// Uses pure-JS libraries (mammoth for Word, xlsx for spreadsheets, adm-zip XML
// parsing for PowerPoint) so it ALWAYS works on the Render host with no system
// binaries. This is what lets the agent actually READ the user's .docx instead
// of giving up and fabricating content.
// ─────────────────────────────────────────────────────────────────────────────
async function extractOfficeText(buffer, lowerName) {
  // ---- Word: .docx / .docm (true OOXML) — mammoth gives clean text + structure
  if (/\.docx?$/i.test(lowerName) || /\.docm$/i.test(lowerName)) {
    // .docx / .docm are zip-based OOXML → mammoth handles them perfectly.
    if (!/\.doc$/i.test(lowerName)) {
      try {
        const mammoth = require('mammoth');
        // Markdown keeps headings/lists/bold so the model sees real structure.
        let res;
        try { res = await mammoth.convertToMarkdown({ buffer }); }
        catch (_) { res = await mammoth.extractRawText({ buffer }); }
        const text = (res && res.value) ? res.value : '';
        if (text && text.trim()) return { text, meta: 'Word document' };
      } catch (e) { /* fall through to raw XML */ }
    }
    // Legacy .doc (binary OLE) OR mammoth failure → crude XML/byte extraction.
    try {
      const zip = new AdmZip(buffer);
      const docXml = zip.getEntry('word/document.xml');
      if (docXml) {
        const xml = zip.readAsText(docXml);
        const text = xml
          .replace(/<w:p[ >]/g, '\n')                 // paragraphs → newlines
          .replace(/<w:tab\/>/g, '\t')
          .replace(/<[^>]+>/g, '')                     // strip tags
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (text) return { text, meta: 'Word document (XML extract)' };
      }
    } catch (_) { /* not a zip (legacy .doc) */ }
    // Last resort for legacy binary .doc: pull printable runs.
    const raw = buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
    const text = raw.replace(/\s{3,}/g, '\n').trim();
    if (text && text.length > 20) return { text, meta: 'Word document (binary extract)' };
    return { text: '', meta: 'Word document (no extractable text)' };
  }

  // ---- PowerPoint: .pptx — pull text from every slide XML.
  if (/\.pptx?$/i.test(lowerName)) {
    try {
      const zip = new AdmZip(buffer);
      const slides = zip.getEntries()
        .filter(e => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => {
          const na = +(a.entryName.match(/slide(\d+)\.xml/i)?.[1] || 0);
          const nb = +(b.entryName.match(/slide(\d+)\.xml/i)?.[1] || 0);
          return na - nb;
        });
      let out = '';
      slides.forEach((e, i) => {
        const xml = zip.readAsText(e);
        const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
        const slideText = runs.join(' ').replace(/<[^>]+>/g, '').trim();
        if (slideText) out += `\n## Slide ${i + 1}\n${slideText}\n`;
      });
      out = out.trim();
      if (out) return { text: out, meta: `${slides.length} slides` };
    } catch (e) { /* fall through */ }
    return { text: '', meta: 'PowerPoint (no extractable text)' };
  }

  // ---- Excel: .xlsx / .xls — dump every sheet as a Markdown-ish table.
  if (/\.xls[xmb]?$/i.test(lowerName)) {
    try {
      const XLSX = require('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      let out = '';
      for (const sheetName of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName], { blankrows: false });
        if (csv && csv.trim()) out += `\n## Sheet: ${sheetName}\n${csv}\n`;
      }
      out = out.trim();
      if (out) return { text: out, meta: `${wb.SheetNames.length} sheet(s)` };
    } catch (e) { /* fall through */ }
    return { text: '', meta: 'Spreadsheet (no extractable text)' };
  }

  // ---- CSV / TSV — already plain text.
  if (/\.(csv|tsv)$/i.test(lowerName)) {
    const text = buffer.toString('utf-8');
    return { text, meta: 'CSV' };
  }

  return null; // not an office type → caller handles
}

// True when read_document / read_file should route a name through extractOfficeText.
function isOfficeDoc(lowerName) {
  return /\.(docx?|docm|pptx?|xls[xmb]?|csv|tsv)$/i.test(lowerName);
}

// Normalise a filename for robust matching across the sandbox boundary.
// The sandbox sanitises uploaded names (spaces, parens, etc. → "_"), so the
// model often calls read_document / analyze_image with the SANITISED name while
// ctx.attachments still holds the ORIGINAL name. We compare on a canonical form
// (lower-cased, every non-alphanumeric/dot run collapsed) plus basename so the
// match never silently fails. Returns "" for empty input.
function _canonName(s) {
  return String(s || '')
    .replace(/\\/g, '/')              // normalise separators
    .split('/').pop()                  // basename only
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '_')      // collapse spaces/parens/etc → "_"
    .replace(/_+/g, '_')               // squeeze repeats
    .replace(/^_+|_+$/g, '');          // trim edges
}
// Find the best-matching attachment for a (possibly sanitised) name.
function _findAttachment(attachments, name) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const want = _canonName(name);
  if (!want) return null;
  // 1) exact original match  2) exact canonical match  3) canonical substring
  return attachments.find(a => a.name === name)
      || attachments.find(a => _canonName(a.name) === want)
      || attachments.find(a => { const c = _canonName(a.name); return c.includes(want) || want.includes(c); })
      || null;
}

async function toolReadDocument(args, ctx) {
  const name = args.name || '';
  // If exactly one file is attached, just use it — the agent often passes a
  // slightly-off name, and there is no ambiguity to resolve.
  let att = _findAttachment(ctx.attachments, name)
           || (ctx.attachments.length === 1 ? ctx.attachments[0] : null);
  // Fallback: the file may live in the sandbox/work dir (e.g. the agent
  // generated it, or the host-side attachment registry was lost on restart).
  // Pull it straight out of the working dir via ctx.fsx so read_document never
  // dead-ends with "no attached file" when the bytes are actually reachable.
  if (!att && ctx.fsx && typeof ctx.fsx.list === 'function') {
    try {
      const want = _canonName(name);
      const files = await ctx.fsx.list();
      const docs = files.filter(f => {
        const base = (f.rel || '').split('/').pop();
        if (/(^|\/)(_step|\.agent_)/.test(f.rel)) return false;
        return isOfficeDoc(base.toLowerCase()) || /\.pdf$/i.test(base);
      });
      let pick = docs.find(f => want && _canonName(f.rel) === want)
              || docs.find(f => { const c = _canonName(f.rel); return want && (c.includes(want) || want.includes(c)); })
              || (docs.length === 1 ? docs[0] : null);
      if (pick) {
        const buf = await ctx.fsx.downloadBuffer(pick.rel);
        if (buf && buf.length) att = { name: pick.rel.split('/').pop(), buffer: buf, isImage: false };
      }
    } catch (_) { /* fall through to the not-found message */ }
  }
  if (!att) return `[read_document] No attached file named "${name}". Attached: ${ctx.attachments.map(a => a.name).join(', ') || '(none)'}`;
  const lower = att.name.toLowerCase();
  // How much extracted text to hand the model. Big enough to fit full reports /
  // multi-page docs so it can reproduce the WHOLE thing (no more "scanty" output
  // caused by only seeing the first 9 KB).
  const MAX = 180000;
  // ── OmniOCR-FIRST for documents (PDF / DOCX / XLSX) ──────────────────────
  // Per the inbound-file spec, user documents are routed through the OmniOCR
  // Python engine FIRST (hybrid native+OCR for PDFs, native parse for DOCX/XLSX,
  // OCR for embedded images). If OmniOCR is unavailable or returns nothing, we
  // fall straight through to the existing pure-JS extractors below — so this is
  // purely additive and never breaks the established path.
  try {
    if (omniOcr.isDocName(att.name)) {
      const ex = await omniOcr.extract(ctx, att.buffer, att.name, { mode: 'auto', pages: 30 });
      if (ex && ex.ok && ex.text && ex.text.trim()) {
        const text = ex.text;
        const label = ex.type === 'pdf' ? 'PDF' : ex.type === 'excel' ? 'Spreadsheet' : ex.type === 'docx' ? 'Word document' : (ex.type || 'document');
        const tn = text.length > MAX ? `\n\n[...truncated — document is ${text.length} chars; showing first ${MAX}. Use the content shown to reproduce the full document.]` : '';
        if (ctx.onStep) ctx.onStep(`📄 ${att.name}: extracted via OmniOCR (${text.length} chars, conf ${ex.confidence}%).`);
        return `[read_document] ${label} "${att.name}" via OmniOCR (${text.length} chars extracted, confidence ${ex.confidence}%):\n${text.slice(0, MAX)}${tn}`;
      }
      if (ctx.onStep) ctx.onStep(`ℹ️ ${att.name}: OmniOCR found no text (${ex && ex.reason || 'n/a'}) — using built-in extractor.`);
    }
  } catch (_) { /* fall through to the JS extractors below */ }
  try {
    if (lower.endsWith('.pdf')) {
      let text = '';
      let pages = '?';
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(att.buffer);
        text = data.text || '';
        pages = data.numpages;
      } catch (e) {
        // Fallback 1: try the `pdftotext` CLI if present (on the host)
        try {
          const tmp = path.join(os.tmpdir(), `_pdfin_${Date.now()}.pdf`);
          fs.writeFileSync(tmp, att.buffer);
          const r = await runShellLocal(`pdftotext "${tmp}" - 2>/dev/null`, os.tmpdir());
          text = r.output || '';
          try { fs.unlinkSync(tmp); } catch (_) {}
        } catch (_) {}
        // Fallback 2: crude text-stream extraction from the raw bytes
        if (!text || text.trim().length < 3) {
          const raw = att.buffer.toString('latin1');
          const chunks = [];
          const re = /\(([^()\\]{2,})\)\s*Tj|\[(.*?)\]\s*TJ/g;
          let m;
          while ((m = re.exec(raw)) !== null) {
            const seg = (m[1] || m[2] || '').replace(/\\[rn]/g, ' ').replace(/\([^()]*\)/g, s => s.slice(1, -1));
            if (seg) chunks.push(seg.replace(/[^\x20-\x7E]/g, ''));
          }
          text = chunks.join(' ');
        }
      }
      if (!text || !text.trim()) return `[read_document] PDF "${att.name}" had no extractable text (it may be scanned/image-only). Try analyze_image if it's a scan.`;
      const truncNote = text.length > MAX ? `\n\n[...truncated — document is ${text.length} chars; showing first ${MAX}. Use the content shown to reproduce the full document.]` : '';
      return `[read_document] PDF "${att.name}" (${pages} pages, ${text.length} chars extracted):\n${text.slice(0, MAX)}${truncNote}`;
    }
    // Office documents: Word / PowerPoint / Excel / CSV — extract REAL text so
    // the agent can read & rewrite them instead of giving up.
    if (isOfficeDoc(lower)) {
      const res = await extractOfficeText(att.buffer, lower);
      if (res && res.text && res.text.trim()) {
        const text = res.text;
        const truncNote = text.length > MAX ? `\n\n[...truncated — document is ${text.length} chars; showing first ${MAX}. Use the content shown to reproduce the full document.]` : '';
        return `[read_document] ${res.meta} "${att.name}" (${text.length} chars extracted):\n${text.slice(0, MAX)}${truncNote}`;
      }
      return `[read_document] "${att.name}" — ${res ? res.meta : 'could not extract text'}. The file may be empty, password-protected, or image-only. If it is scanned, try analyze_image / convert_file with OCR.`;
    }
    if (lower.endsWith('.zip')) {
      const zip = new AdmZip(att.buffer);
      const entries = zip.getEntries();
      let out = `[read_document] ZIP "${att.name}" — ${entries.length} entries:\n`;
      for (const e of entries.slice(0, 60)) out += ` - ${e.entryName} (${e.header.size}b)\n`;
      // Inline small text files
      for (const e of entries) {
        if (!e.isDirectory && e.header.size < 40000 && /\.(txt|md|js|ts|py|json|html|css|java|c|cpp|go|rs|sh|yml|yaml|xml|csv)$/i.test(e.entryName)) {
          out += `\n----- ${e.entryName} -----\n${zip.readAsText(e).slice(0, 3000)}\n`;
          if (out.length > 9000) break;
        }
      }
      return out.slice(0, 12000);
    }
    // Treat everything else as text
    const text = att.buffer.toString('utf-8');
    const truncNote = text.length > MAX ? `\n\n[...truncated — ${text.length} chars; showing first ${MAX}.]` : '';
    return `[read_document] "${att.name}" (${text.length} chars):\n${text.slice(0, MAX)}${truncNote}`;
  } catch (e) {
    return `[read_document] error reading ${att.name}: ${e.message}`;
  }
}

// ── Tool: solve_math — math specialist (text + image + PDF) ──────────────────
// Routes a math problem to the dedicated math brains (MathPanda for text/PDF,
// MathPanda + figpromptfinder in parallel for images). Resilient & rate-limit
// free; runs independently of the general chat race. Returns markdown+LaTeX.
async function toolSolveMath(args, ctx) {
  const prompt = (args.query || args.problem || args.text || '').trim();
  const name = (args.name || args.file || '').trim();

  // 1) A named attachment (image or PDF) takes priority.
  if (name) {
    const att = ctx.attachments.find(a => a.name === name) ||
                ctx.attachments.find(a => a.name.includes(name));
    if (!att) return `[solve_math] No attached file named "${name}". Attached: ${ctx.attachments.map(a => a.name).join(', ') || '(none)'}`;
    const lower = att.name.toLowerCase();
    try {
      if (lower.endsWith('.pdf')) {
        const out = await mathSolver.solvePdf(att.buffer, att.name, prompt || 'Solve the problem in this PDF.');
        return `[solve_math] (PDF: ${att.name})\n${out}`;
      }
      if (/\.(png|jpg|jpeg)$/i.test(lower) || att.isImage) {
        const mime = att.mime || 'image/png';
        const out = await mathSolver.solveImage(att.buffer, att.name, mime, prompt || 'Solve the problem in this image.');
        return `[solve_math] (image: ${att.name})\n${out}`;
      }
      return `[solve_math] Unsupported file type for "${att.name}". solve_math accepts .png/.jpg/.jpeg/.pdf, or pass {"query":"..."} for text.`;
    } catch (e) {
      return `[solve_math] error solving ${att.name}: ${e.message}`;
    }
  }

  // 2) If there's no named file but an image/PDF is attached and no text query,
  //    auto-pick the first math-capable attachment.
  if (!prompt) {
    const att = ctx.attachments.find(a => a.isImage || /\.pdf$/i.test(a.name));
    if (att) {
      try {
        if (/\.pdf$/i.test(att.name)) {
          const out = await mathSolver.solvePdf(att.buffer, att.name);
          return `[solve_math] (PDF: ${att.name})\n${out}`;
        }
        const out = await mathSolver.solveImage(att.buffer, att.name, att.mime || 'image/png');
        return `[solve_math] (image: ${att.name})\n${out}`;
      } catch (e) {
        return `[solve_math] error: ${e.message}`;
      }
    }
    return '[solve_math] No query and no math image/PDF attached. Pass {"query":"<math problem>"} or {"name":"<attached image/pdf>"}.';
  }

  // 3) Plain text math.
  try {
    const out = await mathSolver.solveText(prompt);
    return `[solve_math]\n${out}`;
  } catch (e) {
    return `[solve_math] error: ${e.message}`;
  }
}

// Analyze ONE attached image (by exact name, partial name, or the first image
// if no name is given) using the working vision gateway.
async function toolAnalyzeImage(args, ctx) {
  // "all": true (or analyze_images alias) → analyze EVERY attached image.
  const wantAll = args.all === true || args.all === 'true' ||
                  /^(all|every|\*)$/i.test(String(args.name || '').trim());
  const images = extractionCompleteness.orderImages(ctx.attachments.filter(a => a.isImage));
  if (!images.length) return `[analyze_image] No attached image found. Attached: ${ctx.attachments.map(a => a.name).join(', ') || '(none)'}`;
  const maxImages = Math.min(10, Math.max(1, parseInt(process.env.MAX_IMAGE_BATCH || '10', 10) || 10));
  if (wantAll && images.length > maxImages) {
    return `[analyze_image] This request has ${images.length} images; the verified batch limit is ${maxImages}. Split it into ordered batches of at most ${maxImages} so no page is silently skipped.`;
  }

  const question = args.question || 'You are a precise OCR + vision engine. Do BOTH of the following:\n\n(A) TRANSCRIBE — extract EVERY piece of visible text in the image VERBATIM, exactly as written (preserve spelling, casing, punctuation, numbers, symbols, line breaks and reading order). Include headings, body text, buttons, labels, captions, menu items, form fields, watermarks, fine print, code, tables and any text inside logos or images. If text is in columns or a table, preserve that structure. Do NOT summarise, translate, paraphrase, correct or omit any text. If a character is genuinely unreadable, mark it [?]. If there is no text at all, say "NO TEXT".\n\n(B) DESCRIBE — then, if it is a UI / website / app design / wireframe / screenshot, describe the exact layout, sections, components, color palette (give hex values), typography, spacing, imagery and icons — enough detail to rebuild it faithfully.\n\nReturn the transcription first under a "TEXT:" heading, then the description under a "LAYOUT:" heading.';

  // Aggressive OCR-only fallback used when the first pass comes back empty or
  // suspiciously short — squeezes the gateway for a pure verbatim transcription.
  const OCR_RETRY_PROMPT = 'Transcribe ALL text visible in this image, character for character, exactly as it appears (keep casing, punctuation, numbers, line order and layout). Output ONLY the transcribed text, nothing else. If there is no text, reply "NO TEXT".';

  // Detect the real MIME from the buffer's magic bytes so PNG/WEBP/GIF are not
  // mislabelled as JPEG (mislabelling makes some vision models reject the image).
  const sniffMime = (att) => {
    const b = att.buffer;
    if (!b || b.length < 4) return att.mime || 'image/png';
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';            // PNG
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';           // JPEG
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';            // GIF
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';            // BMP
    if (b.length > 12 && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return att.mime || 'image/png';
  };

  // Resilient vision call: try the primary brain (HotBot/GPT-5 vision), and if
  // it throws or returns nothing, fall back to the Gemini gateway DIRECTLY so a
  // single flaky provider never kills a multi-image batch.
  const callVision = async (att, q) => {
    const mime = sniffMime(att);
    const b64 = att.buffer.toString('base64');
    const dataUri = `data:${mime};base64,${b64}`;
    const messages = [
      { role: 'system', content: gemini.SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUri } },
        { type: 'text', text: q },
      ] },
    ];
    // 1) primary brain
    try {
      const r = await hotbot.chat(messages);
      if (r && String(r).trim()) return String(r);
    } catch (_) { /* fall through to Gemini */ }
    // 2) direct Gemini gateway fallback (most reliable for raw vision/OCR)
    try {
      const data = await gemini.generate([
        { inline_data: { mime_type: mime, data: b64 } },
        { text: q },
      ]);
      const txt = gemini.extractText ? gemini.extractText(data) : '';
      if (txt && txt.trim()) return txt;
    } catch (_) { /* give up gracefully */ }
    return '';
  };

  const analyzeOne = async (att) => {
    // ── OmniOCR-FIRST pipeline ───────────────────────────────────────────────
    // Per the inbound-file spec: images that CONTAIN TEXT must be transcribed by
    // the OmniOCR Python engine first (high-precision, local, no API limits);
    // only PURE images (photos with no meaningful text) go to the vision model.
    // OmniOCR failure for ANY reason silently falls back to the vision path
    // below — it must never break image handling.
    let omniText = '';
    let omniHadText = false;
    let omniMeta = { engine: 'vision', confidence: null };
    try {
      // Extract once at full quality. The former classify→extract sequence ran
      // the complete multi-pass OCR pipeline twice per image, increasing cost,
      // provider timeouts and partial 10-page batches without improving text.
      const ex = await omniOcr.extract(ctx, att.buffer, att.name, { mode: 'auto' });
      if (ex && ex.ok && ex.text && ex.text.trim()) {
        omniHadText = true;
        omniText = ex.text.trim();
        omniMeta = { engine: ex.engine || 'sandbox_ocr', confidence: ex.confidence };
        if (ctx.onStep) ctx.onStep(`🔎 ${att.name}: text extracted via OmniOCR (${omniText.length} chars).`);
      }
    } catch (_) { /* fall through to vision */ }

    // If OCR produced text, that is the ONLY source used for document reading.
    // The LLM may reason over this extracted text later, but it must not inspect
    // the image and silently replace/augment OCR. Vision is allowed here only
    // when the user explicitly requested visual/layout analysis rather than
    // document transcription.
    if (omniText) {
      const wantsLayout = /\b(layout|design|wireframe|ui|visual|colour|color|typography|rebuild|describe the image|what is in)\b/i.test(String(args.question || ''));
      let layout = '';
      if (wantsLayout) {
        try {
          const r = await callVision(att,
            'Describe only the visual layout and non-text visual elements. Do not transcribe, correct, or reinterpret any text; OCR text is supplied separately.');
          if (r && r.trim()) layout = r.trim();
        } catch (_) { /* layout is optional */ }
      }
      const combined = layout
        ? `TEXT (OCR):\n${omniText}\n\nVISUAL LAYOUT (AI-assisted):\n${layout}`
        : `TEXT (OCR):\n${omniText}`;
      return { text: combined, rawText: omniText, ...omniMeta };
    }

    // ── LAST-RESORT vision path ──────────────────────────────────────────────
    // Reached only after sandbox OCR AND isolated host OCR failed/found no text.
    if (ctx.onStep) ctx.onStep(`⚠️ ${att.name}: OCR engines returned no readable text; using AI vision as the labelled last-resort fallback.`);
    let out = '';
    try { out = await callVision(att, question); } catch (e) { out = ''; }
    // If the model returned little/nothing, retry once with a pure-OCR prompt so
    // text-heavy images (screenshots, docs, receipts, code) still get extracted.
    if (!out || out.trim().length < 12) {
      // Last-ditch: if OmniOCR was available but classifier said "no text", a
      // forced OCR extraction can still rescue faint text before we give up.
      if (!omniHadText) {
        try {
          const ex = await omniOcr.extract(ctx, att.buffer, att.name, { mode: 'auto' });
          if (ex && ex.ok && ex.text && ex.text.trim()) {
            return { text: `TEXT (OmniOCR):\n${ex.text.trim()}`, rawText: ex.text.trim(), engine: ex.engine || 'sandbox_ocr', confidence: ex.confidence };
          }
        } catch (_) {}
      }
      try {
        const ocr = await callVision(att, OCR_RETRY_PROMPT);
        if (ocr && ocr.trim()) out = out && out.trim() ? `${out}\n\nTEXT (OCR retry):\n${ocr}` : ocr;
      } catch (_) { /* keep whatever we had */ }
    }
    const text = out && out.trim() ? out.trim() : '[no readable content returned by the vision gateway]';
    return { text, rawText: text, engine: 'vision', confidence: null };
  };

  // ── Cross-image SYNTHESIS pass ───────────────────────────────────────────
  // After every image has been individually transcribed/described, feed the
  // COMBINED per-image text back to the brain so it can UNDERSTAND THE WHOLE SET
  // as one document/problem — not 9 disconnected fragments. This is what lets
  // the AI "read multiple images (9 or more), understand it, and solve":
  //   • stitch a question that spans several photos/pages into one problem,
  //   • answer/solve past-questions that are split across images,
  //   • reconcile a multi-page table/spreadsheet screenshotted in parts,
  //   • produce ONE coherent answer instead of a pile of transcriptions.
  // It NEVER throws and NEVER discards the raw per-image text — if synthesis
  // fails for any reason the caller still gets the full per-image report.
  const crossSynthesize = async (perImageReport, imageCount) => {
    if (imageCount < 2) return '';           // nothing to cross-reference
    if (String(process.env.VISION_SYNTHESIS || '').toLowerCase() === 'off') return '';
    // Guard the payload so we never blow the brain's context on huge albums.
    const MAX = parseInt(process.env.VISION_SYNTHESIS_MAX_CHARS || '48000', 10);
    const body = perImageReport.length > MAX
      ? perImageReport.slice(0, MAX) + '\n\n[...truncated for synthesis]'
      : perImageReport;
    const userGoal = (args.question && !/precise OCR \+ vision engine/i.test(args.question))
      ? String(args.question).trim()
      : '';
    const solveHint = userGoal
      ? `The user's request for these images is: """${userGoal}"""\nDo exactly that using ALL images together.`
      : `Treat the images as ONE combined document/problem set. If they contain question(s), problem(s), an exam, past-questions or a task, SOLVE them completely with full working/steps. If they are pages of one document, reassemble it in order. Otherwise, give one unified, structured understanding of the whole set.`;
    const synthPrompt =
      `You are given the extracted text + layout of ${imageCount} images that belong together (pages/parts of one thing, or a set the user sent as a batch).\n\n` +
      `${solveHint}\n\n` +
      `Rules:\n` +
      `- Consider the images as a WHOLE; cross-reference across them.\n` +
      `- Preserve reading order (Image 1 → ${imageCount}).\n` +
      `- First create a question ledger (question number, sub-parts, source image) and verify no extracted question was omitted or duplicated.\n` +
      `- For calculations: use formula → substitution → every algebra/arithmetic transformation → units → final answer. Never jump from setup to result, and never replace working with prose.\n` +
      `- For written/theory questions: answer directly and proportionately; do not pad calculation questions with essays.\n` +
      `- Independently verify each numerical result by substitution, inverse operation, symbolic computation, or a second derivation; correct discrepancies before answering.\n` +
      `- Do NOT just re-list the raw text; deliver understanding/answers.\n` +
      `- If the images are unrelated plain photos, say so briefly.\n\n` +
      `=== EXTRACTED CONTENT (per image) ===\n${body}`;
    try {
      const out = await geminiComplete(
        'You are an expert multi-document analyst and problem solver. You reason carefully across many pages/images and produce one correct, complete, well-structured answer.',
        [{ role: 'user', text: synthPrompt }],
      );
      if (out && String(out).trim()) return String(out).trim();
    } catch (_) { /* synthesis is best-effort — never breaks the report */ }
    return '';
  };

  try {
    // Analyze ALL images and return a combined, per-image report.
    // Done in CONCURRENT batches (not strictly sequential) so a large album
    // (e.g. 9+ images) finishes fast and one slow/failed image never blocks the
    // rest. Concurrency scales with album size so 9+ images finish fast, while
    // staying friendly with provider rate limits.
    if (wantAll) {
      // OCR jobs are CPU/memory heavy and several sandbox providers serialize
      // command execution. A bounded OCR pool prevents 9-page batches from
      // dropping pages under provider pressure while preserving source order.
      const CONCURRENCY = Math.max(1, Math.min(3, parseInt(process.env.OCR_CONCURRENCY || '2', 10) || 2));
      const results = new Array(images.length);
      let done = 0;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= images.length) break;
          try {
            let out = await analyzeOne(images[i]);
            let assessed = extractionCompleteness.assessPage({ name: images[i].name, text: out.rawText, engine: out.engine, confidence: out.confidence });
            // Weak OCR remains visible in the manifest. Do not hide it by asking
            // an LLM to re-read the image; deterministic OCR already performs
            // multiple preprocessing, segmentation and tiled passes. AI is used
            // only later to reason over the retained OCR text.
            if (assessed.weak && ctx.onStep) {
              ctx.onStep(`⚠️ ${images[i].name}: OCR completed but extraction quality is weak (${assessed.weakReasons.join(', ')}).`);
            }
            results[i] = { name: images[i].name, ...out, assessment: assessed };
          } catch (e) {
            results[i] = { name: images[i].name, text: `[error: ${e.message}]`, rawText: '', engine: 'error', confidence: 0, error: e.message };
          }
          done++;
          if (ctx.onStep) ctx.onStep(`🖼️ analyzed ${done}/${images.length} image(s)…`);
        }
      };
      const pool = Array.from({ length: Math.min(CONCURRENCY, images.length) }, () => worker());
      await Promise.all(pool);
      const pageRows = results.map((r, i) => ({ name: r.name || images[i].name, text: r.rawText || r.text, engine: r.engine, confidence: r.confidence, error: r.error }));
      const verified = extractionCompleteness.renderPageReport(pageRows);
      const ok = verified.manifest.pages.filter(p => !p.weak && p.text).length;
      const detailReport = results.map((r, i) => `### Image ${i + 1}: ${r.name}\n${r.text}`).join('\n\n');
      const perImageReport = `${extractionCompleteness.completenessInstruction(verified.manifest)}\n\n${verified.report}\n\n=== VISUAL/SECONDARY DETAILS ===\n${detailReport}`;
      // Cross-image understanding/solve pass over the WHOLE set.
      let synthesis = '';
      if (ctx.onStep) ctx.onStep(`🧩 understanding all ${images.length} image(s) together…`);
      try { synthesis = await crossSynthesize(perImageReport, images.length); } catch (_) {}
      const status = verified.manifest.complete ? 'complete' : `needs review on page(s) ${verified.manifest.weakPages.join(',') || verified.manifest.missingPages.join(',')}`;
      const head = `[analyze_image] Processed ${images.length}/${images.length} image(s); ${ok} passed extraction checks; manifest status: ${status}.`;
      if (synthesis) {
        return `${head}\n\n## COMBINED UNDERSTANDING (all ${images.length} images together)\n${synthesis}\n\n---\n## PER-IMAGE EXTRACTION\n\n${perImageReport}`;
      }
      return `${head}\n\n${perImageReport}`;
    }

    // Analyze a single targeted image.
    const name = args.name || '';
    const att = (name && (images.find(a => a.name === name) || images.find(a => a.name.includes(name)))) || images[0];
    const analyzed = await analyzeOne(att);
    return `[analyze_image] ${att.name}:\n${analyzed.text}`;
  } catch (e) {
    return `[analyze_image] error: ${e.message}`;
  }
}

// ── Helpers: walk the working dir (skip the agent's own scratch scripts) ────
function walkDir(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name.startsWith('_step_')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) walkDir(full, base, out);
    else out.push({ rel: path.relative(base, full), full, size: stat.size, mtime: stat.mtimeMs });
  }
  return out;
}

function safeJoin(workdir, rel) {
  const target = path.resolve(workdir, rel || '.');
  if (target !== workdir && !target.startsWith(workdir + path.sep)) return null; // path traversal guard
  return target;
}

async function toolListFiles(args, ctx) {
  const files = await ctx.fsx.list();
  if (!files.length) return '[list_files] working dir is empty.';
  let out = `[list_files] ${files.length} file(s) in working dir:\n`;
  for (const f of files.slice(0, 200)) out += ` - ${f.rel} (${f.size}b)\n`;
  return out.slice(0, 8000);
}

async function toolInspectCodebase(args, ctx) {
  const prefix = String(args.path || '.').replace(/^\.\/?/, '').replace(/\\/g, '/');
  const skip = /(^|\/)(?:\.git|node_modules|vendor|\.venv|venv|__pycache__|\.next|dist|build|coverage|\.dart_tool|\.gradle|target)(?:\/|$)/;
  const textExt = /(?:\.(?:js|cjs|mjs|ts|tsx|jsx|py|go|rs|java|kt|dart|rb|php|cs|c|cc|cpp|h|hpp|sh|sql|html|css|scss|vue|svelte|json|ya?ml|toml|xml|md)|(?:^|\/)(?:Dockerfile|Makefile|Procfile|Gemfile|Rakefile))$/i;
  const listed = (await ctx.fsx.list()).filter(f => !skip.test(f.rel) && textExt.test(f.rel) && (prefix === '' || prefix === '.' || f.rel === prefix || f.rel.startsWith(prefix + '/')));
  const files = [];
  let totalBytes = 0;
  for (const f of listed) {
    try {
      const text = await ctx.fsx.readText(f.rel); // full first-party file read
      const bytes = Buffer.byteLength(text);
      totalBytes += bytes;
      files.push({ path: f.rel, bytes, lines: text.split('\n').length, sha256: crypto.createHash('sha256').update(text).digest('hex') });
    } catch (_) { /* binary/unreadable files are excluded */ }
  }
  const top = {};
  for (const f of files) { const k = f.path.split('/')[0]; top[k] = (top[k] || 0) + 1; }
  return `[inspect_codebase]\nCODEBASE_INVENTORY_COMPLETE files=${files.length} bytes=${totalBytes} hashed_full_files=${files.length}\nTop-level architecture: ${JSON.stringify(top)}\n` +
    files.slice(0, 120).map(f => `- ${f.path} (${f.lines} lines, ${f.sha256.slice(0, 12)})`).join('\n') +
    '\nNow grep for the symptom and read every file you may change in full before editing.';
}

async function toolReadFile(args, ctx) {
  const rel = args.path || '';
  if (!rel) return '[read_file] no path given.';
  const MAX = 180000;
  try {
    if (!(await ctx.fsx.exists(rel))) return `[read_file] "${rel}" not found. Use list_files to see available files.`;
    const lower = rel.toLowerCase();
    // Binary documents in the working dir (e.g. extracted from a ZIP, or one the
    // agent created): extract REAL text instead of reading raw bytes as UTF-8.
    if (isOfficeDoc(lower) || lower.endsWith('.pdf')) {
      let buf;
      try { buf = await ctx.fsx.downloadBuffer(rel); } catch (e) { return `[read_file] could not read "${rel}": ${e.message}`; }
      // OmniOCR-FIRST (PDF / DOCX / XLSX). Falls through to the JS extractors
      // below if OmniOCR is unavailable or yields nothing — never breaks.
      try {
        if (omniOcr.isDocName(rel)) {
          const ex = await omniOcr.extract(ctx, buf, rel, { mode: 'auto', pages: 30 });
          if (ex && ex.ok && ex.text && ex.text.trim()) {
            const t = ex.text;
            const tn = t.length > MAX ? `\n\n[...truncated — ${t.length} chars; showing first ${MAX}.]` : '';
            return `[read_file] "${rel}" via OmniOCR (${t.length} chars, conf ${ex.confidence}%):\n${t.slice(0, MAX)}${tn}`;
          }
        }
      } catch (_) { /* fall through */ }
      if (lower.endsWith('.pdf')) {
        let text = '';
        try { const pdfParse = require('pdf-parse'); text = (await pdfParse(buf)).text || ''; } catch (_) {}
        if (!text.trim()) return `[read_file] PDF "${rel}" had no extractable text (may be scanned). Try analyze_image / convert_file OCR.`;
        const tn = text.length > MAX ? `\n\n[...truncated — ${text.length} chars; showing first ${MAX}.]` : '';
        return `[read_file] PDF "${rel}" (${text.length} chars):\n${text.slice(0, MAX)}${tn}`;
      }
      const res = await extractOfficeText(buf, lower);
      if (res && res.text && res.text.trim()) {
        const tn = res.text.length > MAX ? `\n\n[...truncated — ${res.text.length} chars; showing first ${MAX}.]` : '';
        return `[read_file] ${res.meta} "${rel}" (${res.text.length} chars):\n${res.text.slice(0, MAX)}${tn}`;
      }
      return `[read_file] "${rel}" — ${res ? res.meta : 'could not extract text'}.`;
    }
    const text = await ctx.fsx.readText(rel);
    const tn = text.length > MAX ? `\n\n[...truncated — "${rel}" is ${text.length} chars; showing first ${MAX}.]` : '';
    return `[read_file] "${rel}" (${text.length} chars):\n${text.slice(0, MAX)}${tn}`;
  } catch (e) {
    return `[read_file] error: ${e.message}`;
  }
}

async function toolEditFile(args, ctx) {
  const rel = args.path || '';
  if (!rel) return '[edit_file] no path given.';
  try {
    await ctx.fsx.writeText(rel, args.content != null ? String(args.content) : '');
    ctx.addFile(rel, path.posix.basename(rel));
    return `[edit_file] wrote ${rel} (${String(args.content || '').length} bytes). Remember to make_zip if the user needs the whole project back.`;
  } catch (e) {
    return `[edit_file] error: ${e.message}`;
  }
}

// Repackage the working dir (or a subfolder) into an archive and deliver it.
// Supports multiple formats chosen by the output extension: .zip (default),
// .tar.gz / .tgz, .tar, .tar.bz2 / .tbz2, .tar.xz / .txz. In the sandbox we use
// the native CLI tools (zip / tar) which are fast and handle ANY file type
// (binaries, nested dirs, symlinks). Falls back to AdmZip on the host backend.
function archiveFormat(name) {
  const n = name.toLowerCase();
  if (/\.(tar\.gz|tgz)$/.test(n)) return { kind: 'targz', tarFlag: 'czf', ext: '.tar.gz' };
  if (/\.(tar\.bz2|tbz2|tbz)$/.test(n)) return { kind: 'tarbz2', tarFlag: 'cjf', ext: '.tar.bz2' };
  if (/\.(tar\.xz|txz)$/.test(n)) return { kind: 'tarxz', tarFlag: 'cJf', ext: '.tar.xz' };
  if (/\.tar$/.test(n)) return { kind: 'tar', tarFlag: 'cf', ext: '.tar' };
  return { kind: 'zip', ext: '.zip' };
}

async function toolMakeZip(args, ctx) {
  // Sanitize but PRESERVE the requested extension so .tar.gz etc. survive.
  let output = (args.output || 'result.zip').replace(/[^\w.\-]/g, '_');
  const fmt = archiveFormat(output);
  if (!new RegExp(fmt.ext.replace(/\./g, '\\.') + '$', 'i').test(output) && fmt.kind === 'zip' && !/\.zip$/i.test(output)) {
    output = output.replace(/\.[^.]*$/, '') + '.zip';
  }
  const srcRel = (args.source || '.').replace(/^\.?\/+/, '') || '.';
  try {
    // 🐙 Native-FS backend (GitHub Actions): building the archive with a shell
    // `zip`/`tar` command would burn a whole CI run. Instead pull the work-tree
    // files via the native Git Data API, build the ZIP on the HOST with AdmZip,
    // and upload the single result — no workflow dispatch at all.
    if (ctx.fsx.nativeFs && fmt.kind === 'zip' &&
        typeof ctx.fsx.list === 'function' && typeof ctx.fsx.downloadBuffer === 'function' &&
        typeof ctx.fsx.uploadBuffer === 'function') {
      const all = await ctx.fsx.list();
      const prefix = srcRel === '.' ? '' : (srcRel.replace(/\/+$/, '') + '/');
      const zip = new AdmZip();
      let added = 0;
      for (const f of all) {
        const rel = f.rel || '';
        if (_isInternalArtifact(rel)) continue;
        if (rel === output || rel.endsWith('/' + output)) continue;   // never zip the output itself
        if (prefix && !rel.startsWith(prefix) && rel !== srcRel) continue;
        try {
          const buf = await ctx.fsx.downloadBuffer(rel);
          const entryName = prefix ? rel.slice(prefix.length) : rel;
          zip.addFile(entryName || path.posix.basename(rel), buf);
          added++;
        } catch (_) { /* skip unreadable entry */ }
        if (added > 3000) break;
      }
      if (!added) return `[make_zip] source "${srcRel}" is empty or not found.`;
      const zbuf = zip.toBuffer();
      await ctx.fsx.uploadBuffer(output, zbuf);
      ctx.addFile(output, output);
      return `[make_zip] packaged ${added} file(s) from "${srcRel}" into ${output} (${zbuf.length} bytes) and queued it for delivery.`;
    }
    if (ctx.fsx.kind === 'sandbox') {
      const srcArg = srcRel === '.' ? '.' : `'${srcRel.replace(/'/g, "'\\''")}'`;
      const out = `'${output.replace(/'/g, "'\\''")}'`;
      // Build into a temp name INSIDE the working dir (so relative `source: "."`
      // still works), excluding the temp file itself, then move it to the final
      // name. This avoids the archive trying to include itself.
      const tmpName = `.mkarchive_${Date.now()}.part`;
      const tmp = `'${tmpName}'`;
      let cmd;
      if (fmt.kind === 'zip') {
        cmd =
          `command -v zip >/dev/null 2>&1 || (apt-get update -y >/dev/null 2>&1 && apt-get install -y zip >/dev/null 2>&1); ` +
          `rm -f ${out} ${tmp}; ` +
          `zip -r ${tmp} ${srcArg} -x '_step_*' -x '*/.git/*' -x '*/node_modules/*' -x '.mkarchive_*' >/dev/null 2>&1; ` +
          `mv ${tmp} ${out}; stat -c '%s' ${out} 2>/dev/null || echo 0`;
      } else {
        // tar family. xz/bzip2 installed on demand if missing. GNU tar can exit
        // 1 with a harmless "file changed as we read it" warning while still
        // producing a valid archive, so we validate by output size, not exit code.
        const ensure = fmt.kind === 'tarxz'
          ? `command -v xz >/dev/null 2>&1 || (apt-get update -y >/dev/null 2>&1 && apt-get install -y xz-utils >/dev/null 2>&1); `
          : fmt.kind === 'tarbz2'
          ? `command -v bzip2 >/dev/null 2>&1 || (apt-get update -y >/dev/null 2>&1 && apt-get install -y bzip2 >/dev/null 2>&1); `
          : '';
        cmd =
          ensure +
          `rm -f ${out} ${tmp}; ` +
          `tar --exclude='_step_*' --exclude='.git' --exclude='node_modules' --exclude='.mkarchive_*' ` +
          `-${fmt.tarFlag} ${tmp} ${srcArg} >/dev/null 2>&1; ` +
          `mv ${tmp} ${out}; stat -c '%s' ${out} 2>/dev/null || echo 0`;
      }
      const r = await ctx.fsx.sh(cmd);
      // The command's last line is the byte size of the produced archive.
      const lines = (r.output || '').trim().split('\n');
      const size = parseInt((lines[lines.length - 1] || '0').trim(), 10) || 0;
      if (size <= 0) return `[make_zip] error packaging (empty/missing archive): ${r.output.slice(0, 400)}`;
      ctx.addFile(output, output);
      return `[make_zip] packaged "${srcRel}" into ${output} (${fmt.kind}, ${size} bytes) and queued it for delivery.`;
    }
    // Local backend: build the zip with AdmZip from the host fs.
    const base = ctx.fsx.workdir;
    const src = path.resolve(base, srcRel);
    if (src !== base && !src.startsWith(base + path.sep)) return '[make_zip] invalid source path.';
    if (!fs.existsSync(src)) return `[make_zip] source "${srcRel}" not found.`;
    const zip = new AdmZip();
    let added = 0;
    for (const f of walkDir(src)) {
      if (f.full.endsWith(output)) continue;
      zip.addLocalFile(f.full, path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel));
      added++;
    }
    const fp = path.join(base, output);
    zip.writeZip(fp);
    ctx.addFile(output, output);
    return `[make_zip] packaged ${added} file(s) into ${output} and queued it for delivery.`;
  } catch (e) {
    return `[make_zip] error: ${e.message}`;
  }
}

// ── Tool: scan working dir for credentials (Supabase, DB, JWT, API keys) ────
async function toolScanSecrets(args, ctx) {
  const allFiles = (await ctx.fsx.list()).filter(f =>
    f.size < 400000 && (
      /\.(env|js|ts|jsx|tsx|json|yml|yaml|toml|txt|md|py|rb|go|java|php|cfg|ini|properties|sh|sql|xml|html)$/i.test(f.rel) ||
      /(^|\/)\.env/i.test(f.rel) || /config|secret|credential/i.test(f.rel)
    )
  );
  const findings = {
    supabaseUrl: new Set(), supabaseAnon: new Set(), supabaseService: new Set(),
    dbHost: new Set(), dbUser: new Set(), dbPassword: new Set(), dbName: new Set(),
    connString: new Set(), jwt: new Set(), apiKeys: new Set(),
  };

  const RE = {
    supabaseUrl: /https?:\/\/[a-z0-9-]+\.supabase\.co/gi,
    // Supabase keys are JWTs whose payload contains role anon / service_role
    jwt: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    pgConn: /postg(?:res(?:ql)?):\/\/[^\s'"]+/gi,
    dbHostKV: /(?:DB_HOST|DATABASE_HOST|PGHOST|host)\s*[:=]\s*['"]?([A-Za-z0-9.\-_]+\.[A-Za-z0-9.\-_]+)['"]?/gi,
    dbUserKV: /(?:DB_USER|DATABASE_USER|PGUSER|user(?:name)?)\s*[:=]\s*['"]?([A-Za-z0-9.\-_@]+)['"]?/gi,
    dbPassKV: /(?:DB_PASS(?:WORD)?|DATABASE_PASSWORD|PGPASSWORD|password|pass)\s*[:=]\s*['"]?([^\s'"]{4,})['"]?/gi,
    dbNameKV: /(?:DB_NAME|DATABASE_NAME|PGDATABASE|database)\s*[:=]\s*['"]?([A-Za-z0-9.\-_]+)['"]?/gi,
    apiKey: /(?:sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{20,}|rnd_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
  };

  function decodeJwtRole(tok) {
    try {
      const payload = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
      return (payload.role || '').toLowerCase();
    } catch { return ''; }
  }

  let scanned = 0;
  for (const f of allFiles) {
    let text;
    try { text = await ctx.fsx.readText(f.rel); } catch { continue; }
    scanned++;
    for (const m of text.match(RE.supabaseUrl) || []) findings.supabaseUrl.add(m);
    for (const m of text.match(RE.jwt) || []) {
      const role = decodeJwtRole(m);
      if (role === 'service_role') findings.supabaseService.add(m);
      else if (role === 'anon') findings.supabaseAnon.add(m);
      else findings.jwt.add(m.slice(0, 24) + '…');
    }
    for (const m of text.match(RE.pgConn) || []) findings.connString.add(m);
    for (const m of text.match(RE.apiKey) || []) findings.apiKeys.add(m);
    let mm;
    while ((mm = RE.dbHostKV.exec(text))) findings.dbHost.add(mm[1]);
    while ((mm = RE.dbUserKV.exec(text))) findings.dbUser.add(mm[1]);
    while ((mm = RE.dbPassKV.exec(text))) findings.dbPassword.add(mm[1]);
    while ((mm = RE.dbNameKV.exec(text))) findings.dbName.add(mm[1]);
    // Derive DB host from supabase URL if not explicitly set
    for (const u of text.match(RE.supabaseUrl) || []) {
      const ref = u.match(/https?:\/\/([a-z0-9-]+)\.supabase\.co/i);
      if (ref) findings.dbHost.add(`db.${ref[1]}.supabase.co`);
    }
  }

  const fmt = (set, mask = false) => {
    const arr = [...set];
    if (!arr.length) return '_not found_';
    return arr.map(v => mask ? (v.length > 14 ? v.slice(0, 8) + '…' + v.slice(-4) : v) : v).join(', ');
  };

  if (!scanned) return '[scan_secrets] No scannable config/text files found in the working dir. (Did the user attach a ZIP? It is auto-extracted — try list_files.)';

  const out = [
    '🔐 *Credentials summary*',
    '',
    `• *Supabase URL:* ${fmt(findings.supabaseUrl)}`,
    `• *DB Host:* ${fmt(findings.dbHost)}`,
    `• *DB User:* ${fmt(findings.dbUser)}`,
    `• *DB Name:* ${fmt(findings.dbName)}`,
    `• *DB Password:* ${findings.dbPassword.size ? fmt(findings.dbPassword, true) : '_not found_'}`,
    `• *Anon Key:* ${findings.supabaseAnon.size ? fmt(findings.supabaseAnon, true) : '_not found_'}`,
    `• *Service Role Key:* ${findings.supabaseService.size ? fmt(findings.supabaseService, true) : '_not found_'}`,
    `• *Connection string(s):* ${findings.connString.size ? fmt(findings.connString, true) : '_not found_'}`,
    `• *Other JWTs:* ${fmt(findings.jwt)}`,
    `• *Other API keys:* ${findings.apiKeys.size ? fmt(findings.apiKeys, true) : '_not found_'}`,
    '',
    `Scanned ${scanned} file(s).`,
  ].join('\n');
  return `[scan_secrets]\n${out}`;
}

// ── Tool: record/refresh the task plan (decomposition + reflection anchor) ──
function toolPlan(args, ctx) {
  let steps = args.steps;
  if (typeof steps === 'string') steps = steps.split(/\n|;/).map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(steps) || !steps.length) {
    return '[plan] No steps provided. Pass {"steps": ["...", "..."]}.';
  }
  ctx.plan = steps.slice(0, 20);
  const numbered = ctx.plan.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `[plan] Plan recorded (${ctx.plan.length} steps). Follow it, checking each result:\n${numbered}`;
}

// ── SKILL LIBRARY TOOLS (host-side) ─────────────────────────────────────────
// The agent carries a library of expert SKILL.md files under .codebanana/.skills.
// `list_skills` enumerates them; `read_skill` loads one in full so the agent can
// FOLLOW its exact method. Per the SKILL-FIRST DOCTRINE the agent must load the
// matching skill BEFORE executing any build/design/document/code/deploy task.
const SKILLS_ROOT = path.join(__dirname, '..', '.codebanana', '.skills');

function _walkSkillFiles(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(_walkSkillFiles(p));
    else if (e.name === 'SKILL.md') out.push(p);
  }
  return out;
}

function _skillMeta(absPath) {
  let name = '', desc = '';
  try {
    const t = fs.readFileSync(absPath, 'utf8');
    const ym = t.match(/^---\n([\s\S]*?)\n---/);
    if (ym) {
      const nm = ym[1].match(/name:\s*(.+)/); if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '');
      const dm = ym[1].match(/description:\s*([\s\S]*?)(\n[a-z_]+:|$)/);
      if (dm) desc = dm[1].replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    }
    if (!name) { const h = t.match(/^#\s+(.+)/m); if (h) name = h[1].trim(); }
  } catch (_) {}
  if (!name) name = path.basename(path.dirname(absPath));
  const rel = path.relative(path.join(__dirname, '..'), absPath).split(path.sep).join('/');
  return { name, desc: desc.slice(0, 200), rel };
}

function toolListSkills() {
  const files = _walkSkillFiles(SKILLS_ROOT).sort();
  if (!files.length) return `[list_skills] No skills found under .codebanana/.skills.`;
  const rows = files.map(_skillMeta);
  const lines = rows.map((r, i) => `${i + 1}. ${r.name} — ${r.desc || '(no description)'}\n   path: ${r.rel}`);
  return `[list_skills] ${rows.length} skills available (read_skill the one that matches your task):\n\n${lines.join('\n')}`;
}

function toolReadSkill(args) {
  let rel = String((args && (args.path || args.skill || args.file)) || '').trim();
  const wantName = String((args && (args.name || args.skill_name)) || '').trim().toLowerCase();
  const files = _walkSkillFiles(SKILLS_ROOT);
  let abs = '';

  if (rel) {
    // Normalise and resolve against repo root; guard against path escape.
    const cleaned = rel.replace(/^\.?\/+/, '');
    const candidate = path.resolve(path.join(__dirname, '..', cleaned));
    if (candidate.startsWith(path.resolve(SKILLS_ROOT)) && fs.existsSync(candidate)) abs = candidate;
    // If they passed a directory or skill folder, append /SKILL.md.
    if (!abs) {
      const asDir = path.resolve(path.join(__dirname, '..', cleaned, 'SKILL.md'));
      if (asDir.startsWith(path.resolve(SKILLS_ROOT)) && fs.existsSync(asDir)) abs = asDir;
    }
  }
  if (!abs && (wantName || rel)) {
    const needle = (wantName || rel).toLowerCase().replace(/\.md$/, '').trim();
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const nNeedle = norm(needle);
    const hit = files.find(f => _skillMeta(f).name.toLowerCase() === needle)
      || files.find(f => path.basename(path.dirname(f)).toLowerCase() === needle)
      || files.find(f => f.toLowerCase().includes(needle))
      // Token-overlap fuzzy match: any skill whose name/dir shares a word with
      // the request (e.g. "pdf skill" → the pdf skill, "make slides" → pptx).
      || files.find(f => {
        const hay = norm(_skillMeta(f).name + ' ' + path.basename(path.dirname(f)));
        return nNeedle.split(' ').some(w => w.length >= 3 && hay.includes(w));
      });
    if (hit) abs = hit;
  }
  if (!abs) {
    // Never dead-end with a bare "not found" — inline the available skills so
    // the model can immediately retry with a correct path in the SAME turn.
    const rows = files.map(_skillMeta);
    const list = rows.map((r) => `- ${r.name} → path: ${r.rel}`).join('\n');
    return `[read_skill] No skill matched "${rel || wantName}". Available skills (pass one as {"path":"..."}):\n${list || '(none installed)'}`;
  }
  try {
    let body = fs.readFileSync(abs, 'utf8');
    // Skills can be very large; cap so a single load never blows the context.
    const MAX = 60000;
    let truncated = '';
    if (body.length > MAX) { body = body.slice(0, MAX); truncated = `\n\n…[skill truncated at ${MAX} chars — it is loaded; follow what you have read]`; }
    const meta = _skillMeta(abs);
    return `[read_skill] LOADED skill "${meta.name}" (${meta.rel}). FOLLOW this skill's method and quality bar exactly while you execute the task:\n\n${body}${truncated}`;
  } catch (e) {
    return `[read_skill] Failed to read ${abs}: ${e.message}`;
  }
}

// ── Robust content coercion ─────────────────────────────────────────────────
// The model sometimes returns a tool's `content` as something OTHER than a
// plain string — e.g. an object `{}`, an array of lines/blocks, or a nested
// wrapper like { text: "..." } / { content: "..." } / { markdown: "..." }.
// Naïvely doing String(content) then yields "[object Object]" or "{}" and the
// real text never makes it into the PDF/DOCX/file. This helper turns ANY shape
// into the intended text so file creation NEVER drops the actual content.
function coerceContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  // Array → join its (recursively coerced) parts as paragraphs/lines.
  if (Array.isArray(content)) {
    return content.map(coerceContent).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    // Common wrapper keys the model uses to hold the real body.
    const keys = ['text', 'content', 'body', 'markdown', 'md', 'value', 'data', 'html'];
    for (const k of keys) {
      if (typeof content[k] === 'string' && content[k].trim()) return content[k];
      if (content[k] != null && typeof content[k] === 'object') {
        const inner = coerceContent(content[k]);
        if (inner.trim()) return inner;
      }
    }
    // Structured doc: { title, sections:[{heading, body}] } or { blocks:[...] }.
    if (Array.isArray(content.sections)) {
      return content.sections.map(s => {
        if (typeof s === 'string') return s;
        const h = s.heading || s.title ? `## ${s.heading || s.title}\n` : '';
        return h + coerceContent(s.body ?? s.content ?? s.text ?? s);
      }).join('\n\n');
    }
    if (Array.isArray(content.blocks)) return content.blocks.map(coerceContent).join('\n\n');
    // Last resort: pretty-print the object so SOMETHING readable is delivered
    // instead of "[object Object]" or "{}".
    try { return JSON.stringify(content, null, 2); } catch (_) { return String(content); }
  }
  return String(content);
}

// Resolve the body text for document tools (create_pdf/create_docx). Supports
// EITHER inline `content` OR `content_file` — a path in the work dir the agent
// wrote earlier with write_file/run_code. The content_file path is the ROBUST
// way to build LONG reports: the model writes the (possibly huge) body to a
// file in small steps, then asks create_pdf to render it — avoiding the giant
// single-JSON-arg that the brain gateway truncates with INVALID_ARGUMENT.
async function resolveDocContent(args, ctx) {
  // Prefer an explicit file reference when given (and inline content is empty).
  const ref = args && (args.content_file || args.contentFile || args.content_path || args.source || args.from_file);
  const inline = coerceContent(args && args.content);
  if (ref && (!inline || !inline.trim()) && ctx && ctx.fsx) {
    try {
      const rel = String(ref).replace(/^\.?\/+/, '');
      const txt = await ctx.fsx.readText(rel);
      if (txt && txt.trim()) return txt;
    } catch (_) { /* fall back to inline */ }
  }
  return inline;
}

// ── WRITING-LENGTH ENFORCER (fixes "asked for 10 pages, got half a page") ────
// The #1 long-form failure: the model dumps a whole "book/report" into ONE
// create_pdf/create_docx step, but its per-step output budget caps it at a few
// hundred words, so the document arrives thin. This enforcer measures the
// ACTUAL word count against the REQUESTED length and, when the content is a
// stub, REFUSES to deliver and returns a precise corrective instruction back
// into the ReAct loop — so the agent keeps writing (ideally chunk-by-chunk into
// a content_file) until the pages are genuinely full.
//
// Target resolution priority:
//   1. explicit args.target_words / args.min_words
//   2. explicit args.pages  (→ pages * WORDS_PER_PAGE)
//   3. inferred from the ORIGINAL user task text (ctx.taskText):
//        "N page(s)" / "N-page" / "N pages long"  → N pages
//        "book" / "novel" / "ebook" / "story book" with no number → BOOK_MIN pages
//   4. otherwise 0 (no enforcement — short docs like a cover letter are fine)
const WORDS_PER_PAGE = parseInt(process.env.WRITING_WORDS_PER_PAGE || '480', 10);
const BOOK_MIN_PAGES = parseInt(process.env.WRITING_BOOK_MIN_PAGES || '12', 10);
// Deliver once we reach this fraction of the target (so we don't loop forever
// chasing the last few words). 0.85 ≈ "full enough".
const WRITING_OK_RATIO = parseFloat(process.env.WRITING_OK_RATIO || '0.85');
// Hard cap on how many times we bounce a single document back for expansion,
// so a stubborn brain can never wedge the loop.
const WRITING_MAX_NUDGES = parseInt(process.env.WRITING_MAX_NUDGES || '4', 10);

function countWords(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// Figure out the requested word target for THIS document.
function resolveWritingTarget(args, ctx) {
  const A = args || {};
  const explicitWords = parseInt(A.target_words || A.min_words || A.words || 0, 10);
  if (explicitWords > 0) return { words: explicitWords, source: 'target_words' };

  const explicitPages = parseFloat(A.pages || A.page_count || A.num_pages || 0);
  if (explicitPages > 0) return { words: Math.round(explicitPages * WORDS_PER_PAGE), pages: explicitPages, source: 'pages' };

  // Infer from the user's own words.
  const task = String((ctx && ctx.taskText) || '').toLowerCase();
  // "10 page", "10-page", "10 pages", "ten pages" (digits only — keep it robust)
  const pm = task.match(/(\d{1,3})\s*[-–]?\s*page/);
  if (pm) {
    const n = parseInt(pm[1], 10);
    if (n > 0 && n <= 500) return { words: n * WORDS_PER_PAGE, pages: n, source: 'task:pages' };
  }
  // "N words"
  const wm = task.match(/(\d{3,6})\s*words?/);
  if (wm) {
    const n = parseInt(wm[1], 10);
    if (n >= 200) return { words: n, source: 'task:words' };
  }
  // A "book / novel / ebook / story book / storybook" with no number → treat as
  // a substantial multi-chapter work, not a one-pager.
  if (/\b(story\s?book|storybook|novel|e-?book|full\s+book|whole\s+book|a\s+book|chapters?)\b/.test(task)) {
    return { words: BOOK_MIN_PAGES * WORDS_PER_PAGE, pages: BOOK_MIN_PAGES, source: 'task:book' };
  }
  return { words: 0, source: 'none' };
}

// Given the resolved body + args + ctx, decide whether to DELIVER or BOUNCE.
// Returns { ok:true } to proceed, or { ok:false, message } with a corrective
// observation for the ReAct loop. Uses a per-file nudge counter on ctx so we
// never loop indefinitely.
function enforceWritingLength(kind, filename, body, args, ctx) {
  const target = resolveWritingTarget(args, ctx);
  if (!target.words) return { ok: true }; // nothing requested → no enforcement

  const have = countWords(body);
  const need = Math.round(target.words * WRITING_OK_RATIO);
  if (have >= need) return { ok: true };

  // Track nudges per filename so a stubborn brain can't wedge the loop.
  if (ctx && !ctx._writingNudges) ctx._writingNudges = new Map();
  const key = String(filename || 'doc');
  const nudges = (ctx && ctx._writingNudges) ? (ctx._writingNudges.get(key) || 0) : WRITING_MAX_NUDGES;
  if (nudges >= WRITING_MAX_NUDGES) {
    // Give up bouncing — deliver whatever we have rather than failing outright.
    return { ok: true };
  }
  if (ctx && ctx._writingNudges) ctx._writingNudges.set(key, nudges + 1);

  const short = target.words - have;
  const pagesTxt = target.pages ? ` (~${target.pages} pages @ ~${WORDS_PER_PAGE} words/page)` : '';
  const msg =
    `[${kind}] ⛔ NOT DELIVERED — the content is far too short. ` +
    `You wrote only ~${have} words but the request needs ~${target.words} words${pagesTxt}. ` +
    `That is a HALF-EMPTY document, which is a HARD FAILURE per WRITING MODE.\n\n` +
    `DO THIS NOW to fix it (do NOT call ${kind} again with the same short body):\n` +
    `1. Write the FULL body to a file in CHUNKS so nothing is truncated by the step budget:\n` +
    `   • First write_file "${(filename || 'document').replace(/\\.[^.]+$/, '')}.md" with the opening ~1000 words (title + first section/chapter, in full prose).\n` +
    `   • Then, in SEPARATE steps, use write_file again on the SAME filename to APPEND the next chapter/section each time (~1000+ words per step). Repeat until the file clearly holds AT LEAST ~${target.words} words — write every chapter/section fully, no summaries, no "[continued]", no placeholders.\n` +
    `2. Only when the .md file is genuinely long enough, call ${kind} again with {"content_file":"<that .md file>"} (NOT inline content) plus the title/filename.\n` +
    `3. Keep going until the document truly fills ${target.pages ? target.pages + ' pages' : 'the requested length'} top-to-bottom. Depth over brevity — develop every idea into full paragraphs.`;
  return { ok: false, message: msg };
}
async function toolWriteFile(args, ctx) {
  const filename = (args.filename || 'output.txt').replace(/[^\w.\-]/g, '_');
  const text = coerceContent(args.content);
  // ── APPEND MODE (critical for long-form writing) ──────────────────────────
  // The WRITING-LENGTH ENFORCER tells the model to build a long book/report by
  // APPENDING one chapter/section per step to the SAME file, so no single step
  // is truncated by the brain's output budget. Support {"append":true} (or
  // mode:"append") by reading the current file and concatenating. Falls back to
  // a plain overwrite when the file doesn't exist yet or append isn't requested.
  const wantAppend = args.append === true || args.append === 'true' ||
                     String(args.mode || '').toLowerCase() === 'append';
  if (wantAppend) {
    let prev = '';
    try { if (await ctx.fsx.exists(filename)) prev = await ctx.fsx.readText(filename); } catch (_) { prev = ''; }
    const joiner = prev && !/\n\s*$/.test(prev) ? '\n\n' : '';
    const merged = prev + joiner + text;
    await ctx.fsx.writeText(filename, merged);
    ctx.addFile(filename, filename);
    const words = merged.trim().split(/\s+/).filter(Boolean).length;
    return `[write_file] appended to ${filename} (+${text.length} bytes → ${merged.length} bytes total, ~${words} words). Keep appending more chapters/sections until it hits the requested length, then render it with create_pdf/create_docx {"content_file":"${filename}"}.`;
  }
  await ctx.fsx.writeText(filename, text);
  ctx.addFile(filename, filename);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return `[write_file] wrote ${filename} (${text.length} bytes, ~${words} words).`;
}

// ── Inline Markdown → docx TextRun[] ────────────────────────────────────────
// Supports **bold**, *italic* / _italic_, `code`, ~~strike~~, and ***bold+italic***.
// Returns an array of TextRun so a single paragraph can mix styles.
function mdInlineToRuns(text, base = {}) {
  const TextRun = require('docx').TextRun;
  const runs = [];
  if (text == null) return [new TextRun({ text: '', ...base })];
  // Tokenise on the supported inline markers (order matters: longest first).
  const re = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let last = 0, m;
  const push = (t, extra) => { if (t) runs.push(new TextRun({ text: t, ...base, ...extra })); };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('***')) push(tok.slice(3, -3), { bold: true, italics: true });
    else if (tok.startsWith('**')) push(tok.slice(2, -2), { bold: true });
    else if (tok.startsWith('~~')) push(tok.slice(2, -2), { strike: true });
    else if (tok.startsWith('`')) push(tok.slice(1, -1), { font: 'Consolas', shading: { fill: 'F3F3F3' } });
    else if (tok.startsWith('*')) push(tok.slice(1, -1), { italics: true });
    else if (tok.startsWith('_')) push(tok.slice(1, -1), { italics: true });
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last));
  return runs.length ? runs : [new TextRun({ text: '', ...base })];
}

// ── Full Markdown → Word .docx renderer ─────────────────────────────────────
// Professional, multi-page documents: title + subtitle, H1–H4, bold/italic/
// code/strike inline, bullet & numbered lists, pipe tables, blockquotes,
// horizontal rules / explicit page breaks, code blocks, page numbers. Built to
// handle very long content (reports, full books with chapters) without truncating.
async function toolCreateDocx(args, ctx) {
  const docx = require('docx');
  const {
    Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak,
    Footer, PageNumber, ShadingType,
  } = docx;

  const filename = (args.filename || 'document.docx').replace(/[^\w.\-]/g, '_');
  const raw = await resolveDocContent(args, ctx);
  // WRITING-LENGTH GATE: refuse to ship a half-empty document; bounce back to
  // the loop with precise instructions to write the full content instead.
  const gate = enforceWritingLength('create_docx', filename, raw, args, ctx);
  if (!gate.ok) return gate.message;
  const lines = raw.split('\n');
  const children = [];

  // Title block
  if (args.title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 },
      children: [new TextRun({ text: String(args.title), bold: true, size: 56 })],
    }));
  }
  if (args.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 240 },
      children: [new TextRun({ text: String(args.subtitle), italics: true, size: 28, color: '555555' })],
    }));
  }

  const HEADING = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];

  // Parse a Markdown pipe-table starting at index i; returns {table, next} or null.
  function tryTable(i) {
    const head = lines[i];
    const sep = lines[i + 1];
    if (!head || !/\|/.test(head)) return null;
    if (!sep || !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(sep)) return null;
    const splitRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const header = splitRow(head);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      if (!/\|/.test(lines[j]) || !lines[j].trim()) break;
      rows.push(splitRow(lines[j]));
    }
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' };
    const borders = { top: border, bottom: border, left: border, right: border };
    const mkCell = (txt, isHead) => new TableCell({
      borders,
      margins: { top: 40, bottom: 40, left: 90, right: 90 },
      shading: isHead ? { type: ShadingType.CLEAR, fill: 'F0F0F0' } : undefined,
      children: [new Paragraph({ children: mdInlineToRuns(txt, isHead ? { bold: true } : {}) })],
    });
    const tableRows = [new TableRow({ tableHeader: true, children: header.map(h => mkCell(h, true)) })];
    for (const r of rows) {
      while (r.length < header.length) r.push('');
      tableRows.push(new TableRow({ children: r.slice(0, header.length).map(c => mkCell(c, false)) }));
    }
    return {
      table: new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows }),
      next: j,
    };
  }

  let inCode = false;
  let codeBuf = [];
  let orderedCounter = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const t = rawLine.replace(/\s+$/, '');
    const trimmed = t.trim();

    // Fenced code block
    if (/^```/.test(trimmed)) {
      if (inCode) {
        // flush code block
        for (const cl of codeBuf) {
          children.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: cl || ' ', font: 'Consolas', size: 20 })],
          }));
        }
        codeBuf = []; inCode = false;
      } else { inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(rawLine); continue; }

    if (!trimmed) { orderedCounter = 0; children.push(new Paragraph({ text: '' })); continue; }

    // Explicit page break: a line that is exactly --- or \pagebreak
    if (/^(\\pagebreak|\\newpage|<!--\s*pagebreak\s*-->)$/i.test(trimmed)) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
      continue;
    }
    // Horizontal rule
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(trimmed)) {
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } },
        spacing: { before: 120, after: 120 },
        children: [new TextRun('')],
      }));
      continue;
    }

    // Table
    const tbl = tryTable(i);
    if (tbl) { children.push(tbl.table); children.push(new Paragraph({ text: '' })); i = tbl.next - 1; continue; }

    // Headings
    const hm = trimmed.match(/^(#{1,5})\s+(.*)$/);
    if (hm) {
      orderedCounter = 0;
      const level = hm[1].length - 1;
      children.push(new Paragraph({
        heading: HEADING[level] || HeadingLevel.HEADING_5,
        spacing: { before: level === 0 ? 280 : 200, after: 100 },
        children: mdInlineToRuns(hm[2]),
      }));
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      children.push(new Paragraph({
        indent: { left: 360 },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'CCCCCC', space: 8 } },
        spacing: { before: 40, after: 40 },
        children: mdInlineToRuns(trimmed.replace(/^>\s?/, ''), { italics: true, color: '444444' }),
      }));
      continue;
    }

    // Numbered list (1. / 1) )
    const om = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (om) {
      orderedCounter++;
      children.push(new Paragraph({
        numbering: { reference: 'ordered-list', level: 0 },
        children: mdInlineToRuns(om[2]),
      }));
      continue;
    }

    // Bullet list (-, *, +) with nesting by leading spaces
    const bm = t.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bm) {
      orderedCounter = 0;
      const indentLevel = Math.min(Math.floor(bm[1].length / 2), 4);
      children.push(new Paragraph({
        bullet: { level: indentLevel },
        children: mdInlineToRuns(bm[3]),
      }));
      continue;
    }

    // Normal paragraph (justified for body readability)
    orderedCounter = 0;
    children.push(new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120, line: 300 },
      children: mdInlineToRuns(trimmed),
    }));
  }
  // flush trailing code block
  if (inCode && codeBuf.length) {
    for (const cl of codeBuf) {
      children.push(new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
        children: [new TextRun({ text: cl || ' ', font: 'Consolas', size: 20 })],
      }));
    }
  }

  const doc = new Document({
    creator: 'WormGPT Agent',
    title: args.title || 'Document',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
      },
    },
    numbering: {
      config: [{
        reference: 'ordered-list',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 460, hanging: 260 } } } }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 18, color: '888888' }),
              new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '888888' }),
              new TextRun({ text: ' of ', size: 18, color: '888888' }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: '888888' }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  await ctx.deliverBuffer(filename, buffer);
  const words = raw.split(/\s+/).filter(Boolean).length;
  return `[create_docx] created ${filename} (${children.length} blocks, ~${words} words, ${(buffer.length / 1024).toFixed(0)} KB).`;
}
// ── Markdown → HTML for the math-PDF renderer ──────────────────────────────
// Supports headings, **bold**/*italic*/`code`, bullet + numbered lists, pipe
// tables, blockquotes, fenced code blocks, horizontal rules and explicit page
// breaks (--- alone, \pagebreak, \newpage). Math delimiters are preserved for
// MathJax. Built for long, well-structured documents.
function mdToHtml(md) {
  // ── Protect embedded VISUAL html so diagrams actually render ──────────────
  // The agent delivers solved past-questions with real diagrams: inline <svg>,
  // <img src="data:image/png;base64,…"> (matplotlib), <figure>, <picture>,
  // <canvas>. If we blindly esc() every line these become LITERAL text and the
  // "diagram" turns into ugly angle-bracket soup (the classic broken/empty-
  // looking PDF). So BEFORE the markdown pass we lift every such block out into
  // a placeholder, convert the surrounding markdown, then splice the raw visual
  // HTML back in verbatim. Only known-safe, self-contained visual tags are
  // preserved (no <script>/<iframe>/<object> — those stay escaped for safety).
  const preserved = [];
  const PH = (i) => `\u0000MDPH${i}\u0000`;
  let src = String(md || '');
  const VISUAL_BLOCK = /<(svg|figure|picture|canvas|table)\b[\s\S]*?<\/\1>|<img\b[^>]*\/?>/gi;
  src = src.replace(VISUAL_BLOCK, (m) => {
    // Reject anything that smuggles in a script/handler — keep those escaped.
    if (/<\s*(script|iframe|object|embed)\b/i.test(m) || /\son\w+\s*=/i.test(m)) return m;
    preserved.push(m);
    return PH(preserved.length - 1);
  });
  md = src;

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inlineFmt = (s) => esc(s)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md || '').split('\n');
  let html = '';
  let inUl = false, inOl = false, inCode = false, inQuote = false;
  const closeUl = () => { if (inUl) { html += '</ul>'; inUl = false; } };
  const closeOl = () => { if (inOl) { html += '</ol>'; inOl = false; } };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };
  const closeAll = () => { closeUl(); closeOl(); closeQuote(); };

  // Pipe-table separator detection
  const isTableSep = (s) => s && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, '    ');
    const t = line.trim();

    if (/^```/.test(t)) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { closeAll(); html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }

    if (!t) { closeAll(); continue; }

    // Explicit page break
    if (/^(\\pagebreak|\\newpage|<!--\s*pagebreak\s*-->)$/i.test(t)) {
      closeAll(); html += '<div class="pagebreak"></div>'; continue;
    }
    // Horizontal rule
    if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(t)) {
      closeAll(); html += '<hr/>'; continue;
    }

    // Pipe table
    if (/\|/.test(t) && isTableSep(lines[i + 1])) {
      closeAll();
      const splitRow = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const header = splitRow(t);
      let tbl = '<table><thead><tr>' + header.map(h => `<th>${inlineFmt(h)}</th>`).join('') + '</tr></thead><tbody>';
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j];
        if (!/\|/.test(r) || !r.trim()) break;
        const cells = splitRow(r);
        while (cells.length < header.length) cells.push('');
        tbl += '<tr>' + cells.slice(0, header.length).map(c => `<td>${inlineFmt(c)}</td>`).join('') + '</tr>';
      }
      tbl += '</tbody></table>';
      html += tbl;
      i = j - 1;
      continue;
    }

    // Headings
    const hm = t.match(/^(#{1,5})\s+(.*)$/);
    if (hm) { closeAll(); const lvl = hm[1].length; html += `<h${lvl}>${inlineFmt(hm[2])}</h${lvl}>`; continue; }

    // Blockquote
    if (/^>\s?/.test(t)) {
      closeUl(); closeOl();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += `<p>${inlineFmt(t.replace(/^>\s?/, ''))}</p>`;
      continue;
    }
    closeQuote();

    // Numbered list
    const om = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (om) { closeUl(); if (!inOl) { html += '<ol>'; inOl = true; } html += `<li>${inlineFmt(om[2])}</li>`; continue; }

    // Bullet list
    if (/^[-*+]\s+/.test(t)) {
      closeOl();
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${inlineFmt(t.replace(/^[-*+]\s+/, ''))}</li>`;
      continue;
    }

    // Paragraph
    closeAll();
    html += `<p>${inlineFmt(t)}</p>`;
  }
  if (inCode) html += '</code></pre>';
  closeAll();

  // ── Restore the preserved visual blocks (svg/img/figure/…) verbatim ───────
  // A placeholder that landed on its own line will have been wrapped in <p>…</p>
  // by the paragraph rule; unwrap that so the block-level diagram is not nested
  // inside an inline paragraph (which some renderers collapse). Center images /
  // svg diagrams for a clean, print-quality look.
  if (preserved.length) {
    html = html.replace(/<p>\s*\u0000MDPH(\d+)\u0000\s*<\/p>/g, (_, i) =>
      `<div class="diagram">${preserved[Number(i)]}</div>`);
    html = html.replace(/\u0000MDPH(\d+)\u0000/g, (_, i) => preserved[Number(i)] || '');
  }
  return html;
}

// Ensure a rich HTML doc has the MathJax runtime + a readiness flag so
// Browserless waitForFunction resolves. If the model already included a MathJax
// <script>, we leave it. Otherwise we inject the standard tex-svg config used
// by buildMathHtml so \( … \) / \[ … \] / $…$ typeset in the direct-HTML path.
function ensureMathJax(html) {
  let s = String(html || '');
  if (/MathJax|tex-svg\.js|tex-chtml\.js/i.test(s)) {
    // Model supplied MathJax already — just make sure a readiness flag exists so
    // the PDF renderer doesn't hang waiting on window.__mjReady.
    if (!/__mjReady/.test(s) && /<\/head>/i.test(s)) {
      s = s.replace(/<\/head>/i,
        `<script>setTimeout(function(){window.__mjReady=true;},6000);</script></head>`);
    }
    return s;
  }
  const inject = `<script>
  window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']],displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'global'},
    startup:{pageReady(){return MathJax.startup.defaultPageReady().then(function(){window.__mjReady=true;});}}};
  setTimeout(function(){ if(!window.__mjReady) window.__mjReady=true; }, 6000);
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>`;
  // IMPORTANT: `inject` contains `$` sequences (MathJax delimiters `$`, `$$`).
  // When passed as the REPLACEMENT string to String.replace, `$$`→`$` and
  // `$'`→"text after match" are special patterns that corrupt/duplicate the
  // document. Always use a function replacer so `inject` is inserted VERBATIM.
  if (/<\/head>/i.test(s)) return s.replace(/<\/head>/i, () => inject + '</head>');
  if (/<body[^>]*>/i.test(s)) return s.replace(/<body[^>]*>/i, (m) => m + inject);
  // No head/body — wrap it into a minimal document.
  return `<!doctype html><html><head><meta charset="utf-8">${inject}</head><body>${s}</body></html>`;
}

function buildMathHtml(title, content, opts = {}) {
  // NOTE: math delimiters \( \) \[ \] and $ $$ are preserved through esc()
  // because MathJax processes them in the rendered DOM text.
  const body = mdToHtml(content);
  const subtitle = opts.subtitle ? `<div class="doc-subtitle">${String(opts.subtitle).replace(/</g, '&lt;')}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  @page { margin: 22mm 18mm 20mm 18mm; }
  body{font-family:'Georgia','Segoe UI',Arial,serif;font-size:12pt;line-height:1.6;color:#1a1a1a;}
  h1{font-size:21pt;border-bottom:2px solid #333;padding-bottom:6px;margin:1.1em 0 .5em;page-break-after:avoid;}
  h2{font-size:16pt;margin:1.1em 0 .4em;color:#222;page-break-after:avoid;}
  h3{font-size:13.5pt;margin:.9em 0 .3em;color:#333;page-break-after:avoid;}
  h4,h5{font-size:12pt;margin:.8em 0 .3em;color:#444;page-break-after:avoid;}
  p{margin:.45em 0;text-align:justify;}
  ul,ol{margin:.35em 0 .7em 1.4em;} li{margin:.18em 0;}
  blockquote{margin:.6em 0;padding:.3em 1em;border-left:4px solid #ccc;color:#555;background:#fafafa;}
  blockquote p{margin:.2em 0;}
  code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-family:Consolas,'Courier New',monospace;font-size:.9em;}
  pre{background:#f6f8fa;padding:11px 13px;border-radius:6px;overflow:auto;border:1px solid #eaecef;page-break-inside:avoid;}
  pre code{background:none;padding:0;font-size:.86em;line-height:1.45;}
  table{border-collapse:collapse;margin:.7em 0;width:100%;font-size:.95em;page-break-inside:avoid;}
  th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top;}
  th{background:#f0f0f0;font-weight:600;}
  hr{border:none;border-top:1px solid #ddd;margin:1em 0;}
  .pagebreak{page-break-after:always;height:0;}
  .doc-title{font-size:26pt;font-weight:700;margin:0 0 .15em;line-height:1.2;}
  .doc-subtitle{font-size:13pt;font-style:italic;color:#666;margin-bottom:1.2em;}
  del{color:#999;}
  .diagram{margin:.9em 0;text-align:center;page-break-inside:avoid;}
  .diagram svg,.diagram img{max-width:100%;height:auto;}
</style>
<script>
  window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']],displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'global'},
    startup:{pageReady(){return MathJax.startup.defaultPageReady().then(function(){window.__mjReady=true;});}}};
  // Safety net: if MathJax never loads (CDN blocked), still signal ready after 6s
  // so the PDF renderer's waitForFunction doesn't hang the whole request.
  setTimeout(function(){ if(!window.__mjReady) window.__mjReady=true; }, 6000);
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
</head><body>
${title ? `<div class="doc-title">${title.replace(/</g, '&lt;')}</div>` : ''}
${subtitle}
${body}
</body></html>`;
}

function pdfWithPdfkit(args, ctx) {
  return new Promise((resolve) => {
    try {
      const PDFDocument = require('pdfkit');
      const filename = (args.filename || 'document.pdf').replace(/[^\w.\-]/g, '_');
      const tmpFp = path.join(os.tmpdir(), `_pdf_${Date.now()}_${filename}`);
      const doc = new PDFDocument({ margin: 56, bufferPages: true });
      const stream = fs.createWriteStream(tmpFp);
      doc.pipe(stream);
      // Strip inline markdown markers for the plain-text fallback.
      const clean = (s) => String(s)
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1');
      if (args.title) doc.font('Helvetica-Bold').fontSize(22).text(clean(args.title)).moveDown(0.3);
      if (args.subtitle) doc.font('Helvetica-Oblique').fontSize(12).fillColor('#666').text(clean(args.subtitle)).fillColor('#000').moveDown(0.6);
      doc.font('Helvetica').fontSize(11.5);
      const lines = coerceContent(args.content).split('\n');
      let inCode = false, orderedN = 0;
      for (const ln of lines) {
        const t = ln.replace(/\s+$/, '').trim();
        if (/^```/.test(t)) { inCode = !inCode; if (!inCode) doc.moveDown(0.3); continue; }
        if (inCode) { doc.font('Courier').fontSize(9.5).text(ln, { lineGap: 1 }).font('Helvetica').fontSize(11.5); continue; }
        if (!t) { orderedN = 0; doc.moveDown(0.45); continue; }
        if (/^(\\pagebreak|\\newpage)$/i.test(t)) { doc.addPage(); continue; }
        if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(t)) { doc.moveDown(0.2).strokeColor('#ccc').moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke().strokeColor('#000').moveDown(0.4); continue; }
        const hm = t.match(/^(#{1,5})\s+(.*)$/);
        if (hm) { orderedN = 0; const sz = [18, 15, 13.5, 12.5, 12][hm[1].length - 1] || 12; doc.moveDown(0.3).font('Helvetica-Bold').fontSize(sz).text(clean(hm[2])).font('Helvetica').fontSize(11.5).moveDown(0.15); continue; }
        if (/^>\s?/.test(t)) { doc.font('Helvetica-Oblique').fillColor('#555').text('  ' + clean(t.replace(/^>\s?/, ''))).fillColor('#000').font('Helvetica'); continue; }
        const om = t.match(/^(\d+)[.)]\s+(.*)$/);
        if (om) { orderedN++; doc.text(`${orderedN}. ${clean(om[2])}`, { indent: 14 }); continue; }
        if (/^[-*+]\s+/.test(t)) { orderedN = 0; doc.text('•  ' + clean(t.replace(/^[-*+]\s+/, '')), { indent: 14 }); continue; }
        orderedN = 0;
        doc.text(clean(t), { align: 'justify', lineGap: 1.5 });
      }
      // Page numbers
      try {
        const range = doc.bufferedPageRange();
        for (let p = range.start; p < range.start + range.count; p++) {
          doc.switchToPage(p);
          doc.font('Helvetica').fontSize(8).fillColor('#888')
            .text(`Page ${p - range.start + 1} of ${range.count}`, 0, doc.page.height - 40, { align: 'center', width: doc.page.width });
          doc.fillColor('#000');
        }
      } catch (_) {}
      doc.end();
      stream.on('finish', async () => {
        try {
          const buffer = fs.readFileSync(tmpFp);
          await ctx.deliverBuffer(filename, buffer);
          try { fs.unlinkSync(tmpFp); } catch (_) {}
          resolve(`[create_pdf] created ${filename} (formatted text PDF, ${(buffer.length / 1024).toFixed(0)} KB; math not typeset — Browserless unavailable).`);
        } catch (e) { resolve(`[create_pdf] error: ${e.message}`); }
      });
      stream.on('error', (e) => resolve(`[create_pdf] error: ${e.message}`));
    } catch (e) {
      resolve(`[create_pdf] error: ${e.message}`);
    }
  });
}

// ── HIGH-QUALITY host-side LaTeX → PDF (offline pdflatex, no network) ────────
// ROOT-CAUSE FIX companion for the sandbox path: the Docker image now bakes in
// a full offline TeX Live (see Dockerfile), and agent_worker/latex_render.py is
// a self-contained stdlib module that turns Markdown/LaTeX → a validated PDF
// with real math + tables + TikZ/PGFPlots charts. Running it on the HOST gives
// the create_pdf fallback the SAME print-quality output as the in-sandbox path
// — deterministic, offline, and never a blank/empty PDF (latex_render validates
// header + size + >=1 page before returning). Resolves with the PDF path or
// rejects so the caller can fall back to the Browserless/pdfkit path.
function pdfWithLatex(args, ctx, contentText) {
  return new Promise((resolve, reject) => {
    try {
      const isFullLatex = typeof args.latex === 'string' && /\\documentclass/.test(args.latex);
      const body = isFullLatex ? args.latex : String(contentText || '');
      if (!body.trim()) return reject(new Error('empty content'));
      const enginePy = path.join(__dirname, '..', 'agent_worker', 'latex_render.py');
      if (!fs.existsSync(enginePy)) return reject(new Error('latex_render.py not found'));
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latexpdf_'));
      const srcName = isFullLatex ? 'input.tex' : 'input.md';
      const srcPath = path.join(workDir, srcName);
      const outPath = path.join(workDir, 'out.pdf');
      // For Markdown, prepend an H1 title so the doc has a proper heading block.
      let src = body;
      if (!isFullLatex && args.title) src = `# ${args.title}\n\n${body}`;
      fs.writeFileSync(srcPath, src, 'utf-8');
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const title = String(args.title || '').slice(0, 200);
      const cmd = `python3 ${q(enginePy)} ${q(srcPath)} ${q(outPath)} ${q(title)}`;
      // AGENT_WORK points the engine's cache into the temp workdir; PATH is
      // extended so a TinyTeX-style install is also picked up if present.
      const env = Object.assign({}, process.env, {
        AGENT_WORK: workDir,
        PATH: `${process.env.PATH || ''}:${process.env.HOME || ''}/.TinyTeX/bin/x86_64-linux`,
      });
      exec(cmd, { timeout: 180000, env, maxBuffer: 8 * 1024 * 1024 }, async (err, stdout, stderr) => {
        try {
          if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
            return reject(new Error('latex render produced no PDF: ' + String(stderr || stdout || err || '').slice(0, 300)));
          }
          const filename = (args.filename || 'document.pdf').replace(/[^\w.\-]/g, '_');
          const buffer = fs.readFileSync(outPath);
          await ctx.deliverBuffer(filename, buffer);
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
          resolve(`[create_pdf] created ${filename} (LaTeX: math + charts + diagrams, ${(buffer.length / 1024).toFixed(0)} KB @host).`);
        } catch (e2) { reject(e2); }
      });
    } catch (e) { reject(e); }
  });
}

async function toolCreatePdf(args, ctx) {
  const filename = (args.filename || 'document.pdf').replace(/[^\w.\-]/g, '_');
  const wantMath = args.math !== false; // default ON
  // ── NEW: direct rich-HTML path (visual-pdf-master skill) ──────────────────
  // If the brain passes a full `html` string (with embedded <img> diagrams,
  // MathJax equations, styled cards, tables), render it verbatim. This is the
  // high-quality path for solved past-questions, reports and trading analyses
  // that include real diagrams/charts. We only lightly ensure MathJax is
  // present so \( … \) / \[ … \] typeset even if the model forgot the script.
  const rawHtml = (typeof args.html === 'string' && args.html.trim().length > 40) ? args.html : '';
  if (rawHtml) {
    try {
      const html = ensureMathJax(rawHtml);
      const buffer = await browserless.htmlToPdf(html, { waitFor: 4000 });
      await ctx.deliverBuffer(filename, buffer);
      return `[create_pdf] created ${filename} (rich HTML + diagrams, MathJax-typeset, ${(buffer.length / 1024).toFixed(0)} KB).`;
    } catch (e) {
      // Fall through: strip tags into text and use the standard path so we
      // ALWAYS return a PDF even if Browserless is momentarily unavailable.
      try {
        const plain = String(rawHtml).replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim();
        return await pdfWithPdfkit({ filename, title: args.title || '', content: plain }, ctx);
      } catch (_) { /* fall through to content path below */ }
    }
  }
  const contentText = await resolveDocContent(args, ctx);
  // WRITING-LENGTH GATE (text/markdown PDFs only — the `html` diagram path
  // above is exempt since it carries figures, not prose). Refuse to ship a
  // half-empty story/report; bounce back with instructions to write it in full.
  {
    const gate = enforceWritingLength('create_pdf', filename, contentText, args, ctx);
    if (!gate.ok) return gate.message;
  }
  // Try the in-image LaTeX engine FIRST for Markdown/LaTeX content: it renders
  // real math + tables + TikZ/PGFPlots charts with ZERO network dependency and
  // validates the output, so we never ship a blank PDF. Falls through to the
  // Browserless/pdfkit paths only if the LaTeX engine genuinely can't run.
  try {
    return await pdfWithLatex(args, ctx, contentText);
  } catch (e) {
    // Fall through to the MathJax HTML→PDF path below.
  }
  // Try the high-quality, math-capable HTML→PDF path next.
  if (wantMath) {
    try {
      const html = buildMathHtml(args.title || '', contentText, { subtitle: args.subtitle || '' });
      const buffer = await browserless.htmlToPdf(html, { waitFor: 3500 });
      await ctx.deliverBuffer(filename, buffer);
      return `[create_pdf] created ${filename} (MathJax-typeset, ${(buffer.length / 1024).toFixed(0)} KB).`;
    } catch (e) {
      // Fall through to pdfkit (no math typesetting, but always works).
    }
  }
  return await pdfWithPdfkit({ ...args, content: contentText }, ctx);
}

// ── Safety net: extract fenced code blocks from the final message ──────────
// If the model finishes by pasting code/content into the chat WITHOUT producing
// a file (its #1 failure mode), we extract every fenced ```code``` block, write
// each to a real file with a sensible extension, and strip it from the message.
// This guarantees the user always gets a downloadable file when code was meant
// to be delivered. Returns { files:[{name,content}], message } (message has the
// blocks replaced by a short "(delivered as <file>)" note).
const LANG_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', typescript: 'ts', ts: 'ts',
  html: 'html', css: 'css', json: 'json', yaml: 'yml', yml: 'yml', bash: 'sh', sh: 'sh',
  shell: 'sh', sql: 'sql', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', go: 'go',
  rust: 'rs', rs: 'rs', php: 'php', ruby: 'rb', rb: 'rb', xml: 'xml', csv: 'csv',
  markdown: 'md', md: 'md', kotlin: 'kt', swift: 'swift', dart: 'dart', text: 'txt', '': 'txt',
};
function extractCodeFiles(message) {
  const out = [];
  if (!message) return { files: out, message: message || '' };
  const fence = /```([a-zA-Z0-9_+\-.]*)\s*\n([\s\S]*?)```/g;
  let m, idx = 0, newMsg = '', last = 0;
  while ((m = fence.exec(message)) !== null) {
    const lang = (m[1] || '').toLowerCase().trim();
    const body = m[2] || '';
    // Only treat sizeable blocks as deliverable files (skip tiny inline snippets).
    if (body.trim().split('\n').length < 3 && body.length < 120) continue;
    const ext = LANG_EXT[lang] !== undefined ? LANG_EXT[lang] : 'txt';
    idx++;
    const name = out.length === 0 ? `output.${ext}` : `output_${idx}.${ext}`;
    out.push({ name, content: body.replace(/\s+$/, '') + '\n' });
    newMsg += message.slice(last, m.index) + `\n_(delivered as **${name}** — see the attached file)_\n`;
    last = fence.lastIndex;
  }
  newMsg += message.slice(last);
  return { files: out, message: newMsg.trim() || message };
}

// ── Main agent loop ─────────────────────────────────────────────────────────
// opts: { task, attachments:[{name,buffer,isImage}], onStep, history:[{role,text}] }
// returns: { message: string, files: [{path, name}], steps: number, workdir }
//   `files[].path` always points to a real file on the HOST (downloaded from the
//   sandbox when needed) so the Telegram bot / web UI can read & deliver it.
async function runAgent(opts) {
  const { task, onStep, history = [], sessionKey = null } = opts;
  const throwIfStopped = () => {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error('Task stopped by user');
      e.code = 'AGENT_STOPPED';
      throw e;
    }
  };
  throwIfStopped();
  const runtime = await agentRuntimeConfig.resolve();
  // Optional per-agent identity override. Defaults to the WormGPT persona so
  // existing callers are unaffected. The Lemon AI Agent passes its own prompt
  // here while reusing the SAME Daytona DID sandbox + hotbot/Gemini brain.
  const SYSTEM_PROMPT_OVERRIDE = (opts.systemPrompt && String(opts.systemPrompt).trim()) || null;
  // Load a bounded profile isolated to this opaque user/session scope. This is
  // predictive guidance only: current instructions and safety always override it.
  const adaptation = sessionKey ? await userAdaptation.prepare(sessionKey, task) : null;
  // Load per-user memory (facts, past solutions, learned skills, projects)
  const memoryContext = sessionKey ? await userMemory.buildContext(sessionKey) : '';
  const baseSystemPrompt = SYSTEM_PROMPT_OVERRIDE || AGENT_SYSTEM_PROMPT;
  const stemPublisher = require('./stemSolutionPublisher');
  const stemContract = stemPublisher.classifyTask(task).publish ? stemPublisher.SYSTEM_PROMPT_CONTRACT : '';
  const adaptedSystemPrompt = adaptation && adaptation.context
    ? `${baseSystemPrompt}\n\n${adaptation.context}`
    : baseSystemPrompt;
  // Inject per-user memory after the adaptation context
  const effectiveSystemPromptWithMemory = memoryContext
    ? `${adaptedSystemPrompt}\n\n${memoryContext}`
    : adaptedSystemPrompt;
  const effectiveSystemPrompt = stemContract
    ? `${effectiveSystemPromptWithMemory}\n\n${stemContract}`
    : effectiveSystemPromptWithMemory;
  let attachments = opts.attachments || [];

  // Guarantee that readable attachment text enters the model context before
  // sandbox planning. Tool selection is no longer a prerequisite for the LLM
  // to see an uploaded image/document. Reuse Capy-first pre-ingestion when
  // present so the same bytes are never OCR'd twice in one request.
  let preExtractedAttachmentContext = String(opts.preExtractedAttachmentContext || '');
  if (!preExtractedAttachmentContext && attachments.length) {
    try {
      const pre = await attachmentText.extractAttachments(attachments, { onStep });
      preExtractedAttachmentContext = pre.context || '';
    } catch (_) { /* tools can still inspect the staged files */ }
  }
  const taskForModel = preExtractedAttachmentContext
    ? `${task}\n\n=== PRE-EXTRACTED ATTACHMENT CONTENT (use as source text; do not wait for another extractor) ===\n${preExtractedAttachmentContext}\n=== END PRE-EXTRACTED ATTACHMENT CONTENT ===`
    : task;

  // ── "AGENT OWNS THE COMPUTER" MODE (default, option A) ───────────────────
  // When enabled (Daytona + a public bridge URL are configured), the WHOLE
  // plan→act→observe loop runs INSIDE the user's persistent Daytona sandbox via
  // a long-running agent.py worker — so the agent literally lives on the box and
  // can work for minutes→hours. We require a sessionKey (per-chat persistence).
  // ANY failure transparently falls back to the in-process host loop below, so a
  // live Telegram/WhatsApp user is never left with a dead bot.
  if (sessionKey) {
    try {
      const sandboxAgent = require('./sandboxAgent');
      if (await sandboxAgent.enabled()) {
        if (onStep) onStep('🧠 running in "owns-the-computer" mode (agent lives inside your sandbox)…');
        let sandboxResult;
        try {
          sandboxResult = await sandboxAgent.runAgentInSandbox({
            task: taskForModel, attachments, history, onStep, sessionKey,
            systemPrompt: effectiveSystemPrompt,
            signal: opts.signal,
            thinkUntilMs: opts.thinkUntilMs, minDurationMs: opts.minDurationMs,
            maxIterations: runtime.maxIterations, maxToolSteps: runtime.maxToolSteps,
          });
        } finally {
          if (sandboxAgent.clearActiveTask) sandboxAgent.clearActiveTask(sessionKey);
        }
        // Best-effort online learning from aggregate completion outcome. Never
        // block or fail a user task because profile storage is unavailable.
        userAdaptation.learn(sessionKey, adaptation, {
          task, success: !!(sandboxResult && sandboxResult.message && !/^⚠️/.test(sandboxResult.message)),
        }).catch(() => {});
        // Auto-record what the user asked and what worked — builds memory over time
        userMemory.autoRecord(sessionKey, task, sandboxResult?.message || '', {
          success: !!(sandboxResult && sandboxResult.message && !/^⚠️/.test(sandboxResult.message)),
        }).catch(() => {});
        return await stemPublisher.postProcessResult(opts, sandboxResult);
      }
    } catch (e) {
      if (opts.signal && opts.signal.aborted) {
        return { message: '🛑 Task stopped.', files: [], steps: 0, workdir: null, brain: 'stopped', stopped: true };
      }
      console.error('[agentEngine] in-sandbox mode failed, falling back to host loop:', e.message);
      // Make the fallback VISIBLE and reassuring — the app must never be left on
      // a frozen "Working inside the sandbox…" spinner. We tell the user we're
      // switching engines and that their task continues (the host loop runs the
      // SAME plan→act→observe loop, just on the Render host instead of the box).
      if (onStep) onStep(`⚙️ sandbox is busy/unreachable (${String(e.message).slice(0, 110)}) — switching to the fast host engine, your task continues…`);
    }
  }

  // Host-side staging dir: holds attachment copies (for analyze/read_document)
  // and the downloaded deliverables we hand back to the caller.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wormstage_'));

  // Build the execution/file backend with a graceful cascade:
  //   1. Runloop  (PRIMARY)  — preferred sandbox for every task.
  //   2. Daytona  (BACKUP)   — used if Runloop isn't configured or fails.
  //   3. Local host          — last-resort legacy fallback.
  // Enablement is re-checked per-run (not just at module load) so env/admin
  // changes are always honoured, and we LOG every fallback so production issues
  // are diagnosable.
  //
  // When `sessionKey` is set (e.g. "tg:<chatId>"), the SAME sandbox is reused
  // across turns so the agent's working directory PERSISTS — files the user
  // sent or the agent produced earlier are still there, so it never has to ask
  // the user to resend them.
  let fsx;
  const LABELS = { codesandbox: 'CodeSandbox', hopx: 'HopX', runloop: 'Runloop', daytona: 'Daytona', novita: 'Novita', upstashbox: 'Upstash Box', tensorlake: 'Tensorlake', githubactions: 'GitHub Actions' };
  // Prefer the ASYNC enablement probe so a key that lives only in the DB (admin
  // Integrations tab) counts even when the sync `enabled()` cache is cold.
  const _isOn = async (mod) => {
    if (!mod) return false;
    try { if (mod.enabledAsync) return !!(await mod.enabledAsync()); } catch (_) {}
    try { return !!mod.enabled(); } catch (_) { return false; }
  };
  const tryBackend = async (mod, label) => {
    if (!(await _isOn(mod))) return null;
    try {
      const f = await makeSandboxFsx(onStep, sessionKey, mod, label);
      console.log(`[agentEngine] Sandbox backend: ${label} (id=${f.sandboxId}, reused=${f.reused}).`);
      return f;
    } catch (e) {
      console.error(`[agentEngine] ${label} sandbox unavailable:`, e.message);
      if (onStep) onStep(`⚠️ ${label} sandbox unavailable (${e.message.slice(0, 100)})`);
      return null;
    }
  };

  // Honour the ADMIN-CHOSEN backend. The selection (DB setting `sandbox_backend`)
  // is read fresh every run so admin changes apply immediately without a restart.
  // 🔒 STICKY CONTRACT (fixes "sandbox changes mid-task"): when a specific backend
  // is PINNED it is a HARD LOCK — the cascade contains ONLY it, so the session
  // can never drift to another provider. In 'auto' we reuse whatever backend the
  // session already lives on (sticky) so a task NEVER hops Novita→Daytona etc.
  const selName = await getSelectedBackendName();
  const prevBackend = sessionKey ? await _getSessionBackendEngine(sessionKey) : null;
  const cascade = await resolveBackendCascade(prevBackend);
  if (selName !== 'auto') {
    const chosen = SANDBOX_BACKENDS[selName];
    if (chosen && !(await _isOn(chosen))) {
      if (onStep) onStep(`⚠️ selected sandbox "${LABELS[selName] || selName}" has no API key — add it in the admin Integrations tab.`);
      console.warn(`[agentEngine] Admin-selected backend "${selName}" not configured.`);
    } else if (chosen) {
      if (onStep) onStep(`🧭 admin-selected sandbox (locked for the whole session): ${LABELS[selName] || selName}.`);
    }
  }

  // 🔀 BACKEND-SWITCH MIGRATION (host-loop path). ONLY migrate when the ADMIN
  // has PINNED a backend that DIFFERS from where this chat's sandbox currently
  // lives. In 'auto' mode we do NOT migrate — the session stays put (sticky), so
  // an ordinary task never gets yanked between providers mid-conversation.
  if (sessionKey && selName !== 'auto') {
    try {
      if (prevBackend && prevBackend !== selName && SANDBOX_BACKENDS[prevBackend]) {
        if (onStep) onStep(`🔀 admin switched the active sandbox — moving your session off ${LABELS[prevBackend] || prevBackend} onto ${LABELS[selName] || selName}.`);
        try { await SANDBOX_BACKENDS[prevBackend].endSession(sessionKey); } catch (_) {}
      }
    } catch (_) {}
  }

  for (const { name, mod } of cascade) {
    fsx = await tryBackend(mod, LABELS[name] || name);
    if (fsx) {
      // Record which backend this session now lives on for future switch detection.
      if (sessionKey) { try { await _setSessionBackendEngine(sessionKey, name); } catch (_) {} }
      break;
    }
  }
  const anyRemoteEnabled = (await Promise.all(cascade.map(({ mod }) => _isOn(mod)))).some(Boolean);
  if (!fsx) {
    if (anyRemoteEnabled) {
      if (onStep) onStep('⚠️ all remote sandboxes unavailable — falling back to local execution.');
      console.error('[agentEngine] All remote sandboxes failed; using local host fallback.');
    }
    fsx = makeLocalFsx();
  }

  // ── PER-TASK FILE ISOLATION (permanent fix for "previous task files come back") ─
  // The sandbox work tree PERSISTS across turns (great for follow-ups: "now
  // convert that file"), but a NEW task must only ever hand back the files IT
  // produced — never leftovers from earlier tasks that are still sitting in the
  // persistent work dir. We solve this two ways, both scoped to THIS session's
  // sandbox id so other users are never affected:
  //
  //   (a) On GitHub Actions (nativeFs + perCommand), the work tree lives in a
  //       SHARED git repo and the deliverable scan (make_zip ., tree reads, etc.)
  //       would otherwise sweep up every past file. When this is NOT a follow-up
  //       turn (no prior chat history referencing the workspace), we WIPE the
  //       work tree up-front so the task starts from a clean slate. This is the
  //       permanent, multi-user-safe answer to "GitHub Actions keeps returning
  //       old task files" — each task begins empty, so only its own outputs exist.
  //   (b) On EVERY backend we capture a task-start baseline (rel → size:mtime).
  //       At delivery time we drop any candidate whose rel existed UNCHANGED at
  //       task start, so pre-existing files can never leak into the results even
  //       when a whole-dir tool (make_zip .) or a safety net would include them.
  //
  // `isFollowUp` = the caller passed prior turn history AND did not force a fresh
  // workspace. On a follow-up we KEEP the files (the user may reference them) but
  // still rely on the baseline diff (b) to only deliver this-turn's new/changed
  // files. `opts.freshWorkspace === true` forces (a) even on a follow-up.
  const isFollowUp = Array.isArray(opts.history) && opts.history.length > 0 && opts.freshWorkspace !== true;
  const taskBaseline = new Map(); // rel -> size:mtime at task start
  const taskBaselineHashes = new Map(); // rel -> sha256 for robust mtime-bump isolation
  {
    const sig = (f) => `${f.size}:${f.mtime || 0}`;
    // GitHub Actions / any perCommand+nativeFs backend → wipe up-front on a NEW
    // (non-follow-up) task, or whenever freshWorkspace is forced.
    const wantWipe = fsx && fsx.nativeFs && fsx.backendMod && fsx.backendMod.perCommand &&
                     (!isFollowUp || opts.freshWorkspace === true);
    if (wantWipe && typeof fsx.clearWorkTree === 'function') {
      try {
        const n = await fsx.clearWorkTree();
        if (n && onStep) onStep(`🧹 fresh workspace — cleared ${n} file(s) from the previous task so only THIS task's outputs are returned.`);
      } catch (e) { if (onStep) onStep(`⚠️ could not auto-clear the previous task's files: ${e.message}`); }
    }
    // Baseline snapshot AFTER any wipe (empty if we wiped) so delivery diffs are
    // measured against the true task-start state.
    try {
      const baselineFiles = await fsx.list();
      let hashedBytes = 0;
      const hashBudget = parseInt(process.env.TASK_BASELINE_HASH_BUDGET || String(96 * 1024 * 1024), 10);
      for (const f of baselineFiles) {
        const rel = String(f.rel).replace(/^\.?\/+/, '');
        taskBaseline.set(rel, sig(f));
        if (_isInternalArtifact(rel) || f.size > 45 * 1024 * 1024 || hashedBytes + f.size > hashBudget) continue;
        try {
          const buf = await fsx.downloadBuffer(rel);
          taskBaselineHashes.set(rel, crypto.createHash('sha256').update(buf).digest('hex'));
          hashedBytes += buf.length;
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Deliverables tracked as RELATIVE paths inside the working dir, plus any
  // host-side buffers staged directly (docx/pdf generated on host).
  const deliverRel = new Map();      // rel -> name
  const stagedBuffers = new Map();   // name -> hostPath (already on host)

  const ctx = {
    fsx, attachments, step: 0, onStep,
    // Chat/session identity for delivery-bound tools (market watch alerts,
    // scheduled follow-ups). sessionKey is e.g. "tg:<chatId>" / a WhatsApp jid;
    // chatId is the raw id the bots key their send()/runner on.
    sessionKey,
    chatId: opts.chatId || (sessionKey ? String(sessionKey).replace(/^[a-z]+:/i, '') : null),
    source: opts.source || null,
    // The ORIGINAL user task text — used by the WRITING-LENGTH ENFORCER so
    // document tools can infer a requested page/word target ("10 page story
    // book", "5-page report", "a full book") even when the model forgets to
    // pass an explicit pages/target_words arg.
    taskText: String(task || ''),
    // Rich event emitter for non-step UI events (live screen frames, etc).
    // Threaded from the server SSE handler as onEvent(type, data). When a caller
    // (e.g. the Telegram bot) doesn't provide one, it's a harmless no-op so the
    // agent behaves identically.
    onEvent: (typeof opts.onEvent === 'function') ? opts.onEvent : () => {},
    // Stable per-user identity used for deploy URL isolation (Cloudflare Pages
    // project name). Same user (sessionKey) → same project → same URL; a
    // different user → different project → different URL.
    userKey: sessionKey || 'anon',
    get workdir() { return fsx.workdir; },
    // Register a file produced inside the working dir for delivery.
    addFile(rel, name) {
      const key = String(rel).replace(/^\.?\/+/, '');
      if (!deliverRel.has(key)) deliverRel.set(key, name || path.posix.basename(key));
    },
    // Deliver a buffer generated on the host (docx/pdf): write it into the
    // working dir (so the agent can also see/zip it) AND stage it for return.
    async deliverBuffer(name, buffer) {
      const safe = String(name).replace(/[^\w.\-]/g, '_');
      try { await fsx.uploadBuffer(safe, buffer); } catch (_) {}
      const hostPath = path.join(stageDir, safe);
      try { fs.writeFileSync(hostPath, buffer); stagedBuffers.set(safe, hostPath); } catch (_) {}
      deliverRel.set(safe, safe);
    },
  };

  // Push uploaded attachments into the working dir so run_code / read_file /
  // edit_file can use them. ZIPs are auto-extracted. Inputs are NOT marked as
  // deliverables — only NEW files the agent produces are returned.
  // We track which attachments ACTUALLY landed so the prompt never advertises a
  // file that failed to upload (which is what made the model report an "empty
  // workspace" and ask the user to re-attach).
  //
  // 🐙 GitHub Actions (nativeFs) FAST PATH: every fsx.exec() on GitHub Actions
  // is a full CI workflow dispatch (30 s–minutes). The previous per-file
  // uploadBuffer + exists() + `unzip` (a CI run!) meant a single pdf/apk/zip
  // upload fired many workflow dispatches and the bot appeared to "hang
  // forever". On nativeFs backends we now (a) extract ZIPs locally in-process
  // (adm-zip, no CI run), (b) commit ALL files — the raw attachments plus every
  // extracted entry — in ONE git commit, and (c) skip the per-file exists()
  // probe (the commit is authoritative). No workflow is dispatched during
  // staging at all, so file uploads are instant and reliable.
  const stagedAttachments = [];
  const nativeFs = !!(fsx && fsx.nativeFs && typeof fsx.uploadMany === 'function');

  if (nativeFs) {
    const batch = [];             // [{ rel, buffer }] — one commit for everything
    for (const a of attachments) {
      try {
        const safe = String(a.name || 'input').replace(/[^\w.\-]/g, '_');
        if (!a.buffer) throw new Error('empty attachment buffer');
        batch.push({ rel: safe, buffer: a.buffer });
        a.localPath = safe;
        // Extract ZIPs locally (no CI run) and add every entry to the same commit.
        if (/\.zip$/i.test(safe)) {
          const dir = safe.replace(/\.zip$/i, '') + '_extracted';
          try {
            const entries = _safeZipEntries(a.buffer);
            for (const entry of entries) {
              batch.push({ rel: `${dir}/${entry.rel}`, buffer: entry.buffer });
            }
            a.extractedTo = dir;
          } catch (e) {
            if (onStep) onStep(`⚠️ could not extract ${a.name}: ${e.message} — leaving the raw .zip so you can still work with it.`);
          }
        }
        stagedAttachments.push(a);
      } catch (e) {
        if (a && a.isImage) {
          if (onStep) onStep(`ℹ️ ${a.name}: not written to sandbox (${e.message}); will analyze it from memory instead.`);
          stagedAttachments.push(a);
        } else {
          if (onStep) onStep(`⚠️ failed to load attachment ${a && a.name}: ${e.message}`);
        }
      }
    }
    if (batch.length) {
      try {
        await fsx.uploadMany(batch);
        if (onStep) onStep(`📎 staged ${batch.length} file(s) into your sandbox.`);
      } catch (e) {
        if (onStep) onStep(`⚠️ could not stage files into the sandbox (${String(e.message).slice(0, 120)}) — keeping images in memory.`);
        // Keep only images (analyzable from memory); drop non-image entries that
        // never landed so the model isn't told about a file that isn't there.
        for (let i = stagedAttachments.length - 1; i >= 0; i--) {
          if (!stagedAttachments[i].isImage) stagedAttachments.splice(i, 1);
        }
      }
    }
  } else {
    for (const a of attachments) {
    try {
      const safe = String(a.name || 'input').replace(/[^\w.\-]/g, '_');
      await fsx.uploadBuffer(safe, a.buffer);
      // Verify it is really there before trusting it.
      let landed = true;
      try { landed = await fsx.exists(safe); } catch (_) { landed = true; }
      if (!landed) throw new Error('upload verification failed');
      a.localPath = safe;
      if (/\.zip$/i.test(safe)) {
        const dir = safe.replace(/\.zip$/i, '') + '_extracted';
        try {
          const entries = _safeZipEntries(a.buffer);
          if (fsx.kind === 'sandbox') {
            // Upload validated entries individually. This is slower than shell
            // unzip but guarantees identical zip-slip/bomb protection across
            // Novita, Upstash, Runloop, Daytona and other providers.
            for (const entry of entries) await fsx.uploadBuffer(`${dir}/${entry.rel}`, entry.buffer);
          } else {
            const extractDir = path.join(fsx.workdir, dir);
            fs.mkdirSync(extractDir, { recursive: true });
            for (const entry of entries) {
              const dest = path.join(extractDir, ...entry.rel.split('/'));
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, entry.buffer);
            }
          }
          a.extractedTo = dir;
        } catch (e) {
          if (onStep) onStep(`⚠️ could not extract ${a.name}: ${e.message}`);
          /* leave the raw zip if extraction fails */
        }
      }
      stagedAttachments.push(a);
    } catch (e) {
      // IMAGES are analyzed straight from their in-memory buffer (analyze_image
      // never touches the sandbox), so even if the sandbox write failed the
      // image is still fully usable. Keeping it here is what lets WhatsApp /
      // Telegram image tasks work on EVERY backend instead of only Daytona —
      // previously a failed sandbox upload silently dropped the image and the
      // bot replied that it "failed" / saw an empty workspace.
      if (a && a.isImage) {
        if (onStep) onStep(`ℹ️ ${a.name}: not written to sandbox (${e.message}); will analyze it from memory instead.`);
        stagedAttachments.push(a);
      } else {
        if (onStep) onStep(`⚠️ failed to load attachment ${a && a.name}: ${e.message}`);
        /* skip non-image attachment — it is NOT advertised to the model */
      }
    }
  }
  }
  // From here on, only reference files that actually made it into the workdir.
  attachments = stagedAttachments;

  // Build a precise, verbatim list of the EXACT filenames the user actually
  // provided this turn — this is the authoritative source of truth the model
  // must reference (fixes the "agent invents an unrelated filename like
  // server.py" bug: the model must ONLY touch files that really exist).
  const exactNames = attachments.map(a => a.name);
  const attachLine = attachments.length
    ? `\n\nATTACHED FILES (already in your working dir — never ask the user to re-send them): ${attachments.map(a => {
        if (a.isImage) return `${a.name} (image — analyze it with analyze_image using this exact name)`;
        if (a.extractedTo) return `${a.name} (ZIP — auto-extracted into ./${a.extractedTo}/, use list_files / read_file / edit_file / make_zip)`;
        return a.name;
      }).join(', ')}\n\n🔒 FILE-REFERENCE CONTRACT (STRICT — obey exactly):
1. The user's files for THIS task are EXACTLY: [${exactNames.map(n => `"${n}"`).join(', ')}]. These are the ONLY input files that belong to this request. WORK ON THESE FILES — not on anything left over from a previous task.
2. Your FIRST action MUST be list_files (for documents/zips/code) or analyze_image (for images) to see the REAL contents of the working directory. Reference files ONLY by the names list_files actually returns.
3. NEVER invent, assume, guess, or reference a filename that is NOT in the list above or in the list_files output — e.g. do NOT talk about "server.py", "app.py", "index.js" or any other file unless list_files proves it exists. If you need a file that isn't there, you must CREATE it explicitly with write_file, not pretend it already exists.
4. When the ZIP/project is auto-extracted, walk it with list_files and read the ACTUAL files inside — build your understanding from the real tree, not from a template or memory of a similar project.
5. NEVER claim the workspace is empty and NEVER ask the user to attach the file again — they are already here. The text instruction and the attached file(s) belong to the SAME task.
6. CURRENT-UPLOAD PRIORITY: If the working directory ALSO contains older files from a previous task, IGNORE them and operate ONLY on the files listed in rule 1 — UNLESS the user's message explicitly refers to an earlier/previous file. When in doubt, prefer the file(s) the user just uploaded. Do NOT merge, confuse, or cross-reference this task's files with leftovers from an unrelated earlier task.`
    : '';

  // ── PERSISTENT ANALYSIS MEMORY ──────────────────────────────────────────
  // When the session is persistent (sessionKey set, e.g. "tg:<chatId>"), the
  // sandbox disk survives across turns — but the agent's *understanding* of
  // what it read/analyzed earlier (a PDF's contents, an image's details, a
  // page it browsed) lived only in that turn's short conversation window and
  // was forgotten. We durably persist a compact note of every analysis to
  // `.agent_memory.md` in the workdir and replay it on the next turn, so the
  // agent never "forgets what it analyzed" and never asks the user to re-send.
  //
  // 100% additive + best-effort: gated on `sessionKey`, every read/write is
  // wrapped in try/catch, and any failure silently leaves the original
  // behaviour untouched. It can never break a task.
  const MEMORY_FILE = '.agent_memory.md';
  const MEMORY_MAX_CHARS = 24000;   // cap the persisted log so it never bloats the prompt
  const memoryActive = !!sessionKey;

  // Append a compact, timestamped note to the persistent memory file.
  ctx.rememberAnalysis = async function rememberAnalysis(label, text) {
    if (!memoryActive) return;
    try {
      const snippet = String(text == null ? '' : text).replace(/\s+$/g, '').slice(0, 4000);
      if (!snippet.trim()) return;
      let prev = '';
      try { if (await fsx.exists(MEMORY_FILE)) prev = await fsx.readText(MEMORY_FILE); } catch (_) { prev = ''; }
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
      let next = `${prev || '# Agent analysis memory (persists across turns)\n'}\n## [${stamp}] ${label}\n${snippet}\n`;
      // Keep only the most recent MEMORY_MAX_CHARS (drop oldest notes first).
      if (next.length > MEMORY_MAX_CHARS) next = '# Agent analysis memory (persists across turns)\n…(older notes trimmed)…\n' + next.slice(next.length - MEMORY_MAX_CHARS);
      await fsx.writeText(MEMORY_FILE, next);
    } catch (_) { /* best-effort: never break the run */ }
  };

  // Load any prior analysis memory so it can be injected into the conversation.
  let priorMemory = '';
  if (memoryActive) {
    try {
      if (await fsx.exists(MEMORY_FILE)) {
        priorMemory = (await fsx.readText(MEMORY_FILE) || '').slice(0, MEMORY_MAX_CHARS).trim();
      }
    } catch (_) { priorMemory = ''; }
  }

  // Seed the conversation with prior turns (conversational memory).
  //
  // 🐛 FIX — "agent redoes the previous, already-finished task":
  // Previously the prior user turns were replayed as plain `user` messages,
  // IDENTICAL in shape to the new task. The model could not tell that those
  // earlier requests were ALREADY COMPLETED, so on the next message it often
  // re-executed the previous finished task in addition to (or instead of) the
  // new one. We now:
  //   1. Wrap the whole replayed history in an explicit, clearly-labelled
  //      CONVERSATION HISTORY block (reference/context ONLY — already done).
  //   2. Prefix each historical user turn with "[past request — ALREADY DONE]"
  //      and each assistant turn with "[past reply]" so their status is
  //      unambiguous.
  //   3. Emit ONE current-task message that states, in strong terms, that this
  //      is the ONLY thing to act on now and that finished history must NOT be
  //      redone unless the new task explicitly asks for it.
  const conversation = [];
  if (Array.isArray(history) && history.length) {
    const hist = history.slice(-12).filter(h => h && h.text);
    if (hist.length) {
      // A single leading marker so the model treats everything until the
      // current task as settled context, not a live to-do list.
      conversation.push({
        role: 'user',
        text: '=== CONVERSATION HISTORY (context only — every request below was ALREADY handled and COMPLETED in an earlier turn; do NOT redo any of it unless the CURRENT TASK explicitly asks you to) ===',
      });
      for (const h of hist) {
        const isModel = (h.role === 'assistant' || h.role === 'model');
        const label = isModel ? '[past reply]' : '[past request — ALREADY DONE]';
        conversation.push({
          role: isModel ? 'model' : 'user',
          text: `${label} ${String(h.text).slice(0, 4000)}`,
        });
      }
      conversation.push({ role: 'model', text: '[Understood. The above is finished history for context only. I will act ONLY on the CURRENT TASK below and will not repeat any already-completed work unless explicitly asked.]' });
    }
  }
  // Replay persisted analysis BEFORE the new task so the agent recalls what it
  // already read/analyzed in earlier turns and does not re-ask or re-read.
  if (priorMemory) {
    conversation.push({
      role: 'user',
      text: `ANALYSIS MEMORY (things you already read/analyzed in earlier turns — treat as already known, do NOT ask the user to re-send these files and do NOT re-read them unless something changed):\n\n${priorMemory}`,
    });
  }
  // The current task is explicitly demarcated as the ONE and ONLY instruction to
  // execute now, so the model never conflates it with the finished history above.
  conversation.push({
    role: 'user',
    text: `=== CURRENT TASK (this is the ONLY thing to do now — act on THIS request only; ignore/do NOT redo anything already completed in the history above) ===\n\n${taskForModel}${attachLine}`,
  });

  let finalMessage = '';
  let outFiles = [];

  // ── Tool executor: the single source of truth for every agent action. ────
  // Extracted from the old inline switch so the LangGraph `tools` node and any
  // future caller share ONE implementation. Returns the observation string.
  //
  // executeTool wraps the raw dispatcher so that, for analysis-type tools, the
  // observation is durably persisted to .agent_memory.md (see PERSISTENT
  // ANALYSIS MEMORY above). This is additive and best-effort — the dispatcher's
  // return value is passed through UNCHANGED, so existing behaviour is identical.
  const ANALYSIS_TOOLS = new Set([
    'read_document', 'analyze_image', 'analyze_images', 'read_file', 'browse', 'web_search',
  ]);
  async function executeTool(name, args) {
    throwIfStopped();
    // 🔴 AUTO LIVE SCREEN — the moment the agent touches ANY browsing/
    // interaction tool, make sure the live sandbox screen is streaming so the
    // user can tap LIVE and actually watch (instead of "Connecting…" forever).
    // Fire-and-forget + best-effort: never delays or breaks the real tool.
    try { autoLiveScreen.onBrowseTool(ctx, name, args); } catch (_) {}
    const result = await dispatchTool(name, args);
    // Persist a compact note for analysis tools so it survives across turns.
    if (memoryActive && ANALYSIS_TOOLS.has(name) && typeof result === 'string') {
      // Skip obvious error/empty observations — only remember real findings.
      if (result.trim() && !/^\[?\w[\w ]*\]?\s*(error|No attached|No image|not configured|unavailable)/i.test(result)) {
        let label = name;
        try {
          const hint = (args && (args.name || args.path || args.url || args.query)) || '';
          if (hint) label += ` · ${String(hint).slice(0, 80)}`;
        } catch (_) {}
        ctx.rememberAnalysis(label, result).catch(() => {});
      }
    }
    return result;
  }

  async function dispatchTool(name, args) {
    switch (name) {
      case 'plan': return toolPlan(args, ctx);
      case 'list_skills': case 'skills': return toolListSkills();
      case 'read_skill': case 'load_skill': case 'use_skill': return toolReadSkill(args);
      case 'web_search': return await toolWebSearch(args);
      case 'wolfram_alpha': return await toolWolframAlpha(args);
      case 'sequential_thinking': case 'think': case 'reasoning': case 'sequentialthinking':
        return await toolSequentialThinking(args);
      case 'mcp_filesystem': case 'fs': case 'filesystem':
        return await toolMcpFilesystem(args);
      case 'mcp_call': case 'mcp': case 'mcp_tool':
        return await toolMcpCall(args);
      case 'browse': return await toolBrowse(args, ctx);
      case 'sandbox_browse': case 'browse_sandbox': case 'realtime_browse': case 'live_navigate': case 'sandbox_navigate':
        return await toolSandboxBrowse(args, ctx);
      case 'power_scrape': case 'power_browse': case 'fallback_browse':
        return await toolPowerScrape(args);
      case 'browse_live': case 'live_browse': case 'live_view': case 'live_screen': case 'watch_live':
        return await toolBrowseLive(args, ctx);
      case 'solve_captcha': case 'captcha': case 'bypass_captcha': return await toolSolveCaptcha(args);
      case 'screenshot': return await toolScreenshot(args, ctx);
      case 'run_code': return await toolRunCode(args, ctx);
      case 'read_document': return await toolReadDocument(args, ctx);
      case 'list_files': return await toolListFiles(args, ctx);
      case 'inspect_codebase': case 'codebase_map': return await toolInspectCodebase(args, ctx);
      case 'read_file': return await toolReadFile(args, ctx);
      case 'edit_file': return await toolEditFile(args, ctx);
      case 'make_zip': return await toolMakeZip(args, ctx);
      case 'scan_secrets': return await toolScanSecrets(args, ctx);
      case 'analyze_image': return await toolAnalyzeImage(args, ctx);
      case 'analyze_images': return await toolAnalyzeImage({ ...args, all: args.all === undefined ? true : args.all }, ctx);
      case 'solve_math': case 'math_solver': case 'solve': return await toolSolveMath(args, ctx);
      case 'write_file': return await toolWriteFile(args, ctx);
      case 'create_docx': return await toolCreateDocx(args, ctx);
      case 'create_pdf': return await toolCreatePdf(args, ctx);
      case 'fetch_url': return await manusTools.toolFetchUrl(args, ctx);
      case 'get_market_price': case 'market_price': case 'live_price': case 'get_price': case 'price':
        return await manusTools.toolGetMarketPrice(args, ctx);
      case 'watch_market': case 'market_watch': case 'watch_price': case 'monitor_market': case 'set_alert': case 'price_alert':
        return await manusTools.toolWatchMarket(args, ctx);
      case 'list_watches': case 'my_watches': case 'watches': case 'list_alerts':
        return await manusTools.toolListWatches(args, ctx);
      case 'stop_watch': case 'stop_watches': case 'cancel_watch': case 'unwatch': case 'clear_alerts':
        return await manusTools.toolStopWatch(args, ctx);
      case 'trade_watch': case 'watch_trade': case 'trading_watch': case 'monitor_trade': case 'monitor_trading':
        return await manusTools.toolTradeWatch(args, ctx);
      // ── 📊 TRADING SUPERPOWERS (PAPER + REAL, Binance USDT-M / Bybit perp) ──
      case 'open_trade': case 'new_trade': case 'trade_open': case 'place_trade': case 'enter_trade': case 'buy': case 'sell': case 'long': case 'short':
        return await manusTools.toolOpenTrade(args, ctx);
      case 'close_trade': case 'trade_close': case 'exit_trade': case 'close_position':
        return await manusTools.toolCloseTrade(args, ctx);
      case 'list_trades': case 'my_trades': case 'trades': case 'open_trades': case 'positions':
        return await manusTools.toolListTrades(args, ctx);
      case 'trade_stats': case 'trading_stats': case 'my_stats': case 'winrate': case 'pnl':
        return await manusTools.toolTradeStats(args, ctx);
      case 'connect_exchange': case 'connect_broker': case 'add_exchange_keys': case 'link_exchange': case 'set_api_keys':
        return await manusTools.toolConnectExchange(args, ctx);
      case 'disconnect_exchange': case 'remove_exchange': case 'unlink_exchange': case 'clear_api_keys':
        return await manusTools.toolDisconnectExchange(args, ctx);
      case 'generate_image': return await manusTools.toolGenerateImage(args, ctx);
      case 'web_image': case 'image_search': case 'find_image': case 'fetch_image': case 'crop_image': case 'get_image':
        return await webImage.toolWebImage(args, ctx);
      case 'edit_image': case 'image_edit': case 'modify_image': case 'inpaint':
        return await preciseImageEdit.toolEditImage(args, ctx);
      case 'host_media': case 'upload_cloudinary': case 'cloudinary_upload': case 'host_image': case 'host_video':
        return await manusTools.toolHostMedia(args, ctx);
      case 'create_chart': return await manusTools.toolCreateChart(args, ctx);
      case 'create_slides': return await manusTools.toolCreateSlides(args, ctx);
      case 'create_presentation': case 'create_pptx': case 'create_powerpoint':
        return await manusTools.toolCreatePresentation(args, ctx);
      case 'run_php': case 'php': case 'exec_php':
        return await manusTools.toolRunPhp(args, ctx);
      case 'convert_file': case 'convert': case 'file_convert':
        return await fileConverter.toolConvertFile(args, ctx);
      case 'browser_action': return await manusTools.toolBrowserAction(args, ctx);
      case 'deploy_site': return await manusTools.toolDeploySite(args, ctx);
      case 'deploy_cloudflare_pages': case 'deploy_pages': case 'deploy_cf':
        return await manusTools.toolDeployCloudflarePages(args, ctx);
      case 'deploy_github': case 'deploy_to_github': case 'push_github':
        return await manusTools.toolDeployGithub(args, ctx);
      case 'docker_run': case 'docker': case 'dind': case 'container_run':
        return await toolDockerRun(args, ctx);
      case 'deploy_render': case 'push_deploy': case 'deploy_to_render': case 'ship':
        return await toolDeployRender(args, ctx);
      // ── GitHub automation tools ──────────────────────────────────────────
      case 'github_scan': case 'scan_github': case 'scan_repo':
        return await manusTools.toolGithubScan(args, ctx);
      case 'github_workflow': case 'trigger_workflow': case 'workflow':
        return await manusTools.toolGithubWorkflow(args, ctx);
      case 'github_monitor': case 'monitor_workflow': case 'watch_workflow':
        return await manusTools.toolGithubMonitor(args, ctx);
      case 'github_push': case 'push_code': case 'git_push':
        return await manusTools.toolGithubPush(args, ctx);
      case 'github_apk': case 'apk_build': case 'build_apk': case 'watch_apk':
        return await manusTools.toolGithubApk(args, ctx);
      // ── ENTERPRISE TOOLS ─────────────────────────────────────────────────
      case 'glob':
        return await enterpriseTools.toolGlob(args, ctx);
      case 'grep':
        return await enterpriseTools.toolGrep(args, ctx);
      case 'bash':
        return await enterpriseTools.toolBash(args, ctx);
      case 'gitclone': case 'git_clone': case 'clone':
        return await enterpriseTools.toolGitClone(args, ctx);
      case 'gitdiff': case 'git_diff':
        return await enterpriseTools.toolGitDiff(args, ctx);
      case 'write': case 'write_file':
        // Use the existing write_file (line 2668) for 'write_file', enterpriseTools.toolWrite for 'write'
        return await enterpriseTools.toolWrite(args, ctx);
      case 'read':
        return await enterpriseTools.toolRead(args, ctx);
      case 'edit':
        return await enterpriseTools.toolEdit(args, ctx);
      case 'coding':
        return await enterpriseTools.toolCoding(args, ctx);
      case 'database': case 'db':
        return await enterpriseTools.toolDatabase(args, ctx);
      case 'webshell': case 'web_shell':
        return await enterpriseTools.toolWebshell(args, ctx);
      case 'todo':
        return await enterpriseTools.toolTodo(args, ctx);
      case 'sandbox': case 'sandbox_info':
        return await enterpriseTools.toolSandboxInfo(args, ctx);
      case 'documents': case 'document': case 'docx': case 'pptx': case 'xlsx': case 'pdf':
        return await enterpriseTools.toolDocuments(args, ctx);
      case 'deepseek': case 'ds':
        return await enterpriseTools.toolDeepSeek(args, ctx);
      case 'upload_file': case 'upload': case 'catbox':
        return await enterpriseTools.toolUploadFile(args, ctx);
      default:
        return `[error] Unknown action "${name}". Valid: plan, list_skills, read_skill, web_search, wolfram_alpha, sequential_thinking, mcp_filesystem, mcp_call, browse, sandbox_browse, power_scrape, screenshot, run_code, docker_run, read_document, list_files, read_file, edit_file, make_zip, scan_secrets, analyze_image, analyze_images, solve_math, write_file, create_docx, create_pdf, convert_file, fetch_url, get_market_price, watch_market, trade_watch, list_watches, stop_watch, open_trade, close_trade, list_trades, trade_stats, connect_exchange, disconnect_exchange, analyze_market, trade_signal, position_size, risk_check, performance_report, health_check, generate_image, edit_image, host_media, create_chart, create_slides, create_presentation, run_php, browser_action, deploy_site, deploy_cloudflare_pages, deploy_github, deploy_render, github_scan, github_workflow, github_monitor, glob, grep, bash, gitclone, gitdiff, write, read, edit, coding, database, webshell, todo, sandbox, documents, deepseek, finish.`;
    }
  }

  try {
    // ── LangGraph drives the plan→act→observe loop (replaces the old for-loop).
    // The graph reuses the SAME brain (geminiComplete), parseAction, ctx/sandbox
    // and tool executor above, and honours the MAX_STEPS budget as its recursion
    // limit — so behaviour is identical, just expressed as an explicit state
    // machine with conditional edges (agent → tools → agent … → finish/END).
    const loopResult = await runGraphLoop({
      conversation,
      brain: geminiComplete,
      systemPrompt: effectiveSystemPrompt,
      parseAction,
      executeTool,
      ctx,
      onStep,
      taskText: task,
      maxSteps: runtime.maxToolSteps,
      maxIterations: runtime.maxIterations,
      signal: opts.signal || null,
      // ⏱️ Time-box (host-loop path): keep exploring new angles until the
      // deadline instead of finishing early. Mirrors the in-sandbox worker.
      thinkUntilMs: (opts.thinkUntilMs && Number.isFinite(opts.thinkUntilMs)) ? opts.thinkUntilMs
        : ((opts.minDurationMs && Number.isFinite(opts.minDurationMs)) ? Date.now() + opts.minDurationMs : 0),
    });
    finalMessage = loopResult.finalMessage || finalMessage;
  } finally {
    // 🔴 AUTO LIVE SCREEN — tear down any auto-started live session now the run
    // is finishing, emitting the `screen:end` the UI uses to flip LIVE→ENDED.
    try { await autoLiveScreen.stop(ctx); } catch (_) {}
    // ── SAFETY NET: if the model finished by pasting code into the chat and
    //    produced NO files at all, extract those code blocks into real files so
    //    the user still gets a download instead of just code on screen. ──────
    if (deliverRel.size === 0 && finalMessage && /```[\s\S]*?```/.test(finalMessage)) {
      try {
        const extracted = extractCodeFiles(finalMessage);
        if (extracted.files.length) {
          for (const ef of extracted.files) {
            await ctx.deliverBuffer(ef.name, Buffer.from(ef.content, 'utf-8'));
          }
          finalMessage = extracted.message;
          if (onStep) onStep(`📎 packaged ${extracted.files.length} code block(s) into downloadable file(s)`);
        }
      } catch (_) { /* best-effort */ }
    }

    // ── SAFETY NET 2: REPORT / DOCUMENT → ALWAYS RETURN A PDF ────────────────
    //    If the model finished a long-form document (lab/practical report,
    //    essay, article, analysis, etc.) by writing the WHOLE thing into the
    //    chat message but produced NO downloadable file, we render that prose
    //    into a real PDF and deliver it. This guarantees the user ALWAYS gets a
    //    PDF back for report-style tasks (the user explicitly requires it), even
    //    when the agent forgets to call create_pdf or runs out of steps.
    if (deliverRel.size === 0 && finalMessage) {
      try {
        const plain = String(finalMessage);
        const wordCount = (plain.trim().match(/\S+/g) || []).length;
        const looksLikeReport = /\b(abstract|introduction|theory|procedure|apparatus|results?|analysis|discussion|precaution|conclusion|references?|aim|objective)\b/i.test(plain);
        // Long prose (a real document), OR a clearly report-structured message.
        if (wordCount >= 250 && (looksLikeReport || wordCount >= 400)) {
          // Derive a sensible filename/title from the first heading if present.
          const headingMatch = plain.match(/^\s*#{1,3}\s+(.+)$/m) || plain.match(/^\s*([A-Z][^\n]{6,80})\s*$/m);
          const rawTitle = (headingMatch && headingMatch[1] ? headingMatch[1] : 'Report').trim();
          const baseName = rawTitle.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'report';
          const filename = `${baseName}.pdf`;
          const res = await toolCreatePdf(
            { filename, title: rawTitle, content: plain, math: true },
            ctx
          );
          if (deliverRel.size > 0) {
            if (onStep) onStep(`📄 auto-generated PDF from the report text → ${filename}`);
            finalMessage = `✅ Your report is ready — attached as **${filename}**.\n\n${plain.slice(0, 1200)}${plain.length > 1200 ? '\n\n_(full content in the attached PDF)_' : ''}`;
          } else if (onStep) {
            onStep(`⚠️ could not auto-generate report PDF: ${String(res).slice(0, 120)}`);
          }
        }
      } catch (e) {
        if (onStep) onStep(`⚠️ report→PDF safety net failed: ${e.message}`);
        /* best-effort — never block delivery */
      }
    }

    // ── Materialize deliverables onto the HOST so the caller can send them ──
    const files = [];
    const usedNames = new Set();
    // Signature helper for the task-start baseline diff (per-task isolation).
    const _sig = (f) => `${f.size}:${f.mtime || 0}`;
    // Current work-tree signatures so we can tell whether a candidate deliverable
    // is UNCHANGED since the task started (→ a leftover from an earlier task).
    let _nowSigs = new Map();
    if (taskBaseline.size) {
      try { for (const f of await fsx.list()) _nowSigs.set(String(f.rel).replace(/^\.?\/+/, ''), _sig(f)); } catch (_) {}
    }
    for (const [rel, name] of deliverRel.entries()) {
      // Skip scratch scripts, the internal analysis-memory file, OmniOCR engine
      // staging + staged inputs, and anything that vanished.
      if (_isInternalArtifact(rel)) continue;
      // 🧹 PER-TASK ISOLATION: drop any candidate that existed UNCHANGED at task
      // start — it is a leftover from a PREVIOUS task, not an output of THIS one.
      // (Host-staged buffers — docx/pdf generated this turn — are always kept.)
      const relKey = String(rel).replace(/^\.?\/+/, '');
      if (taskBaseline.size && !stagedBuffers.has(name)) {
        const base = taskBaseline.get(relKey);
        const now = _nowSigs.get(relKey);
        if (base !== undefined && now !== undefined && base === now) continue; // unchanged leftover
        // A formatter, sync operation or reinstall may bump mtime without
        // changing bytes. Compare content against the task-start hash so such a
        // previous-task file still cannot leak into this task's result.
        if (base !== undefined && taskBaselineHashes.has(relKey)) {
          try {
            const current = await fsx.downloadBuffer(rel);
            const currentHash = crypto.createHash('sha256').update(current).digest('hex');
            if (currentHash === taskBaselineHashes.get(relKey)) continue;
          } catch (_) { /* normal download below remains the final authority */ }
        }
      }
      let uniqueName = name;
      let n = 1;
      while (usedNames.has(uniqueName)) { uniqueName = name.replace(/(\.[^.]+)?$/, m => `_${n}${m || ''}`); n++; }
      usedNames.add(uniqueName);
      const hostPath = path.join(stageDir, uniqueName.replace(/[^\w.\-]/g, '_'));
      try {
        if (stagedBuffers.has(name)) {
          // Already on host (docx/pdf). Copy/rename into place if needed.
          if (stagedBuffers.get(name) !== hostPath) fs.copyFileSync(stagedBuffers.get(name), hostPath);
        } else {
          const buf = await fsx.downloadBuffer(rel);
          fs.writeFileSync(hostPath, buf);
        }
        if (fs.existsSync(hostPath)) {
          // Keep `rel` so the bundler can preserve directory structure inside
          // the delivered zip.
          files.push({ path: hostPath, name: uniqueName, rel: String(rel).replace(/^\.?\/+/, '') });
        }
      } catch (e) { /* a missing/failed file is skipped, not fatal */ }
    }
    // 🎁 Apply the delivery rule (office docs/images individually; everything
    // else → ONE zip; drop agent-made archives). This mirrors agent.py's
    // collect_deliverables so the GitHub-CI-runner (host-loop) path delivers
    // EXACTLY like every other sandbox: no zip-in-zip, no duplicate loose copies.
    outFiles = _bundleDeliverables(files, stageDir);

    // Tear down the isolated sandbox (best-effort).
    try { await fsx.cleanup(); } catch (_) {}

    if (!finalMessage) finalMessage = '✅ Task complete.';
  }
  // Learn only compact per-user behavioural signals and aggregate success — no
  // raw prompt, credentials, file contents, or cross-user data is persisted.
  if (sessionKey) {
    userAdaptation.learn(sessionKey, adaptation, {
      task, success: !!finalMessage && !/^⚠️/.test(finalMessage),
    }).catch(() => {});
  }
  // `workdir` = the host stage dir, which the caller rm -rf's after sending.
  return await stemPublisher.postProcessResult(opts, {
    message: finalMessage, files: outFiles, steps: ctx.step + 1,
    workdir: stageDir, brain: getLastBrain(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BRIDGE for the IN-SANDBOX agent worker (services/sandboxAgent.js + agent.py).
//
// When the agent loop runs INSIDE the user's Daytona sandbox ("agent owns the
// computer" mode), the worker calls back to the Render host for two things:
//   • brainComplete()  — the LLM brain (GPT-5 HotBot + Gemini gateway race),
//   • runHostTool()    — host-only tools (web_search, browse, wolfram, image &
//                        document generation, deploys, etc.). Local tools
//                        (run_code, docker_run, file ops) run in the box and
//                        never hit this bridge.
//
// These reuse the EXACT same brain + tool implementations as runAgent(), so the
// in-sandbox path produces identical results. Both are additive — runAgent()
// and every existing caller are completely untouched.
// ─────────────────────────────────────────────────────────────────────────────

// The canonical agent system prompt (so the worker doesn't have to carry the
// huge prompt itself — it sends "__DEFAULT__" and we substitute it here).
function getAgentSystemPrompt() { return AGENT_SYSTEM_PROMPT; }

// Ask any running in-sandbox task for this session to STOP immediately. Used by
// the Telegram/WhatsApp /stop command. Best-effort: returns true if a stop flag
// was successfully written into the chat's sandbox. Falls back gracefully (the
// bot still clears its busy lock either way).
async function stopAgent(sessionKey) {
  if (!sessionKey) return false;
  try {
    const sandboxAgent = require('./sandboxAgent');
    if (sandboxAgent.requestStop) return await sandboxAgent.requestStop(sessionKey);
  } catch (e) {
    console.error('[agentEngine] stopAgent failed:', e.message);
  }
  return false;
}

// Ask the brain for the next action. `messages` = [{role,text}].
async function brainComplete(systemPrompt, messages) {
  const sys = (systemPrompt && systemPrompt !== '__DEFAULT__') ? systemPrompt : AGENT_SYSTEM_PROMPT;
  const conv = (messages || []).map(m => ({
    role: (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
    text: String(m.text || ''),
  }));
  return geminiComplete(sys, conv);
}

// Run a single HOST-side tool against a specific (already-running) sandbox
// (Runloop OR Daytona — resolved from the active `sandbox_backend`). Returns
// { result, files:[{name,b64}] } — any files the tool produced are read back
// from the sandbox work dir and returned so the worker can place them as
// deliverables. The sandbox is NEVER torn down here (it's the user's persistent
// session sandbox owned by sandboxAgent.js).
async function runHostTool(toolName, args, sandboxId, hooks = {}) {
  const name = String(toolName || '').toLowerCase();
  // Resolve the active backend so the fsx talks to the SAME sandbox the worker
  // lives in (Runloop or Daytona). Falls back to Daytona if resolution fails.
  let backendMod = daytona, backendLabel = 'Daytona';
  try {
    const sandboxAgent = require('./sandboxAgent');
    const active = await sandboxAgent.resolveActiveBackend();
    if (active && active.mod) { backendMod = active.mod; backendLabel = active.label; }
  } catch (_) {}
  // Build a sandbox-backed fsx bound to the EXISTING sandbox id (no create).
  const fsx = makeSandboxFsxForId(sandboxId, backendMod, backendLabel);

  // ── Rehydrate attachments for the CONTENT tools ──────────────────────────
  // analyze_image / analyze_images / read_document / solve_math read the file
  // BYTES from ctx.attachments. In owns-the-computer mode the worker proxies
  // these to us with NO bytes, so we restore them from the per-sandbox registry
  // (populated by sandboxAgent when the task started). If the registry is empty
  // (e.g. the host restarted mid-session), we fall back to downloading the
  // referenced/likely file straight out of the sandbox work dir.
  const CONTENT_TOOLS = new Set(['analyze_image', 'analyze_images', 'read_document', 'solve_math', 'math_solver', 'solve']);
  let attachments = [];
  if (CONTENT_TOOLS.has(name)) {
    const registryKey = String(sandboxId || '');
    const hasCurrentTaskRegistration = _sandboxAttachments.has(registryKey);
    attachments = getSandboxAttachments(sandboxId);
    if (!attachments.length && !hasCurrentTaskRegistration) {
      // Recovery only after a host restart (no current-task registration). An
      // explicitly empty current task must NEVER discover persistent old files.
      // Fallback: pull candidate files from the sandbox work dir.
      try {
        const wanted = String((args && (args.name || args.path)) || '').trim();
        const files = await fsx.list();
        const isImgTool = (name === 'analyze_image' || name === 'analyze_images');
        const matches = files.filter(f => {
          const base = path.posix.basename(f.rel);
          if (/(^|\/)(_step|\.agent_)/.test(f.rel)) return false;
          if (wanted) return base === wanted || base.includes(wanted) || f.rel.includes(wanted);
          return isImgTool ? omniOcr.isImageName(base) : (omniOcr.isImageName(base) || omniOcr.isDocName(base) || /\.(pdf|txt|csv|tsv|md)$/i.test(base));
        }).slice(0, 12);
        for (const f of matches) {
          try {
            const buf = await fsx.downloadBuffer(f.rel);
            if (buf && buf.length) {
              const base = path.posix.basename(f.rel);
              const isImage = omniOcr.isImageName(base);
              attachments.push({ name: base, buffer: buf, isImage, mime: isImage ? _sniffMimeFromBuffer(buf, 'image/png') : _sniffMimeFromBuffer(buf) });
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  const produced = new Map(); // name -> Buffer (host-generated, e.g. docx/pdf/img)
  const explicitDeliveries = []; // files a tool marked for delivery via ctx.addFile(rel, name)
  const ctx = {
    fsx, step: 0, attachments, userKey: 'tg:' + sandboxId,
    taskText: String(hooks.taskText || ''),
    // Stream progress + LIVE screen frames back to the user. In owns-the-computer
    // mode these are wired by the bridge (serviceBridgeOnce) so browse_live and
    // other rich tools stream to the SAME SSE the host loop uses.
    onStep: (typeof hooks.onStep === 'function') ? hooks.onStep : () => {},
    onEvent: (typeof hooks.onEvent === 'function') ? hooks.onEvent : () => {},
    get workdir() { return fsx.workdir; },
    // 🔧 FIX: sandbox addFile was a NO-OP that relied entirely on the
    // before/after size:mtime diff below to capture output files. That silently
    // DROPPED converted files (convert_file → PDF/DOCX/XLSX etc.) whenever the
    // diff missed them — e.g. an output that reuses an existing filename (same
    // size/mtime bucket), or a file the shallow list() didn't surface. When a
    // tool EXPLICITLY marks a file for delivery via addFile(rel, name), we now
    // actively download it and queue it under the requested delivery name, so
    // "conversion doesn't give back the converted file" can no longer happen.
    addFile(rel, name) {
      try {
        const deliverName = String(name || require('path').posix.basename(String(rel)));
        // Defer the actual download until after the tool finishes (the file may
        // still be being written); record the intent so the collector picks it up.
        explicitDeliveries.push({ rel: String(rel), name: deliverName });
      } catch (_) { /* best-effort — diff capture below is still a safety net */ }
    },
    async deliverBuffer(fname, buffer) {
      const safe = String(fname).replace(/[^\w.\-]/g, '_');
      produced.set(safe, buffer);
      try { await fsx.uploadBuffer(safe, buffer); } catch (_) {}
    },
  };

  // Snapshot sandbox files so we can return anything the tool wrote there too.
  const sig = (f) => `${f.size}:${f.mtime || 0}`;
  const before = new Map();
  try { for (const f of await fsx.list()) before.set(f.rel, sig(f)); } catch (_) {}

  let result;
  try {
    // 🔴 AUTO LIVE SCREEN (owns-the-computer bridge) — light up the live sandbox
    // screen the moment the agent browses, so the user can tap LIVE and watch.
    // Best-effort + fire-and-forget; the real host tool runs untouched below.
    try { autoLiveScreen.onBrowseToolBridge(fsx, name, args, ctx.onEvent, ctx.onStep); } catch (_) {}
    result = await dispatchHostTool(name, args, ctx);
  } catch (e) {
    result = `[${name}] host error: ${e.message}`;
  }

  // Collect produced files: host-generated buffers + any new/changed sandbox files.
  const files = [];
  const seen = new Set();
  for (const [n, buf] of produced.entries()) {
    files.push({ name: n, b64: buf.toString('base64') });
    seen.add(n);
  }
  // 1) EXPLICIT deliveries first — files a tool marked via ctx.addFile(rel, name).
  //    This guarantees converted/generated files are returned even when the
  //    size:mtime diff below would miss them (fixes "conversion doesn't give
  //    back the converted file").
  for (const d of explicitDeliveries) {
    try {
      const deliverName = String(d.name || path.posix.basename(d.rel));
      if (seen.has(deliverName)) continue;
      if (!(await fsx.exists(d.rel))) continue;
      const buf = await fsx.downloadBuffer(d.rel);
      if (!buf || !buf.length) continue;
      if (buf.length > 45 * 1024 * 1024) continue;
      files.push({ name: deliverName, b64: buf.toString('base64') });
      seen.add(deliverName);
    } catch (_) { /* best-effort */ }
  }
  // 2) Anything else new/changed in the sandbox (safety net).
  try {
    for (const f of await fsx.list()) {
      if (_isInternalArtifact(f.rel)) continue;
      const base = path.posix.basename(f.rel);
      if (seen.has(base)) continue;
      if (before.get(f.rel) !== sig(f)) {
        if (f.size > 45 * 1024 * 1024) continue;
        try {
          const buf = await fsx.downloadBuffer(f.rel);
          files.push({ name: base, b64: buf.toString('base64') });
          seen.add(base);
        } catch (_) {}
      }
    }
  } catch (_) {}

  return { result: String(result || ''), files };
}

// Dispatch a host-side tool by name (mirror of runAgent's inner dispatchTool,
// limited to the HOST tools — local tools run in the sandbox worker).
async function dispatchHostTool(name, args, ctx) {
  switch (name) {
    case 'list_skills': case 'skills': return toolListSkills();
    case 'read_skill': case 'load_skill': case 'use_skill': return toolReadSkill(args);
    case 'web_search': return await toolWebSearch(args);
    case 'wolfram_alpha': return await toolWolframAlpha(args);
    case 'sequential_thinking': case 'think': case 'reasoning': case 'sequentialthinking':
      return await toolSequentialThinking(args);
    case 'mcp_filesystem': case 'fs': case 'filesystem':
      return await toolMcpFilesystem(args);
    case 'mcp_call': case 'mcp': case 'mcp_tool':
      return await toolMcpCall(args);
    case 'browse': return await toolBrowse(args);
    case 'power_scrape': case 'power_browse': case 'fallback_browse':
      return await toolPowerScrape(args);
    case 'browse_live': case 'live_browse': case 'live_view': case 'live_screen': case 'watch_live':
      return await toolBrowseLive(args, ctx);
    case 'solve_captcha': case 'captcha': case 'bypass_captcha': return await toolSolveCaptcha(args);
    case 'screenshot': return await toolScreenshot(args, ctx);
    case 'read_document': return await toolReadDocument(args, ctx);
    case 'list_files': return await toolListFiles(args, ctx);
    case 'inspect_codebase': case 'codebase_map': return await toolInspectCodebase(args, ctx);
    case 'read_file': return await toolReadFile(args, ctx);
    case 'edit_file': return await toolEditFile(args, ctx);
    case 'make_zip': return await toolMakeZip(args, ctx);
    case 'scan_secrets': return await toolScanSecrets(args, ctx);
    case 'analyze_image': return await toolAnalyzeImage(args, ctx);
    case 'analyze_images': return await toolAnalyzeImage({ ...args, all: args.all === undefined ? true : args.all }, ctx);
    case 'solve_math': case 'math_solver': case 'solve': return await toolSolveMath(args, ctx);
    case 'write_file': return await toolWriteFile(args, ctx);
    case 'create_docx': return await toolCreateDocx(args, ctx);
    case 'create_pdf': return await toolCreatePdf(args, ctx);
    case 'fetch_url': return await manusTools.toolFetchUrl(args, ctx);
    case 'get_market_price': case 'market_price': case 'live_price': case 'get_price': case 'price':
      return await manusTools.toolGetMarketPrice(args, ctx);
    case 'watch_market': case 'market_watch': case 'watch_price': case 'monitor_market': case 'set_alert': case 'price_alert':
      return await manusTools.toolWatchMarket(args, ctx);
    case 'list_watches': case 'my_watches': case 'watches': case 'list_alerts':
      return await manusTools.toolListWatches(args, ctx);
    case 'stop_watch': case 'stop_watches': case 'cancel_watch': case 'unwatch': case 'clear_alerts':
      return await manusTools.toolStopWatch(args, ctx);
    case 'trade_watch': case 'watch_trade': case 'trading_watch': case 'monitor_trade': case 'monitor_trading':
      return await manusTools.toolTradeWatch(args, ctx);
    case 'open_trade': case 'new_trade': case 'trade_open': case 'place_trade': case 'enter_trade': case 'buy': case 'sell': case 'long': case 'short':
      return await manusTools.toolOpenTrade(args, ctx);
    case 'close_trade': case 'trade_close': case 'exit_trade': case 'close_position':
      return await manusTools.toolCloseTrade(args, ctx);
    case 'list_trades': case 'my_trades': case 'trades': case 'open_trades': case 'positions':
      return await manusTools.toolListTrades(args, ctx);
    case 'trade_stats': case 'trading_stats': case 'my_stats': case 'winrate': case 'pnl':
      return await manusTools.toolTradeStats(args, ctx);
    case 'connect_exchange': case 'connect_broker': case 'add_exchange_keys': case 'link_exchange': case 'set_api_keys':
      return await manusTools.toolConnectExchange(args, ctx);
    case 'disconnect_exchange': case 'remove_exchange': case 'unlink_exchange': case 'clear_api_keys':
      return await manusTools.toolDisconnectExchange(args, ctx);
    case 'analyze_market': case 'market_analysis': case 'analyze': case 'ta': case 'technical_analysis': case 'chart_analysis':
      return await manusTools.toolAnalyzeMarket(args, ctx);
    case 'trade_signal': case 'signal': case 'get_signal': case 'setup': case 'find_setup': case 'entry_signal':
      return await manusTools.toolTradeSignal(args, ctx);
    case 'position_size': case 'size': case 'calc_size': case 'lot_size': case 'sizing':
      return await manusTools.toolPositionSize(args, ctx);
    case 'risk_check': case 'check_risk': case 'rr': case 'risk_reward': case 'validate_trade':
      return await manusTools.toolRiskCheck(args, ctx);
    case 'performance_report': case 'performance': case 'report': case 'analytics': case 'my_performance': case 'expectancy':
      return await manusTools.toolPerformanceReport(args, ctx);
    case 'health_check': case 'system_health': case 'bot_health': case 'check_health': case 'diagnostics':
      return await manusTools.toolHealthCheck(args, ctx);
    case 'generate_image': return await manusTools.toolGenerateImage(args, ctx);
    case 'web_image': case 'image_search': case 'find_image': case 'fetch_image': case 'crop_image': case 'get_image':
      return await webImage.toolWebImage(args, ctx);
    case 'edit_image': case 'image_edit': case 'modify_image': case 'inpaint':
      return await preciseImageEdit.toolEditImage(args, ctx);
    case 'host_media': case 'upload_cloudinary': case 'cloudinary_upload': case 'host_image': case 'host_video':
      return await manusTools.toolHostMedia(args, ctx);
    case 'create_chart': return await manusTools.toolCreateChart(args, ctx);
    case 'create_slides': return await manusTools.toolCreateSlides(args, ctx);
    case 'create_presentation': case 'create_pptx': case 'create_powerpoint':
      return await manusTools.toolCreatePresentation(args, ctx);
    case 'run_php': case 'php': case 'exec_php':
      return await manusTools.toolRunPhp(args, ctx);
    case 'convert_file': case 'convert': case 'file_convert':
      return await fileConverter.toolConvertFile(args, ctx);
    case 'browser_action': return await manusTools.toolBrowserAction(args, ctx);
    case 'deploy_site': return await manusTools.toolDeploySite(args, ctx);
    case 'deploy_cloudflare_pages': case 'deploy_pages': case 'deploy_cf':
      return await manusTools.toolDeployCloudflarePages(args, ctx);
    case 'deploy_github': case 'deploy_to_github': case 'push_github':
      return await manusTools.toolDeployGithub(args, ctx);
    case 'deploy_render': case 'push_deploy': case 'deploy_to_render': case 'ship':
      return await toolDeployRender(args, ctx);
    // ── GitHub automation tools (host-proxied for in-sandbox agent) ───────
    case 'github_scan': case 'scan_github': case 'scan_repo':
      return await manusTools.toolGithubScan(args, ctx);
    case 'github_workflow': case 'trigger_workflow': case 'workflow':
      return await manusTools.toolGithubWorkflow(args, ctx);
    case 'github_monitor': case 'monitor_workflow': case 'watch_workflow':
      return await manusTools.toolGithubMonitor(args, ctx);
    case 'github_push': case 'push_code': case 'git_push':
      return await manusTools.toolGithubPush(args, ctx);
    case 'github_apk': case 'apk_build': case 'build_apk': case 'watch_apk':
      return await manusTools.toolGithubApk(args, ctx);
    // ── Enterprise tools (host-proxied for in-sandbox agent) ──────────────
    case 'glob':
      return await enterpriseTools.toolGlob(args, ctx);
    case 'grep':
      return await enterpriseTools.toolGrep(args, ctx);
    case 'bash':
      return await enterpriseTools.toolBash(args, ctx);
    case 'gitclone': case 'git_clone': case 'clone':
      return await enterpriseTools.toolGitClone(args, ctx);
    case 'gitdiff': case 'git_diff':
      return await enterpriseTools.toolGitDiff(args, ctx);
    case 'write':
      return await enterpriseTools.toolWrite(args, ctx);
    case 'read':
      return await enterpriseTools.toolRead(args, ctx);
    case 'edit':
      return await enterpriseTools.toolEdit(args, ctx);
    case 'coding':
      return await enterpriseTools.toolCoding(args, ctx);
    case 'database': case 'db':
      return await enterpriseTools.toolDatabase(args, ctx);
    case 'webshell': case 'web_shell':
      return await enterpriseTools.toolWebshell(args, ctx);
    case 'todo':
      return await enterpriseTools.toolTodo(args, ctx);
    case 'sandbox': case 'sandbox_info':
      return await enterpriseTools.toolSandboxInfo(args, ctx);
    case 'documents': case 'document': case 'docx': case 'pptx': case 'xlsx': case 'pdf':
      return await enterpriseTools.toolDocuments(args, ctx);
    case 'deepseek': case 'ds':
      return await enterpriseTools.toolDeepSeek(args, ctx);
    case 'upload_file': case 'upload': case 'catbox':
      return await enterpriseTools.toolUploadFile(args, ctx);
    default:
      return `[error] Unknown host action "${name}".`;
  }
}

// Build a minimal fsx bound to an EXISTING sandbox id (no create/destroy).
// Backend-agnostic: `backend` is the active sandbox module (runloop.js or
// daytona.js); both expose the same exec/uploadFile/downloadFile/dockerSetup/
// dockerRun interface. Mirrors the read/write/list/exec surface host tools use.
function makeSandboxFsxForId(id, backend, backendLabel) {
  const sb = backend || daytona;
  const label = backendLabel || (sb === runloop ? 'Runloop' : sb === hopx ? 'HopX' : sb === novita ? 'Novita' : sb === codesandbox ? 'CodeSandbox' : sb === tensorlake ? 'Tensorlake' : sb === upstashbox ? 'Upstash Box' : 'Daytona');
  const root = sb.WORKDIR;
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const absPath = (rel) => {
    const clean = path.posix.normalize('/' + (rel || '.')).replace(/^\/+/, '');
    if (clean.startsWith('..')) throw new Error('path traversal blocked');
    return clean === '.' || clean === '' ? root : `${root}/${clean}`;
  };
  return {
    kind: 'sandbox', backend: label, backendMod: sb, workdir: root, sandboxId: id,
    async sh(command, options = {}) {
      const timeout = Math.max(1, Math.min(Number(options.timeout) || 600, 6 * 60 * 60));
      const r = await sb.exec(id, command, { cwd: root, timeout });
      return { exitCode: r.exitCode, output: (r.output || '').slice(0, 12000) || '(no output)' };
    },
    async run(code, lang, step) {
      const name = `_step_${step || 0}.${lang === 'node' ? 'js' : lang === 'bash' ? 'sh' : 'py'}`;
      const runner = lang === 'node' ? `node ${name}` : lang === 'bash' ? `bash ${name}` : `python3 ${name}`;
      const b64 = Buffer.from(code, 'utf-8').toString('base64');
      await sb.exec(id, `printf %s ${shq(b64)} | base64 -d > ${root}/${name}`, { cwd: root, timeout: 120 });
      const r = await sb.exec(id, `${runner} 2>&1`, { cwd: root, timeout: 600 });
      return (r.output || '').slice(0, 12000) || '(no output)';
    },
    async writeText(rel, text) {
      const b64 = Buffer.from(text == null ? '' : String(text), 'utf-8').toString('base64');
      await sb.exec(id, `mkdir -p ${shq(path.posix.dirname(absPath(rel)))} && printf %s ${shq(b64)} | base64 -d > ${shq(absPath(rel))}`, { cwd: root, timeout: 120 });
    },
    async readText(rel) { return (await sb.downloadFile(id, absPath(rel))).toString('utf-8'); },
    async exists(rel) {
      const r = await sb.exec(id, `test -e ${shq(absPath(rel))} && echo yes || echo no`, { cwd: root, timeout: 30 });
      return (r.output || '').includes('yes');
    },
    async list() {
      const r = await sb.exec(id, `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -name '_step*' -printf '%s\\t%T@\\t%p\\n' 2>/dev/null | head -300`, { cwd: root, timeout: 30 });
      const out = [];
      for (const line of (r.output || '').split('\n')) {
        const t1 = line.indexOf('\t'); if (t1 < 0) continue;
        const t2 = line.indexOf('\t', t1 + 1); if (t2 < 0) continue;
        const size = parseInt(line.slice(0, t1), 10) || 0;
        const mtime = parseFloat(line.slice(t1 + 1, t2)) || 0;
        let rel = line.slice(t2 + 1).replace(/^\.\//, '');
        if (rel) out.push({ rel, size, mtime });
      }
      return out;
    },
    async uploadBuffer(rel, buf) { await sb.uploadFile(id, absPath(rel), buf, path.posix.basename(rel)); },
    async downloadBuffer(rel) { return sb.downloadFile(id, absPath(rel)); },
    async docker(dockerArgs, { timeout = 280 } = {}) {
      if (typeof sb.dockerRun !== 'function' || typeof sb.dockerSetup !== 'function') {
        return { exitCode: 1, output: `[docker] the current sandbox backend (${label}) does not support Docker-in-Docker.` };
      }
      try { await sb.dockerSetup(id, {}); } catch (e) { return { exitCode: 1, output: `[docker] setup failed: ${e.message}` }; }
      return sb.dockerRun(id, dockerArgs, { timeout });
    },
    async cleanup() { /* never tear down the persistent session sandbox here */ },
  };
}

// ── PUBLIC: acquire a ready sandbox fsx for one-off host-side use ────────────
// Used by services/brain.js when LOCAL OmniOCR can't run (no python/tesseract
// on the host, e.g. a slim Render image). We spin up an EPHEMERAL sandbox on
// the active backend (HopX / Runloop / Daytona, honouring the admin selection)
// and hand back its fsx so OmniOCR can stage + run the Python engine THERE
// instead of on the host. The caller MUST call fsx.cleanup() when done.
//
// Returns the fsx object, or null if no remote backend is configured/available
// (so the caller can fall back to Gemini vision / JS extractors).
//
// opts: { onStep?, sessionKey? }  — sessionKey reuses a persistent sandbox.
//
// 🔑 RESILIENCE CONTRACT (differs from the agent-execution path):
//   The agent-execution cascade honours the admin's PINNED backend with NO
//   cross-backend fallback (so a deliberate switch is never silently masked).
//   But this function provisions a THROW-AWAY utility box for OCR / file
//   extraction — a transient task that must NEVER fail just because one
//   provider is mid-outage. HopX in particular periodically returns 503
//   "no available nodes". If we only tried the single pinned backend, OCR
//   would die and Render would be forced to do the heavy install on its own
//   tiny host (exactly what we're trying to avoid).
//
//   So here we ALWAYS try the FULL backend cascade: the admin-selected backend
//   FIRST (preserving their preference), then every OTHER configured backend
//   as automatic fallback. Order: <selected> → remaining SANDBOX_ORDER.
async function acquireSandboxFsx(opts = {}) {
  const { onStep = null, sessionKey = null } = opts;

  // Build the resilient order: selected backend first, then the rest.
  let sel = 'auto';
  try { sel = await getSelectedBackendName(); } catch (_) {}
  const order = [];
  if (sel !== 'auto' && SANDBOX_BACKENDS[sel]) order.push(sel);
  for (const n of SANDBOX_ORDER) { if (!order.includes(n) && SANDBOX_BACKENDS[n]) order.push(n); }
  const cascade = order.map(n => ({ name: n, mod: SANDBOX_BACKENDS[n] })).filter(x => x.mod);
  if (!cascade.length) return null;

  const LABELS = { codesandbox: 'CodeSandbox', hopx: 'HopX', runloop: 'Runloop', daytona: 'Daytona', novita: 'Novita', upstashbox: 'Upstash Box', tensorlake: 'Tensorlake', githubactions: 'GitHub Actions' };
  const _isOn = async (mod) => {
    if (!mod) return false;
    try { if (mod.enabledAsync) return !!(await mod.enabledAsync()); } catch (_) {}
    try { return !!mod.enabled(); } catch (_) { return false; }
  };

  let triedAny = false;
  for (const { name, mod } of cascade) {
    if (!(await _isOn(mod))) continue;
    triedAny = true;
    try {
      const fsx = await makeSandboxFsx(onStep, sessionKey, mod, LABELS[name] || name);
      console.log(`[agentEngine] acquireSandboxFsx → ${LABELS[name] || name} (id=${fsx.sandboxId}).`);
      return fsx;
    } catch (e) {
      console.warn(`[agentEngine] acquireSandboxFsx: ${LABELS[name] || name} unavailable, trying next backend:`, e.message);
      if (onStep) { try { onStep(`⚠️ ${LABELS[name] || name} unavailable — trying the next sandbox provider…`); } catch (_) {} }
    }
  }
  if (triedAny) console.warn('[agentEngine] acquireSandboxFsx: ALL configured sandbox backends failed/unavailable.');
  return null; // no remote backend configured / all failed
}

// Acquire a sandbox fsx on a SPECIFIC backend (no cross-backend fallback).
// Used by the live-screen layer (services/autoLiveScreen.js) so browser-use can
// prefer the DAYTONA computer first regardless of the admin's global selection.
// Returns the fsx, or null if that backend isn't configured / failed.
//   backendName: 'daytona' | 'runloop' | 'hopx'
//   opts: { onStep?, sessionKey? }
async function acquireSandboxFsxOn(backendName, opts = {}) {
  const { onStep = null, sessionKey = null } = opts;
  const name = String(backendName || '').trim().toLowerCase();
  const mod = SANDBOX_BACKENDS[name];
  if (!mod) return null;
  const LABELS = { codesandbox: 'CodeSandbox', hopx: 'HopX', runloop: 'Runloop', daytona: 'Daytona', novita: 'Novita', upstashbox: 'Upstash Box', tensorlake: 'Tensorlake', githubactions: 'GitHub Actions' };
  // Only provision if the backend is actually configured (env or admin key).
  let on = false;
  try { if (mod.enabledAsync) on = !!(await mod.enabledAsync()); } catch (_) {}
  if (!on) { try { on = !!mod.enabled(); } catch (_) { on = false; } }
  if (!on) return null;
  try {
    const fsx = await makeSandboxFsx(onStep, sessionKey, mod, LABELS[name] || name);
    console.log(`[agentEngine] acquireSandboxFsxOn(${name}) → ${LABELS[name] || name} (id=${fsx.sandboxId}).`);
    return fsx;
  } catch (e) {
    console.warn(`[agentEngine] acquireSandboxFsxOn(${name}) failed:`, e.message);
    if (onStep) { try { onStep(`⚠️ ${LABELS[name] || name} unavailable for the live screen.`); } catch (_) {} }
    return null;
  }
}


// Cheap probe: is ANY remote sandbox backend configured? (no provisioning)
async function anySandboxConfigured() {
  let cascade;
  try { cascade = await resolveBackendCascade(); } catch (_) { return false; }
  for (const { mod } of (cascade || [])) {
    try { if (mod && mod.enabledAsync && await mod.enabledAsync()) return true; } catch (_) {}
    try { if (mod && mod.enabled && mod.enabled()) return true; } catch (_) {}
  }
  return false;
}

module.exports = {
  runAgent,
  // Sandbox backend selection (used by the admin panel via server.js):
  SANDBOX_BACKENDS, SANDBOX_ORDER, DEFAULT_SANDBOX_BACKEND,
  getSelectedBackendName, resolveBackendCascade,
  // One-off sandbox fsx provisioning (used by services/brain.js OCR fallback):
  acquireSandboxFsx, anySandboxConfigured,
  // Backend-pinned sandbox fsx (used by services/autoLiveScreen.js for the
  // Daytona-first browser-use live screen):
  acquireSandboxFsxOn,
  // In-sandbox agent bridge (used by services/sandboxAgent.js + server.js):
  brainComplete, runHostTool, getAgentSystemPrompt,
  registerSandboxAttachments, getSandboxAttachments,
  // /stop support (used by the Telegram/WhatsApp bots):
  stopAgent,
  // /clearfiles support: wipe a session's sandbox WORK FILES only (keep the
  // sandbox + chat memory). Backend-agnostic; used by both bots.
  clearSessionFiles,
  // Which AI model produced the most recent brain reply (DeepSeek/HotBot/Gemini).
  // The bots append this to outgoing replies so users know which model answered.
  getLastBrain,
  // Exposed for unit testing / reuse:
  _internals: {
    toolListFiles, toolReadFile, toolEditFile, toolMakeZip, toolScanSecrets,
    mdToHtml, buildMathHtml, ensureMathJax, walkDir, parseAction,
    toolWriteFile, toolCreateDocx, toolCreatePdf, pdfWithPdfkit, mdInlineToRuns,
    coerceContent, toolAnalyzeImage,
    extractOfficeText, isOfficeDoc, toolReadDocument,
    _isInternalArtifact, resolveDocContent,
    _bundleDeliverables, _isArchiveDelivery, _deliveryExt, _safeZipEntries,
  },
};
