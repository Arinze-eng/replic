// ─────────────────────────────────────────────────────────────────────────────
// wormgptBot.js — WormGPT Agent (Telegram).
//
// A Manus-style autonomous AI agent that lives inside Telegram. It REUSES the
// website account auth + linking from the old patcher bot (email + password
// verified against the `users` table, stored in `patcher_links`), but the dex /
// ads patching has been completely removed. Instead, after authenticating the
// user can talk to the WormGPT Agent which:
//   • answers ANY question (uncensored — same gateway as the AI-chat section),
//   • analyzes images they send,
//   • browses the web, analyzes PDFs / ZIPs / code,
//   • writes & runs code, edits code,
//   • returns real files (docx / pdf / txt / code) right in the chat.
//
// Bot token: WORMGPT_BOT_TOKEN (falls back to the legacy PATCHER_BOT_TOKEN so
// the existing @appmodding_bot keeps working without re-provisioning).
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const agent = require('./agentEngine');
// 🎵 Shared Spotify downloader — the SAME converter + tiered daily quota the
// website uses (services/spotify.js). Paste a track/album/playlist link and the
// bot returns the file, exactly like the site. Loaded best-effort so a missing
// module never breaks the bot.
let spotifyBot = null;
try { spotifyBot = require('./spotifyBot'); } catch (_) { spotifyBot = null; }
const daytona = require('./daytona');
const latex = require('./latexRender');
const { deliverGeneratedFiles } = require('./botFileDelivery');
const { runWithIdleGuard, positiveMs } = require('./botRunGuard');
// 🦫 "Capy first" wrapper — IDENTICAL to the website/app (server.js) WormGPT AI
// flow: every task is handed to Capy.ai's own cloud sandbox FIRST and polled for
// a long time (up to CAPY_POLL_CEILING_MS, returns files of any type) before any
// fallback. When Capy is off/unconfigured it is a transparent pass-through to
// the in-house engine (agentEngine.runAgent), so behaviour is unchanged unless
// Capy is enabled — exactly like the web. Loaded best-effort so a missing module
// never breaks the bot.
let agentCapyFirst = null;
try { agentCapyFirst = require('./agentCapyFirst'); } catch (_) { agentCapyFirst = null; }
let cloudflareTunnel = null;
try { cloudflareTunnel = require('./cloudflareTunnel'); } catch (_) { cloudflareTunnel = null; }

// ⏰⏱️ Scheduler + time-box parser. Best-effort require so a missing module
// never breaks the bot. start() is called in start() below with a runner that
// re-enters runTask() for the same chat when a scheduled task fires.
let scheduler = null;
try { scheduler = require('./agentScheduler'); } catch (_) { scheduler = null; }

// 📈 Real-time market watch — polls live prices and alerts the user the INSTANT
// a symbol hits TP / SL / a target. Best-effort require so a missing module
// never breaks the bot. The price fetcher (manusTools.getSpot) + notifier runner
// are wired in start() below.
let marketWatch = null;
try { marketWatch = require('./marketWatch'); } catch (_) { marketWatch = null; }
// 📊 Trading engine — PAPER + REAL trades on Binance USDT-M / Bybit perp. It
// watches every OPEN trade 24/7 and fires an INSTANT alert the moment SL/TP is
// hit. Best-effort require + notifier registration in start() (like marketWatch).
let tradingEngine = null;
try { tradingEngine = require('./tradingEngine'); } catch (_) { tradingEngine = null; }
let manusTools = null;
try { manusTools = require('./manusTools'); } catch (_) { manusTools = null; }

// ── Runtime-first bot token (survives redeploys / missing env) ──────────────
// Resolution order at start(): DB setting `wormgpt_bot_token` (admin-settable
// in Supabase) → env WORMGPT_BOT_TOKEN → legacy env PATCHER_BOT_TOKEN. We keep
// API/FILE_API MUTABLE and (re)build them in start() so saving the token in
// Supabase makes THIS codebase claim @appmodding_bot on the next boot WITHOUT a
// code change — which is exactly what stops the old "join our channel" bot from
// holding the token (only ONE process can long-poll a Telegram token at a time).
// ── Telegram API base (supports a LOCAL Bot API server for large files) ──────
// The public Bot API (api.telegram.org) caps `getFile` downloads at 20 MB and
// uploads at 50 MB. To move files up to the requested 100 MB (and beyond, up to
// 2 GB) you point the bot at a self-hosted local Bot API server by setting
// TELEGRAM_API_ROOT (e.g. http://127.0.0.1:8081). We build the API/FILE_API
// from it so raising the limits below actually takes effect there. When unset it
// falls back to the public server (where Telegram still enforces its own caps,
// but the app-side guard is the 100 MB limit the user asked for).
const TG_API_ROOT = (process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
let BOT_TOKEN = process.env.WORMGPT_BOT_TOKEN || process.env.PATCHER_BOT_TOKEN || '';
let API = BOT_TOKEN ? `${TG_API_ROOT}/bot${BOT_TOKEN}` : null;
let FILE_API = BOT_TOKEN ? `${TG_API_ROOT}/file/bot${BOT_TOKEN}` : null;

async function resolveToken() {
  try {
    const runtime = await db.getSetting('wormgpt_bot_token');
    if (runtime && String(runtime).trim()) return String(runtime).trim();
  } catch (_) {}
  return process.env.WORMGPT_BOT_TOKEN || process.env.PATCHER_BOT_TOKEN || '';
}

// ── File-size limits (DOWNLOAD set back to 20 MB per request) ────────────────
// Downloads (files the user sends the bot) are capped at 20 MB to MATCH the
// hard limit Telegram enforces on the PUBLIC api.telegram.org `getFile`
// endpoint. Previously this app-side cap was 100 MB, which let a 50 MB file
// PASS the guard and then fail deep inside getFile with the cryptic
// "Could not fetch file from Telegram" error. Aligning the guard with the real
// 20 MB ceiling means the user now gets a clear, friendly "file too large"
// message UP FRONT instead of a broken download.
//
// To actually move files larger than 20 MB you must run a LOCAL Bot API server
// and set TELEGRAM_API_ROOT (see above) — then raise TG_MAX_DOWNLOAD_BYTES.
// Uploads (files the bot sends back) stay env-tunable; on the public API
// Telegram allows ~50 MB uploads. Both remain env-overridable so an admin can
// tune without a code change once a local Bot API server is in place.
const TG_MAX_DOWNLOAD = parseInt(process.env.TG_MAX_DOWNLOAD_BYTES || String(20 * 1024 * 1024), 10); // 20 MB (public getFile cap)
const TG_MAX_UPLOAD = parseInt(process.env.TG_MAX_UPLOAD_BYTES || String(50 * 1024 * 1024), 10);      // 50 MB (public upload cap)

// Read the admin-configured WormGPT daily-limit overrides from the settings
// store (set in the admin panel → Limits tab). Falls back to db.js defaults
// when unset/invalid. Returns { free, basic } for db.wormgptDailyLimit().
async function wormgptOverrides() {
  const read = async (key, def) => {
    try {
      const raw = await db.getSetting(key);
      const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
      return (Number.isFinite(n) && n >= 0) ? n : def;
    } catch (_) { return def; }
  };
  return { free: await read('limit_wormgpt_free', 5), basic: await read('limit_wormgpt_basic', 50) };
}

// 🪙 Credit knobs (admin-tunable, shared with the website). Returns
// { caps:{free,basic}, costs:{base,step,heavy} }.
// 💸 The cost knobs are scaled by an engine-aware cost-recovery multiplier
// (kept in sync with server.js getCreditCosts):
//   • mode 'capy'   → credit_mult_capy   (default X10 — Capy is the priciest,
//                     most advanced cloud-sandbox AI)
//   • mode 'normal' → credit_mult_normal (default X5 — in-house sandbox)
// The Telegram agent always runs Capy-FIRST, so it defaults to the 'capy' rate.
async function creditConfig(mode = 'capy') {
  const read = async (key, def) => {
    try {
      const raw = await db.getSetting(key);
      const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
      return (Number.isFinite(n) && n >= 0) ? n : def;
    } catch (_) { return def; }
  };
  const base = await read('credit_task_base', 10);
  const step = await read('credit_step_cost', 3);
  const heavy = await read('credit_step_heavy', 6);
  const mCapy = Math.max(1, await read('credit_mult_capy', 10));
  const mNormal = Math.max(1, await read('credit_mult_normal', 5));
  const m = (mode === 'normal') ? mNormal : mCapy;
  return {
    caps: { free: await read('credit_free_cap', 900), basic: await read('credit_basic_cap', 5000) },
    costs: {
      base: Math.round(base * m),
      step: Math.round(step * m),
      heavy: Math.round(heavy * m),
      multiplier: m,
    },
  };
}

// Heavy sandbox tools cost more per step (kept in sync with server.js).
const HEAVY_CREDIT_TOOLS = new Set([
  'run_code', 'docker_run', 'browse', 'browse_live', 'browser_action', 'fetch_url',
  'web_search', 'wolfram_alpha', 'solve_captcha', 'captcha', 'screenshot',
  'generate_image', 'edit_image', 'create_pdf', 'create_docx', 'create_slides',
  'create_presentation', 'create_chart', 'convert_file', 'deploy_site',
  'deploy_cloudflare_pages', 'deploy_github', 'deploy_render', 'host_media',
  'make_zip', 'analyze_image', 'analyze_images', 'solve_math', 'read_document',
]);
function creditStepCost(note, costs) {
  const n = String(note || '').toLowerCase();
  for (const t of HEAVY_CREDIT_TOOLS) { if (n.includes(t)) return costs.heavy; }
  return costs.step;
}

let polling = false;
let offset = 0;
// chatId -> timestamp(ms) while an agent task is running (prevents overlap).
// Storing the START TIME (not just `true`) lets us SELF-HEAL: if a previous run
// wedged (e.g. the sandbox backend hung), the lock auto-expires after
// AGENT_LOCK_TTL_MS so the chat is never bricked with "a task is going on".
const busy = new Map();
// chatId -> AbortController for the currently running task. This cancels Capy
// polling and prevents fallback/result delivery after the user sends /stop.
const activeRuns = new Map();
// Global hard deadline for a single agent run. If runAgent() hangs (a hung
// sandbox backend, dead exec channel, etc.) we abort, tell the user, and ALWAYS
// release the lock — instead of wedging the chat for hours.
//
// 🦫 Capy headroom: because Capy now runs FIRST and is polled for a long time
// (the admin-settable capy_timeout_ms → CAPY_POLL_CEILING_MS, default 30 min)
// before any fallback, the bot's hard deadline must be at least the Capy ceiling
// + the in-house fallback budget, otherwise a legitimate heavy Capy task would
// be killed mid-poll. The effective deadline is now resolved at RUNTIME from the
// admin-settable Capy ceiling (so raising the timeout in the admin panel also
// extends the bot's run-deadline + lock TTL, no redeploy). The constants below
// are only the FALLBACK if the runtime lookup fails / no override is set.
let _capy = null;
try { _capy = require('./capy'); } catch (_) { _capy = null; }
const CAPY_AGENT_CEILING_MS = parseInt(
  process.env.CAPY_AGENT_CEILING_MS || process.env.CAPY_POLL_CEILING_MS || String(30 * 60 * 1000), 10);
const FALLBACK_BUDGET_MS = 5 * 60 * 1000; // in-house fallback chain headroom
const AGENT_RUN_TIMEOUT_MS = parseInt(
  process.env.AGENT_RUN_TIMEOUT_MS || String(CAPY_AGENT_CEILING_MS + FALLBACK_BUDGET_MS), 10); // Capy ceiling + 5 min
const AGENT_LOCK_TTL_MS = parseInt(process.env.AGENT_LOCK_TTL_MS || String(AGENT_RUN_TIMEOUT_MS + 60 * 1000), 10);

// Resolve the effective per-run deadline at call-time from the admin-settable
// Capy ceiling (+ fallback headroom). An explicit AGENT_RUN_TIMEOUT_MS env wins.
async function _resolveRunTimeoutMs() {
  if (process.env.AGENT_RUN_TIMEOUT_MS) return AGENT_RUN_TIMEOUT_MS;
  try {
    if (_capy && typeof _capy.getCeilingMs === 'function') {
      const ceil = await _capy.getCeilingMs();
      if (Number.isFinite(ceil) && ceil > 0) return ceil + FALLBACK_BUDGET_MS;
    }
  } catch (_) { /* fall through */ }
  return AGENT_RUN_TIMEOUT_MS;
}
// Lock TTL = run deadline + 60s. Resolved dynamically so it tracks the timeout.
async function _resolveLockTtlMs() {
  if (process.env.AGENT_LOCK_TTL_MS) return AGENT_LOCK_TTL_MS;
  return (await _resolveRunTimeoutMs()) + 60 * 1000;
}

// Is this chat currently locked by a LIVE (non-expired) run? Uses the largest of
// the static and dynamically-resolved TTL so a long admin-set timeout never lets
// a genuinely-running task be treated as stale, but a wedged run still self-heals.
function isBusy(chatId) {
  const started = busy.get(chatId);
  if (!started) return false;
  const ttl = Math.max(AGENT_LOCK_TTL_MS, busy.get('__ttl__:' + chatId) || 0);
  if (Date.now() - started > ttl) {
    // Stale lock from a wedged previous run — self-heal.
    busy.delete(chatId);
    busy.delete('__ttl__:' + chatId);
    return false;
  }
  return true;
}

async function stopCurrentTask(chatId) {
  const wasBusy = isBusy(chatId);
  const controller = activeRuns.get(chatId);
  if (controller && !controller.signal.aborted) controller.abort();
  try { await agent.stopAgent(memScope(chatId)); } catch (_) {}
  if (!wasBusy) {
    busy.delete(chatId);
    busy.delete('__ttl__:' + chatId);
  }
  return { wasBusy, aborted: !!controller };
}

// Run a promise with a hard deadline. Rejects with a clear error on timeout so
// the caller's finally{} releases the busy lock.
function withRunTimeout(promise, ms, label, onTimeout) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => {
      try { if (typeof onTimeout === 'function') onTimeout(); } catch (_) {}
      rej(new Error((label || 'task') + ' exceeded the time limit (' + Math.round(ms / 60000) + ' min) — the sandbox may be unresponsive. Please try again.'));
    }, ms);
    if (t && t.unref) t.unref();
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// 🧠 Conversational memory is persisted in Supabase (db.wormgpt_memory) and
// auto-expires after 20 minutes. Scope key for the Telegram bot is "tg:<chatId>".
const MEMORY_MAX = 12; // 6 user+assistant exchanges
const memScope = (chatId) => `tg:${chatId}`;

