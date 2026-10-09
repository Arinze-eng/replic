// ─────────────────────────────────────────────────────────────────────────────
// whatsappBot.js — WormGPT Agent (WhatsApp).
//
// The EXACT same autonomous WormGPT Agent that runs on Telegram (services/
// wormgptBot.js), exposed through a dedicated WhatsApp number instead. It is a
// SEPARATE, self-contained Baileys socket — it does NOT touch the per-user
// WhatsApp "online tracker" in services/whatsapp.js. One fixed WhatsApp number
// (WHATSAPP_BOT_NUMBER) is linked once via pairing code; anyone who messages
// that number then talks to the agent.
//
// It mirrors the Telegram bot 1:1:
//   • Website account auth (email + password against the `users` table),
//     stored in the SAME `patcher_links` table — keyed by `wa:<jid>` so it
//     never collides with Telegram's numeric chat ids.
//   • The same tiered daily quota (Free 5 / Basic 50 / Pro & Admin unlimited).
//   • The same 20-min conversational memory in `wormgpt_memory`, scope
//     `wa:<jid>`.
//   • The same file in / file out flow (analyze PDFs/ZIP/code/images, return
//     docx / pdf / txt / code), and the same "file then message" sync buffer.
//   • The brain is services/agentEngine.runAgent(...) — UNCHANGED & shared.
//
// Enable by setting WHATSAPP_BOT_NUMBER (e.g. 2349119289980). If it is unset
// the bot stays disabled and nothing in the app changes (same opt-in pattern
// as WORMGPT_BOT_TOKEN). Auth creds are persisted in the `settings` store
// (db.getSetting/setSetting → api_keys with a `__setting__` prefix, NO foreign
// keys) under WA_BOT_CREDS_KEY so the link survives Render restarts without
// touching the per-user tracker's `wa_sessions` table.
// ─────────────────────────────────────────────────────────────────────────────

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const agent = require('./agentEngine');
const daytona = require('./daytona');
const latex = require('./latexRender');
const { deliverGeneratedFiles } = require('./botFileDelivery');
const { runWithIdleGuard, positiveMs } = require('./botRunGuard');
// 🎵 Shared Spotify downloader — same converter + tiered daily quota as the
// website + Telegram bot (services/spotify.js via services/spotifyBot.js).
let spotifyBot = null;
try { spotifyBot = require('./spotifyBot'); } catch (_) { spotifyBot = null; }
// 🦫 "Capy first" wrapper — IDENTICAL to the website/app (server.js) WormGPT AI
// flow and to the Telegram bot: every task is handed to Capy.ai's own cloud
// sandbox FIRST and polled for a long time (returns files of any type) before
// any fallback. Transparent pass-through to agentEngine.runAgent when Capy is
// off/unconfigured, so behaviour is unchanged unless Capy is enabled. Loaded
// best-effort so a missing module never breaks the bot.
let agentCapyFirst = null;
try { agentCapyFirst = require('./agentCapyFirst'); } catch (_) { agentCapyFirst = null; }
let cloudflareTunnel = null;
try { cloudflareTunnel = require('./cloudflareTunnel'); } catch (_) { cloudflareTunnel = null; }

// ⏰⏱️ Scheduler + time-box parser (shared with the Telegram bot).
let scheduler = null;
try { scheduler = require('./agentScheduler'); } catch (_) { scheduler = null; }

// 📈 Real-time market watch (shared with the Telegram bot) — live SL/TP alerts.
let marketWatch = null;
try { marketWatch = require('./marketWatch'); } catch (_) { marketWatch = null; }
// 📊 Trading engine (shared) — 24/7 PAPER/REAL trade watcher + SL/TP alerts.
let tradingEngineWA = null;
try { tradingEngineWA = require('./tradingEngine'); } catch (_) { tradingEngineWA = null; }
let manusToolsWA = null;
try { manusToolsWA = require('./manusTools'); } catch (_) { manusToolsWA = null; }

const logger = pino({ level: 'silent' });

// Reserved key used to persist THIS bot's creds in the settings store. Kept
// completely separate from the tracker's `wa_sessions` rows (no collision, no
// foreign-key concerns).
const WA_BOT_CREDS_KEY = 'wormgpt_wa_bot_creds';
const WA_BOT_STATUS_KEY = 'wormgpt_wa_bot_status';
// Admin-configurable override for the bot number. When set in the settings
// store it takes precedence over the WHATSAPP_BOT_NUMBER env var, so an admin
// can change the WhatsApp bot number from the admin panel WITHOUT editing
// Render env vars or redeploying. Cached in `numberOverride` (kept sync so
// botNumber()/enabled() stay synchronous) and refreshed on boot + on change.
const WA_BOT_NUMBER_KEY = 'wormgpt_wa_bot_number';

// In-memory cache of the admin override (digits only). null = not loaded yet,
// '' = explicitly cleared (fall back to env). Loaded once on startup.
let numberOverride = null;

// The dedicated bot number (digits only). Empty → bot disabled.
// Priority: admin override (settings store) → WHATSAPP_BOT_NUMBER env var.
function botNumber() {
  const override = String(numberOverride || '').replace(/[^0-9]/g, '');
  if (override) return override;
  return String(process.env.WHATSAPP_BOT_NUMBER || '').replace(/[^0-9]/g, '');
}
function enabled() { return !!botNumber(); }

// Load the persisted admin override into the cache (best-effort, called on boot).
async function loadNumberOverride() {
  try {
    const raw = await db.getSetting(WA_BOT_NUMBER_KEY);
    numberOverride = String(raw || '').replace(/[^0-9]/g, '');
  } catch (_) { numberOverride = ''; }
  return numberOverride;
}

// Local auth dir for THIS bot only (kept separate from the tracker's wa_auth/).
const SESS_DIR = path.join(__dirname, '..', 'wa_bot_auth');
if (!fs.existsSync(SESS_DIR)) { try { fs.mkdirSync(SESS_DIR, { recursive: true }); } catch (_) {} }

// Caps (WhatsApp/Baileys handle large media better than Telegram, but stay safe).
const WA_MAX_DOWNLOAD = 60 * 1024 * 1024;  // refuse to ingest absurd files
const WA_MAX_UPLOAD = 90 * 1024 * 1024;    // refuse to send absurd files

// ── Runtime state ───────────────────────────────────────────────────────────
let sock = null;
let status = 'idle';        // idle | connecting | pairing | connected | error
let starting = false;
let pairingCode = null;
// 🔒 PAIRING SPAM FIX: a pairing code (which triggers a "link device" prompt +
// notification on the owner's phone) must ONLY be generated when an admin
// explicitly asks for one. The auto-reconnect / watchdog loop must NEVER pair
// on its own — that was firing codes to the owner's number repeatedly. This
// flag is set true ONLY by requestPairing() and cleared the moment a code is
// produced (or the socket connects). connect() refuses to pair unless it's true.
let wantPairing = false;
let saveCreds = null;
let reconnectTimer = null;
// Backoff counter for the auto-reconnect loop. Reset to 0 on a clean OPEN.
// Escalates the reconnect delay so a 440 "conflictReplaced" storm can't flap
// the socket every few seconds (which left WhatsApp unable to ever answer).
let reconnectAttempts = 0;
// Marks a connection as "healthy" only after it stays open 30s, so a rapid
// connect→440→connect flap keeps escalating the backoff instead of resetting.
let stableTimer = null;
// 🛑 440-FLAP FIX: dedicated counter for consecutive conflictReplaced (440)
// events. After a few conflicts we STAND DOWN (stop reconnecting) so the rival
// session — the linked phone or another WhatsApp Web tab — keeps the single
// active session and the fight loop ends. The watchdog (ensureLive, every 2
// min) will re-establish later if the session truly drops, so the bot still
// self-heals without flapping every few seconds. Reset to 0 on a healthy OPEN.
let conflictCount = 0;
// When true, the auto-reconnect loop refuses to reconnect (we've stood down
// after repeated 440s). Cleared on a healthy OPEN or an explicit start/pair.
let standDown = false;
// Tracks the socket instance for which a pairing code was already requested.
// Prevents the requestPairingCode retry loop from firing on a DIFFERENT (newer)
// socket if connect() was called again before the retries finished.
let pairingSocket = null;
// One-shot pairing-code requester, armed per connect() and fired by the first
// `qr` connection ref (Baileys 6.7+ requires the ref before requestPairingCode
// — otherwise the code is never registered and no phone notification fires).
let firePairing = null;
let pairRequested = false;
// 🩹 401 TOLERANCE FIX: Baileys reports a genuine device-unlink as code 401
// (DisconnectReason.loggedOut) — but on Render's free tier a 401 is FREQUENTLY a
// transient handshake/cold-start failure, NOT a real unlink. The old code wiped
// creds + went permanently idle on the FIRST 401, which left the bot offline and
// silent forever (it showed online, marked messages blue, then a 401 killed it
// before it could reply). We now reconnect (preserving creds) for the first few
// 401s and only wipe + unlink after repeated 401s confirm a true unlink. Reset
// to 0 on a healthy OPEN.
let unauthorizedCount = 0;
const MAX_401_RETRIES = parseInt(process.env.WA_BOT_MAX_401_RETRIES || '4', 10);

// ─────────────────────────────────────────────────────────────────────────────
// 🩺 STALE-CONNECTION WATCHDOG — the real cure for "answers for a while, then
// silently stops".
//
// The nastiest Baileys failure mode is NOT a clean 'connection.update' close —
// it's a HALF-DEAD socket: the underlying WebSocket still looks "open", but the
// WhatsApp stream behind it is gone. No close event fires, so none of the
// reconnect logic above ever runs; inbound messages simply stop arriving and
// outbound replies vanish into the void. That is exactly the reported symptom.
//
// `lastAlive` is bumped on EVERY sign of life from the socket (open, any inbound
// message, creds.update, and the keep-alive's own activity). A 60s watchdog
// checks it: if the socket claims to be 'connected' but has been silent past
// STALE_MS, we treat it as dead, tear it down, and force a clean reconnect — so
// the bot self-heals within ~1 minute instead of staying silent indefinitely.
// ─────────────────────────────────────────────────────────────────────────────
let lastAlive = Date.now();
let watchdogTimer = null;
const STALE_MS = parseInt(process.env.WA_BOT_STALE_MS || String(75 * 1000), 10);
function markAlive() { lastAlive = Date.now(); }
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    try {
      // Only police a socket that THINKS it is healthy. Other states already
      // have their own reconnect/backoff handling above.
      if (status !== 'connected' || !sock) return;
      if (Date.now() - lastAlive <= STALE_MS) return;
      console.warn(`🩺 WA-BOT watchdog: no socket activity for ${Math.round((Date.now() - lastAlive) / 1000)}s while "connected" — forcing reconnect.`);
      const dead = sock;
      sock = null;
      status = 'idle';
      try { dead.ev.removeAllListeners(); } catch (_) {}
      try { dead.end(new Error('stale connection — watchdog reconnect')); } catch (_) {}
      // Reconnect immediately (preserve creds — this is NOT a logout).
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(e => console.error('WA-BOT watchdog reconnect error:', e.message)); }, 500);
    } catch (_) { /* never let the watchdog crash the process */ }
  }, 30 * 1000);
  if (watchdogTimer && watchdogTimer.unref) watchdogTimer.unref();
}

// jid -> timestamp(ms) while an agent task runs (prevents overlap, like
// Telegram's `busy`). We store the START TIME so a wedged run (e.g. a hung
// sandbox backend) SELF-HEALS after AGENT_LOCK_TTL_MS instead of permanently
// bricking the chat with "a task is going on".
const busy = new Map();
// jid -> AbortController for the current task. /stop aborts Capy polling and
// suppresses fallback/result delivery, rather than only clearing the busy flag.
const activeRuns = new Map();

// Global hard deadline for one agent run + lock TTL (mirror Telegram bot).
// 🦫 Capy headroom: Capy now runs FIRST and is polled for a long time
// (the admin-settable capy_timeout_ms → CAPY_POLL_CEILING_MS, default 30 min)
// before any fallback, so the hard deadline must clear the Capy ceiling + the
// in-house fallback budget, otherwise a legitimate heavy Capy task would be
// killed mid-poll. The deadline is resolved at RUNTIME from the admin-settable
// Capy ceiling (so raising the admin timeout extends it too, no redeploy); the
// constants below are the FALLBACK. Mirrors wormgptBot.js.
let _capySvc = null;
try { _capySvc = require('./capy'); } catch (_) { _capySvc = null; }
const CAPY_AGENT_CEILING_MS = parseInt(
  process.env.CAPY_AGENT_CEILING_MS || process.env.CAPY_POLL_CEILING_MS || String(30 * 60 * 1000), 10);
const FALLBACK_BUDGET_MS = 5 * 60 * 1000;
const AGENT_RUN_TIMEOUT_MS = parseInt(
  process.env.AGENT_RUN_TIMEOUT_MS || String(CAPY_AGENT_CEILING_MS + FALLBACK_BUDGET_MS), 10); // Capy ceiling + 5 min
const AGENT_LOCK_TTL_MS = parseInt(process.env.AGENT_LOCK_TTL_MS || String(AGENT_RUN_TIMEOUT_MS + 60 * 1000), 10);

async function _resolveRunTimeoutMs() {
  if (process.env.AGENT_RUN_TIMEOUT_MS) return AGENT_RUN_TIMEOUT_MS;
  try {
    if (_capySvc && typeof _capySvc.getCeilingMs === 'function') {
      const ceil = await _capySvc.getCeilingMs();
      if (Number.isFinite(ceil) && ceil > 0) return ceil + FALLBACK_BUDGET_MS;
    }
  } catch (_) { /* fall through */ }
  return AGENT_RUN_TIMEOUT_MS;
}

// Is this jid currently locked by a LIVE (non-expired) run?
function isBusy(jid) {
  const started = busy.get(jid);
  if (!started) return false;
  const ttl = Math.max(AGENT_LOCK_TTL_MS, busy.get('__ttl__:' + jid) || 0);
  if (Date.now() - started > ttl) {
    busy.delete(jid);
    busy.delete('__ttl__:' + jid);
    return false;
  }
  return true;
}

async function stopCurrentTask(jid) {
  const wasBusy = isBusy(jid);
  const controller = activeRuns.get(jid);
  if (controller && !controller.signal.aborted) controller.abort();
  try { await agent.stopAgent(memScope(jid)); } catch (_) {}
  if (!wasBusy) {
    busy.delete(jid);
    busy.delete('__ttl__:' + jid);
  }
  return { wasBusy, aborted: !!controller };
}

// Run a promise with a hard deadline so a hung backend can't wedge the chat.
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


// ─────────────────────────────────────────────────────────────────────────────
// 🛑 DOUBLE-FIRE FIX — message-level de-duplication.
//
// Baileys delivers the SAME message through `messages.upsert` more than once in
// several normal situations:
//   • an initial (encrypted) notify followed by the decrypted copy,
//   • retry-receipt re-deliveries,
//   • a brief window where two sockets overlap during a reconnect/440 flap.
// Because the old code had NO per-message guard and only set the `busy` lock
// AFTER multiple `await`s, two duplicate deliveries of one message both raced
// past every check → the agent ran TWICE → every reply (and every sandbox
// status line) appeared twice on WhatsApp.
//
// `seenMessageIds` records the WhatsApp message id (`m.key.id`) of every message
// we have already accepted. The first delivery wins; any later delivery with the
// same id is dropped instantly, before any work begins. Ids self-expire so the
// map can never grow without bound.
// ─────────────────────────────────────────────────────────────────────────────
const seenMessageIds = new Map();        // msgId -> firstSeen timestamp (ms)
const SEEN_TTL_MS = 10 * 60 * 1000;      // remember a message id for 10 minutes
const SEEN_MAX = 5000;                   // hard cap so the map can't grow forever

// Returns true the FIRST time a message id is seen (caller should process it),
// false on every subsequent (duplicate) delivery (caller should ignore it).
function claimMessage(msgId) {
  if (!msgId) return true; // no id → can't dedupe; let it through (rare)
  const now = Date.now();
  // Opportunistic prune of expired ids (and a hard size cap as a safety net).
  if (seenMessageIds.size > SEEN_MAX) {
    for (const [id, ts] of seenMessageIds) {
      if (now - ts > SEEN_TTL_MS) seenMessageIds.delete(id);
    }
    // Still too big after pruning expired ones? Drop the oldest entries.
    if (seenMessageIds.size > SEEN_MAX) {
      const overflow = seenMessageIds.size - SEEN_MAX;
      let i = 0;
      for (const id of seenMessageIds.keys()) {
        seenMessageIds.delete(id);
        if (++i >= overflow) break;
      }
    }
  }
  const prev = seenMessageIds.get(msgId);
  if (prev !== undefined && (now - prev) < SEEN_TTL_MS) {
    return false; // duplicate delivery — already claimed
  }
  seenMessageIds.set(msgId, now);
  return true;
}

const MEMORY_MAX = 12; // 6 user+assistant exchanges (same as Telegram)
const memScope = (jid) => `wa:${jid}`;     // wormgpt_memory scope
const linkKey  = (jid) => `wa:${jid}`;     // patcher_links.chat_id value

// ─────────────────────────────────────────────────────────────────────────────
// 🔗 PER-CHAT SERIAL QUEUE — "file then message" is treated as ONE request.
// (Parity with the Telegram bot.)
//
// THE BUG THIS FIXES: `messages.upsert` dispatched every message CONCURRENTLY
// (`handleIncoming(m).catch(...)` with no await). So when a user sent a FILE and
// then quickly typed an INSTRUCTION, the two messages raced:
//   • the media handler was still DOWNLOADING the attachment (slow, async) and
//     had not yet buffered it, while
//   • the text handler already ran `takePending()`, found the buffer empty, and
//     treated the instruction as a SEPARATE standalone task.
// Net effect: file + text were handled as two disconnected tasks, and the file
// later auto-fired with a generic default 35 s afterwards.
//
// FIX: process messages for the SAME jid strictly in arrival order, so a file
// that arrives just before its instruction is fully downloaded AND buffered
// before the instruction runs `takePending()` — reliably fusing them into one
// task. Different chats keep running in parallel (one queue per jid).
// ─────────────────────────────────────────────────────────────────────────────
const _jidQueues = new Map(); // jid -> Promise chain (tail of the FIFO queue)

// Enqueue an incoming message on its jid's serial queue so same-chat messages
// never overlap. Returns a promise that resolves when THIS message is handled.
function enqueueIncoming(msg) {
  const jid = msg?.key?.remoteJid;
  if (!jid) return handleIncoming(msg).catch(e => console.error('WA-BOT handleIncoming error:', e && e.stack ? e.stack : e.message));
  const prev = _jidQueues.get(jid) || Promise.resolve();
  const next = prev
    .catch(() => {})            // a prior failure must not wedge the queue
    .then(() => handleIncoming(msg));
  _jidQueues.set(jid, next);
  next
    .catch(e => console.error('WA-BOT handleIncoming error:', e && e.stack ? e.stack : e.message))
    .finally(() => { if (_jidQueues.get(jid) === next) _jidQueues.delete(jid); });
  return next;
}

// Admin-configured WormGPT daily-limit overrides (settings store → admin panel
// Limits tab). Falls back to db.js defaults. Returns { free, basic }.
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

// 🪙 Credit knobs (shared with website + Telegram). { caps, costs }.
// 💸 Cost knobs scaled by an engine-aware cost-recovery multiplier (in sync
// with server.js getCreditCosts + wormgptBot.js):
//   • mode 'capy'   → credit_mult_capy   (default X10 — Capy cloud AI)
//   • mode 'normal' → credit_mult_normal (default X5 — in-house sandbox)
// The WhatsApp agent always runs Capy-FIRST, so it defaults to the 'capy' rate.
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
const HEAVY_CREDIT_TOOLS = new Set([
  'run_code', 'docker_run', 'browse', 'browser_action', 'fetch_url', 'web_search',
  'wolfram_alpha', 'solve_captcha', 'captcha', 'screenshot', 'generate_image',
  'edit_image', 'create_pdf', 'create_docx', 'create_slides', 'create_presentation',
  'create_chart', 'convert_file', 'deploy_site', 'deploy_cloudflare_pages',
  'deploy_github', 'deploy_render', 'host_media', 'make_zip', 'analyze_image',
  'analyze_images', 'solve_math', 'read_document',
]);
function creditStepCost(note, costs) {
  const n = String(note || '').toLowerCase();
  for (const t of HEAVY_CREDIT_TOOLS) { if (n.includes(t)) return costs.heavy; }
  return costs.step;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔗 ATTACHMENT INTENT GATE — receive first, process only after instructions.
// Sent and forwarded attachments are held until a separate text message states
// what the current user wants. Captions are not trusted as instructions because
// forwarded media often retains the original sender's caption.
//   pending: jid -> { files:[{name,buffer,isImage,mime}], timer, ts }
// ─────────────────────────────────────────────────────────────────────────────
const pending = new Map();
const PENDING_TTL = Math.max(60000, Number(process.env.ATTACHMENT_INTENT_TTL_MS) || 20 * 60 * 1000);
function clearPendingTimer(jid) {
  const p = pending.get(jid);
  if (p && p.timer) { clearTimeout(p.timer); p.timer = null; }
}
function bufferAttachment(jid, attachment) {
  let p = pending.get(jid);
  if (!p) { p = { files: [], timer: null, ts: Date.now() }; pending.set(jid, p); }
  p.ts = Date.now();
  p.files.push(attachment);
  clearPendingTimer(jid);
  // Expiry releases memory only; it never starts an agent task.
  p.timer = setTimeout(() => {
    const cur = pending.get(jid);
    if (!cur || !cur.files.length) return;
    pending.delete(jid);
    sendText(jid, '⌛ I did not process the attachment because no instruction was provided. Please send it again and tell me what you want done.').catch(() => {});
  }, PENDING_TTL);
  if (p.timer && p.timer.unref) p.timer.unref();
}
function takePending(jid) {
  const p = pending.get(jid);
  if (!p) return [];
  clearPendingTimer(jid);
  pending.delete(jid);
  return p.files || [];
}

function normEmail(e) { return (e || '').toLowerCase().trim(); }

// ── Auth state: persist creds to the settings store (no FK) like a key/value ─
async function loadAuthState() {
  // Restore persisted creds (if any) from the settings store → local files.
  try {
    const raw = await db.getSetting(WA_BOT_CREDS_KEY);
    if (raw) {
      const files = typeof raw === 'string' ? JSON.parse(raw) : raw;
      for (const [name, content] of Object.entries(files)) {
        try { fs.writeFileSync(path.join(SESS_DIR, name), content); } catch (_) {}
      }
    }
  } catch (e) { /* best-effort */ }

  const { state, saveCreds: rawSave } = await useMultiFileAuthState(SESS_DIR);

  // Wrap saveCreds to also mirror the whole folder back to the settings store.
  const persist = async () => {
    try {
      await rawSave();
      const files = {};
      for (const f of fs.readdirSync(SESS_DIR)) {
        files[f] = fs.readFileSync(path.join(SESS_DIR, f), 'utf-8');
      }
      await db.setSetting(WA_BOT_CREDS_KEY, JSON.stringify(files));
    } catch (e) { console.error('WA-BOT persist creds error:', e.message); }
  };
  return { state, saveCreds: persist };
}

async function clearPersistedCreds() {
  // 1) Clear the persisted copy in the settings store so loadAuthState() can't
  //    restore an old (already-registered) creds.json on the next connect.
  try { await db.setSetting(WA_BOT_CREDS_KEY, ''); } catch (_) {}
  // 2) Robustly wipe the local auth dir. The old code used readdir+unlink which
  //    silently left files behind if a single unlink threw or if Baileys had
  //    created a nested folder — leaving a `creds.json` with `registered:true`
  //    on disk. useMultiFileAuthState() would then load that stale identity,
  //    making `usePairingCode` false → connect() bails to idle → NO pairing
  //    code and NO link-device notification. Nuke the whole dir recursively and
  //    recreate it empty so the next pairing always starts from scratch.
  try { fs.rmSync(SESS_DIR, { recursive: true, force: true }); } catch (_) {}
  try { fs.mkdirSync(SESS_DIR, { recursive: true }); } catch (_) {}
}

async function saveStatus(obj) {
  try { await db.setSetting(WA_BOT_STATUS_KEY, JSON.stringify({ ...obj, updated_at: db.nowISO() })); } catch (_) {}
}

// ── Low-level send helpers ───────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 🩹 SILENT-SEND FIX — the real "WhatsApp is online but never answers" bug.
//
// The old send helpers each did `try { await sock.sendMessage(...) } catch {}` —
// swallowing EVERY error with no log and no retry. Combined with the fact that
// an agent task takes ~30–90s to run, the socket that received the message can
// be REPLACED (440 conflict) or briefly drop by the time the reply is ready.
// When that happens `sock` points at a dead/replaced socket, `sendMessage`
// throws (or resolves to nothing), the catch eats it silently, and the user
// sees absolutely nothing back — exactly the reported symptom. Telegram never
// has this problem because every send is a fresh stateless HTTPS POST.
//
// `waitForLiveSocket()` makes sure we have a CONNECTED socket before sending
// (reviving it if needed and waiting up to a few seconds), and `safeSend()`
// retries the actual send a few times across reconnects and LOGS any final
// failure instead of hiding it. All four senders (text / answer / document /
// image) now go through safeSend, so a transient socket blip no longer turns
// into a permanently silent bot.
// ─────────────────────────────────────────────────────────────────────────────

// Resolve once the socket is connected, or after `timeoutMs` regardless. Kicks
// ensureLive() so a dead/idle socket is revived before we try to send.
//
// NOTE on stand-down: after repeated 440 conflicts the bot deliberately STANDS
// DOWN (standDown=true) and won't auto-revive for 10 min so the rival session
// keeps the line. But if we genuinely need to SEND a reply and the socket is
// dead, staying silent for 10 min is exactly the "online but no answer" bug.
// So here — only when a real send is pending — we clear the stand-down ONCE and
// force a single revive attempt. If the conflict is real it'll re-stand-down on
// the next 440 close, so this can't reignite an endless flap.
async function waitForLiveSocket(timeoutMs = 12000) {
  if (sock && status === 'connected') return true;
  if (standDown) { standDown = false; conflictCount = 0; }
  try { await ensureLive(); } catch (_) {}
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sock && status === 'connected') return true;
    await new Promise(r => setTimeout(r, 400));
    // Nudge a revive again if we're sitting idle/errored with no pending retry.
    if ((status === 'idle' || status === 'error') && !reconnectTimer) {
      try { await ensureLive(); } catch (_) {}
    }
  }
  return !!(sock && status === 'connected');
}