// ─────────────────────────────────────────────────────────────────────────────
// 🔗 SYNCHRONIZATION BUFFER — make "file then message" feel like ONE request.
//
// Telegram delivers a file (document/photo) and its instruction as separate
// updates. Every received or forwarded attachment is held here until the user
// sends a follow-up instruction. We deliberately do NOT infer an action from a
// caption and never auto-analyze on a timer: forwarded captions often describe
// the original post rather than what the current user wants us to do.
// Multiple files sent back-to-back accumulate and are fused with the next
// explicit text instruction. An idle batch expires without entering runTask.
//
//   pending: chatId -> { files:[{name,buffer,isImage,mime}], timer, link, ts }
// ─────────────────────────────────────────────────────────────────────────────
const pending = new Map();
const PENDING_TTL = Math.max(60000, Number(process.env.ATTACHMENT_INTENT_TTL_MS) || 20 * 60 * 1000);

function clearPendingTimer(chatId) {
  const p = pending.get(chatId);
  if (p && p.timer) { clearTimeout(p.timer); p.timer = null; }
}

// Buffer an attachment and expire it safely if no instruction arrives.
// Expiry only releases memory; it never starts an agent task.
function bufferAttachment(chatId, link, attachment) {
  let p = pending.get(chatId);
  if (!p) { p = { files: [], timer: null, link, ts: Date.now() }; pending.set(chatId, p); }
  p.link = link || p.link;
  p.ts = Date.now();
  p.files.push(attachment);
  clearPendingTimer(chatId);
  p.timer = setTimeout(() => {
    const cur = pending.get(chatId);
    if (!cur || !cur.files.length) return;
    pending.delete(chatId);
    send(chatId, '⌛ I did not process the attachment because no instruction was provided. Please send it again and tell me what you want done.').catch(() => {});
  }, PENDING_TTL);
  if (p.timer && p.timer.unref) p.timer.unref();
}

// Pull & clear any buffered attachments for this chat.
function takePending(chatId) {
  const p = pending.get(chatId);
  if (!p) return [];
  clearPendingTimer(chatId);
  pending.delete(chatId);
  return p.files || [];
}

function enabled() { return !!API; }

async function tg(method, body) {
  if (!API) return null;
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    console.error('WormGPT TG api error', method, e.message);
    return null;
  }
}

// Append a small badge showing WHICH AI model produced the reply. The agent
// brain cascades DeepSeek → HotBot → Gemini; `brain` is the display name of the
// one that actually answered (from agentEngine.getLastBrain()). Users always
// see which model replied. Safe no-op when brain is unknown.
const BRAIN_EMOJI = { Cloudflare: '🧠', DeepSeek: '🧠', HotBot: '🔥', Gemini: '✨' };
function withBrainBadge(text, brain) {
  const t = String(text || '');
  if (!brain) return t;
  const emoji = BRAIN_EMOJI[brain] || '🤖';
  if (/🤖 _Answered by /.test(t) || /_Answered by .+_/.test(t)) return t;
  return `${t}\n\n— 🤖 _Answered by ${emoji} ${brain}_`;
}

async function send(chatId, text, extra = {}) {
  if (!chatId) return;
  // Telegram hard-limits messages to 4096 chars; chunk long replies.
  const chunks = [];
  let s = String(text || '');
  while (s.length > 3900) {
    let cut = s.lastIndexOf('\n', 3900);
    if (cut < 2000) cut = 3900;
    chunks.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  chunks.push(s);
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    last = await tg('sendMessage', {
      chat_id: chatId, text: chunks[i],
      parse_mode: 'Markdown', disable_web_page_preview: true,
      ...(i === chunks.length - 1 ? extra : {}),
    });
    // If Markdown parse failed, resend as plain text.
    if (last && last.ok === false) {
      last = await tg('sendMessage', { chat_id: chatId, text: chunks[i], disable_web_page_preview: true, ...(i === chunks.length - 1 ? extra : {}) });
    }
  }
  return last;
}

async function sendChatAction(chatId, action = 'typing') {
  return tg('sendChatAction', { chat_id: chatId, action });
}

function menu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌐 Browse the web', callback_data: 'ex_browse' }, { text: '🧑‍💻 Write code', callback_data: 'ex_code' }],
        [{ text: '📄 Make a report (docx/pdf)', callback_data: 'ex_report' }],
        [{ text: 'ℹ️ What can you do?', callback_data: 'ex_help' }, { text: '🚪 Logout', callback_data: 'logout' }],
      ],
    },
  };
}

function normEmail(e) { return (e || '').toLowerCase().trim(); }

// ── Download a Telegram file (document or photo) to a Buffer ────────────────
async function downloadTelegramFile(fileId) {
  const meta = await tg('getFile', { file_id: fileId });
  if (!meta || !meta.ok || !meta.result?.file_path) {
    // The most common cause here is Telegram's hard 20 MB getFile cap on the
    // PUBLIC Bot API: for files above ~20 MB, getFile itself returns an error
    // (no file_path). Surface a clear, actionable message instead of a generic
    // failure so the user knows it is a size issue, not a bug.
    const desc = (meta && meta.description) ? ` (${meta.description})` : '';
    throw new Error(
      'Could not fetch file from Telegram' + desc +
      '. Files above ~20 MB cannot be downloaded via the public Telegram Bot API — please send a smaller file (up to 20 MB).'
    );
  }
  const url = `${FILE_API}/${meta.result.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('File download failed (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

// ── Send a Buffer back as a document ────────────────────────────────────────
async function sendDocument(chatId, buffer, filename, caption) {
  if (!API) return null;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    form.append('document', buffer, { filename });
    try {
      const r = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
      const body = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
      if (r.ok && body && body.ok !== false) return body;
      last = new Error((body && body.description) || `Telegram HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 700 * attempt));
  }
  console.error(`Telegram sendDocument failed after 3 attempts (${filename}):`, last && last.message);
  return { ok: false, description: last && last.message ? last.message : 'document upload failed' };
}

// ── Send a Buffer back as a photo (used for typeset LaTeX/maths) ────────────
async function sendPhoto(chatId, buffer, caption) {
  if (!API) return null;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) { form.append('caption', caption.slice(0, 1024)); }
  form.append('photo', buffer, { filename: 'math.png' });
  try {
    const r = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
    return await r.json();
  } catch (e) {
    console.error('sendPhoto error', e.message);
    return null;
  }
}

// ── Send a Buffer back as an AUDIO file (used for Spotify MP3 downloads) ─────
// Telegram's sendAudio shows a native player with title/performer metadata and
// still lets the user download the .mp3. Falls back to sendDocument on failure
// (e.g. a track Telegram refuses to treat as audio) so the file always arrives.
async function sendAudio(chatId, buffer, filename, { title, performer, caption } = {}) {
  if (!API) return null;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('audio', buffer, { filename });
  if (title) form.append('title', String(title).slice(0, 64));
  if (performer) form.append('performer', String(performer).slice(0, 64));
  if (caption) form.append('caption', String(caption).slice(0, 1024));
  try {
    const r = await fetch(`${API}/sendAudio`, { method: 'POST', body: form });
    const j = await r.json();
    if (j && j.ok === false) {
      // Telegram rejected it as audio → deliver as a plain document instead.
      return await sendDocument(chatId, buffer, filename, caption);
    }
    return j;
  } catch (e) {
    console.error('sendAudio error', e.message);
    try { return await sendDocument(chatId, buffer, filename, caption); } catch (_) { return null; }
  }
}