// Send one WhatsApp message payload with liveness-wait + retries. Returns true
// on success, false (and logs) on definitive failure — NEVER throws so callers
// stay simple, but failures are now VISIBLE in the logs instead of swallowed.
async function safeSend(jid, content, label = 'message') {
  if (!jid || !content) return false;
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Make sure we have a live socket before each attempt (revive across drops).
    const live = await waitForLiveSocket(attempt === 1 ? 12000 : 8000);
    if (!live || !sock) {
      lastErr = new Error('socket not connected');
    } else {
      try {
        await sock.sendMessage(jid, content);
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      const backoff = 800 * attempt; // 0.8s, 1.6s, 2.4s
      console.warn(`WA-BOT safeSend(${label}) attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastErr && lastErr.message}); retrying in ${backoff}ms…`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  console.error(`WA-BOT safeSend(${label}) FAILED after ${MAX_ATTEMPTS} attempts: ${lastErr && lastErr.message}. jid=${jid}`);
  return false;
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
  // Don't double-badge if a previous step already appended one.
  if (/🤖 _Answered by /.test(t) || /_Answered by .+ \(/.test(t)) return t;
  return `${t}\n\n— 🤖 _Answered by ${emoji} ${brain}_`;
}

async function sendText(jid, text) {
  if (!jid) return;
  // WhatsApp has no hard 4096 cap like Telegram, but keep messages sane.
  let s = String(text || '');
  if (!s) return;
  const chunks = [];
  while (s.length > 14000) {
    let cut = s.lastIndexOf('\n', 14000);
    if (cut < 6000) cut = 14000;
    chunks.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  chunks.push(s);
  for (const c of chunks) {
    // Resilient: waits for a live socket + retries across reconnects + logs on
    // definitive failure (no more silently-swallowed sends → no more "online
    // but says nothing" bot).
    await safeSend(jid, { text: c }, 'text');
  }
}

async function sendDocument(jid, buffer, filename, caption) {
  if (!jid) return false;
  const mimetype = guessMime(filename);
  return safeSend(jid, { document: buffer, fileName: filename, mimetype, caption: caption || undefined }, 'document');
}

// Send an MP3 as a playable WhatsApp audio message AND (for reliability) also as
// a downloadable document, so the user can both listen and save it. WhatsApp
// audio messages don't carry a filename, so the document copy preserves the
// clean "Title - Artist.mp3" name. Used by the Spotify downloader.
async function sendAudio(jid, buffer, filename, caption) {
  if (!jid) return false;
  // Playable audio bubble first (best-effort), then the named document copy.
  await safeSend(jid, { audio: buffer, mimetype: 'audio/mpeg' }, 'audio');
  return safeSend(jid, { document: buffer, fileName: filename, mimetype: 'audio/mpeg', caption: caption || undefined }, 'audio-doc');
}

// Send an image buffer (used to deliver beautifully typeset LaTeX/maths so it
// looks PERFECT on WhatsApp instead of raw "\frac{}{}" text).
async function sendImage(jid, buffer, caption) {
  if (!jid) return false;
  return safeSend(jid, { image: buffer, caption: caption || undefined }, 'image');
}

// Deliver the agent's textual answer. If it contains LaTeX/maths, render the
// whole reply to a clean typeset PNG and send it as an image (with a readable
// Unicode text caption) so equations look perfect on WhatsApp. Falls back to
// plain (cleaned) text whenever rendering isn't available.
async function sendAnswer(jid, text) {
  const raw = String(text || '');
  if (raw && latex.detectMath(raw)) {
    try {
      const img = await latex.renderMathImage(raw);
      if (img) {
        // WhatsApp captions are length-limited; keep a short readable caption and
        // send the full readable text separately if it's long.
        const readable = latex.toReadableText(raw);
        const caption = readable.length <= 900 ? readable : '🧮 See the rendered answer above.';
        const sent = await sendImage(jid, img, caption);
        if (sent) {
          if (readable.length > 900) await sendText(jid, readable);
          return;
        }
      }
      // Rendering failed → send the Unicode-cleaned text so it's still readable.
      await sendText(jid, latex.toReadableText(raw));
      return;
    } catch (_) { /* fall through to plain text */ }
  }
  await sendText(jid, raw);
}

// WhatsApp text messages are generous, but keep chunks comfortable.
const WA_MSG_LIMIT = 3500;

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    zip: 'application/zip', html: 'text/html', js: 'text/javascript', py: 'text/x-python',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  };
  return map[ext] || 'application/octet-stream';
}

async function setState(jid, fields) { return db.upsertPatcherLink(linkKey(jid), fields); }
async function getLink(jid) { return db.getPatcherLinkByChat(linkKey(jid)); }

function menuText() {
  return '\n\n———\n🌐 _Browse the web_ · 🧑‍💻 _Write code_ · 📄 _Make a docx/pdf report_\n' +
    'Type /help for everything I can do · /reset to start fresh · /logout to disconnect.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Run an agent task and deliver the result + any files. (Direct port of the
// Telegram bot's runTask — same quota, memory, file re-hydration & delivery.)
// ─────────────────────────────────────────────────────────────────────────────
async function runTask(jid, task, attachments = [], opts = {}) {
  // 🛑 DOUBLE-FIRE FIX (layer 2): claim the per-jid lock SYNCHRONOUSLY, before
  // any `await`. The old code set `busy` only after several awaits (getLink,
  // getUserById, usage gate), so two near-simultaneous deliveries of the same
  // message could both pass the `busy.get` check before either set it → the
  // task ran twice. Claiming the lock atomically up-front rejects a concurrent
  // duplicate immediately. The lock is always released in the finally block.
  //
  // It also stores the START TIME so a wedged run (hung sandbox backend) can
  // SELF-HEAL after AGENT_LOCK_TTL_MS — see isBusy() — and runs the body under a
  // HARD DEADLINE so a hung backend can never permanently wedge the chat.
  if (isBusy(jid)) {
    await sendText(jid, '⏳ I\'m still working on your previous task — one moment…');
    return;
  }
  busy.set(jid, Date.now());
  const controller = new AbortController();
  activeRuns.set(jid, controller);
  const runOpts = {
    ...opts,
    signal: controller.signal,
    abort: () => {
      if (!controller.signal.aborted) controller.abort();
      agent.stopAgent(memScope(jid)).catch(() => {});
    },
  };
  let deadlineExpired = false;
  try {
    // Resolve the per-run deadline from the admin-settable Capy ceiling so a
    // long admin timeout doesn't get the task killed early; track lock TTL.
    let runTimeoutMs = await _resolveRunTimeoutMs();
    if (runOpts.minDurationMs && Number.isFinite(runOpts.minDurationMs)) {
      runTimeoutMs = Math.max(runTimeoutMs, runOpts.minDurationMs + 90 * 1000);
    }
    try { busy.set('__ttl__:' + jid, runTimeoutMs + 60 * 1000); } catch (_) {}
    await withRunTimeout(
      runTaskInner(jid, task, attachments, runOpts),
      runTimeoutMs,
      'Your task',
      () => { deadlineExpired = true; runOpts.abort(); }
    );
  } catch (e) {
    if (deadlineExpired || !controller.signal.aborted) {
      try { await sendText(jid, '❌ Task failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    }
  } finally {
    if (activeRuns.get(jid) === controller) activeRuns.delete(jid);
    busy.delete(jid);
    busy.delete('__ttl__:' + jid);
  }
}

// The actual task body. `busy` is guaranteed held for the whole duration by the
// runTask() wrapper above and released in its finally block.
async function runTaskInner(jid, task, attachments = [], opts = {}) {
  const link = await getLink(jid);
  if (!link || !link.authed || !link.user_id) {
    await sendText(jid, '🔐 Please authenticate first — send /start.');
    return;
  }

  // ── 🪙 CREDIT GATE — shared with website & Telegram (sandbox drains credits) ──
  let user = null;
  try { user = await db.getUserById(link.user_id); } catch (_) {}
  if (!user || user.blocked) {
    await sendText(jid, '⛔ Your account is not available. Send /logout then /start to re-link, or contact support.');
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
      await sendText(jid,
        `⚠️ *Out of WormGPT credits* — ${tier} plan has *${creditBalance}* credits left.\n\n${upsell}\n\n🔓 Upgrade here 👉 https://hackerx-v7-d5s4.onrender.com\n\nYour credits renew at midnight.`);
      return;
    }
    try { creditBalance = await db.chargeWormgptCredits(user, costs.base, { job_id: jid, scope: 'whatsapp', reason: 'task_base', caps }); } catch (_) {}
    await sendText(jid, `🪙 ${tier} plan · ${creditBalance} credits left (draining as the sandbox works).`);
  }

  // Bump last-activity timestamp on patcher_links for the admin Bot Users tab.
  const linkKey_ = 'wa:' + jid;
  try { await db.upsertPatcherLink(linkKey_, {}); } catch (_) {}
  // Also update the user's last_seen in the users table.
  if (link && link.user_id) { try { await db.updateUser(link.user_id, { last_seen: db.nowISO() }); } catch (_) {} }

  // (busy lock already held by the runTask() wrapper — released in its finally.)
  const jobId = uuidv4();
  await db.createPatchJob({ id: jobId, user_id: link.user_id, chat_id: linkKey(jid), mode: 'agent', in_name: task.slice(0, 120), status: 'processing' }).catch(() => {});

  await sendText(jid, '🤖 *WormGPT Agent* is on it…');

  let lastNote = 0;
  let markEngineActivity = () => {};
  const onStep = (note) => {
    // 🪙 Drain credits for this sandbox step.
    if (!unlimited && !outOfCredits) {
      const cost = creditStepCost(note, costs);
      db.chargeWormgptCredits(user, cost, { job_id: jobId, scope: 'whatsapp', reason: 'step', caps })
        .then((bal) => {
          creditBalance = bal;
          if (bal <= 0 && !outOfCredits) {
            outOfCredits = true;
            if (typeof opts.abort === 'function') opts.abort();
            sendText(jid, '🪙 Credits exhausted — the task stopped immediately. Recharge or wait for the daily renewal to continue.').catch(() => {});
          }
        })
        .catch(() => {});
    }
    const now = Date.now();
    _lastActivityWa = now;               // 💓 feed the heartbeat watchdog
    // Polling text proves the loop is alive but not that the task is advancing.
    // Only concrete engine/tool events reset the stalled-stage recovery timer.
    if (!/^Capy working…/i.test(String(note || ''))) markEngineActivity();
    if (now - lastNote > 2500) { // a touch slower than TG to avoid WA flood limits
      lastNote = now;
      const badge = unlimited ? '' : ` (🪙 ${creditBalance})`;
      sendText(jid, '› ' + note + badge).catch(() => {});
    }
  };

  // 💓 HEARTBEAT WATCHDOG (parity with Telegram) — keeps the user informed during
  // long silent steps (APK build, heavy install/scan) so the bot never appears
  // to hang. WhatsApp has stricter flood limits, so we alert on a longer quiet
  // window and send fewer messages.
  const HEARTBEAT_MS_WA = parseInt(process.env.BOT_HEARTBEAT_MS_WA || '30000', 10);
  const QUIET_ALERT_MS_WA = parseInt(process.env.BOT_QUIET_ALERT_MS_WA || '60000', 10);
  let _lastActivityWa = Date.now();
  let _hbCountWa = 0;
  const _heartbeatWa = setInterval(() => {
    try {
      if (_hbCountWa > (parseInt(process.env.BOT_HEARTBEAT_MAX || '40', 10))) { clearInterval(_heartbeatWa); return; }
      const quietFor = Date.now() - _lastActivityWa;
      if (quietFor >= QUIET_ALERT_MS_WA) {
        _hbCountWa++;
        _lastActivityWa = Date.now();
        const secs = Math.round(quietFor / 1000);
        const msg = _hbCountWa === 1
          ? `⏳ This step has been quiet for ${secs}s. It is still running; automatic recovery will switch engines if it stops making progress.`
          : `⏳ The step is still active. I’m monitoring it and will recover automatically if it stalls.`;
        sendText(jid, msg).catch(() => {});
      }
    } catch (_) { /* never let the heartbeat throw */ }
  }, HEARTBEAT_MS_WA);
  if (_heartbeatWa.unref) _heartbeatWa.unref();

  // Keep recovery inputs outside the primary try block. Otherwise a Capy-stage
  // exception makes the fallback reference block-scoped variables that no
  // longer exist (`taskForAgent is not defined`, then `history is not defined`).
  const taskForAgent = task;
  let history = [];
  let result;
  try {
    // 🧠 Pull the last 6 chats from Supabase (persisted; see db.js TTL).
    try { history = await db.getWormgptMemory(memScope(jid), MEMORY_MAX); } catch (_) {}

    // 📎 Re-hydrate previously uploaded files when this turn has none.
    //    With PERSISTENT sandbox sessions the files persist in the agent's
    //    working dir, so this Supabase fallback is only needed when Daytona is
    //    unavailable (local-host fallback).
    if ((!attachments || attachments.length === 0) && !daytona.enabled()) {
      try {
        const prior = await db.getWormgptFiles(memScope(jid));
        if (prior && prior.length) {
          attachments = prior;
          const names = prior.map(p => p.name).join(', ');
          await sendText(jid, `📎 Reusing your previously sent file${prior.length > 1 ? 's' : ''}: ${names}`);
        }
      } catch (_) { /* best-effort */ }
    }

    // 🧠 The WormGPT Agent (DeepSeek primary → HotBot → Gemini fallback) handles
    //    the task directly. No pre-debate / consensus step.

    // 🦫 Capy FIRST (same as website/app + Telegram bot): every task is handed
    //    to Capy.ai's own cloud sandbox and polled for a long time (returns files
    //    of any type) before falling back to the in-house engine. When Capy is
    //    off/unconfigured this is a transparent pass-through to agentEngine.runAgent
    //    — identical behaviour to before. Capy does the task before fall back and
    //    honours the large CAPY_POLL_CEILING_MS timeout for heavy tasks.
    const engOpts = { task: taskForAgent, attachments, history, onStep, sessionKey: memScope(jid), source: 'whatsapp', signal: opts.signal };
    // ⏱️ Time-box pass-through (see wormgptBot).
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
      clearInterval(_heartbeatWa);
      await db.updatePatchJob(jobId, { status: 'error', log: 'Stopped by user' }).catch(() => {});
      return;
    }
    // 🛟 GUARANTEE THE TASK STILL FINISHES (mirrors the Telegram bot). If the
    // Capy-first wrapper itself threw, make one last direct attempt with the
    // in-house engine before reporting failure so "Capy head → racers finish"
    // always completes.
    try {
      onStep('🤖 Capy path errored — finishing your task with the in-house agent…');
      const fallbackIdleMs = positiveMs(process.env.BOT_FALLBACK_IDLE_TIMEOUT_MS, 3 * 60 * 1000);
      result = await runWithIdleGuard(
        async ({ signal, touch }) => {
          markEngineActivity = touch;
          return agent.runAgent({ task: taskForAgent, attachments, history, onStep, sessionKey: memScope(jid), source: 'whatsapp', signal });
        },
        { signal: opts.signal, idleMs: fallbackIdleMs, label: 'Fallback agent stage' }
      );
    } catch (e2) {
      clearInterval(_heartbeatWa);
      await db.updatePatchJob(jobId, { status: 'error', log: String(e && e.message ? e.message : e) + ' | fallback: ' + String(e2 && e2.message ? e2.message : e2) }).catch(() => {});
      await sendText(jid, '❌ Task failed: ' + (e2 && e2.message ? e2.message : (e && e.message ? e.message : String(e2 || e))));
      return; // busy lock released by runTask()'s finally
    }
  }
  // 💓 Task produced a result — stop the heartbeat watchdog now.
  clearInterval(_heartbeatWa);
  if ((opts.signal && opts.signal.aborted) || (result && result.stopped)) {
    await db.updatePatchJob(jobId, { status: 'error', log: 'Stopped by user' }).catch(() => {});
    return;
  }

  // Send the textual answer (auto-renders LaTeX/maths to a clean image so it
  // looks perfect on WhatsApp instead of raw \frac{}{} text).
  // Append a small badge telling the user WHICH AI model produced this reply
  // (DeepSeek / HotBot / Gemini) so it's always clear which brain answered.
  await sendAnswer(jid, withBrainBadge(result.message || '✅ Done.', result.brain));

  // 🧠 Persist this exchange + any uploaded files to Supabase memory (20-min TTL).
  try {
    await db.saveWormgptMemory(memScope(jid), 'user', String(task).slice(0, 4000));
    await db.saveWormgptMemory(memScope(jid), 'model', String(result.message || 'Done.').slice(0, 4000));
    for (const a of (attachments || [])) {
      if (a && a.buffer && a.buffer.length <= 6 * 1024 * 1024) {
        await db.saveWormgptFile(memScope(jid), { name: a.name, b64: a.buffer.toString('base64'), mime: a.mime });
      }
    }
  } catch (_) {}

  // Deliver generated artifacts before deleting their temporary workdir. The
  // shared adapter accepts host paths, Buffers, base64 and text artifacts, and
  // verifies safeSend actually succeeded instead of silently marking failure as done.
  const delivery = await deliverGeneratedFiles({
    files: result.files,
    maxBytes: WA_MAX_UPLOAD,
    channel: 'WhatsApp',
    sendFile: (buffer, name, caption) => sendDocument(jid, buffer, name, caption),
    sendNotice: (message) => sendText(jid, message),
    onFailure: ({ name, reason }) => console.error(`WhatsApp artifact delivery failed (${name}): ${reason}`),
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
  await sendText(jid, finishText + menuText());
  // busy lock released by runTask()'s finally
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎵 SPOTIFY DOWNLOADER (WhatsApp) — paste a track / album / playlist link and
// the bot returns the file(s). SAME converter + tiered daily quota as the
// website + Telegram bot (Free 2/day · Basic 15/day · Pro & Admin unlimited;
// album/playlist = 1 use). Shares the per-jid busy lock so a download never
// overlaps an agent task. Never throws to the caller.
// ─────────────────────────────────────────────────────────────────────────────
async function handleSpotify(jid, link, detected) {
  if (!spotifyBot) {
    await sendText(jid, '\u26a0\ufe0f The Spotify downloader is temporarily unavailable.');
    return;
  }
  if (isBusy(jid)) {
    await sendText(jid, '\u23f3 I\'m still working on your previous task \u2014 one moment\u2026');
    return;
  }
  busy.set(jid, Date.now());
  try {
    const quota = await spotifyBot.checkQuota(link.user_id);
    if (!quota.allowed) {
      await sendText(jid, quota.message || '\u26a0\ufe0f You cannot download right now.');
      return;
    }

    db.logBotActivity({
      user_id: link.user_id, chat_id: linkKey(jid), channel: 'whatsapp',
      action: 'spotify', message_text: detected.kind + ': ' + detected.url, file_name: null,
      tier: quota.tier,
    }).catch(() => {});
    try { await db.updateUser(link.user_id, { last_seen: db.nowISO() }); } catch (_) {}
    try { await db.upsertPatcherLink(linkKey(jid), {}); } catch (_) {}

    if (detected.kind === 'track') {
      await sendText(jid, '\ud83c\udfb5 Fetching your track from Spotify\u2026');
      const r = await spotifyBot.fetchTrack(detected.url);
      if (!r.ok) {
        await sendText(jid, '\u274c ' + (r.error || 'Could not download this track.'));
        return;
      }
      if (r.buffer.length > WA_MAX_UPLOAD) {
        await sendText(jid, '\u26a0\ufe0f "' + r.filename + '" is ' + (r.buffer.length / 1024 / 1024).toFixed(1) + ' MB \u2014 larger than WhatsApp allows.');
        return;
      }
      await sendAudio(jid, r.buffer, r.filename, '\ud83c\udfb5 ' + r.title + (r.artists ? ' \u2014 ' + r.artists : ''));
      await spotifyBot.recordDownload(link.user_id, quota.unlimited);
      const left = quota.unlimited ? 'unlimited' : Math.max(0, quota.remaining - 1);
      await sendText(jid, '\u2705 Done. Downloads left today: *' + left + '* (' + quota.tier + ').');
      return;
    }

    const kind = detected.kind;
    await sendText(jid, '\ud83c\udfb5 Reading the ' + kind + ' from Spotify and preparing your download\u2026 (this can take a moment for large ' + kind + 's)');

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
      await sendText(jid, '\u274c ' + (result.error || ('Could not download this ' + kind + '.')));
      return;
    }
    if (!result.downloaded) {
      await sendText(jid, '\u274c None of the tracks on this ' + kind + ' could be downloaded. Please try again later.');
      return;
    }

    const zipName =
      kind === 'album'
        ? spotifyBot.safeAlbumName(result.name, result.artistsOrOwner) + '.zip'
        : spotifyBot.safePlaylistName(result.name, result.artistsOrOwner) + '.zip';
    const out = zip.toBuffer();
    if (out.length > WA_MAX_UPLOAD) {
      await sendText(jid,
        '\u26a0\ufe0f The ' + kind + ' ZIP is ' + (out.length / 1024 / 1024).toFixed(1) + ' MB \u2014 too large for WhatsApp. ' +
        'Try a smaller ' + kind + ', or download it on the website: https://hackerx-v7-d5s4.onrender.com/spotify');
      return;
    }
    const failedNote = result.failed && result.failed.length
      ? '\n\u26a0\ufe0f ' + result.failed.length + ' track(s) were skipped (unavailable).'
      : '';
    await sendDocument(jid, out, zipName,
      '\ud83c\udfb5 ' + result.name + (result.artistsOrOwner ? ' \u2014 ' + result.artistsOrOwner : '') + ' \u00b7 ' + result.downloaded + '/' + result.trackCount + ' tracks' + failedNote);
    await spotifyBot.recordDownload(link.user_id, quota.unlimited);
    const left = quota.unlimited ? 'unlimited' : Math.max(0, quota.remaining - 1);
    await sendText(jid, '\u2705 Done. Downloads left today: *' + left + '* (' + quota.tier + ').');
  } catch (e) {
    try { await sendText(jid, '\u274c Spotify download failed: ' + (e && e.message ? e.message : String(e))); } catch (_) {}
  } finally {
    busy.delete(jid);
    busy.delete('__ttl__:' + jid);
  }
}

function helpText() {
  return '🤖 *WormGPT Agent — what I can do*\n\n' +
    '• Answer ANY question (uncensored)\n' +
    '• 🌐 Browse the web & research\n' +
    '• 🖼️ Analyze images you send\n' +
    '• 📄 Read & analyze PDFs, ZIPs and code files (just send them)\n' +
    '• 🧑‍💻 Write, edit and RUN code\n' +
    '• 📑 Produce real files back: *.docx*, *.pdf*, *.txt*, code\n\n' +
    '🧠 I remember our last 6 chats for context — *private to this chat only*, no one else sees your history. Send */last* to see your recent tasks, */clearfiles* to wipe just the workspace files (keeps memory), or /reset to start fresh.\n\n' +
    '🖥️ You’ll see my *live sandbox terminal* stream as I work. Send */stop* anytime to halt a running task instantly.\n\n' +
    '🌐 *Sandbox Internet tunnel:* send */cloudflare* (or */cloudflare novita|upstash|runloop|tensorlake*) for a verified Cloudflare URL and local proxy port. Send */stopcloudflare* to close it and sleep the sandbox.\n\n' +
    '⏰ *Schedule:* tell me *when* — _"at 6pm, generate the report"_. Times use *UTC+1* by default — say _"set timezone to +2"_ to change. Send */schedules* to list.\n\n' +
    '📈 *Watch the market:* _"watch XAUUSD, alert me at TP 2650 SL 2600"_ or _"monitor BTC and give me feedback on price changes"_. I recheck every ~45s, send periodic updates, and alert the INSTANT a level is hit. Send */watches* / */stopwatch*.\n\n' +
    'Just type a task, or attach a file / image. Examples:\n' +
    '_"Research the top 5 AI trends in 2026 and write me a docx report"_\n' +
    '_"Write a Python script that scrapes a site and run it"_\n' +
    '_"Summarize this PDF"_ (then attach it)';
}

// ── Extract the plain text out of an incoming WhatsApp message ───────────────
function extractText(msg) {
  const c = msg.message || {};
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    c.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim();
}

// ── Is this message carrying a media attachment we should ingest? ────────────
function mediaKind(msg) {
  let c = msg.message || {};
  if (c.ephemeralMessage?.message) c = c.ephemeralMessage.message;
  if (c.viewOnceMessage?.message) c = c.viewOnceMessage.message;
  if (c.viewOnceMessageV2?.message) c = c.viewOnceMessageV2.message;
  if (c.documentWithCaptionMessage?.message) c = c.documentWithCaptionMessage.message;
  if (c.imageMessage) return 'image';
  if (c.documentMessage) return 'document';
  return null;
}

// ── Download an incoming media message to a Buffer ───────────────────────────
async function downloadIncoming(msg) {
  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  let c = msg.message || {};
  if (c.ephemeralMessage?.message) c = c.ephemeralMessage.message;
  if (c.viewOnceMessage?.message) c = c.viewOnceMessage.message;
  if (c.viewOnceMessageV2?.message) c = c.viewOnceMessageV2.message;
  if (c.documentWithCaptionMessage?.message) c = c.documentWithCaptionMessage.message;
  const type = getContentType(c);
  const node = c[type] || {};
  const mime = node.mimetype || 'application/octet-stream';
  const isImage = /^image\//.test(mime) || type === 'imageMessage';
  let name = node.fileName || '';
  if (!name) {
    const ext = (mime.split('/')[1] || 'bin').split(';')[0];
    name = isImage ? `image.${ext === 'jpeg' ? 'jpg' : ext}` : `file.${ext}`;
  }
  return { name, buffer, isImage, mime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core message handler. `jid` is the sender's chat jid; `text` already trimmed.
// ─────────────────────────────────────────────────────────────────────────────
async function handleIncoming(msg) {
  const jid = msg.key?.remoteJid;
  if (!jid) return;
  // Only 1:1 chats — ignore groups, status, broadcast, newsletters, our own msgs.
  if (msg.key.fromMe) return;
  if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

  const text = extractText(msg);
  const kind = mediaKind(msg);

  let link = await getLink(jid);

  // ── Commands (work regardless of media) ──
  if (/^\/(start|auth|login)\b/i.test(text)) {
    await setState(jid, { state: 'await_email', authed: link?.authed || 0 });
    link = await getLink(jid);
    if (link && link.authed && link.user_id) {
      await setState(jid, { state: 'ready' });
      await sendText(jid,
        `👋 *Welcome back!* You're connected as \`${link.email}\`.\n\n` +
        `I'm *WormGPT Agent* — your autonomous AI. Just send me any task and I'll do it.` + menuText());
      return;
    }
    await sendText(jid,
      '🤖 *WormGPT Agent — Account Authentication*\n\n' +
      'To use the agent you must sign in with the *same email & password* you use on the website:\n' +
      'https://hackerx-v7-d5s4.onrender.com\n\n' +
      '🆕 *New here?* Open the website above, *create an account*, then come back and use those same credentials to sign in here.\n\n' +
      '👉 Send me your *email* now (the one you registered with):');
    return;
  }

  if (/^\/logout\b/i.test(text)) {
    await setState(jid, { authed: 0, user_id: null, state: 'idle' });
    takePending(jid);
    db.clearWormgptMemory(memScope(jid)).catch(() => {});
    daytona.endSession(memScope(jid)).catch(() => {}); // destroy the persistent sandbox + its files
    await sendText(jid, '🚪 Disconnected. Send /start to authenticate again.');
    return;
  }

  // 🗑️ /clearfiles — wipe ONLY the working-directory files in this chat's
  // sandbox (GitHub Actions / Novita / Daytona / whichever backend is active),
  // keeping chat memory, the auth link and the warm sandbox itself. Scoped to
  // THIS chat's sandbox id, so it never affects any other user's files. Placed
  // BEFORE /reset so it is never swallowed by the reset matcher.
  if (/^\/(clearfiles|clearfile|wipefiles|emptyfiles)\b/i.test(text)) {
    if (isBusy(jid)) { await sendText(jid, '⏳ A task is still running — send /stop first, then /clearfiles.'); return; }
    takePending(jid);
    try {
      const res = await agent.clearSessionFiles(memScope(jid));
      if (res && res.ok) {
        const n = res.cleared || 0;
        await sendText(jid,
          `🗑️ Workspace files cleared${res.backend ? ` (${res.backend})` : ''}${n ? ` — removed ${n} file(s)` : ''}.\n` +
          `Your chat memory is kept. The next task starts with an empty working directory.` + menuText());
      } else {
        await sendText(jid, `ℹ️ No sandbox files to clear right now${res && res.error ? ` (${res.error})` : ''}. The next task will start clean anyway.` + menuText());
      }
    } catch (e) {
      await sendText(jid, `⚠️ Could not clear the workspace files: ${e.message}` + menuText());
    }
    return;
  }

  if (/^\/(reset|clear|new)\b/i.test(text)) {
    takePending(jid);
    db.clearWormgptMemory(memScope(jid)).catch(() => {});
    daytona.endSession(memScope(jid)).catch(() => {}); // wipe the sandbox so the next task starts clean
    await sendText(jid, '🧹 Memory & workspace cleared. Starting a fresh sandbox.' + menuText());
    return;
  }

  // 🧠 /last — recall this chat's most recent tasks (per-chat, fully isolated).
  if (/^\/(last|history|recall|mylast)\b/i.test(text)) {
    let hist = [];
    try { hist = await db.getWormgptMemory(memScope(jid), 12); } catch (_) { hist = []; }
    const userTurns = (hist || []).filter(h => h.role === 'user');
    if (!userTurns.length) {
      await sendText(jid, '🧠 I have no recent tasks on record for you yet. Send me a task and I\'ll remember it here.' + menuText());
      return;
    }
    const recent = userTurns.slice(-5).reverse();
    const lines = recent.map((h, i) => `${i + 1}. ${String(h.text || h.content || '').slice(0, 140)}`);
    await sendText(jid,
      `🧠 *Your last ${recent.length} task${recent.length > 1 ? 's' : ''}* (this chat only):\n\n${lines.join('\n')}\n\n` +
      `Just reply with a follow-up and I'll continue from where we left off.` + menuText());
    return;
  }

  if (/^\/help\b/i.test(text)) {
    await sendText(jid, helpText());
    return;
  }

  // 🌐 Authenticated Cloudflare WebSocket tunnel to this chat's sandbox.
  if (cloudflareTunnel && cloudflareTunnel.isStopCommand(text)) {
    if (!link || !link.authed) { await sendText(jid, '🔐 Please authenticate first — send /start.'); return; }
    await sendText(jid, '🛑 Stopping the Cloudflare tunnel and sleeping its sandbox…');
    const result = await cloudflareTunnel.stop(memScope(jid)).catch(e => ({ error: e.message }));
    if (result.error) await sendText(jid, `⚠️ Could not fully stop the tunnel: ${result.error}` + menuText());
    else if (!result.stopped) await sendText(jid, 'ℹ️ No Cloudflare tunnel is active for this chat.' + menuText());
    else await sendText(jid, `✅ Tunnel stopped${result.slept ? ' and sandbox put to sleep' : ''}.` + menuText());
    return;
  }
  if (cloudflareTunnel && cloudflareTunnel.isStartCommand(text)) {
    if (!link || !link.authed) { await sendText(jid, '🔐 Please authenticate first — send /start.'); return; }
    if (isBusy(jid)) { await sendText(jid, '⏳ A task is still running — send /stop first, then start the tunnel.'); return; }
    let provider;
    try { provider = cloudflareTunnel.commandProvider(text); }
    catch (e) { await sendText(jid, `⚠️ ${e.message}` + menuText()); return; }
    await sendText(jid, `⏳ Starting${provider ? ` ${provider}` : ''} sandbox proxy and verifying it through Cloudflare…`);
    try {
      const t = await cloudflareTunnel.start(memScope(jid), { provider });
      const command = cloudflareTunnel.clientCommand(t);
      await sendText(jid,
        `✅ *Cloudflare proxy is active and verified*\n\n` +
        `URL: \`${t.wssUrl}\`\nCloudflare port: *443*\nYour local proxy port: *${t.clientPort}*\n` +
        `Proxy username: \`${t.username}\`\nProxy password: \`${t.password}\`\n\n` +
        `1. Install the client:\n\`curl -fsSL https://hackerx-v7-d5s4.onrender.com/install-proxy-client.sh | sh\`\n` +
        `2. Run:\n\`${command}\`\n` +
        `3. Set your HTTP/HTTPS proxy to \`127.0.0.1:${t.clientPort}\` with the username and password above.\n\n` +
        `Send /stopcloudflare when finished.` + menuText());
    } catch (e) {
      await sendText(jid, `❌ Cloudflare tunnel did not pass verification: ${e.message}` + menuText());
    }
    return;
  }

  // 🛑 STOP / HALT — halt the running sandbox task only (schedules untouched).
  if (/^\/(stop|halt)(?:@\w+)?(?:\s|$)/i.test(text)) {
    const wasBusy = isBusy(jid);
    await sendText(jid, wasBusy ? '🛑 Stopping the running task…' : 'ℹ️ Nothing is running right now — but I cleared any stuck state.');
    await stopCurrentTask(jid);
    takePending(jid);
    await sendText(jid, '✅ Stopped. Send me a new task whenever you’re ready. (Scheduled tasks are still set — use /cancelall to clear those.)' + menuText());
    return;
  }

  // 🚫 /cancel & /cancelall — cancel EVERY scheduled task + stop the running one.
  if (/^\/(cancelall|cancel_all|cancel|clearschedule|clearschedules)\b/i.test(text)) {
    const wasBusy = isBusy(jid);
    if (wasBusy) { try { await agent.stopAgent(memScope(jid)); } catch (_) {} }
    busy.delete(jid);
    busy.delete('__ttl__:' + jid);
    takePending(jid);
    let removed = 0;
    if (scheduler) { try { removed = await scheduler.cancelAll(jid); } catch (_) {} }
    await sendText(jid,
      `✅ Cancelled ${removed} scheduled task${removed === 1 ? '' : 's'}` +
      (wasBusy ? ' and stopped the running task.' : '.') + menuText());
    return;
  }

  // 📅 /schedules — list this chat's pending scheduled tasks.
  if (/^\/(schedules|schedule|scheduled)\b/i.test(text)) {
    if (!scheduler) { await sendText(jid, 'ℹ️ Scheduling is not available right now.'); return; }
    let items = [];
    try { items = await scheduler.list(jid); } catch (_) { items = []; }
    let offMin = scheduler.DEFAULT_TZ_OFFSET_MIN;
    try { offMin = await scheduler.getChatOffsetMin(jid); } catch (_) {}
    if (!items.length) {
      await sendText(jid, `📅 You have no scheduled tasks.\n\nYour timezone: *${scheduler.offsetLabel(offMin)}* (default UTC+1 — say "set timezone to +2" to change).\n\nTo schedule one, tell me *when* in your task, e.g. "at 6pm, generate the daily report".`);
      return;
    }
    const lines = items.map((s, i) => `${i + 1}. ${scheduler.humanizeWhen(s.fireAt, s.offsetMin != null ? s.offsetMin : offMin)} — ${String(s.task).slice(0, 90)}`);
    await sendText(jid, `📅 *Your scheduled tasks (${items.length})* · timezone ${scheduler.offsetLabel(offMin)}:\n\n${lines.join('\n')}\n\nSend /cancelall to clear them all.`);
    return;
  }

  // 📈 /watches — list this chat's active real-time market watches.
  if (/^\/(watches|watch|alerts)\b/i.test(text)) {
    if (!marketWatch) { await sendText(jid, 'ℹ️ Market watching is not available right now.'); return; }
    let items = [];
    try { items = await marketWatch.list(jid); } catch (_) { items = []; }
    if (!items.length) {
      await sendText(jid, '📈 You have no active market watches.\n\nTo start one, tell me what to watch, e.g. "watch XAUUSD and alert me at TP 2650 SL 2600". I check the live price every ~45s and message you the INSTANT a level is hit. 🔔');
      return;
    }
    const wl = items.map((w, i) => `${i + 1}. ${marketWatch.describe(w)}`);
    await sendText(jid, `📈 *Your live market watches (${items.length}):*\n\n${wl.join('\n')}\n\nSend /stopwatch to clear them all.`);
    return;
  }

  // 🛑 /stopwatch — cancel ALL active market watches for this chat.
  if (/^\/(stopwatch|stopwatches|unwatch|clearwatches|stopalerts)\b/i.test(text)) {
    if (!marketWatch) { await sendText(jid, 'ℹ️ Market watching is not available right now.'); return; }
    let removed = 0;
    try { removed = await marketWatch.stopAll(jid); } catch (_) {}
    await sendText(jid, `✅ Cancelled ${removed} market watch${removed === 1 ? '' : 'es'}.`);
    return;
  }

  if (!link) {
    // First contact, no link row yet — greet & start auth.
    await setState(jid, { state: 'await_email', authed: 0 });
    await sendText(jid,
      '👋 Welcome to *WormGPT Agent*.\n\n' +
      'Sign in with the *same email & password* you use on https://hackerx-v7-d5s4.onrender.com\n\n' +
      '👉 Send me your *email* to begin:');
    return;
  }

  // ── Auth: awaiting email ──
  if (link.state === 'await_email' && !kind) {
    const email = normEmail(text);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      await sendText(jid, '⚠️ That doesn\'t look like a valid email. Please send the email you registered with:');
      return;
    }
    await setState(jid, { email, state: 'await_password' });
    await sendText(jid, '🔑 Got it. Now send your *password*:');
    return;
  }

  // ── Auth: awaiting password ──
  if (link.state === 'await_password' && !kind) {
    const password = text;
    const user = await db.getUserByEmail(link.email).catch(() => null);
    if (!user) {
      await setState(jid, { state: 'await_email' });
      await sendText(jid, '❌ No account found with that email on the website. Sign up first at https://hackerx-v7-d5s4.onrender.com then send your email again.');
      return;
    }
    if (user.blocked) {
      await setState(jid, { state: 'idle' });
      await sendText(jid, '⛔ This account is blocked. Contact support.');
      return;
    }
    const ok = (() => { try { return bcrypt.compareSync(password, user.password); } catch { return false; } })();
    if (!ok) {
      await setState(jid, { state: 'await_password' });
      await sendText(jid, '❌ Incorrect password. Please send your password again:');
      return;
    }
    await setState(jid, { authed: 1, user_id: user.id, email: user.email, state: 'ready' });
    await sendText(jid,
      `✅ *Connected!* Signed in as \`${user.email}\`.\n\n` +
      `Your website account now shows as *linked*.\n\n` +
      `I'm *WormGPT Agent* — send me ANY task and I'll do it end-to-end. 👇` + menuText());
    return;
  }

  // Must be authed beyond this point.
  if (!link.authed || !link.user_id) {
    await sendText(jid, '🔐 Please authenticate first — send /start.');
    return;
  }

  // ── Authenticated: handle media (with or without caption) ──
  if (kind) {
    let att;
    try { att = await downloadIncoming(msg); }
    catch (e) { await sendText(jid, '❌ Could not download the attachment: ' + e.message); return; }
    if (att.buffer && att.buffer.length > WA_MAX_DOWNLOAD) {
      await sendText(jid, `⚠️ That file is too large (max ${(WA_MAX_DOWNLOAD / 1024 / 1024) | 0} MB).`);
      return;
    }
    const caption = text;
    // Always wait for a separate instruction. Forwarded media can retain the
    // original caption, so processing it immediately would act without consent.
    const first = !(pending.get(jid) && pending.get(jid).files.length);
    att.receivedCaption = caption || null;
    bufferAttachment(jid, att);
    if (first) {
      const what = att.isImage
        ? '🖼️ I received your image. What would you like me to do with it? I will wait for your instruction before analyzing or editing it.'
        : `📎 I received *${att.name}*. What would you like me to do with it? I will not open, analyze, extract, or modify it until you send an instruction. You can send more files first.`;
      await sendText(jid, what);
    }
    return;
  }

  // ── Authenticated text → agent task ──
  if (!text) {
    await sendText(jid, 'Send me a task (text), an image to analyze, or a file (PDF / ZIP / code) to work on.' + menuText());
    return;
  }

  // 🎵 SPOTIFY: a Spotify track/album/playlist link → download it directly (same
  // converter + tiered quota as the website) instead of the slow agent loop.
  if (spotifyBot) {
    const detected = spotifyBot.detectSpotifyLink(text);
    if (detected) {
      takePending(jid); // a Spotify link is a standalone action
      await handleSpotify(jid, link, detected);
      return;
    }
  }

  // 🔗 SYNC: file(s) sent without caption + this instruction → fuse into ONE task.
  const buffered = takePending(jid);

  // 📈 REAL-TIME MARKET WATCH DETECTION (parity with Telegram). Register a live
  // price watch that alerts this chat the instant a TP/SL/level is hit AND sends
  // periodic price feedback / recheck updates even before a target is reached.
  if (marketWatch && !buffered.length) {
    try {
      const w = marketWatch.parseWatch(text);
      if (w && w.symbol && ((w.targets && w.targets.length) || w.feedback)) {
        const entry = await marketWatch.add(jid, w.symbol, w.targets || [], { interval: w.interval, feedback: true, feedbackMs: w.feedbackMs, feedbackMovePct: w.feedbackMovePct });
        const legs = (entry.targets || []).map(l => `${l.label} ${marketWatch._fmt(l.price)}`).join(', ');
        const fbMin = Math.round((entry.feedbackMs || 300000) / 60000);
        await sendText(jid,
          `📈 *Live watch armed* — monitoring *${entry.symbol}* in real time (rechecked every ~45s).\n\n` +
          (legs ? `🔔 Alert legs: ${legs}\n` : `🔁 Mode: live price feedback (no fixed target)\n`) +
          (entry.startPrice != null ? `💲 Current price: ${marketWatch._fmt(entry.startPrice)} (${entry.startSrc || 'live'})\n` : '') +
          `\n🔁 I'll send a price update every ~${fbMin} min and the INSTANT the price moves — plus an immediate alert if any level is hit. Send /watches to review or /stopwatch to cancel.`);
        return;
      }
    } catch (e) {
      if (/active market watches/.test(e.message || '')) { await sendText(jid, '⚠️ ' + e.message); return; }
    }
  }

  // ⏰⏱️ SCHEDULE + TIME-BOX DETECTION (parity with Telegram).
  let minDurationMs = 0;
  if (scheduler) {
    // 🌍 TIMEZONE: default UTC+1; a message that sets a timezone persists it.
    let chatOffset = scheduler.DEFAULT_TZ_OFFSET_MIN;
    try { chatOffset = await scheduler.getChatOffsetMin(jid); } catch (_) {}
    try {
      const tz = scheduler.parseTimezone(text);
      if (tz) {
        chatOffset = await scheduler.setChatOffsetMin(jid, tz.offsetMin);
        if (!scheduler.parseSchedule(text, chatOffset)) {
          await sendText(jid,
            `🌍 Timezone set to *${scheduler.offsetLabel(chatOffset)}*.\n` +
            `All your scheduled tasks will now use this time. (Default is UTC+1.)`);
          return;
        }
      }
    } catch (_) {}

    try {
      const sched = scheduler.parseSchedule(text, chatOffset);
      if (sched && sched.fireAt) {
        const dur = scheduler.parseDuration(text);
        if (buffered.length) {
          await sendText(jid, `📎 I'll use your file${buffered.length > 1 ? 's' : ''} now (scheduled tasks can't hold files). Running immediately.`);
        } else {
          const entry = await scheduler.add(jid, sched.cleanTask || text, sched.fireAt, { minDurationMs: dur, offsetMin: sched.offsetMin });
          await sendText(jid,
            `⏰ Scheduled! I'll run this ${scheduler.humanizeWhen(entry.fireAt, sched.offsetMin)}:\n\n"${String(entry.task).slice(0, 200)}"\n\n` +
            `Send /schedules to see all, or /cancelall to clear them.`);
          return;
        }
      }
    } catch (e) {
      if (/scheduled tasks/.test(e.message || '')) { await sendText(jid, '⚠️ ' + e.message); return; }
    }
    try { minDurationMs = scheduler.parseDuration(text) || 0; } catch (_) { minDurationMs = 0; }
    if (minDurationMs) {
      await sendText(jid, `⏱️ Got it — I'll keep working and improving for about ${Math.round(minDurationMs / 60000)} min, exploring new angles until then.`);
    }
  }

  if (buffered.length) {
    const names = buffered.map(f => f.name).join(', ');
    await sendText(jid, `📎 Got it — using your file${buffered.length > 1 ? 's' : ''} (${names}) with this instruction.`);
    await runTask(jid, text, buffered, { minDurationMs });
    return;
  }

  await runTask(jid, text, [], { minDurationMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket lifecycle (connect, pairing code, auto-reconnect). Self-contained;
// does NOT share any socket/state with services/whatsapp.js.
// ─────────────────────────────────────────────────────────────────────────────
async function connect() {
  if (!enabled()) { console.log('⏳ WormGPT WhatsApp bot disabled (set WHATSAPP_BOT_NUMBER to enable).'); return; }
  if (starting) return;
  if (sock && (status === 'connected' || status === 'connecting' || status === 'pairing')) return;
  starting = true;

  // Tear down any lingering socket before opening a new one.
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.end(new Error('replacing socket')); } catch (_) {}
    sock = null;
  }

  const { state, saveCreds: persist } = await loadAuthState();
  saveCreds = persist;
  const { version } = await fetchLatestBaileysVersion();

  const num = botNumber();
  // 🐛 RE-PAIR FIX (defensive): an EXPLICIT admin pair/re-pair request must never
  // be blocked by stale "registered" creds. If something (a racing creds.update
  // from a dying socket, a partial disk wipe, a DB read lag) left a registered
  // identity behind, wipe it now and reload a clean (unregistered) auth state so
  // requestPairingCode() will actually run and the link-device notification
  // fires. Without this, re-pairing the env-default number (2349119289980) kept
  // loading its old registered creds → usePairingCode=false → silent idle.
  let authState = state;
  if (num && wantPairing && authState.creds.registered) {
    console.log('♻️ WA-BOT explicit pair requested but stale registered creds found — wiping and reloading clean auth state.');
    try { await clearPersistedCreds(); } catch (_) {}
    const fresh = await loadAuthState();
    authState = fresh.state;
    saveCreds = fresh.saveCreds;
  }

  // 🔒 PAIRING SPAM FIX: pair ONLY when (a) a number is set, (b) creds are not
  // yet registered, AND (c) an admin explicitly requested pairing this cycle.
  // The auto-reconnect/watchdog path leaves wantPairing=false, so it will NEVER
  // fire a pairing code to the owner's phone on its own.
  const usePairingCode = !!(num && !authState.creds.registered && wantPairing);

  // If creds aren't registered and nobody asked to pair, there is nothing for
  // this socket to do but spam pairing — so bail out cleanly and stay idle.
  if (num && !authState.creds.registered && !wantPairing) {
    console.log('🔕 WA-BOT not linked and no pairing requested — staying idle (no code will be sent). Admin: POST /api/admin/whatsapp-bot/pair to link.');
    sock = null;
    starting = false;
    status = 'idle';
    await saveStatus({ status: 'unlinked' });
    return;
  }

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: authState,
    browser: Browsers.macOS('Safari'),
    // 🩹 STABILITY (Baileys 6.7.23): a short, explicit keep-alive is the #1 cure
    // for the "bot answers for a while then silently stops" symptom. Baileys'
    // default keep-alive can let a half-dead WebSocket linger (the TCP socket
    // stays "open" but the WhatsApp stream is gone), so inbound messages stop
    // arriving and outbound replies vanish with no close event. A 20s WhatsApp-
    // level ping detects a stale stream fast and forces a clean reconnect via
    // the connection.update handler below, so the bot keeps answering 24/7.
    keepAliveIntervalMs: 20000,
    // Give a slow Render free-dyno enough time to complete the auth handshake
    // before Baileys gives up — prevents spurious cold-start disconnects.
    connectTimeoutMs: 60000,
    // Wait up to 25s for a query (presence/usync/etc.) before timing out, so a
    // momentarily slow network doesn't tear the whole socket down.
    defaultQueryTimeoutMs: 25000,
    // Auto-resend a message if WhatsApp asks for a retry receipt, instead of
    // dropping it — keeps replies reliable across brief network blips.
    retryRequestDelayMs: 350,
    // This is a BOT, not a tracker — no need to sync chat history.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    // 🛑 440-FLAP FIX: do NOT force ourselves "online" on connect. Forcing
    // presence makes this Baileys socket fight the linked PHONE (and any other
    // linked-device session) for the single active WhatsApp session — which is
    // exactly what triggers the endless `conflictReplaced` (440) flap where the
    // bot connects for a few seconds, gets kicked, reconnects, and NEVER stays
    // online long enough to answer a message. The proven-stable per-user tracker
    // (services/whatsapp.js) keeps this false for the same reason. The bot can
    // still receive AND reply perfectly while presence is "unavailable".
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // 🛑 DOUBLE-FIRE FIX (layer 3): provide getMessage so Baileys' retry logic
    // has a defined (no-op) source instead of triggering extra decrypt/retry
    // round-trips that can re-deliver the same message through messages.upsert.
    // We don't keep an outgoing message store (this is a stateless bot), so we
    // simply return undefined — combined with the message-id dedup above, this
    // keeps each inbound message handled exactly once.
    getMessage: async () => undefined,
  });

  status = 'connecting';
  pairingCode = null;
  pairingSocket = null; // clear so the new socket can request a code once
  markAlive();          // fresh socket → reset the stale-watchdog clock
  startWatchdog();      // ensure the half-dead-socket watchdog is running
  // Safety: clear the single-flight lock if no connection event arrives.
  setTimeout(() => { starting = false; }, 45000);

  // Persist creds AND treat every creds.update as a sign of life (the socket is
  // actively talking to WhatsApp), so the watchdog never trips on a busy link.
  sock.ev.on('creds.update', (...args) => { markAlive(); return saveCreds(...args); });

  // ── Pairing code (only when not yet registered) ──
  // 🐛 PAIRING-NOTIFICATION FIX (Baileys 6.7+):
  // requestPairingCode() MUST be called only AFTER the socket has emitted its
  // first connection ref (the `qr` field on a 'connection.update' event). The
  // old code fired it on a blind setTimeout(3000) — BEFORE that ref existed —
  // so WhatsApp handed back a code that was NOT actually registered for the
  // "Link with phone number" flow: the code displayed, but entering it on the
  // phone did nothing and NO link-device notification ever fired. That is the
  // exact "code generates but user gets no pairing notification" bug.
  //
  // Fix (mirrors the working logic in services/whatsapp.js): arm a one-shot
  // requester that fires the instant the first `qr` ref arrives (handled in the
  // 'connection.update' listener below via _firePairing). A long fallback timer
  // only kicks in if the ref never shows up, so we still degrade gracefully.
  if (usePairingCode) {
    // Capture the socket this connect() created so the retry loop can bail
    // out if connect() is called again and replaces the socket.
    const thisSock = sock;
    pairingSocket = thisSock;
    pairRequested = false;

    const requestCode = async (attempt = 1) => {
      // Abort if this socket was replaced by a newer connect() call.
      if (sock !== thisSock || pairingSocket !== thisSock) return;
      if (pairingCode || status === 'connected') return;
      pairRequested = true;
      try {
        const code = await sock.requestPairingCode(num);
        // Double-check we're still on the same socket after the await.
        if (sock !== thisSock || pairingSocket !== thisSock) return;
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        pairingCode = pretty;
        status = 'pairing';
        wantPairing = false; // 🔒 one code per explicit request — do not auto-renew
        await saveStatus({ status: 'pairing', pairing_code: pretty, phone: num });
        console.log(`\n🔗 WormGPT WhatsApp bot pairing code for +${num}: ${pretty}`);
        console.log('   On the bot phone: WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number → enter the code above.\n');
      } catch (e) {
        console.error(`WA-BOT requestPairingCode attempt ${attempt} error:`, e.message);
        // Only retry on the same socket.
        if (sock !== thisSock || pairingSocket !== thisSock) return;
        pairRequested = false; // allow a retry to re-arm
        if (attempt < 5) setTimeout(() => requestCode(attempt + 1), 2500);
        else { status = 'error'; }
      }
    };

    // Primary trigger: the 'connection.update' handler calls this the moment
    // the first connection ref (`qr`) is emitted — the ONLY point at which
    // WhatsApp registers the code for the link-device flow (and fires the
    // notification on the bot phone).
    firePairing = () => {
      if (sock !== thisSock || pairingSocket !== thisSock) return;
      if (pairRequested || pairingCode || status === 'connected') return;
      requestCode(1);
    };

    // Fallback safety net: if no ref event arrives within ~8s (rare network
    // stalls), try anyway so we are never left without a code.
    setTimeout(() => { if (!pairRequested) firePairing(); }, 8000);
  } else {
    firePairing = null;
  }

  // ── Incoming messages ──
  // NOTE: bind this listener exactly ONCE per socket. connect() always tears
  // down the previous socket (removeAllListeners) before creating a new one, so
  // there is never more than one live `messages.upsert` subscriber.
  sock.ev.on('messages.upsert', ({ messages = [], type }) => {
    markAlive(); // ANY inbound traffic proves the stream is alive (incl. history/receipts)
    if (type !== 'notify') return; // only fresh messages, not history backfill
    for (const m of messages) {
      if (!m?.message) continue;
      if (m.key?.fromMe) continue; // never react to our own outgoing messages
      // 🛑 DOUBLE-FIRE FIX: Baileys can deliver the same message twice (encrypted
      // + decrypted copy, retry receipts, reconnect overlap). Claim each message
      // id exactly once — duplicates are dropped here before any work happens, so
      // the agent runs (and replies) a single time per real message.
      if (!claimMessage(m.key?.id)) {
        continue;
      }
      // 🔎 DIAGNOSTIC: log every accepted inbound message so we can SEE in the
      // Render logs whether messages actually reach the handler (vs. the socket
      // dropping them). Helps distinguish "never received" from "received but
      // reply failed to send".
      try {
        const _jid = m.key?.remoteJid || '?';
        const _t = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').slice(0, 60);
        console.log(`📩 WA-BOT inbound from ${_jid}: "${_t}" (status=${status})`);
      } catch (_) {}
      // 📩 Mark the incoming message as read. This is a lightweight session
      // signal that keeps WhatsApp's delivery path healthy for our OUTGOING
      // reply, WITHOUT forcing "online" presence (which is what triggers the
      // 440 conflict fight — see markOnlineOnConnect:false above). Best-effort.
      try { if (sock && m.key) sock.readMessages([m.key]).catch(() => {}); } catch (_) {}
      // Enqueue on the per-jid serial queue so a file + its following instruction
      // (sent back-to-back) are handled in order and FUSED into one task, instead
      // of racing and being treated as two separate tasks.
      enqueueIncoming(m);
    }
  });


  // ── Auto-reject calls so the bot never "rings" (optional nicety) ──
  sock.ev.on('call', async (calls) => {
    for (const c of (calls || [])) {
      if (c.status === 'offer') {
        try { await sock.rejectCall(c.id, c.from); } catch (_) {}
      }
    }
  });

  // ── Connection lifecycle ──
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── Pairing trigger ──────────────────────────────────────────────────
    // The first time WhatsApp emits a connection ref (`qr`) the socket is
    // ready to register a pairing code for the "Link with phone number" flow.
    // This is the ONLY moment that produces a code WhatsApp will actually
    // honour (and that fires the link-device notification on the bot phone).
    if (qr && usePairingCode && typeof firePairing === 'function') {
      firePairing();
    }

    if (connection === 'open') {
      starting = false;
      status = 'connected';
      markAlive(); // healthy connect → reset stale-watchdog clock
      startWatchdog(); // (idempotent) ensure the watchdog is running
      pairingCode = null;
      wantPairing = false; // 🔒 linked successfully — clear any pending pair request
      // 🔧 STABILITY FIX: clear the scheduled-reconnect handle now that we are
      // live. ensureLive() skips reviving while reconnectTimer is set, so a
      // stale (already-fired) handle would otherwise block all future revives.
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      // ✅ A successful OPEN proves the creds are valid → any prior 401s were
      // transient (cold-start/handshake), so reset the 401 tolerance counter
      // immediately. Without this, scattered transient 401s over the lifetime of
      // the process could slowly accumulate to MAX_401_RETRIES and wrongly wipe
      // a perfectly good session.
      unauthorizedCount = 0;
      const me = sock.user?.id || '';
      console.log(`✅ WormGPT WhatsApp bot online as ${me}`);
      await saveStatus({ status: 'connected', phone: botNumber() });
      // ⏰ Start the shared scheduler once (its runner re-enters runTask for the
      // scheduled jid when a task's time arrives). Idempotent — scheduler.start
      // no-ops if already running.
      if (scheduler) {
        try {
          scheduler.start(async ({ chatId, task, minDurationMs }) => {
            // WhatsApp owns jids (contain '@'). Let Telegram handle numeric ids.
            if (!String(chatId).includes('@')) return false;
            try {
              const l = await getLink(String(chatId));
              if (!l || !l.authed || !l.user_id) return true; // ours, user logged out — consume
              await sendText(chatId, `⏰ Running your scheduled task now:\n\n"${String(task).slice(0, 200)}"`);
              await runTask(String(chatId), String(task), [], { minDurationMs: minDurationMs || 0 });
            } catch (_) {}
            return true;
          });
        } catch (_) {}
      }
      // 📈 Start the shared MARKET WATCH once — give it a live-price source, then
      // register a notifier so a watched WhatsApp jid gets an instant SL/TP alert.
      if (marketWatch) {
        try {
          if (manusToolsWA && typeof manusToolsWA.getSpot === 'function') {
            marketWatch.setPriceFetcher((symbol) => manusToolsWA.getSpot(symbol));
          }
          marketWatch.start(async ({ chatId, event, watch }) => {
            if (!String(chatId).includes('@')) return false; // Telegram handles numeric ids
            try {
              const l = await getLink(String(chatId));
              if (!l || !l.authed || !l.user_id) return true; // ours, logged out — consume
              await sendText(String(chatId), event.text);
              const isTargetHit = event && !['poll', 'change'].includes(event.type);
              if (watch && watch.interactive && isTargetHit) {
                await sendText(String(chatId), '🤖 Analyzing the move for you…');
                const followup = `${watch.symbol} just ${event.label} at ${event.target} (live ${event.price}). ` +
                  `Use get_market_price to pull the latest ${watch.symbol} data and give a concise, accurate read: ` +
                  `real breakout or fakeout, next key levels, and the smartest next move with fresh SL/TP.`;
                await runTask(String(chatId), followup, [], {});
              }
            } catch (_) {}
            return true;
          });
        } catch (_) {}
      }
      // 📊 Start the shared 24/7 TRADING watcher once — register a WhatsApp
      // notifier so any OPEN trade on this jid fires an instant TP/SL alert.
      if (tradingEngineWA && tradingEngineWA.enabled()) {
        try {
          tradingEngineWA.start(async ({ chatId, event }) => {
            if (!String(chatId).includes('@')) return false; // Telegram handles numeric ids
            try {
              const l = await getLink(String(chatId));
              if (!l || !l.authed || !l.user_id) return true; // ours, logged out — consume
              await sendText(String(chatId), event.text);
            } catch (_) {}
            return true;
          });
        } catch (_) {}
      }
      // ⏱️ Only treat this as a HEALTHY connection (and reset the backoff) if it
      // STAYS open for 30s. A connect→440→connect flap (rival session) closes
      // within seconds, so it must keep escalating the backoff instead of
      // resetting to a fast 60s every cycle.
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        reconnectAttempts = 0;
        // Healthy for 30s → the fight is over; clear the 440 stand-down state so
        // a FUTURE genuine drop reconnects normally instead of staying down.
        conflictCount = 0;
        standDown = false;
      }, 30000);
    } else if (connection === 'close') {
      starting = false;
      status = 'idle';
      if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`WA-BOT connection closed (code=${code}). loggedOut=${loggedOut}`);
      await saveStatus({ status: 'closed' });
      if (loggedOut) {
        // 🩹 401 TOLERANCE FIX: a 401 is *usually* reported as a "logout", but on
        // Render's free tier it is very often a TRANSIENT handshake/cold-start
        // failure, not a real device unlink. Wiping creds on the first 401 (the
        // old behaviour) left the bot permanently offline & silent — exactly the
        // "shows online, marks blue, never answers" bug. So: for the first few
        // 401s we KEEP the creds and simply reconnect with a short backoff. Only
        // after MAX_401_RETRIES consecutive 401s do we accept it as a genuine
        // unlink, wipe creds, and go idle (admin must re-pair). A healthy OPEN
        // resets unauthorizedCount to 0.
        unauthorizedCount += 1;
        if (unauthorizedCount <= MAX_401_RETRIES) {
          const delay = Math.min(3000 * unauthorizedCount, 20000); // 3s → 6s → 9s → 12s
          console.log(`WA-BOT 401 (Unauthorized) — likely transient (attempt ${unauthorizedCount}/${MAX_401_RETRIES}). Keeping creds; reconnecting in ${Math.round(delay / 1000)}s.`);
          status = 'idle';
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(e => console.error('WA-BOT reconnect error:', e.message)); }, delay);
          return;
        }
        // Repeated 401s → treat as a real logout. Wipe creds. We do NOT auto
        // re-pair (that spammed the owner's phone). Stay idle; an admin must
        // explicitly request pairing.
        await clearPersistedCreds();
        wantPairing = false;
        status = 'idle';
        reconnectAttempts = 0;
        unauthorizedCount = 0;
        await saveStatus({ status: 'unlinked' });
        console.log(`WA-BOT genuinely logged out after ${MAX_401_RETRIES} consecutive 401s — cleared creds. No auto-pairing. Admin: POST /api/admin/whatsapp-bot/pair to re-link.`);
        return;
      }

      // 🛑 CONFLICT (440 = conflictReplaced / connectionReplaced): another live
      // WhatsApp session (the linked phone, or another WhatsApp Web tab) has
      // taken over this account. Reconnecting fast just RE-triggers the takeover
      // → an endless flap loop where the bot connects for ~5s, gets kicked,
      // reconnects… and NEVER stays online long enough to receive or answer a
      // message (the "WhatsApp says nothing back" bug we actually observed in
      // the Render logs: dozens of "conflict (440) … Reclaiming in 8s" lines).
      //
      // PROVEN CURE (mirrors the stable per-user tracker in services/whatsapp.js):
      // back off with a growing delay for the FIRST few conflicts, then STAND
      // DOWN entirely. Standing down lets the rival session keep the single
      // active WhatsApp session so the fight ends — and the 2-min watchdog
      // (ensureLive) will re-establish later if the session genuinely drops, so
      // the bot still self-heals without flapping. Combined with
      // markOnlineOnConnect:false above (we no longer fight for presence), this
      // ends the loop and the bot stays online to answer messages.
      const isConflict = code === DisconnectReason.connectionReplaced || code === 440;
      if (isConflict) {
        conflictCount += 1;
        // 🔧 DEDICATED-NUMBER TUNING: the bot runs on a dedicated number with no
        // rival human session, so a 440 here is almost always a transient flap
        // (cold-start / network blip) rather than a real takeover. Be patient:
        // back off and retry for more cycles before ever standing down, and when
        // we DO stand down, re-arm after just 90s (not 10 min) so the bot can't
        // sit silent for long. Tunable via WA_BOT_CONFLICT_RETRIES /
        // WA_BOT_STANDDOWN_MS.
        const CONFLICT_RETRIES = parseInt(process.env.WA_BOT_CONFLICT_RETRIES || '5', 10);
        const STANDDOWN_MS = parseInt(process.env.WA_BOT_STANDDOWN_MS || String(90 * 1000), 10);
        if (conflictCount <= CONFLICT_RETRIES) {
          const delay = Math.min(6000 * conflictCount, 30000); // 6s → 12s → … → 30s
          console.log(`WA-BOT conflict (440): session replaced. Backing off ${Math.round(delay / 1000)}s before retry (conflict ${conflictCount}/${CONFLICT_RETRIES}).`);
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(e => console.error('WA-BOT reconnect error:', e.message)); }, delay);
        } else {
          // Repeatedly replaced → STAND DOWN briefly so only ONE session survives.
          // The watchdog's ensureLive() revives us once standDown clears. On a
          // dedicated number the re-arm is short (90s) so the bot self-heals fast.
          standDown = true;
          status = 'idle';
          console.log(`WA-BOT standing down after ${conflictCount} consecutive 440 conflicts. Re-arming in ${Math.round(STANDDOWN_MS / 1000)}s (or on an admin pair/start).`);
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          setTimeout(() => {
            standDown = false;
            conflictCount = 0;
            console.log('WA-BOT stand-down window elapsed — re-arming reconnect.');
            ensureLive().catch(() => {});
          }, STANDDOWN_MS);
        }
        return;
      }

      // 515 restartRequired — NORMAL right after a successful pairing handshake.
      // Reconnect almost immediately so the freshly-registered creds come online.
      const restartRequired = code === DisconnectReason.restartRequired || code === 515;
      if (restartRequired) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(e => console.error('WA-BOT reconnect error:', e.message)); }, 1500);
        return;
      }

      // Transient drop → reconnect with EXPONENTIAL backoff (capped). wantPairing
      // stays false, so a reconnect on an UNREGISTERED session just goes idle.
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      const delay = Math.min(4000 * Math.pow(2, reconnectAttempts - 1), 2 * 60 * 1000);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(e => console.error('WA-BOT reconnect error:', e.message)); }, delay);
    } else if (connection === 'connecting') {
      status = 'connecting';
    }
  });
}

// Public API (mirrors wormgptBot: enabled/start). `ensureLive` lets the
// server's keep-alive loop revive the socket after Render cold-starts.
async function start() {
  // Hydrate the admin number override BEFORE deciding enabled/connecting.
  if (numberOverride === null) { await loadNumberOverride().catch(() => {}); }
  if (!enabled()) { console.log('⏳ WormGPT WhatsApp bot disabled (set WHATSAPP_BOT_NUMBER or configure a number in the admin panel to enable).'); return; }
  // Explicit (re)start is a fresh attempt — clear any 440 stand-down so we will
  // actually try to come online.
  standDown = false;
  conflictCount = 0;
  unauthorizedCount = 0; // fresh explicit start → reset 401 tolerance counter
  await connect().catch(e => console.error('WA-BOT start error:', e.message));
}

async function ensureLive() {
  if (numberOverride === null) { await loadNumberOverride().catch(() => {}); }
  if (!enabled()) return;
  // Do not interfere if already connecting, pairing (waiting for user to link
  // the device), or connected — only revive a truly dead / errored socket.
  if (status === 'connecting' || status === 'pairing' || status === 'connected') return;
  // 🛑 440-FLAP FIX: if we have STOOD DOWN after repeated conflicts, do NOT
  // revive here — that would restart the fight loop with the rival session and
  // leave the bot flapping (and silent) again. The stand-down timer (10 min)
  // clears the flag and re-arms on its own; an admin start/pair also clears it.
  if (standDown) return;
  // 🔧 STABILITY FIX: if a reconnect is ALREADY scheduled (e.g. after a 440
  // conflict close, status is 'idle' but reconnectTimer is pending), do NOT
  // fire a second connect() here. Two concurrent connect()s racing on the same
  // creds re-trigger the very conflict we're recovering from — an endless flap
  // that left the bot unable to ever answer. Let the scheduled reconnect win.
  if (reconnectTimer) return;
  if (!sock || status === 'idle' || status === 'error') {
    await connect().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: change the WhatsApp bot number at runtime. Persists the new number to
// the settings store (overriding the env var), wipes the old WhatsApp link &
// session, tears down the live socket, and reconnects so a FRESH pairing code
// is generated for the new number. The admin then reads that code from
// GET /api/admin/whatsapp-bot to link the new phone.
//
//   newNumber: full international form, digits only (e.g. "2349119289980").
//              Leading "+" / spaces / dashes are stripped automatically.
//
// Returns the live status object (same shape as getStatus()).
// ─────────────────────────────────────────────────────────────────────────────
async function setNumber(newNumber) {
  const digits = String(newNumber || '').replace(/[^0-9]/g, '');
  if (!digits) throw new Error('A valid phone number (digits only, full international form) is required.');
  if (digits.length < 8 || digits.length > 15) throw new Error('Phone number must be 8–15 digits in full international form (e.g. 2349119289980).');

  const previous = botNumber();
  const sameNumber = digits === previous;

  // 1) Persist the override and refresh the in-memory cache.
  try { await db.setSetting(WA_BOT_NUMBER_KEY, digits); } catch (e) {
    throw new Error('Failed to save the new number: ' + e.message);
  }
  numberOverride = digits;

  // 2) Cancel any pending reconnect and tear down the current socket.
  //    Every teardown step is wrapped so a rejected promise / throw from the
  //    half-open Baileys socket can NEVER bubble up and crash the request
  //    (which would close the HTTP connection with an empty body and make the
  //    admin panel throw "Unexpected end of JSON input").
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // 🐛 RE-PAIR FIX: detach the OLD socket's creds persister BEFORE we tear it
  //    down. dead.logout() fires a final `creds.update`; if the wrapped
  //    saveCreds() is still live it re-writes the (still-registered) creds back
  //    to the settings store AND re-reads SESS_DIR — racing with (and undoing)
  //    the clearPersistedCreds() below. That stale registered identity then
  //    makes the next connect() set usePairingCode=false → it bails to idle →
  //    NO pairing code and NO notification (exactly the 2349119289980 bug).
  //    Nulling saveCreds + removing listeners guarantees the dying socket can
  //    no longer persist anything.
  saveCreds = null;
  if (sock) {
    const dead = sock;
    sock = null;
    try { dead.ev.removeAllListeners(); } catch (_) {}
    // sock.logout() is async and may reject — swallow it explicitly.
    try { Promise.resolve(dead.logout()).catch(() => {}); } catch (_) {}
    try { dead.end(new Error('switching bot number')); } catch (_) {}
  }

  // 3) Wipe the old session creds so the next connect re-pairs from scratch.
  //    (Changing the number means the old linked device is no longer valid.)
  //    Runs AFTER the teardown above so the dead socket cannot re-persist.
  try { await clearPersistedCreds(); } catch (_) { /* best-effort */ }

  // 4) Reset runtime state and reconnect to generate a new pairing code.
  //    Changing the number is an EXPLICIT admin action, so we allow one pairing
  //    code to be generated for the new number.
  status = 'idle';
  starting = false;
  pairingCode = null;
  pairingSocket = null; // abort any lingering requestPairingCode retry loops
  wantPairing = true;   // 🔒 explicit admin re-link → permit a single pairing code
  standDown = false; conflictCount = 0; // explicit admin action — clear 440 stand-down
  try {
    await saveStatus({ status: 'switching', phone: digits, previous: previous || null });
  } catch (_) { /* best-effort */ }
  console.log(`🔁 WA-BOT number changed${sameNumber ? ' (same number — re-linking)' : ` from +${previous || 'none'} to +${digits}`}. Re-pairing…`);

  // Kick off the reconnect WITHOUT awaiting it — the pairing code lands in
  // getStatus() shortly after via the admin panel's poll. Awaiting connect()
  // here risks tying the HTTP response to a slow/failing socket handshake.
  setImmediate(() => {
    connect().catch(e => console.error('WA-BOT reconnect after setNumber error:', e.message));
  });

  return getStatus();
}

function getStatus() { return { enabled: enabled(), status, pairingCode, number: botNumber() }; }

// ─────────────────────────────────────────────────────────────────────────────
// Admin: EXPLICITLY request a pairing code. This is the ONLY way a code gets
// sent to the bot phone now (the auto-reconnect/watchdog never pairs). It sets
// the one-shot wantPairing flag, tears down any idle socket, and connects so a
// single fresh code is generated. The admin reads it from GET
// /api/admin/whatsapp-bot. Safe to call when already connected (it no-ops).
// ─────────────────────────────────────────────────────────────────────────────
async function requestPairing() {
  if (numberOverride === null) { await loadNumberOverride().catch(() => {}); }
  if (!enabled()) throw new Error('No WhatsApp bot number configured. Set one first.');
  if (status === 'connected') {
    return { ...getStatus(), note: 'already linked' };
  }
  wantPairing = true;
  standDown = false; conflictCount = 0; // explicit admin pair — clear 440 stand-down
  pairingCode = null;
  // Tear down any lingering idle socket so connect() starts cleanly.
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Detach the old socket's creds persister before teardown so a final
  // creds.update from the dying socket can't race state (mirrors setNumber).
  saveCreds = null;
  if (sock) {
    const dead = sock; sock = null;
    try { dead.ev.removeAllListeners(); } catch (_) {}
    try { dead.end(new Error('requesting pairing')); } catch (_) {}
  }
  status = 'idle';
  starting = false;
  pairingSocket = null;
  setImmediate(() => { connect().catch(e => console.error('WA-BOT requestPairing connect error:', e.message)); });
  return getStatus();
}

module.exports = { enabled, start, ensureLive, getStatus, setNumber, requestPairing, loadNumberOverride, broadcast };

// Internal helpers exposed ONLY for the dedup/stability + send-resilience unit
// tests (scripts/test-wa-dedup.js, scripts/test-wa-send.js). Not used by the app.
// `__setState` lets a test inject a mock socket + connection status so safeSend's
// liveness-wait + retry behaviour can be exercised without a real WhatsApp link.
module.exports.__test__ = {
  claimMessage, seenMessageIds, busy, activeRuns, isBusy, stopCurrentTask, SEEN_TTL_MS, SEEN_MAX,
  safeSend, waitForLiveSocket,
  pending, bufferAttachment, takePending, PENDING_TTL, mediaKind, extractText,
  __setState: (s) => {
    if (s && Object.prototype.hasOwnProperty.call(s, 'sock')) sock = s.sock;
    if (s && Object.prototype.hasOwnProperty.call(s, 'status')) status = s.status;
    if (s && Object.prototype.hasOwnProperty.call(s, 'standDown')) standDown = s.standDown;
    if (s && Object.prototype.hasOwnProperty.call(s, 'reconnectTimer')) reconnectTimer = s.reconnectTimer;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 📢 Broadcast an admin announcement to every WhatsApp user who linked the
// WormGPT agent (authed rows in patcher_links whose chat_id is `wa:<jid>`).
// Returns { sent, failed, total }. Never throws.
// ─────────────────────────────────────────────────────────────────────────────
async function broadcast(text) {
  const msg = String(text || '').trim();
  if (!enabled() || status !== 'connected' || !sock || !msg) {
    return { sent: 0, failed: 0, total: 0, offline: status !== 'connected' };
  }
  let links = [];
  try { links = await db.getAuthedPatcherLinks(); } catch (_) { links = []; }
  // Only WhatsApp links (chat_id = "wa:<jid>"); strip the "wa:" prefix to get the jid.
  const targets = links
    .filter(l => l && l.chat_id && String(l.chat_id).startsWith('wa:'))
    .map(l => String(l.chat_id).slice(3));
  let sent = 0, failed = 0;
  for (const jid of targets) {
    try {
      await sendText(jid, `📢 *Announcement*\n\n${msg}`);
      sent++;
    } catch (_) { failed++; }
    await new Promise(res => setTimeout(res, 120));
  }
  return { sent, failed, total: targets.length };
}