// Deliver the agent's textual answer. If it contains LaTeX/maths, render the
// reply to a clean typeset PNG and send it as a photo (with a readable Unicode
// caption) so equations look perfect. Falls back to (cleaned) text otherwise.
async function sendAnswer(chatId, text) {
  const raw = String(text || '');
  if (raw && latex.detectMath(raw)) {
    try {
      const img = await latex.renderMathImage(raw);
      if (img) {
        const readable = latex.toReadableText(raw);
        const caption = readable.length <= 1000 ? readable : '🧮 Rendered answer above.';
        const res = await sendPhoto(chatId, img, caption);
        if (res && res.ok !== false) {
          if (readable.length > 1000) await send(chatId, readable);
          return;
        }
      }
      await send(chatId, latex.toReadableText(raw));
      return;
    } catch (_) { /* fall through */ }
  }
  await send(chatId, raw);
}

async function setState(chatId, fields) { return db.upsertPatcherLink(chatId, fields); }

// ─────────────────────────────────────────────────────────────────────────────
// Run an agent task and deliver the result + any files.
//
// The agent brain is now a single deterministic chain — DeepSeek (PRIMARY) →
// HotBot (GPT-5) → Gemini (fallback; also the vision/file-analysis brain). The
// old Mixture-of-Experts debate has been REMOVED, so each task goes straight to
// the WormGPT Agent which plans, uses tools, runs code in the sandbox, and
// returns the final answer + files.
// ─────────────────────────────────────────────────────────────────────────────

// lock synchronously (storing the start time so it can self-heal), runs the real
// body under a HARD DEADLINE, and ALWAYS releases the lock in finally{}. This
// guarantees a hung sandbox backend can NEVER wedge a chat with a permanent
// "a task is going on" — the worst case is a clear timeout message.
// ─────────────────────────────────────────────────────────────────────────────
async function runTask(chatId, link, task, attachments = [], opts = {}) {
  // Claim the lock synchronously up-front (auto-heals a stale/wedged lock).
  if (isBusy(chatId)) {
    await send(chatId, '⏳ I\'m still working on your previous task — one moment… (it will NOT be restarted; send /stop to cancel it first).');
    return;
  }
  busy.set(chatId, Date.now());
  const controller = new AbortController();
  activeRuns.set(chatId, controller);
  const runOpts = {
    ...opts,
    signal: controller.signal,
    abort: () => {
      if (!controller.signal.aborted) controller.abort();
      agent.stopAgent(memScope(chatId)).catch(() => {});
    },
  };
  let deadlineExpired = false;
  try {
    // Resolve the per-run deadline from the admin-settable Capy ceiling so a
    // long admin timeout doesn't get the task killed early. Track the matching
    // lock TTL for isBusy()'s self-heal.
    let runTimeoutMs = await _resolveRunTimeoutMs();
    // ⏱️ If the user asked for a time-box ("use N minutes"), make sure the hard
    // deadline comfortably exceeds it so the sandbox isn't killed mid-think.
    if (runOpts.minDurationMs && Number.isFinite(runOpts.minDurationMs)) {
      runTimeoutMs = Math.max(runTimeoutMs, runOpts.minDurationMs + 90 * 1000);
    }
    try { busy.set('__ttl__:' + chatId, runTimeoutMs + 60 * 1000); } catch (_) {}
    await withRunTimeout(
      runTaskInner(chatId, link, task, attachments, runOpts),
      runTimeoutMs,
      'Your task',
      () => { deadlineExpired = true; runOpts.abort(); }
    );
  } catch (e) {
    if (deadlineExpired || !controller.signal.aborted) {
      try { await send(chatId, '❌ Task failed: ' + (e && e.message ? e.message : String(e)), menu()); } catch (_) {}
    }
  } finally {
    // ALWAYS free the chat — even if the run threw, was stopped, or timed out.
    if (activeRuns.get(chatId) === controller) activeRuns.delete(chatId);
    busy.delete(chatId);
    busy.delete('__ttl__:' + chatId);
  }
}

// The actual task body. The `busy` lock is held for its whole duration by the
// runTask() wrapper and released in that wrapper's finally{}.
async function runTaskInner(chatId, link, task, attachments = [], opts = {}) {
  // ── 🪙 CREDIT GATE (Free 900/day · Basic 5000/day · Pro & Admin unlimited) ──
  // Enforced here so the Telegram agent shares the SAME credit balance + rules
  // as the website. The sandbox drains credits per step as it works.
  let user = null;
  try { user = await db.getUserById(link.user_id); } catch (_) {}
  if (!user || user.blocked) {
    await send(chatId, '⛔ Your account is not available. Send /logout then /start to re-link, or contact support.');
    return;
  }
  const tier = db.wormgptTierName(user);
  const unlimited = db.wormgptCreditUnlimited(user);
  const { caps, costs } = await creditConfig();
  let creditBalance = Infinity;
  let outOfCredits = false;
  if (!unlimited) {
    const ec = await db.ensureWormgptCredits(user, caps);
    creditBalance = ec.balance;
    const minToStart = costs.base + costs.step;
    if (creditBalance < minToStart) {
      const upsell = tier === 'Free'
        ? 'Subscribe to *Basic* (5,000 credits/day) or *Pro* (unlimited) to keep going.'
        : 'Upgrade to *Pro* (unlimited) for more access.';
      await send(chatId,
        `⚠️ *Out of WormGPT credits* — ${tier} plan has *${creditBalance}* credits left.\n\n${upsell}\n\n🔓 Upgrade here 👉 https://hackerx-v7-d5s4.onrender.com\n\nYour credits renew at midnight.`,
        menu());
      return;
    }
    // Charge the BASE task cost up-front (sandbox is about to spin up).
    try { creditBalance = await db.chargeWormgptCredits(user, costs.base, { job_id: chatId, scope: 'telegram', reason: 'task_base', caps }); } catch (_) {}
    await send(chatId, `🪙 ${tier} plan · ${creditBalance} credits left (draining as the sandbox works).`);
  }

  // Bump last-activity timestamp on patcher_links for the admin Bot Users tab.
  try { await db.upsertPatcherLink(chatId, {}); } catch (_) {}
  // Also update the user's last_seen in the users table (like the website does).
  if (link && link.user_id) { try { await db.updateUser(link.user_id, { last_seen: db.nowISO() }); } catch (_) {} }

  // 🧾 Log this task to the admin activity feed.
  db.logBotActivity({
    user_id: link.user_id, chat_id: chatId, channel: 'telegram',
    action: 'task',
    message_text: task,
    file_name: attachments && attachments.length ? attachments.map(a => a.name).join(', ') : null,
    credits_before: unlimited ? null : creditBalance + costs.base,
    credits_after: unlimited ? null : creditBalance,
    tier,
  }).catch(() => {});

  const jobId = uuidv4();
  await db.createPatchJob({ id: jobId, user_id: link.user_id, chat_id: chatId, mode: 'agent', in_name: task.slice(0, 120), status: 'processing' }).catch(() => {});

  await sendChatAction(chatId, 'typing');
  await send(chatId, '🤖 *WormGPT Agent* is on it…');

  let lastNote = 0;
  let markEngineActivity = () => {};
  const onStep = (note) => {
    // 🪙 Drain credits for this sandbox step (light vs heavy tool).
    if (!unlimited && !outOfCredits) {
      const cost = creditStepCost(note, costs);
      db.chargeWormgptCredits(user, cost, { job_id: jobId, scope: 'telegram', reason: 'step', caps })
        .then((bal) => {
          creditBalance = bal;
          if (bal <= 0 && !outOfCredits) {
            outOfCredits = true;
            if (typeof opts.abort === 'function') opts.abort();
            send(chatId, '🪙 Credits exhausted — the task stopped immediately. Recharge or wait for the daily renewal to continue.').catch(() => {});
          }
        })
        .catch(() => {});
    }
    const now = Date.now();
    _lastActivity = now;                 // 💓 feed the heartbeat watchdog
    // Repeated provider polling is liveness, not actual progress. Do not let it
    // keep a wedged stage alive forever; concrete engine/tool notes reset the
    // inactivity guard.
    if (!/^Capy working…/i.test(String(note || ''))) markEngineActivity();
    if (now - lastNote > 1500) {
      lastNote = now;
      sendChatAction(chatId, 'typing').catch(() => {});
      const badge = unlimited ? '' : ` (🪙 ${creditBalance})`;
      send(chatId, '› ' + note + badge).catch(() => {});
    }
  };

  // 💓 HEARTBEAT WATCHDOG (fixes "heavy task hangs with no feedback at the peak").
  // Long single steps — an APK build, a big install/scan, a slow model call —
  // can run for minutes emitting NO onStep notes, so the user sees silence and
  // Telegram's "typing" indicator (which lasts only ~5s) disappears. This timer
  // keeps the chat alive: every HEARTBEAT_MS it refreshes "typing" and, if
  // nothing has happened for a while, sends a short "still working" reassurance
  // (escalating wording) so the user always knows the agent is alive.
  const HEARTBEAT_MS = parseInt(process.env.BOT_HEARTBEAT_MS || '25000', 10);
  const QUIET_ALERT_MS = parseInt(process.env.BOT_QUIET_ALERT_MS || '45000', 10);
  let _lastActivity = Date.now();
  let _hbCount = 0;
  const _heartbeat = setInterval(() => {
    try {
      // Hard self-terminate cap so a heartbeat can never outlive its task
      // (belt-and-braces on top of clearInterval + unref).
      if (_hbCount > (parseInt(process.env.BOT_HEARTBEAT_MAX || '40', 10))) { clearInterval(_heartbeat); return; }
      sendChatAction(chatId, 'typing').catch(() => {});
      const quietFor = Date.now() - _lastActivity;
      if (quietFor >= QUIET_ALERT_MS) {
        _hbCount++;
        _lastActivity = Date.now();       // throttle so we alert at most once per quiet window
        const secs = Math.round(quietFor / 1000);
        const msg = _hbCount === 1
          ? `⏳ This step has been quiet for ${secs}s. It is still running; automatic recovery will switch engines if it stops making progress.`
          : `⏳ The step is still active. I’m monitoring it and will recover automatically if it stalls.`;
        send(chatId, msg).catch(() => {});
      }
    } catch (_) { /* never let the heartbeat throw */ }
  }, HEARTBEAT_MS);
  if (_heartbeat.unref) _heartbeat.unref();

  // Keep fallback inputs in the function scope. The previous block-scoped
  // declarations disappeared when the primary Capy stage threw, causing the
  // recovery path itself to fail with `taskForAgent is not defined` (followed
  // by `history is not defined` once that first error was fixed).
  const taskForAgent = task;
  let history = [];
  let result;
  try {
    // 🧠 Pull the last 6 chats from Supabase (auto-expires after 20 min).
    try { history = await db.getWormgptMemory(memScope(chatId), MEMORY_MAX); } catch (_) {}

    // 📎 Re-hydrate previously uploaded files when this turn has none.
    //    With PERSISTENT sandbox sessions the files the user sent earlier are
    //    still physically in the agent's working dir, so it can list/read them
    //    directly — no re-upload needed. We keep this Supabase fallback ONLY for
    //    when the sandbox is unavailable (local-host fallback) or persistence is
    //    off, so the bot never regresses to "I can't find the file, resend it".
    if ((!attachments || attachments.length === 0) && !daytona.enabled()) {
      try {
        const prior = await db.getWormgptFiles(memScope(chatId));
        if (prior && prior.length) {
          attachments = prior;
          const names = prior.map(p => p.name).join(', ');
          await send(chatId, `📎 Reusing your previously sent file${prior.length > 1 ? 's' : ''}: ${names}`);
        }
      } catch (_) { /* best-effort */ }
    }

    // 🧠 The WormGPT Agent (DeepSeek primary → HotBot → Gemini fallback) now
    //    handles the task directly. No pre-debate / consensus step.

    // 🗂️ sessionKey ties this run to a PERSISTENT sandbox for this chat, so the
    //    agent's files/state survive between messages.
    // 🦫 Capy FIRST (same as website/app): every task is handed to Capy.ai's own
    //    cloud sandbox and polled for a long time (returns files of any type)
    //    before falling back to the in-house engine. When Capy is off/unconfigured
    //    this is a transparent pass-through to agentEngine.runAgent — identical
    //    behaviour to before. Capy does the task before fall back, and honours the
    //    large CAPY_POLL_CEILING_MS timeout for heavy tasks.
    const engOpts = { task: taskForAgent, attachments, history, onStep, sessionKey: memScope(chatId), source: 'telegram', signal: opts.signal };
    // ⏱️ TIME-BOX: when the user asked me to think for a set duration ("use 5
    // minutes"), pass an absolute deadline so the agent keeps exploring NEW
    // strategies until the time is up instead of finishing early or looping.
    if (opts && opts.minDurationMs && Number.isFinite(opts.minDurationMs)) {
      engOpts.minDurationMs = opts.minDurationMs;
      engOpts.thinkUntilMs = Date.now() + opts.minDurationMs;
    }
    const idleMs = positiveMs(process.env.BOT_ENGINE_IDLE_TIMEOUT_MS, 3 * 60 * 1000);
    result = await runWithIdleGuard(
      async ({ signal, touch }) => {
        markEngineActivity = touch;
        return (
          agentCapyFirst && typeof agentCapyFirst.runAgentCapyFirst === 'function'
            ? agentCapyFirst.runAgentCapyFirst({ ...engOpts, signal }, agent.runAgent)
            : agent.runAgent({ ...engOpts, signal })
        );
      },
      { signal: opts.signal, idleMs, label: 'Primary agent stage' }
    );

  } catch (e) {
    if (opts.signal && opts.signal.aborted) {
      clearInterval(_heartbeat);
      await db.updatePatchJob(jobId, { status: 'error', log: 'Stopped by user' }).catch(() => {});
      return;
    }
    // 🛟 GUARANTEE THE TASK STILL FINISHES. If the Capy-first wrapper itself
    // threw (Capy setup error, ceiling race, etc.) the user must NOT be left
    // with silence — the whole point of "Capy is the head but falls back to the
    // racers to finish" is that SOMETHING always completes. So make one last
    // direct attempt with the in-house engine before reporting failure. This
    // mirrors the WhatsApp behaviour and honours "when Capy head is ON it should
    // still work". Only if THIS also fails do we surface the error.
    try {
      onStep('🤖 Capy path errored — finishing your task with the in-house agent…');
      const fallbackIdleMs = positiveMs(process.env.BOT_FALLBACK_IDLE_TIMEOUT_MS, 3 * 60 * 1000);
      result = await runWithIdleGuard(
        async ({ signal, touch }) => {
          markEngineActivity = touch;
          return agent.runAgent({ task: taskForAgent, attachments, history, onStep, sessionKey: memScope(chatId), source: 'telegram', signal });
        },
        { signal: opts.signal, idleMs: fallbackIdleMs, label: 'Fallback agent stage' }
      );
    } catch (e2) {
      clearInterval(_heartbeat);
      await db.updatePatchJob(jobId, { status: 'error', log: String(e && e.message ? e.message : e) + ' | fallback: ' + String(e2 && e2.message ? e2.message : e2) }).catch(() => {});
      await send(chatId, '❌ Task failed: ' + (e2 && e2.message ? e2.message : (e && e.message ? e.message : String(e2 || e))), menu());
      return;
    }
  }
  // 💓 Task produced a result — stop the heartbeat watchdog now.
  clearInterval(_heartbeat);
  if ((opts.signal && opts.signal.aborted) || (result && result.stopped)) {
    await db.updatePatchJob(jobId, { status: 'error', log: 'Stopped by user' }).catch(() => {});
    return;
  }

  // Send the textual answer (auto-renders LaTeX/maths to a clean image so it
  // looks perfect in chat instead of raw \frac{}{} text).
  // Append a small badge telling the user WHICH AI model produced this reply
  // (DeepSeek / HotBot / Gemini) so it's always clear which brain answered.
  await sendAnswer(chatId, withBrainBadge(result.message || '✅ Done.', result.brain));

  // 🧠 Persist this exchange + any uploaded files to Supabase memory.
  //     Rows auto-delete 20 minutes after creation (pg_cron + read-time prune).
  try {
    await db.saveWormgptMemory(memScope(chatId), 'user', String(task).slice(0, 4000));
    await db.saveWormgptMemory(memScope(chatId), 'model', String(result.message || 'Done.').slice(0, 4000));
    for (const a of (attachments || [])) {
      if (a && a.buffer && a.buffer.length <= 6 * 1024 * 1024) { // cap stored files at 6MB
        await db.saveWormgptFile(memScope(chatId), {
          name: a.name, b64: a.buffer.toString('base64'), mime: a.mime,
        });
      }
    }
  } catch (_) {}

  // Deliver generated artifacts before deleting their temporary workdir. The
  // shared adapter accepts host paths, Buffers, base64 and text artifacts, and
  // treats an API rejection as a real failure instead of silently discarding it.
  const delivery = await deliverGeneratedFiles({
    files: result.files,
    maxBytes: TG_MAX_UPLOAD,
    channel: 'Telegram',
    sendFile: (buffer, name, caption) => sendDocument(chatId, buffer, name, caption),
    sendNotice: (message) => send(chatId, message),
    onFailure: ({ name, reason }) => console.error(`Telegram artifact delivery failed (${name}): ${reason}`),
  });

  // Cleanup only after every send attempt has settled.
  try { if (result.workdir) fs.rmSync(result.workdir, { recursive: true, force: true }); } catch (e) {}

  const deliveredNames = delivery.delivered.join(',').slice(0, 200);
  await db.updatePatchJob(jobId, {
    status: delivery.failed.length ? 'error' : 'done',
    out_name: deliveredNames,
    patches_applied: result.steps || 0,
    log: delivery.failed.length ? `Artifact delivery failed: ${delivery.failed.map(f => `${f.name}: ${f.reason}`).join(' | ')}`.slice(0, 2000) : null,
  }).catch(() => {});
  const finishText = delivery.failed.length
    ? `⚠️ Task finished, but ${delivery.failed.length} file${delivery.failed.length === 1 ? '' : 's'} could not be delivered. The failure was logged; please retry the task.`
    : '✅ Done. Send me another task anytime.';
  await send(chatId, finishText, menu());
}


// ─────────────────────────────────────────────────────────────────────────────
// 🎵 SPOTIFY DOWNLOADER — paste a track / album / playlist link and the bot
// returns the file(s). Uses the SAME converter + tiered daily quota as the
// website (services/spotify.js via services/spotifyBot.js):
//   • Free 2/day · Basic 15/day · Pro & Admin unlimited (album/playlist = 1 use)
// A dedicated per-chat busy lock reuses the agent lock so a Spotify download and
// an agent task never overlap. Every failure is reported cleanly; the quota is
// only charged once file(s) are actually delivered.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSpotify(chatId, link, detected) {
  if (!spotifyBot) {
    await send(chatId, '⚠️ The Spotify downloader is temporarily unavailable.');
    return;
  }
  // Share the agent busy-lock so a download can't overlap a running task.
  if (isBusy(chatId)) {
    await send(chatId, '⏳ I\'m still working on your previous task — one moment…');
    return;
  }
  busy.set(chatId, Date.now());
  try {
    // Enforce the SAME tiered daily quota as the website.
    const quota = await spotifyBot.checkQuota(link.user_id);
    if (!quota.allowed) {
      await send(chatId, quota.message || '⚠️ You cannot download right now.', menu());
      return;
    }

    // 🧾 Log to the admin activity feed (mirrors task/file logging).
    db.logBotActivity({
      user_id: link.user_id, chat_id: chatId, channel: 'telegram',
      action: 'spotify', message_text: `${detected.kind}: ${detected.url}`, file_name: null,
      tier: quota.tier,
    }).catch(() => {});
    try { await db.updateUser(link.user_id, { last_seen: db.nowISO() }); } catch (_) {}
    try { await db.upsertPatcherLink(chatId, {}); } catch (_) {}

    if (detected.kind === 'track') {
      await sendChatAction(chatId, 'upload_document');
      await send(chatId, '🎵 Fetching your track from Spotify…');
      const r = await spotifyBot.fetchTrack(detected.url);
      if (!r.ok) {
        await send(chatId, '❌ ' + (r.error || 'Could not download this track.'), menu());
        return;
      }
      if (r.buffer.length > TG_MAX_UPLOAD) {
        await send(chatId, `⚠️ "${r.filename}" is ${(r.buffer.length / 1024 / 1024).toFixed(1)} MB — larger than Telegram allows (${Math.round(TG_MAX_UPLOAD / 1024 / 1024)} MB).`);
        return;
      }
      await sendAudio(chatId, r.buffer, r.filename, {
        title: r.title, performer: r.artists, caption: `🎵 ${r.title}${r.artists ? ' — ' + r.artists : ''}`,
      });
      await spotifyBot.recordDownload(link.user_id, quota.unlimited);
      const left = quota.unlimited ? 'unlimited' : Math.max(0, quota.remaining - 1);
      await send(chatId, `✅ Done. Downloads left today: *${left}* (${quota.tier}).`, menu());
      return;
    }

    // album / playlist → zip of MP3s (one quota use), just like the website.
    const kind = detected.kind;
    await sendChatAction(chatId, 'upload_document');
    await send(chatId, `🎵 Reading the ${kind} from Spotify and preparing your download… (this can take a moment for large ${kind}s)`);

    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    let total = 0;
    const result = await spotifyBot.fetchCollection(
      kind,
      detected.url,
      (track, buffer) => {
        try { zip.addFile(spotifyBot.collectionTrackName(track, total || 99), buffer); } catch (_) {}
      },
      (meta) => { total = meta.trackCount || 0; }
    );
    if (!result.ok) {
      await send(chatId, '❌ ' + (result.error || `Could not download this ${kind}.`), menu());
      return;
    }
    if (!result.downloaded) {
      await send(chatId, `❌ None of the tracks on this ${kind} could be downloaded. Please try again later.`, menu());
      return;
    }

    const zipName =
      kind === 'album'
        ? `${spotifyBot.safeAlbumName(result.name, result.artistsOrOwner)}.zip`
        : `${spotifyBot.safePlaylistName(result.name, result.artistsOrOwner)}.zip`;
    const out = zip.toBuffer();
    if (out.length > TG_MAX_UPLOAD) {
      await send(chatId,
        `⚠️ The ${kind} ZIP is ${(out.length / 1024 / 1024).toFixed(1)} MB — larger than Telegram's ${Math.round(TG_MAX_UPLOAD / 1024 / 1024)} MB upload cap. ` +
        `Try a smaller ${kind}, or download it on the website: https://hackerx-v7-d5s4.onrender.com/spotify`);
      return;
    }
    const failedNote = result.failed && result.failed.length
      ? `\n⚠️ ${result.failed.length} track(s) were skipped (unavailable).`
      : '';
    await sendDocument(chatId, out, zipName,
      `🎵 ${result.name}${result.artistsOrOwner ? ' — ' + result.artistsOrOwner : ''} · ${result.downloaded}/${result.trackCount} tracks${failedNote}`);
    await spotifyBot.recordDownload(link.user_id, quota.unlimited);
    const left = quota.unlimited ? 'unlimited' : Math.max(0, quota.remaining - 1);
    await send(chatId, `✅ Done. Downloads left today: *${left}* (${quota.tier}).`, menu());
  } catch (e) {
    try { await send(chatId, '❌ Spotify download failed: ' + (e && e.message ? e.message : String(e)), menu()); } catch (_) {}
  } finally {
    busy.delete(chatId);
    busy.delete('__ttl__:' + chatId);
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Message handler
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const username = msg.from?.username || '';

  let link = await db.getPatcherLinkByChat(chatId);

  // /start, /auth, /login
  if (text.startsWith('/start') || text === '/auth' || text === '/login') {
    await setState(chatId, { tg_username: username, state: 'await_email', authed: link?.authed || 0 });
    link = await db.getPatcherLinkByChat(chatId);

    if (link.authed && link.user_id) {
      await setState(chatId, { state: 'ready' });
      await send(chatId,
        `👋 *Welcome back!* You're connected as \`${link.email}\`.\n\n` +
        `I'm *WormGPT Agent* — your autonomous AI. Just send me any task and I'll do it.`, menu());
      return;
    }
    await send(chatId,
      '🤖 *WormGPT Agent — Account Authentication*\n\n' +
      'To use the agent you must sign in with the *same email & password* you use on the website:\n' +
      'https://hackerx-v7-d5s4.onrender.com\n\n' +
      '🆕 *New here?* Open the website above, *create an account*, then come back and use those same credentials to sign in here.\n\n' +
      '👉 Send me your *email* now (the one you registered with):');
    return;
  }

  if (text === '/logout') {
    await setState(chatId, { authed: 0, user_id: null, state: 'idle' });
    takePending(chatId); // drop any held files
    db.clearWormgptMemory(memScope(chatId)).catch(() => {}); // clear conversational memory on logout
    daytona.endSession(memScope(chatId)).catch(() => {}); // destroy the persistent sandbox + its files
    await send(chatId, '🚪 Disconnected. Send /start to authenticate again.');
    return;
  }

  if (text === '/reset' || text === '/clear' || text === '/new') {
    takePending(chatId); // drop any held files
    db.clearWormgptMemory(memScope(chatId)).catch(() => {});
    daytona.endSession(memScope(chatId)).catch(() => {}); // wipe the sandbox so the next task starts clean
    await send(chatId, '🧹 Memory & workspace cleared. Starting a fresh sandbox.', menu());
    return;
  }

  // 🗑️ /clearfiles — wipe ONLY the working-directory files in this chat's
  // sandbox (GitHub Actions / Novita / Daytona / whichever backend is active),
  // keeping the chat memory, auth link and the warm sandbox itself. This is the
  // "clean my workspace so the next task starts empty" control; it is scoped to
  // THIS chat's sandbox id, so it never affects any other user's files.
  if (text === '/clearfiles' || text === '/clearfile' || text === '/wipefiles' || text === '/emptyfiles') {
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    if (isBusy(chatId)) { await send(chatId, '⏳ A task is still running — send /stop first, then /clearfiles.'); return; }
    takePending(chatId); // drop any held files not yet processed
    try {
      const res = await agent.clearSessionFiles(memScope(chatId));
      if (res && res.ok) {
        const n = res.cleared || 0;
        await send(chatId,
          `🗑️ Workspace files cleared${res.backend ? ` (${res.backend})` : ''}${n ? ` — removed ${n} file(s)` : ''}.\n` +
          `Your chat memory is kept. The next task starts with an empty working directory.`, menu());
      } else {
        await send(chatId, `ℹ️ No sandbox files to clear right now${res && res.error ? ` (${res.error})` : ''}. The next task will start clean anyway.`, menu());
      }
    } catch (e) {
      await send(chatId, `⚠️ Could not clear the workspace files: ${e.message}`, menu());
    }
    return;
  }

  // 🧠 /last — recall the most recent task(s) for THIS chat only. Memory is
  // scoped per chat (tg:<chatId>), so a user only ever sees their OWN history —
  // never another user's. This satisfies "remember last tasks".
  if (text === '/last' || text === '/history' || text === '/recall' || text === '/mylast') {
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    let hist = [];
    try { hist = await db.getWormgptMemory(memScope(chatId), 12); } catch (_) { hist = []; }
    const userTurns = (hist || []).filter(h => h.role === 'user');
    if (!userTurns.length) {
      await send(chatId, '🧠 I have no recent tasks on record for you yet. Send me a task and I\'ll remember it here.', menu());
      return;
    }
    const recent = userTurns.slice(-5).reverse();
    const lines = recent.map((h, i) => `${i + 1}. ${String(h.text || h.content || '').slice(0, 140)}`);
    await send(chatId,
      `🧠 *Your last ${recent.length} task${recent.length > 1 ? 's' : ''}* (this chat only):\n\n${lines.join('\n')}\n\n` +
      `Just reply with a follow-up and I'll continue from where we left off.`, menu());
    return;
  }

  if (text === '/help') {
    await send(chatId, helpText(), menu());
    return;
  }

  // 🌐 Authenticated Cloudflare WebSocket tunnel to this chat's sandbox.
  if (cloudflareTunnel && cloudflareTunnel.isStopCommand(text)) {
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    await send(chatId, '🛑 Stopping the Cloudflare tunnel and sleeping its sandbox…');
    const result = await cloudflareTunnel.stop(memScope(chatId)).catch(e => ({ error: e.message }));
    if (result.error) await send(chatId, `⚠️ Could not fully stop the tunnel: ${result.error}`, menu());
    else if (!result.stopped) await send(chatId, 'ℹ️ No Cloudflare tunnel is active for this chat.', menu());
    else await send(chatId, `✅ Tunnel stopped${result.slept ? ' and sandbox put to sleep' : ''}.`, menu());
    return;
  }
  if (cloudflareTunnel && cloudflareTunnel.isStartCommand(text)) {
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    if (isBusy(chatId)) { await send(chatId, '⏳ A task is still running — send /stop first, then start the tunnel.'); return; }
    let provider;
    try { provider = cloudflareTunnel.commandProvider(text); }
    catch (e) { await send(chatId, `⚠️ ${e.message}`, menu()); return; }
    await send(chatId, `⏳ Starting${provider ? ` ${provider}` : ''} sandbox proxy and verifying it through Cloudflare…`);
    try {
      const t = await cloudflareTunnel.start(memScope(chatId), { provider });
      const command = cloudflareTunnel.clientCommand(t);
      await send(chatId,
        `✅ *Cloudflare proxy is active and verified*\n\n` +
        `URL: \`${t.wssUrl}\`\nCloudflare port: *443*\nYour local proxy port: *${t.clientPort}*\n` +
        `Proxy username: \`${t.username}\`\nProxy password: \`${t.password}\`\n\n` +
        `1. Install the client:\n\`curl -fsSL https://hackerx-v7-d5s4.onrender.com/install-proxy-client.sh | sh\`\n` +
        `2. Run:\n\`${command}\`\n` +
        `3. Set your HTTP/HTTPS proxy to \`127.0.0.1:${t.clientPort}\` with the username and password above.\n\n` +
        `Send /stopcloudflare when finished.`, menu());
    } catch (e) {
      await send(chatId, `❌ Cloudflare tunnel did not pass verification: ${e.message}`, menu());
    }
    return;
  }

  // 🪙 /credits — show the user's current WormGPT credit balance + tier.
  if (text === '/credits' || text === '/balance' || text === '/credit') {
    if (!link) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    let user = null;
    try { user = await db.getUserById(link.user_id); } catch (_) {}
    if (!user) { await send(chatId, '⛔ Account not found. Send /logout then /start.'); return; }
    const tier = db.wormgptTierName(user);
    if (db.wormgptCreditUnlimited(user)) {
      await send(chatId, `🪙 *WormGPT Credits*\n\nPlan: *${tier}*\nBalance: *Unlimited* ∞`, menu());
      return;
    }
    const { caps } = await creditConfig();
    const { balance, cap } = await db.ensureWormgptCredits(user, caps);
    const spent = await db.getWormgptLifetimeSpent(link.user_id);
    await send(chatId,
      `🪙 *WormGPT Credits*\n\nPlan: *${tier}*\nBalance: *${balance}* / ${cap} (renews daily)\nLifetime spent: ${spent}\n\nCredits drain as the sandbox works on your tasks. Upgrade for more: https://hackerx-v7-d5s4.onrender.com`,
      menu());
    return;
  }

  // 🛑 STOP — halt whatever the agent is currently doing in the sandbox.
  // Works even while a task is running: this message is delivered by the poll
  // loop concurrently, we drop the stop flag (the in-sandbox worker checks it
  // between steps AND mid-command), and we release the per-chat busy lock so the
  // user is never wedged. Safe to call when nothing is running.
  // /stop & /halt → stop the CURRENT running task only (schedules untouched).
  if (/^\/(stop|halt)(?:@\w+)?(?:\s|$)/i.test(text)) {
    const wasBusy = isBusy(chatId);
    await send(chatId, wasBusy ? '🛑 Stopping the running task…' : 'ℹ️ Nothing is running right now — but I cleared any stuck state.');
    await stopCurrentTask(chatId);
    clearPendingTimer(chatId);
    takePending(chatId);          // drop any buffered files
    await send(chatId, '✅ Stopped. Send me a new task whenever you’re ready. (Your scheduled tasks are still set — use /cancelall to clear those.)', menu());
    return;
  }

  // 🚫 /cancelall — cancel EVERY scheduled task for this chat AND stop the
  // running one. This is the "ability to /cancel all task schedule" the product
  // requires. /cancel is a friendly alias that does the same.
  if (text === '/cancelall' || text === '/cancel_all' || text === '/cancel' || text === '/clearschedule' || text === '/clearschedules') {
    // Stop any running task first.
    const wasBusy = isBusy(chatId);
    if (wasBusy) { try { await agent.stopAgent(memScope(chatId)); } catch (_) {} }
    busy.delete(chatId);
    busy.delete('__ttl__:' + chatId);
    clearPendingTimer(chatId);
    takePending(chatId);
    let removed = 0;
    if (scheduler) { try { removed = await scheduler.cancelAll(chatId); } catch (_) {} }
    await send(chatId,
      `✅ Cancelled ${removed} scheduled task${removed === 1 ? '' : 's'}` +
      (wasBusy ? ' and stopped the running task.' : '.') +
      '\n\nSend me a new task whenever you’re ready.', menu());
    return;
  }

  // 📅 /schedules — list this chat's pending scheduled tasks.
  if (text === '/schedules' || text === '/schedule' || text === '/scheduled') {
    if (!scheduler) { await send(chatId, 'ℹ️ Scheduling is not available right now.'); return; }
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    let items = [];
    try { items = await scheduler.list(chatId); } catch (_) { items = []; }
    let offMin = scheduler.DEFAULT_TZ_OFFSET_MIN;
    try { offMin = await scheduler.getChatOffsetMin(chatId); } catch (_) {}
    if (!items.length) {
      await send(chatId,
        `📅 You have no scheduled tasks.\n\nYour timezone: *${scheduler.offsetLabel(offMin)}* (default UTC+1 — say "set timezone to +2" to change).\n\nTo schedule one, just tell me *when* in your task, e.g.:\n` +
        '_"in 30 minutes, summarize today\'s AI news"_\n_"at 6pm, generate the daily report"_\n_"tomorrow at 9am, check my website and email me the status"_', menu());
      return;
    }
    const lines = items.map((s, i) =>
      `${i + 1}. ${scheduler.humanizeWhen(s.fireAt, s.offsetMin != null ? s.offsetMin : offMin)} — ${String(s.task).slice(0, 90)}${s.task.length > 90 ? '…' : ''}`);
    await send(chatId,
      `📅 *Your scheduled tasks (${items.length})* · timezone ${scheduler.offsetLabel(offMin)}:\n\n${lines.join('\n')}\n\nSend /cancelall to clear them all.`, menu());
    return;
  }

  // 📈 /watches — list this chat's active real-time market watches.
  if (text === '/watches' || text === '/watch' || text === '/alerts') {
    if (!marketWatch) { await send(chatId, 'ℹ️ Market watching is not available right now.'); return; }
    if (!link || !link.authed) { await send(chatId, '🔐 Please authenticate first — send /start.'); return; }
    let items = [];
    try { items = await marketWatch.list(chatId); } catch (_) { items = []; }
    if (!items.length) {
      await send(chatId,
        '📈 You have no active market watches.\n\nTo start one, just tell me what to watch, e.g.:\n' +
        '_"watch XAUUSD and alert me when it hits TP 2650 or SL 2600"_\n' +
        '_"monitor BTC, notify me if it goes above 70000 or below 64000"_\n' +
        '_"keep an eye on EURUSD, ping me at 1.0950"_\n\n' +
        'I check the live price every ~45s and message you the INSTANT a level is hit. 🔔', menu());
      return;
    }
    const wl = items.map((w, i) => `${i + 1}. ${marketWatch.describe(w)}`);
    await send(chatId,
      `📈 *Your live market watches (${items.length}):*\n\n${wl.join('\n')}\n\nSend /stopwatch to clear them all.`, menu());
    return;
  }

  // 🛑 /stopwatch — cancel ALL active market watches for this chat.
  if (text === '/stopwatch' || text === '/stopwatches' || text === '/unwatch' || text === '/clearwatches' || text === '/stopalerts') {
    if (!marketWatch) { await send(chatId, 'ℹ️ Market watching is not available right now.'); return; }
    let removed = 0;
    try { removed = await marketWatch.stopAll(chatId); } catch (_) {}
    await send(chatId, `✅ Cancelled ${removed} market watch${removed === 1 ? '' : 'es'}.`, menu());
    return;
  }

  if (!link) {
    await send(chatId, '👋 Welcome to *WormGPT Agent*. Send /start to begin.');
    return;
  }

  // ── Auth: awaiting email ──
  if (link.state === 'await_email') {
    const email = normEmail(text);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      await send(chatId, '⚠️ That doesn\'t look like a valid email. Please send the email you registered with:');
      return;
    }
    await setState(chatId, { email, state: 'await_password' });
    await send(chatId, '🔑 Got it. Now send your *password*:');
    return;
  }

  // ── Auth: awaiting password ──
  if (link.state === 'await_password') {
    const password = text;
    try { await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }); } catch (_) {}

    const user = await db.getUserByEmail(link.email).catch(() => null);
    if (!user) {
      await setState(chatId, { state: 'await_email' });
      await send(chatId, '❌ No account found with that email on the website. Sign up first at https://hackerx-v7-d5s4.onrender.com then send your email again.');
      return;
    }
    if (user.blocked) {
      await setState(chatId, { state: 'idle' });
      await send(chatId, '⛔ This account is blocked. Contact support.');
      return;
    }
    const ok = (() => { try { return bcrypt.compareSync(password, user.password); } catch { return false; } })();
    if (!ok) {
      await setState(chatId, { state: 'await_password' });
      await send(chatId, '❌ Incorrect password. Please send your password again:');
      return;
    }

    await setState(chatId, { authed: 1, user_id: user.id, email: user.email, state: 'ready' });
    await send(chatId,
      `✅ *Connected!* Signed in as \`${user.email}\`.\n\n` +
      `Your website account now shows as *linked*.\n\n` +
      `I'm *WormGPT Agent* — send me ANY task and I'll do it end-to-end. 👇`, menu());
    return;
  }

  // Must be authed beyond this point
  if (!link.authed || !link.user_id) {
    await send(chatId, '🔐 Please authenticate first — send /start.');
    return;
  }

  // ── Authenticated: treat any text as an agent task ──
  if (!text) {
    await send(chatId, 'Send me a task (text), an image to analyze, or a file (PDF / ZIP / code) to work on.', menu());
    return;
  }

  // 🎵 SPOTIFY: if the message contains a Spotify track/album/playlist link,
  // download it directly (same converter + tiered quota as the website) instead
  // of routing it through the slow agent loop. This is what makes "paste a link
  // → get the file" work exactly like the site.
  if (spotifyBot) {
    const detected = spotifyBot.detectSpotifyLink(text);
    if (detected) {
      // Drop any buffered attachments — a Spotify link is a standalone action.
      takePending(chatId);
      await handleSpotify(chatId, link, detected);
      return;
    }
  }

  // 🔗 SYNC: if the user just sent file(s) without a caption and now typed the
  // instruction, fuse them into ONE task so file + message are treated together.
  const buffered = takePending(chatId);

  // 📈 REAL-TIME MARKET WATCH DETECTION. If the user asks me to WATCH a symbol
  // and alert them at TP/SL/a level ("watch XAUUSD, alert me at TP 2650 SL 2600"),
  // register a live price watch INSTEAD of a one-shot scheduled task. The ticker
  // polls the price every ~45s and messages this chat the instant a leg is hit.
  if (marketWatch && !buffered.length) {
    try {
      const w = marketWatch.parseWatch(text);
      if (w && w.symbol && ((w.targets && w.targets.length) || w.feedback)) {
        const entry = await marketWatch.add(chatId, w.symbol, w.targets || [], { interval: w.interval, feedback: true, feedbackMs: w.feedbackMs, feedbackMovePct: w.feedbackMovePct });
        const legs = (entry.targets || []).map(l => `${l.label} ${marketWatch._fmt(l.price)}`).join(', ');
        const fbMin = Math.round((entry.feedbackMs || 300000) / 60000);
        await send(chatId,
          `📈 *Live watch armed* — I'm now monitoring *${entry.symbol}* in real time (rechecked every ~45s).\n\n` +
          (legs ? `🔔 Alert legs: ${legs}\n` : `🔁 Mode: live price feedback (no fixed target)\n`) +
          (entry.startPrice != null ? `💲 Current price: ${marketWatch._fmt(entry.startPrice)} (${entry.startSrc || 'live'})\n` : '') +
          `\n🔁 I'll also send you a price update every ~${fbMin} min and the INSTANT the price moves — plus an immediate alert if any level is hit, even if you're offline.\n` +
          `Send /watches to review or /stopwatch to cancel.`, menu());
        return;
      }
    } catch (e) {
      if (/active market watches/.test(e.message || '')) { await send(chatId, '⚠️ ' + e.message, menu()); return; }
    }
  }

  // ⏰⏱️ SCHEDULE + TIME-BOX DETECTION.
  //   • If the message names a future time ("at 6pm", "in 30 min", "tomorrow
  //     9am") we STORE it as a scheduled task and fire it then — instead of
  //     running now. Attachments accompany the scheduled task where present.
  //   • Otherwise we detect a requested working duration ("use 5 minutes") and
  //     pass it through so the agent keeps thinking until the time is up.
  let minDurationMs = 0;
  if (scheduler) {
    // 🌍 TIMEZONE: default is UTC+1 (WAT). If THIS message sets a timezone
    // ("set timezone to +2", "use EST", "tz WAT") we persist it for this chat.
    // A pure timezone message (no task/schedule) just confirms the change.
    let chatOffset = scheduler.DEFAULT_TZ_OFFSET_MIN;
    try { chatOffset = await scheduler.getChatOffsetMin(chatId); } catch (_) {}
    try {
      const tz = scheduler.parseTimezone(text);
      if (tz) {
        chatOffset = await scheduler.setChatOffsetMin(chatId, tz.offsetMin);
        // If the message ONLY set a timezone (no schedulable time in it), confirm & stop.
        if (!scheduler.parseSchedule(text, chatOffset)) {
          await send(chatId,
            `🌍 Timezone set to *${scheduler.offsetLabel(chatOffset)}*.\n` +
            `All your scheduled tasks will now use this time. (Default is UTC+1.)`, menu());
          return;
        }
      }
    } catch (_) {}

    try {
      const sched = scheduler.parseSchedule(text, chatOffset);
      if (sched && sched.fireAt) {
        // Fold in any duration so a scheduled task can ALSO be time-boxed.
        const dur = scheduler.parseDuration(text);
        // Scheduled tasks can't carry file buffers across a redeploy, so if the
        // user attached files we tell them it runs now WITH the files instead.
        if (buffered.length) {
          await send(chatId, `📎 I'll use your file${buffered.length > 1 ? 's' : ''} now (scheduled tasks can't hold files). Running immediately.`);
        } else {
          const entry = await scheduler.add(chatId, sched.cleanTask || text, sched.fireAt, { minDurationMs: dur, offsetMin: sched.offsetMin });
          await send(chatId,
            `⏰ Scheduled! I'll run this ${scheduler.humanizeWhen(entry.fireAt, sched.offsetMin)}:\n\n_"${String(entry.task).slice(0, 200)}"_\n\n` +
            `Send /schedules to see all scheduled tasks, or /cancelall to clear them.`, menu());
          return;
        }
      }
    } catch (e) {
      // A scheduling failure (e.g. too many schedules) is surfaced, not swallowed.
      if (/scheduled tasks/.test(e.message || '')) { await send(chatId, '⚠️ ' + e.message, menu()); return; }
    }
    try { minDurationMs = scheduler.parseDuration(text) || 0; } catch (_) { minDurationMs = 0; }
    if (minDurationMs) {
      await send(chatId, `⏱️ Got it — I'll keep working and improving for about ${Math.round(minDurationMs / 60000)} min, exploring new angles until then.`);
    }
  }

  if (buffered.length) {
    const names = buffered.map(f => f.name).join(', ');
    await send(chatId, `📎 Got it — using your file${buffered.length > 1 ? 's' : ''} (${names}) with this instruction.`);
    await runTask(chatId, link, text, buffered, { minDurationMs });
    return;
  }

  await runTask(chatId, link, text, [], { minDurationMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// Photo handler → buffer (sync with the next message) or act on caption.
// ─────────────────────────────────────────────────────────────────────────────
async function handlePhoto(msg) {
  const chatId = String(msg.chat.id);
  const link = await db.getPatcherLinkByChat(chatId);
  if (!link || !link.authed || !link.user_id) {
    await send(chatId, '🔐 Please authenticate first — send /start.');
    return;
  }
  const photos = msg.photo || [];
  const best = photos[photos.length - 1];
  if (!best) return;
  if (best.file_size && best.file_size > TG_MAX_DOWNLOAD) {
    await send(chatId, `⚠️ That image is too large (max ${Math.round(TG_MAX_DOWNLOAD / 1024 / 1024)} MB).`);
    return;
  }
  await sendChatAction(chatId, 'typing');
  let buf;
  try { buf = await downloadTelegramFile(best.file_id); }
  catch (e) { await send(chatId, '❌ Could not download the image: ' + e.message); return; }

  const attachment = { name: 'image.jpg', buffer: buf, isImage: true, mime: 'image/jpeg' };
  const caption = (msg.caption || '').trim();

  // 🧾 Log the image upload to the admin activity feed.
  db.logBotActivity({
    user_id: link.user_id, chat_id: chatId, channel: 'telegram',
    action: 'file_upload', message_text: caption || '(image, no caption)', file_name: 'image.jpg',
    tier: null,
  }).catch(() => {});

  // Always wait for a separate instruction. A forwarded image can carry the
  // original sender's caption, which must never be mistaken for user intent.
  const first = !(pending.get(chatId) && pending.get(chatId).files.length);
  attachment.receivedCaption = caption || null;
  bufferAttachment(chatId, link, attachment);
  if (first) {
    await send(chatId, '🖼️ I received your image. What would you like me to do with it? I will wait for your instruction before analyzing or editing it.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Document handler → buffer (sync with the next message) or act on caption.
// ─────────────────────────────────────────────────────────────────────────────

// Extract a downloadable file descriptor from ANY file-bearing message type.
// Telegram delivers forwarded/sent files under different keys depending on the
// original type: document, video, audio, voice, video_note, animation, sticker.
// Previously only `document` (and photo) were handled, so a FORWARDED video/
// audio/voice/gif silently fell through to the text handler and Capy never saw
// it. This normalizes them all into a single {file_id, file_name, mime, size}.
function extractTelegramFile(msg) {
  if (!msg) return null;
  // Order matters: prefer the most "document-like" fields first.
  if (msg.document) {
    const d = msg.document;
    return { file_id: d.file_id, file_name: d.file_name || 'file', mime: d.mime_type || '', size: d.file_size };
  }
  if (msg.video) {
    const v = msg.video;
    return { file_id: v.file_id, file_name: v.file_name || 'video.mp4', mime: v.mime_type || 'video/mp4', size: v.file_size };
  }
  if (msg.animation) {
    const a = msg.animation;
    return { file_id: a.file_id, file_name: a.file_name || 'animation.mp4', mime: a.mime_type || 'video/mp4', size: a.file_size };
  }
  if (msg.audio) {
    const a = msg.audio;
    const ext = /mpeg|mp3/i.test(a.mime_type || '') ? 'mp3' : (a.file_name ? '' : 'audio');
    return { file_id: a.file_id, file_name: a.file_name || (ext ? `audio.${ext}` : 'audio'), mime: a.mime_type || 'audio/mpeg', size: a.file_size };
  }
  if (msg.voice) {
    const v = msg.voice;
    return { file_id: v.file_id, file_name: 'voice.ogg', mime: v.mime_type || 'audio/ogg', size: v.file_size };
  }
  if (msg.video_note) {
    const v = msg.video_note;
    return { file_id: v.file_id, file_name: 'video_note.mp4', mime: 'video/mp4', size: v.file_size };
  }
  if (msg.sticker) {
    const s = msg.sticker;
    const isAnim = s.is_animated || s.is_video;
    return { file_id: s.file_id, file_name: isAnim ? 'sticker.webm' : 'sticker.webp', mime: isAnim ? 'video/webm' : 'image/webp', size: s.file_size };
  }
  return null;
}

async function handleDocument(msg) {
  const chatId = String(msg.chat.id);
  const file = extractTelegramFile(msg);
  if (!file || !file.file_id) return;
  const link = await db.getPatcherLinkByChat(chatId);
  if (!link || !link.authed || !link.user_id) {
    await send(chatId, '🔐 Please authenticate first — send /start.');
    return;
  }
  const name = file.file_name || 'file';
  if (file.size && file.size > TG_MAX_DOWNLOAD) {
    await send(chatId, `⚠️ ${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the bot accepts files up to ${Math.round(TG_MAX_DOWNLOAD / 1024 / 1024)} MB.`);
    return;
  }
  await sendChatAction(chatId, 'typing');
  let buf;
  try { buf = await downloadTelegramFile(file.file_id); }
  catch (e) { await send(chatId, '❌ Could not download the file: ' + e.message); return; }

  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || /^image\//.test(file.mime || '');
  const attachment = { name, buffer: buf, isImage, mime: file.mime || (isImage ? 'image/jpeg' : 'application/octet-stream') };
  const caption = (msg.caption || '').trim();

  // 🧾 Log the document upload to the admin activity feed.
  db.logBotActivity({
    user_id: link.user_id, chat_id: chatId, channel: 'telegram',
    action: 'file_upload', message_text: caption || '(document, no caption)', file_name: name,
    tier: null,
  }).catch(() => {});

  // Always wait for a separate instruction. This applies equally to sent and
  // forwarded documents, images and ZIPs, even when Telegram includes a caption.
  const first = !(pending.get(chatId) && pending.get(chatId).files.length);
  attachment.receivedCaption = caption || null;
  bufferAttachment(chatId, link, attachment);
  if (first) {
    await send(chatId, `📎 I received *${name}*. What would you like me to do with it? I will not open, analyze, extract, or modify it until you send an instruction. You can send more files first.`);
  }
}


function helpText() {
  return '🤖 *WormGPT Agent — what I can do*\n\n' +
    '• Answer ANY question (uncensored)\n' +
    '• 🌐 Browse the web & research\n' +
    '• 🖼️ Analyze images you send\n' +
    '• 📄 Read & analyze PDFs, ZIPs and code files (just send them)\n' +
    '• 🧑‍💻 Write, edit and RUN code\n' +
    '• 📑 Produce real files back: *.docx*, *.pdf*, *.txt*, code\n' +
    '• 🎵 Download Spotify music — paste a *track, album or playlist* link and I will send the MP3(s)\n\n' +
    '🧠 I remember our last 6 chats for context, and my workspace is *persistent* — files you send or I create stay in my sandbox across messages, so you never have to re-send them. Your memory & files are *private to this chat* — no one else can see them. Send */last* to see your recent tasks, */clearfiles* to wipe just the workspace files (keeps your memory), or /reset to wipe both memory and the workspace.\n\n' +
    '🖥️ While I work you’ll see my *live sandbox terminal* stream right here. If I ever get stuck or you want to cut a run, send */stop* to halt me instantly.\n\n' +
    '🌐 *Sandbox Internet tunnel:* send */cloudflare* (or */cloudflare novita|upstash|runloop|tensorlake*) for a verified Cloudflare URL and local proxy port. Send */stopcloudflare* to close it and sleep the sandbox.\n\n' +
    '⏱️ *Think for a set time:* say _"use 5 minutes to research X"_ and I\'ll keep exploring new angles and improving until the time is up (never looping).\n\n' +
    '⏰ *Schedule a task:* just tell me *when* — _"in 30 minutes, …"_, _"at 6pm, …"_, _"tomorrow at 9am, …"_. Times use *UTC+1* by default — say _"set timezone to +2"_ or _"use EST"_ to change it. Send */schedules* to list them, */cancelall* to clear all scheduled tasks.\n\n' +
    '📈 *Watch the market:* _"watch XAUUSD, alert me at TP 2650 SL 2600"_ or _"monitor BTC and give me feedback when the price changes"_. I recheck the live price every ~45s, send you periodic price updates, and alert you the INSTANT a level is hit. Send */watches* to review, */stopwatch* to cancel.\n\n' +
    '🪙 *Credits:* Free daily credits · Basic = 5,000/day · Pro = unlimited. Credits drain as the sandbox works. Send */credits* to check your balance.\n\n' +
    'Just type a task, or attach a file / image. Examples:\n' +
    '_"Research the top 5 AI trends in 2026 and write me a docx report"_\n' +
    '_"Write a Python script that scrapes a site and run it"_\n' +
    '_"Summarize this PDF"_ (then attach it)';
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback queries (inline buttons)
// ─────────────────────────────────────────────────────────────────────────────
async function handleCallback(cq) {
  const chatId = String(cq.message.chat.id);
  const data = cq.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cq.id });

  const link = await db.getPatcherLinkByChat(chatId);
  if (!link || !link.authed || !link.user_id) {
    await send(chatId, '🔐 Please authenticate first — send /start.');
    return;
  }
  if (data === 'logout') {
    await setState(chatId, { authed: 0, user_id: null, state: 'idle' });
    db.clearWormgptMemory(memScope(chatId)).catch(() => {}); // clear conversational memory on logout
    daytona.endSession(memScope(chatId)).catch(() => {}); // destroy the persistent sandbox + its files
    await send(chatId, '🚪 Disconnected. Send /start to authenticate again.');
    return;
  }
  if (data === 'ex_help') { await send(chatId, helpText(), menu()); return; }
  if (data === 'ex_browse') { await send(chatId, '🌐 Send me what to research, e.g. _"Browse the latest AI news and summarize it"_.'); return; }
  if (data === 'ex_code') { await send(chatId, '🧑‍💻 Tell me what to build, e.g. _"Write a Python script that generates 10 strong passwords and run it"_.'); return; }
  if (data === 'ex_report') { await send(chatId, '📄 Tell me the topic, e.g. _"Write a 1-page docx report on quantum computing"_.'); return; }
}

// ── Raw update dispatcher (routes ONE update to its handler) ────────────────
async function dispatchUpdate(update) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return;
    if (msg.photo) return await handlePhoto(msg);
    // Any file-bearing type (document, video, audio, voice, video_note,
    // animation, sticker) → treated as a document so FORWARDED files of every
    // kind reach Capy. Previously only `document` was routed here, so forwarded
    // videos/audio/voice/gifs fell through to the text handler and were dropped.
    if (msg.document || msg.video || msg.audio || msg.voice ||
        msg.video_note || msg.animation || msg.sticker) {
      return await handleDocument(msg);
    }
    return await handleMessage(msg);
  } catch (e) {
    console.error('WormGPT dispatchUpdate error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔗 PER-CHAT SERIAL QUEUE — "file then message" is treated as ONE request.
//
// THE BUG THIS FIXES: the poll loop dispatched every update CONCURRENTLY
// (`handleUpdate(upd).catch(...)` with no await). So when a user sent a FILE and
// then quickly typed an INSTRUCTION, the two updates raced:
//   • the document handler was still DOWNLOADING the file (slow, async) and had
//     not yet buffered it, while
//   • the text handler already ran `takePending()`, found the buffer empty, and
//     treated the instruction as a SEPARATE standalone task.
// Net effect: file + text were handled as two disconnected tasks, and the file
// later auto-fired with a generic default 35 s afterwards.
//
// FIX: process updates for the SAME chat strictly in arrival order. A file that
// arrives just before its instruction is now fully downloaded AND buffered
// before the instruction runs, so `takePending()` reliably fuses them into one
// task. Different chats still run in parallel (each has its own queue), so one
// user's long task never blocks another user.
// ─────────────────────────────────────────────────────────────────────────────
const _chatQueues = new Map(); // chatId -> Promise chain (tail of the FIFO queue)

function _updateChatId(update) {
  if (update.callback_query) return String(update.callback_query.message?.chat?.id || '');
  const msg = update.message || update.edited_message;
  return String(msg?.chat?.id || '');
}

// Public entry point — enqueues the update on its chat's serial queue so
// same-chat updates never overlap. Returns a promise that resolves when THIS
// update has been fully handled.
function handleUpdate(update) {
  const chatId = _updateChatId(update);
  if (!chatId) return dispatchUpdate(update).catch(() => {});
  const prev = _chatQueues.get(chatId) || Promise.resolve();
  const next = prev
    .catch(() => {})               // a prior failure must not wedge the queue
    .then(() => dispatchUpdate(update));
  // Keep the chain's tail; prune when this is the last queued item so the map
  // never grows unbounded for idle chats.
  _chatQueues.set(chatId, next);
  next.catch(() => {}).finally(() => {
    if (_chatQueues.get(chatId) === next) _chatQueues.delete(chatId);
  });
  return next;
}

// ── Long-poll loop ──────────────────────────────────────────────────────────
async function pollLoop() {
  if (!API) return;
  while (polling) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`, { timeout: 40000 });
      const data = await r.json();
      if (data && data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          offset = upd.update_id + 1;
          handleUpdate(upd).catch(() => {});
        }
      }
    } catch (e) {
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

async function start() {
  // Resolve the token DB-first (admin-settable in Supabase, survives redeploys),
  // falling back to env. Rebuild API/FILE_API so a token saved at runtime takes
  // effect on the next boot and THIS codebase claims @appmodding_bot.
  try {
    const tok = await resolveToken();
    if (tok && tok !== BOT_TOKEN) {
      BOT_TOKEN = tok;
      API = `${TG_API_ROOT}/bot${BOT_TOKEN}`;
      FILE_API = `${TG_API_ROOT}/file/bot${BOT_TOKEN}`;
    } else if (tok && !API) {
      API = `${TG_API_ROOT}/bot${tok}`;
      FILE_API = `${TG_API_ROOT}/file/bot${tok}`;
    }
  } catch (_) {}
  if (!API) { console.log('⏳ WormGPT Agent bot disabled (set wormgpt_bot_token in admin/Supabase or WORMGPT_BOT_TOKEN env to enable).'); return; }
  if (polling) return;
  polling = true;
  // Clear any webhook (and drop the backlog) so long-polling cleanly takes over
  // the token from any previously-connected bot/process.
  await tg('deleteWebhook', { drop_pending_updates: true });
  const me = await tg('getMe', {});
  if (me && me.ok) console.log(`✅ WormGPT Agent bot online: @${me.result.username}`);

  // ⏰ Start the scheduler. Its runner re-enters the normal task path for the
  // scheduled chat when a task's time arrives — so a scheduled task behaves
  // exactly like a task the user sends right now (same engine, credits, files,
  // live terminal), just fired at the requested time. Survives redeploys
  // because pending schedules are persisted in Supabase.
  if (scheduler) {
    try {
      scheduler.start(async ({ chatId, task, minDurationMs }) => {
        // Telegram owns numeric chat ids (no '@'). Let WhatsApp handle jids.
        if (String(chatId).includes('@')) return false;
        try {
          const link = await db.getPatcherLinkByChat(String(chatId));
          if (!link || !link.authed || !link.user_id) return true; // ours, but user logged out — consume it
          await send(chatId, `⏰ Running your scheduled task now:\n\n_"${String(task).slice(0, 200)}"_`);
          await runTask(String(chatId), link, String(task), [], { minDurationMs: minDurationMs || 0 });
        } catch (e) {
          try { await send(chatId, '⚠️ Scheduled task failed to start: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
        }
        return true;
      });
      console.log('⏰ WormGPT Agent scheduler started.');
    } catch (e) { console.error('scheduler start failed:', e.message); }
  }

  // 📈 Real-time MARKET WATCH: give the engine a live-price source, then register
  // a notifier so the INSTANT a watched symbol hits TP/SL/a level, THIS chat gets
  // an immediate alert (and, when the watch is interactive, a fresh agent take).
  if (marketWatch) {
    try {
      if (manusTools && typeof manusTools.getSpot === 'function') {
        marketWatch.setPriceFetcher((symbol) => manusTools.getSpot(symbol));
      }
      marketWatch.start(async ({ chatId, event, watch }) => {
        // Telegram owns numeric chat ids (no '@'). Let WhatsApp handle jids.
        if (String(chatId).includes('@')) return false;
        try {
          const link = await db.getPatcherLinkByChat(String(chatId));
          if (!link || !link.authed || !link.user_id) return true; // ours, logged out — consume
          await send(chatId, event.text, menu());
          // Only run the interactive agent follow-up on a REAL target hit
          // (tp/sl/above/below/touch) — never on a routine poll/change update,
          // so periodic feedback stays lightweight and doesn't burn credits.
          const isTargetHit = event && !['poll', 'change'].includes(event.type);
          if (watch && watch.interactive && isTargetHit) {
            await send(chatId, '🤖 Analyzing the move for you…');
            const followup = `${watch.symbol} just ${event.label} at ${event.target} (live ${event.price}). ` +
              `Use get_market_price to pull the latest ${watch.symbol} data and give me a concise, accurate read: ` +
              `is this a real breakout or a fakeout, what are the next key levels, and what's the smartest next move (with fresh SL/TP)?`;
            await runTask(String(chatId), link, followup, [], {});
          }
        } catch (e) {
          try { await send(chatId, '⚠️ Market alert delivery failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
        }
        return true;
      });
      console.log('📈 WormGPT Agent market-watch started.');
    } catch (e) { console.error('market-watch start failed:', e.message); }
  }

  // 📊 24/7 TRADING WATCHER: register a notifier so the INSTANT any OPEN trade
  // hits SL or TP, THIS chat gets the "TP HIT / SL HIT" alert (with PnL + R).
  // Trade Opened alerts also flow through here. Same ownership rule as above:
  // Telegram handles numeric chat ids, WhatsApp handles jids.
  if (tradingEngine && tradingEngine.enabled()) {
    try {
      tradingEngine.start(async ({ chatId, event }) => {
        if (String(chatId).includes('@')) return false; // WhatsApp jid — not ours
        try {
          const link = await db.getPatcherLinkByChat(String(chatId));
          if (!link || !link.authed || !link.user_id) return true; // ours, logged out — consume
          await send(chatId, event.text, menu());
        } catch (e) {
          try { await send(chatId, '⚠️ Trade alert delivery failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
        }
        return true;
      });
      console.log('📊 WormGPT Agent trading watcher started.');
    } catch (e) { console.error('trading watcher start failed:', e.message); }
  }

  pollLoop().catch(e => console.error('WormGPT poll loop crashed:', e.message));
}

module.exports = { enabled, start, handleUpdate, broadcast };

// Internal state exposed only for attachment-intent regression tests.
module.exports.__test__ = {
  pending, bufferAttachment, takePending, PENDING_TTL, extractTelegramFile,
  busy, activeRuns, isBusy, stopCurrentTask,
};

// ─────────────────────────────────────────────────────────────────────────────
// 📢 Broadcast an admin announcement to every Telegram user who connected the
// WormGPT agent (authed rows in patcher_links with a NUMERIC chat_id — the
// `wa:` prefixed rows belong to the WhatsApp bot and are skipped here).
// Returns { sent, failed, total }. Never throws.
// ─────────────────────────────────────────────────────────────────────────────
async function broadcast(text) {
  const msg = String(text || '').trim();
  if (!enabled() || !msg) return { sent: 0, failed: 0, total: 0, disabled: !enabled() };
  let links = [];
  try { links = await db.getAuthedPatcherLinks(); } catch (_) { links = []; }
  // Telegram chat ids are numeric; WhatsApp ids look like "wa:<jid>".
  const targets = links.filter(l => l && l.chat_id && !String(l.chat_id).startsWith('wa:'));
  let sent = 0, failed = 0;
  for (const l of targets) {
    try {
      const r = await send(l.chat_id, `📢 *Announcement*\n\n${msg}`);
      if (r && r.ok === false) failed++; else sent++;
    } catch (_) { failed++; }
    // be gentle with Telegram rate limits
    await new Promise(res => setTimeout(res, 60));
  }
  return { sent, failed, total: targets.length };
}

