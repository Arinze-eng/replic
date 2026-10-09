// ─────────────────────────────────────────────────────────────────────────────
// tradingEngine.js — PAPER + REAL trading superpower for the WormGPT Agent.
//
// This is ADDITIVE and ISOLATED — it never touches the existing agent, brains,
// bots or web logic. It gives the agent (and the REST API / dashboard) the
// ability to:
//
//   • PAPER TRADE (test strategies): no API key needed. Live prices come from
//     the exchange (ccxt.pro WebSocket → REST fallback). Trades are saved to
//     Supabase (app_settings JSON, same crash-safe store marketWatch uses) —
//     no real orders are ever placed. A realistic 0.05% slippage is simulated.
//
//   • REAL TRADE: the user connects BINANCE / BYBIT API keys (per chat/user).
//     The bot places a real USDT-M Futures / USDT Perpetual order with SL & TP
//     ATTACHED in one API call, checks the balance first, and retries on
//     transient errors.
//
//   • 24/7 WATCH: a single setInterval ticker loops every OPEN trade, pulls the
//     live price, and the INSTANT price hits SL or TP it closes the trade,
//     computes PnL + R multiple, and fires an immediate Telegram/WhatsApp alert.
//     Uses EXCHANGE time (server ticker timestamp), not local time, for the
//     "time in trade" and hit timestamps — as required for accuracy.
//
// Design mirrors services/marketWatch.js exactly (its proven safety model):
//   • Zero new infra: ONE ticker + Supabase JSON keys. Survives redeploys.
//   • Crash-safe & best-effort: a bad row can NEVER kill the ticker.
//   • Notifiers are REGISTERED (start) like marketWatch/agentScheduler: Telegram
//     and WhatsApp each register one; the first that OWNS the chat handles it.
//   • Idempotent firing: a trade is marked CLOSED BEFORE the notifier runs so a
//     slow notifier can't double-alert on the next tick.
//   • ccxt instances are cached per (exchange, mode, credHash) and reused.
//
// Compatible library note: the product spec described Python + ccxt.pro. This
// app is a Node.js/Express service (deployed to Render as `node server.js`),
// so we use the Node `ccxt` package — which ships `ccxt.pro` with the SAME
// WebSocket `watchTicker`/`watchOHLCV` API — the fully-compatible equivalent.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

let ccxt = null;
try { ccxt = require('ccxt'); } catch (_) { ccxt = null; }

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

// ── Storage keys (Supabase app_settings JSON — same store as marketWatch) ────
const TRADES_KEY = 'agent_trades';        // all trades (open + recently closed)
const EVENTS_KEY = 'agent_trade_events';   // append-only event log (bounded)
const CREDS_PREFIX = 'agent_exchange_creds:'; // per-chat encrypted creds JSON

// ── Tunables (all env-overridable, no hardcoded magic in the logic) ──────────
const TICK_MS = parseInt(process.env.TRADING_TICK_MS || '1000', 10);          // watch loop cadence (1s per spec)
const PRICE_TTL_MS = parseInt(process.env.TRADING_PRICE_TTL_MS || '900', 10); // reuse a fresh quote inside one tick group
const MAX_OPEN_PER_CHAT = parseInt(process.env.TRADING_MAX_OPEN_PER_CHAT || '50', 10);
const PAPER_SLIPPAGE_PCT = parseFloat(process.env.TRADING_PAPER_SLIPPAGE_PCT || '0.05'); // 0.05% simulated slippage
const RETRY_MAX = parseInt(process.env.TRADING_RETRY_MAX || '3', 10);
const RETRY_BASE_MS = parseInt(process.env.TRADING_RETRY_BASE_MS || '600', 10);
const EVENTS_MAX = parseInt(process.env.TRADING_EVENTS_MAX || '500', 10);
const CLOSED_RETAIN_MS = parseInt(process.env.TRADING_CLOSED_RETAIN_MS || String(3 * 24 * 60 * 60 * 1000), 10); // keep closed 3d

const SUPPORTED = ['binanceusdm', 'bybit'];

let _timer = null;
let _runners = [];        // async ({ chatId, event, trade }) => bool|void
let _ticking = false;
let _cache = null;        // in-memory mirror of trades (works even if Supabase blips)
let _exCache = new Map(); // key → { ex, ts }
const _quoteCache = new Map(); // "exchange|symbol" → { price, ts }

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────
function _uid() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
function _normExchange(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (['binance', 'binanceusdm', 'binancefutures', 'binancef', 'bnb'].includes(n)) return 'binanceusdm';
  if (['bybit', 'bybitusdt', 'bybitperp', 'bybitperpetual'].includes(n)) return 'bybit';
  return SUPPORTED.includes(n) ? n : null;
}
function _normMode(mode) {
  const m = String(mode || 'PAPER').toUpperCase();
  return m === 'REAL' ? 'REAL' : 'PAPER';
}
// Normalise a symbol to ccxt unified USDT-perp form, e.g. "btc" → "BTC/USDT",
// "ETHUSDT" → "ETH/USDT", "SOL/USDT:USDT" is passed through.
function normSymbol(raw) {
  let s = String(raw || '').toUpperCase().trim().replace(/\s+/g, '');
  if (!s) return '';
  if (s.includes('/')) return s;                       // already unified
  s = s.replace(/[-_]/g, '');
  if (s.endsWith('USDT')) return s.slice(0, -4) + '/USDT';
  if (s.endsWith('USD'))  return s.slice(0, -3) + '/USDT';
  return s + '/USDT';
}
function _fmt(p) {
  if (p == null || !Number.isFinite(+p)) return String(p);
  const abs = Math.abs(+p);
  const dec = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return (+p).toFixed(dec);
}
function _money(x) {
  const v = Number(x) || 0;
  return (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
}
function _humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry wrapper for any exchange/network call (transient error resilience).
async function _withRetry(fn, label = 'op') {
  let lastErr = null;
  for (let i = 0; i < RETRY_MAX; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = (e && e.message) ? e.message : String(e);
      // Don't retry hard auth / validation errors — they won't self-heal.
      if (/invalid api|signature|permission|insufficient|auth|forbidden|not enough|minimum|precision/i.test(msg)) break;
      await _sleep(RETRY_BASE_MS * (i + 1));
    }
  }
  throw lastErr || new Error(label + ' failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — trades + event log (Supabase JSON, in-memory mirror)
// ─────────────────────────────────────────────────────────────────────────────
async function _load() {
  if (_cache) return _cache;
  let list = [];
  try {
    if (db && db.getSetting) {
      const raw = await db.getSetting(TRADES_KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; }
    }
  } catch (_) { list = []; }
  _cache = list;
  return _cache;
}
async function _save(list) {
  _cache = Array.isArray(list) ? list : [];
  try { if (db && db.setSetting) await db.setSetting(TRADES_KEY, JSON.stringify(_cache)); } catch (_) {}
}
async function _logEvent(ev) {
  try {
    if (!db || !db.getSetting) return;
    let arr = [];
    try { const raw = await db.getSetting(EVENTS_KEY); if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } } catch (_) {}
    arr.push({ ...ev, ts: ev.ts || Date.now() });
    if (arr.length > EVENTS_MAX) arr = arr.slice(-EVENTS_MAX);
    await db.setSetting(EVENTS_KEY, JSON.stringify(arr));
  } catch (_) { /* logging must never throw */ }
}
async function getEvents(chatId, limit = 50) {
  try {
    if (!db || !db.getSetting) return [];
    const raw = await db.getSetting(EVENTS_KEY);
    let arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    if (chatId) arr = arr.filter(e => String(e.chatId) === String(chatId));
    return arr.slice(-limit).reverse();
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-chat exchange credentials (REAL mode)
// ─────────────────────────────────────────────────────────────────────────────
async function saveCreds(chatId, exchange, apiKey, secret, extra = {}) {
  const ex = _normExchange(exchange);
  if (!ex) throw new Error('Unsupported exchange (use binance or bybit).');
  if (!apiKey || !secret) throw new Error('Both API key and secret are required.');
  const key = CREDS_PREFIX + String(chatId);
  let all = {};
  try { const raw = await db.getSetting(key); if (raw) all = JSON.parse(raw) || {}; } catch (_) {}
  all[ex] = {
    apiKey: String(apiKey).trim(),
    secret: String(secret).trim(),
    // Bybit optionally needs a password/uid for some accounts; store if given.
    password: extra.password ? String(extra.password).trim() : undefined,
    savedAt: Date.now(),
  };
  await db.setSetting(key, JSON.stringify(all));
  _exCache.clear();
  return true;
}
async function getCreds(chatId, exchange) {
  const ex = _normExchange(exchange);
  try {
    const raw = await db.getSetting(CREDS_PREFIX + String(chatId));
    if (!raw) return null;
    const all = JSON.parse(raw) || {};
    return all[ex] || null;
  } catch (_) { return null; }
}
async function hasCreds(chatId, exchange) {
  const c = await getCreds(chatId, exchange);
  return !!(c && c.apiKey && c.secret);
}
async function clearCreds(chatId, exchange) {
  const key = CREDS_PREFIX + String(chatId);
  try {
    const raw = await db.getSetting(key);
    let all = raw ? JSON.parse(raw) : {};
    if (exchange) { const ex = _normExchange(exchange); if (ex) delete all[ex]; }
    else all = {};
    await db.setSetting(key, JSON.stringify(all));
    _exCache.clear();
    return true;
  } catch (_) { return false; }
}
async function connectedExchanges(chatId) {
  try {
    const raw = await db.getSetting(CREDS_PREFIX + String(chatId));
    if (!raw) return [];
    const all = JSON.parse(raw) || {};
    return Object.keys(all).filter(k => all[k] && all[k].apiKey);
  } catch (_) { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// getExchange(name, { mode, creds }) → cached ccxt instance.
// PAPER → a keyless public instance (prices only). REAL → an authenticated
// instance for the given credentials. Uses ccxt.pro when available so the
// watcher can use WebSocket tickers; falls back to the REST class transparently.
// ─────────────────────────────────────────────────────────────────────────────
function getExchange(name, { mode = 'PAPER', creds = null } = {}) {
  if (!ccxt) throw new Error('ccxt library is not installed.');
  const ex = _normExchange(name);
  if (!ex) throw new Error('Unsupported exchange "' + name + '" (use binance or bybit).');
  const m = _normMode(mode);
  const credHash = m === 'REAL' && creds ? (creds.apiKey || '').slice(-8) : 'public';
  const cacheKey = `${ex}|${m}|${credHash}`;
  const hit = _exCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < 30 * 60 * 1000) return hit.ex;

  const opts = {
    enableRateLimit: true,
    timeout: 20000,
    options: { defaultType: 'swap' }, // USDT-M futures / USDT perpetual
  };
  if (m === 'REAL' && creds) {
    opts.apiKey = creds.apiKey;
    opts.secret = creds.secret;
    if (creds.password) opts.password = creds.password;
  }
  // Prefer ccxt.pro (WebSocket) — same class name, superset API.
  const Cls = (ccxt.pro && ccxt.pro[ex]) ? ccxt.pro[ex] : ccxt[ex];
  const inst = new Cls(opts);
  _exCache.set(cacheKey, { ex: inst, ts: Date.now() });
  return inst;
}

// ── Live price: WebSocket ticker (ccxt.pro) with REST fallback. ──────────────
// Uses exchange time from the ticker when present. Cached briefly so a tick
// that groups many trades on the same symbol hits the API once.
async function fetchPrice(exchange, symbol, { mode = 'PAPER', creds = null } = {}) {
  const ex = _normExchange(exchange);
  const sym = normSymbol(symbol);
  const ck = `${ex}|${sym}`;
  const cached = _quoteCache.get(ck);
  if (cached && (Date.now() - cached.ts) < PRICE_TTL_MS) return cached;

  const inst = getExchange(ex, { mode, creds });
  let quote = null;
  try {
    quote = await _withRetry(async () => {
      let t = null;
      // Try WebSocket ticker first (fast, low-latency) when available.
      if (typeof inst.watchTicker === 'function') {
        try { t = await inst.watchTicker(sym); } catch (_) { t = null; }
      }
      if (!t || t.last == null) t = await inst.fetchTicker(sym);
      const price = Number(t.last != null ? t.last : (t.close != null ? t.close : t.bid));
      if (!Number.isFinite(price)) throw new Error('no price for ' + sym);
      // EXCHANGE time (not local) per accuracy requirement.
      const exTime = Number(t.timestamp) || (inst.milliseconds ? inst.milliseconds() : Date.now());
      return { price, exTime, source: ex + (typeof inst.watchTicker === 'function' ? ' ws' : ' rest') };
    }, 'fetchPrice');
  } catch (primaryErr) {
    // ── GEO-BLOCK / DOWNTIME FALLBACK ────────────────────────────────────────
    // On some hosts (e.g. Render Frankfurt) fapi.binance.com / api.bybit.com are
    // geo-blocked (HTTP 451/403) — the SAME issue the existing get_market_price
    // tool works around. So for PRICE reads we fall back to the app's proven
    // keyless public price chain (coingecko → coinbase → binance.us) via
    // manusTools.getSpot, so PAPER trading + the watcher keep working anywhere.
    // (REAL order placement still needs a reachable authenticated endpoint; if
    //  the exchange is blocked for the user's region, real orders will surface
    //  a clear error at order time — but monitoring never goes dark.)
    const fb = await _fallbackPrice(ex, sym);
    if (fb) quote = fb;
    else throw primaryErr;
  }
  const out = { price: quote.price, exTime: quote.exTime, source: quote.source, ts: Date.now(), symbol: sym };
  _quoteCache.set(ck, out);
  return out;
}

// Keyless public price fallback shared with the app's market tools. Returns
// { price, exTime, source } or null. Best-effort, never throws.
async function _fallbackPrice(ex, sym) {
  try {
    const manus = require('./manusTools');
    if (manus && typeof manus.getSpot === 'function') {
      // getSpot understands "BTC", "ETHUSDT", etc. Feed it the base+USDT form.
      const q = await manus.getSpot(sym.replace('/USDT', 'USDT'));
      if (q && Number.isFinite(q.price)) {
        return { price: q.price, exTime: Date.now(), source: `${ex}→fallback(${q.source || 'public'})` };
      }
    }
  } catch (_) {}
  return null;
}

// ── Live RANGE (high/low/last) for WICK-ACCURATE SL/TP detection. ────────────
// The single biggest accuracy bug in a polling watcher is checking only the
// `last` price: between two 1s polls the price can WICK through your SL/TP and
// come straight back — a real exchange fills you on the wick, a naive poller
// misses it entirely. So the watcher must evaluate the HIGH and LOW that
// occurred since the previous check, not just the current snapshot.
//
// fetchRange returns { last, high, low, exTime, source } where high/low are the
// extremes of the most recent (in-progress) 1-minute candle when OHLCV is
// available, widened by the ticker's own high/low and last. It is always safe:
// high >= last >= low, and it degrades to the plain last price if candles are
// unavailable (e.g. on the geo-block public fallback), so a hit is never faked.
async function fetchRange(exchange, symbol, { mode = 'PAPER', creds = null, since = null } = {}) {
  const ex = _normExchange(exchange);
  const sym = normSymbol(symbol);
  const ck = `range|${ex}|${sym}`;
  const cached = _quoteCache.get(ck);
  if (cached && (Date.now() - cached.ts) < PRICE_TTL_MS) return cached;

  const inst = getExchange(ex, { mode, creds });
  let out = null;
  try {
    out = await _withRetry(async () => {
      // 1) ticker gives last + (usually) session high/low + exchange time.
      let t = null;
      if (typeof inst.watchTicker === 'function') {
        try { t = await inst.watchTicker(sym); } catch (_) { t = null; }
      }
      if (!t || t.last == null) t = await inst.fetchTicker(sym);
      const last = Number(t.last != null ? t.last : (t.close != null ? t.close : t.bid));
      if (!Number.isFinite(last)) throw new Error('no price for ' + sym);
      const exTime = Number(t.timestamp) || (inst.milliseconds ? inst.milliseconds() : Date.now());

      // 2) Aggregate only trades that occurred AFTER the previous watcher
      // check. Exchange ticker high/low fields are usually 24-hour extrema and
      // must never be used here; doing so can falsely trigger a level touched
      // hours before this trade/watch existed.
      let hi = last, lo = last;
      const sinceMs = Number.isFinite(+since) ? +since : Math.max(0, exTime - 2000);
      let gotTimedRange = false;
      try {
        let trades = null;
        if (typeof inst.watchTrades === 'function') {
          try { trades = await inst.watchTrades(sym, sinceMs, 1000); } catch (_) { trades = null; }
        }
        if ((!trades || !trades.length) && typeof inst.fetchTrades === 'function') {
          trades = await inst.fetchTrades(sym, sinceMs, 1000);
        }
        for (const tr of (trades || [])) {
          const ts = Number(tr && tr.timestamp);
          const px = Number(tr && tr.price);
          if (Number.isFinite(px) && (!Number.isFinite(ts) || ts >= sinceMs)) {
            hi = Math.max(hi, px); lo = Math.min(lo, px); gotTimedRange = true;
          }
        }
      } catch (_) { /* use the guarded candle fallback below */ }

      // Candle fallback is safe only when the current candle began inside the
      // observation window. A candle that started before `sinceMs` can contain
      // an old wick and would create a false hit for a newly-opened trade.
      if (!gotTimedRange) {
        try {
          let ohlcv = null;
          if (typeof inst.fetchOHLCV === 'function') ohlcv = await inst.fetchOHLCV(sym, '1m', sinceMs, 2);
          for (const c of (ohlcv || [])) {
            if (Number(c[0]) < sinceMs) continue;
            if (Number.isFinite(+c[2])) hi = Math.max(hi, +c[2]);
            if (Number.isFinite(+c[3])) lo = Math.min(lo, +c[3]);
          }
        } catch (_) { /* keep last-only range */ }
      }

      // guarantee invariant lo <= last <= hi
      hi = Math.max(hi, last); lo = Math.min(lo, last);

      return { last, high: hi, low: lo, exTime, source: ex + (typeof inst.watchTicker === 'function' ? ' ws' : ' rest') };
    }, 'fetchRange');
  } catch (primaryErr) {
    // Geo-block / downtime → public last-price only (range collapses to last).
    const fb = await _fallbackPrice(ex, sym);
    if (fb) out = { last: fb.price, high: fb.price, low: fb.price, exTime: fb.exTime, source: fb.source };
    else throw primaryErr;
  }
  const rec = { ...out, price: out.last, ts: Date.now(), symbol: sym };
  _quoteCache.set(ck, rec);
  return rec;
}

// ── Historical OHLCV candles for ANALYSIS (indicators/structure). ────────────
// Returns an array of ccxt rows [ts,open,high,low,close,vol]. Tries ccxt first
// (WebSocket → REST), then falls back to the app's Yahoo candle source (via
// manusTools._yahooCandles) so analysis keeps working even where the exchange
// is geo-blocked. `timeframe` is a ccxt string (1m,5m,15m,1h,4h,1d).
async function fetchCandles(exchange, symbol, { timeframe = '15m', limit = 200, mode = 'PAPER', creds = null } = {}) {
  const ex = _normExchange(exchange);
  const sym = normSymbol(symbol);
  // 1) ccxt
  try {
    const inst = getExchange(ex, { mode, creds });
    if (typeof inst.fetchOHLCV === 'function') {
      const rows = await _withRetry(() => inst.fetchOHLCV(sym, timeframe, undefined, limit), 'fetchOHLCV');
      if (Array.isArray(rows) && rows.length >= 20) return rows;
    }
  } catch (_) { /* fall through to Yahoo */ }
  // 2) Yahoo fallback (crypto + forex + indices + stocks).
  try {
    const manus = require('./manusTools');
    if (manus && typeof manus._yahooCandlesPublic === 'function') {
      const rangeMap = { '1m': '1d', '5m': '5d', '15m': '5d', '30m': '1mo', '1h': '1mo', '4h': '3mo', '1d': '6mo' };
      const base = sym.replace('/USDT', '').replace('/USD', '');
      const cc = await manus._yahooCandlesPublic(base, timeframe, rangeMap[timeframe] || '5d');
      if (cc && cc.c && cc.c.length >= 20) {
        const rows = [];
        for (let i = 0; i < cc.c.length; i++) {
          if (cc.c[i] == null) continue;
          rows.push([ (cc.ts[i] || i) * 1000, cc.o[i], cc.h[i], cc.l[i], cc.c[i], 0 ]);
        }
        if (rows.length >= 20) return rows.slice(-limit);
      }
    }
  } catch (_) {}
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// PnL + R math (shared by paper & real). All USDT-M/perp are linear contracts:
//   pnl = (exit - entry) * amount   [long]   /   (entry - exit) * amount [short]
//   R   = pnl / risk,  risk = |entry - sl| * amount
// ─────────────────────────────────────────────────────────────────────────────
function computePnl(trade, exit) {
  const dir = trade.side === 'sell' ? -1 : 1;
  const pnl = (exit - trade.entry) * trade.amount * dir;
  let r = null;
  if (Number.isFinite(trade.sl) && trade.sl > 0) {
    const risk = Math.abs(trade.entry - trade.sl) * trade.amount;
    if (risk > 0) r = pnl / risk;
  }
  return { pnl, r };
}

// ─────────────────────────────────────────────────────────────────────────────
// openTrade — validate, (REAL) check balance + place order w/ SL+TP attached,
// then persist an OPEN trade the watcher monitors.
//   args: { chatId, userId?, exchange, symbol, side, amount, entry?, sl, tp, mode, leverage? }
// entry defaults to the current live price when omitted (market entry).
// Returns the created trade object.
// ─────────────────────────────────────────────────────────────────────────────
async function openTrade(args = {}) {
  const chatId = String(args.chatId || '').trim();
  if (!chatId) throw new Error('chatId is required.');
  const exchange = _normExchange(args.exchange);
  if (!exchange) throw new Error('Unsupported exchange (use binance or bybit).');
  const symbol = normSymbol(args.symbol);
  if (!symbol) throw new Error('A symbol is required (e.g. BTC/USDT).');
  const side = String(args.side || '').toLowerCase() === 'sell' ? 'sell' : (String(args.side || '').toLowerCase() === 'buy' ? 'buy' : null);
  if (!side) throw new Error('side must be "buy" (long) or "sell" (short).');
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number (contract/coin size).');
  const mode = _normMode(args.mode);
  const sl = args.sl != null && args.sl !== '' ? Number(args.sl) : null;
  const tp = args.tp != null && args.tp !== '' ? Number(args.tp) : null;
  if (sl != null && !Number.isFinite(sl)) throw new Error('sl must be a number.');
  if (tp != null && !Number.isFinite(tp)) throw new Error('tp must be a number.');
  if (sl == null && tp == null) throw new Error('Provide at least a stop-loss (sl) or take-profit (tp).');

  const list = await _load();
  const openMine = list.filter(t => String(t.chatId) === chatId && t.status === 'OPEN');
  if (openMine.length >= MAX_OPEN_PER_CHAT) {
    throw new Error(`You already have ${openMine.length} open trades (max ${MAX_OPEN_PER_CHAT}).`);
  }

  // ── Resolve entry price (live if not given). ──
  let creds = null;
  if (mode === 'REAL') {
    creds = await getCreds(chatId, exchange);
    if (!creds || !creds.apiKey) {
      throw new Error(`REAL mode needs ${exchange} API keys. Connect them first (connect_exchange).`);
    }
  }
  let entry = args.entry != null && args.entry !== '' ? Number(args.entry) : null;
  let livePrice = null;
  try { const q = await fetchPrice(exchange, symbol, { mode, creds }); livePrice = q.price; } catch (_) {}
  if (entry == null) {
    if (livePrice == null) throw new Error('Could not fetch a live entry price — pass an explicit entry.');
    entry = livePrice;
  }

  // ── Validate SL/TP sit on the correct side of entry (protect the user). ──
  if (side === 'buy') {
    if (sl != null && sl >= entry) throw new Error('For a LONG, stop-loss must be BELOW entry.');
    if (tp != null && tp <= entry) throw new Error('For a LONG, take-profit must be ABOVE entry.');
  } else {
    if (sl != null && sl <= entry) throw new Error('For a SHORT, stop-loss must be ABOVE entry.');
    if (tp != null && tp >= entry) throw new Error('For a SHORT, take-profit must be BELOW entry.');
  }

  const now = Date.now();
  const trade = {
    id: _uid(),
    chatId,
    userId: args.userId || null,
    exchange,
    symbol,
    side,
    amount,
    entry: Number(entry),
    sl: sl != null ? Number(sl) : null,
    tp: tp != null ? Number(tp) : null,
    mode,
    leverage: Number(args.leverage) || null,
    status: 'OPEN',
    openedAt: now,
    openedExTime: null,
    closedAt: null,
    exit: null,
    pnl: null,
    r: null,
    closeReason: null,
    realOrderId: null,
    slippagePct: mode === 'PAPER' ? PAPER_SLIPPAGE_PCT : 0,
    lastPrice: livePrice,
    lastCheck: now,
    note: args.note ? String(args.note).slice(0, 200) : null,
  };

  // ── PAPER: simulate slippage on the entry so backtests are realistic. ──
  if (mode === 'PAPER') {
    const slip = (PAPER_SLIPPAGE_PCT / 100) * entry;
    // A buy fills slightly worse (higher), a sell slightly worse (lower).
    trade.entry = side === 'buy' ? entry + slip : entry - slip;
    trade.openedExTime = now;
  }

  // ── REAL: check balance, set leverage, place the order with SL+TP attached. ──
  if (mode === 'REAL') {
    const inst = getExchange(exchange, { mode, creds });
    // 1) balance check — must have free USDT before we place anything.
    await _withRetry(async () => {
      const bal = await inst.fetchBalance();
      const free = (bal && bal.USDT && (bal.USDT.free != null ? bal.USDT.free : bal.free && bal.free.USDT)) || 0;
      const notional = trade.entry * amount / (trade.leverage || 1);
      if (Number(free) <= 0) throw new Error('Insufficient USDT balance to place this order.');
      if (notional > Number(free) * 1.02) {
        throw new Error(`Order notional ~$${notional.toFixed(2)} exceeds free balance $${Number(free).toFixed(2)}.`);
      }
    }, 'balance-check');

    // 2) leverage (best-effort; ignore if the account/symbol rejects it).
    if (trade.leverage) {
      try { if (typeof inst.setLeverage === 'function') await inst.setLeverage(trade.leverage, symbol); } catch (_) {}
    }

    // 3) place market order with SL + TP ATTACHED in one call.
    //    Both Binance USDM and Bybit accept unified `stopLoss`/`takeProfit`
    //    params in ccxt; we pass the prices directly per the spec.
    const params = {};
    if (trade.sl != null) params.stopLoss = { triggerPrice: trade.sl, price: trade.sl };
    if (trade.tp != null) params.takeProfit = { triggerPrice: trade.tp, price: trade.tp };
    // Bybit wants numeric stopLoss/takeProfit too — set the flat fields as well.
    if (exchange === 'bybit') {
      if (trade.sl != null) params.stopLoss = trade.sl;
      if (trade.tp != null) params.takeProfit = trade.tp;
    }
    const order = await _withRetry(
      () => inst.createOrder(symbol, 'market', side, amount, undefined, params),
      'createOrder'
    );
    trade.realOrderId = (order && (order.id || order.orderId)) || null;
    // Use the real fill price + exchange time if returned.
    if (order && order.average != null) trade.entry = Number(order.average);
    else if (order && order.price != null) trade.entry = Number(order.price);
    trade.openedExTime = (order && order.timestamp) ? Number(order.timestamp) : now;
  }

  list.push(trade);
  await _save(list);
  await _logEvent({ chatId, type: 'OPEN', tradeId: trade.id, symbol, side, mode, entry: trade.entry, sl: trade.sl, tp: trade.tp });

  // Immediate "Trade Opened" alert (fire to registered notifiers).
  await _emit({
    chatId,
    trade,
    event: {
      type: 'OPEN',
      text: _formatOpen(trade),
    },
  });
  return trade;
}

// ─────────────────────────────────────────────────────────────────────────────
// closeTrade — manual close (or internal SL/TP close). Computes PnL/R, marks
// CLOSED, and (REAL) closes the position on the exchange with a reduce-only
// market order. Returns the updated trade.
// ─────────────────────────────────────────────────────────────────────────────
async function closeTrade(chatId, tradeId, { reason = 'MANUAL', exitPrice = null } = {}) {
  const list = await _load();
  const trade = list.find(t => t.id === tradeId && String(t.chatId) === String(chatId));
  if (!trade) throw new Error('Trade not found.');
  if (trade.status !== 'OPEN') return trade; // idempotent
  return _finalizeClose(list, trade, { reason, exitPrice });
}

async function _finalizeClose(list, trade, { reason, exitPrice, exTime: exTimeIn = null } = {}) {
  let exit = exitPrice != null ? Number(exitPrice) : null;
  let exTime = exTimeIn != null ? Number(exTimeIn) : Date.now();
  const creds = trade.mode === 'REAL' ? await getCreds(trade.chatId, trade.exchange) : null;
  // A level hit (SL/TP) fills AT the level on the exchange — we must NOT apply
  // simulated slippage to it, or the recorded exit/PnL won't match the level.
  const isLevelHit = (reason === 'SL' || reason === 'TP') && exitPrice != null;

  // Resolve an exit price if not supplied.
  if (exit == null) {
    try { const q = await fetchPrice(trade.exchange, trade.symbol, { mode: trade.mode, creds }); exit = q.price; if (exTimeIn == null) exTime = q.exTime || exTime; }
    catch (_) { exit = trade.lastPrice != null ? trade.lastPrice : trade.entry; }
  }

  // PAPER: apply slippage on exit ONLY for market/manual closes (a MANUAL close
  // is a market order → worse fill). Level hits (SL/TP) fill AT the level.
  if (trade.mode === 'PAPER' && !isLevelHit) {
    const slip = (PAPER_SLIPPAGE_PCT / 100) * exit;
    exit = trade.side === 'buy' ? exit - slip : exit + slip;
  }


  // REAL: close on the exchange with a reduce-only opposite market order.
  if (trade.mode === 'REAL' && reason === 'MANUAL' && creds) {
    try {
      const inst = getExchange(trade.exchange, { mode: 'REAL', creds });
      const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
      const order = await _withRetry(
        () => inst.createOrder(trade.symbol, 'market', closeSide, trade.amount, undefined, { reduceOnly: true }),
        'closeOrder'
      );
      if (order && order.average != null) exit = Number(order.average);
      if (order && order.timestamp) exTime = Number(order.timestamp);
    } catch (e) {
      // If the exchange already closed it via the attached SL/TP, that's fine —
      // we still record the close locally so the user gets an accurate alert.
    }
  }

  const { pnl, r } = computePnl(trade, exit);
  trade.status = 'CLOSED';
  trade.exit = exit;
  trade.closedAt = Date.now();
  trade.closedExTime = exTime;
  trade.pnl = pnl;
  trade.r = r;
  trade.closeReason = reason; // TP | SL | MANUAL | LIQUIDATION
  await _save(list);
  await _logEvent({ chatId: trade.chatId, type: 'CLOSE', tradeId: trade.id, symbol: trade.symbol, reason, exit, pnl, r });
  return trade;
}

// ── list / stats ─────────────────────────────────────────────────────────────
async function listTrades(chatId, { status = null, limit = 50 } = {}) {
  const all = await _load();
  let mine = all.filter(t => String(t.chatId) === String(chatId));
  if (status) mine = mine.filter(t => t.status === String(status).toUpperCase());
  mine.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  return mine.slice(0, limit);
}
async function getTrade(chatId, tradeId) {
  const all = await _load();
  return all.find(t => t.id === tradeId && String(t.chatId) === String(chatId)) || null;
}
async function stats(chatId) {
  const all = await _load();
  const mine = all.filter(t => String(t.chatId) === String(chatId));
  const closed = mine.filter(t => t.status === 'CLOSED' && Number.isFinite(t.pnl));
  const open = mine.filter(t => t.status === 'OPEN');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const rVals = closed.filter(t => Number.isFinite(t.r)).map(t => t.r);
  const avgR = rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;
  const winrate = closed.length ? (wins.length / closed.length) * 100 : null;
  return {
    open: open.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winrate,
    totalPnl,
    avgR,
    bestPnl: closed.length ? Math.max(...closed.map(t => t.pnl)) : null,
    worstPnl: closed.length ? Math.min(...closed.map(t => t.pnl)) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert formatting (matches the product's message spec)
// ─────────────────────────────────────────────────────────────────────────────
function _exLabel(ex) { return ex === 'binanceusdm' ? 'Binance' : ex === 'bybit' ? 'Bybit' : ex; }

function _formatOpen(t) {
  return `📥 TRADE OPENED\n` +
    `Exchange: ${_exLabel(t.exchange)}\n` +
    `Symbol: ${t.symbol}\n` +
    `Side: ${t.side === 'buy' ? 'LONG 🟢' : 'SHORT 🔴'}\n` +
    `Mode: ${t.mode}\n` +
    `Entry: ${_fmt(t.entry)}  •  Size: ${t.amount}\n` +
    (t.sl != null ? `SL: ${_fmt(t.sl)}   ` : '') + (t.tp != null ? `TP: ${_fmt(t.tp)}` : '') +
    (t.leverage ? `\nLeverage: ${t.leverage}x` : '');
}

function _formatHit(t, kind, price, exTime) {
  const emoji = kind === 'TP' ? '🎯' : kind === 'SL' ? '🛑' : '✅';
  const head = kind === 'TP' ? 'TP HIT 🎯' : kind === 'SL' ? 'SL HIT 🛑' : 'TRADE CLOSED ✅';
  const rTxt = Number.isFinite(t.r) ? `  [${t.r.toFixed(1)}R]` : '';
  const dur = _humanDuration((t.closedExTime || Date.now()) - (t.openedExTime || t.openedAt));
  const reasonTxt = kind === 'TP'
    ? `Price tapped TP at ${_fmt(t.tp)}`
    : kind === 'SL'
      ? `Price tapped SL at ${_fmt(t.sl)}`
      : `Closed at ${_fmt(price)}`;
  return `${head}\n` +
    `Exchange: ${_exLabel(t.exchange)}\n` +
    `Symbol: ${t.symbol}\n` +
    `Mode: ${t.mode}\n` +
    `Result: ${_money(t.pnl)}${rTxt}\n` +
    `Time in trade: ${dur}\n` +
    `Reason: ${reasonTxt}`;
}

// ── Emit an event to all registered notifiers; first owner handles it. ───────
async function _emit({ chatId, trade, event }) {
  for (const run of _runners) {
    try { const handled = await run({ chatId, event, trade }); if (handled) break; }
    catch (_) { /* a failed runner never blocks the others */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 24/7 WATCHER — the accuracy-critical loop. Every tick:
//   • group OPEN trades by (exchange, symbol) so each price API is hit once,
//   • pull the live price (WebSocket → REST), using EXCHANGE time,
//   • if price hits SL or TP → mark CLOSED (idempotent) → compute PnL/R → alert.
// ─────────────────────────────────────────────────────────────────────────────
// Wick-aware hit detection. Given the price RANGE observed since the last check
// ({ last, high, low }), decide whether SL and/or TP was touched, and — when
// BOTH were touched inside the same range (a violent candle) — resolve which
// one fills FIRST using the conservative, exchange-realistic rule:
//   • the SL is assumed to fill first (worst case for the trader), unless
//     TRADING_TP_FIRST=1 is set. This is what protects the "no surprise blowup"
//     requirement — we never optimistically assume TP filled before SL.
// Returns { kind: 'SL'|'TP'|null, level:Number, fill:Number }.
const _TP_FIRST = String(process.env.TRADING_TP_FIRST || '0') === '1';
function _hitRange(trade, range) {
  const hi = Number(range.high), lo = Number(range.low);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return { kind: null };
  let slHit = false, tpHit = false;
  if (trade.side === 'buy') {
    if (trade.sl != null && lo <= trade.sl) slHit = true;   // low pierced SL below
    if (trade.tp != null && hi >= trade.tp) tpHit = true;   // high pierced TP above
  } else { // short
    if (trade.sl != null && hi >= trade.sl) slHit = true;   // high pierced SL above
    if (trade.tp != null && lo <= trade.tp) tpHit = true;   // low pierced TP below
  }
  if (slHit && tpHit) {
    // Both touched in one candle → resolve conservatively (SL first by default).
    const kind = _TP_FIRST ? 'TP' : 'SL';
    const level = kind === 'TP' ? trade.tp : trade.sl;
    return { kind, level, fill: level };
  }
  if (slHit) return { kind: 'SL', level: trade.sl, fill: trade.sl };
  if (tpHit) return { kind: 'TP', level: trade.tp, fill: trade.tp };
  return { kind: null };
}

// Back-compat single-price hit test (used by immediate post-open check + tests).
function _hit(trade, price) {
  const p = Number(price);
  return _hitRange(trade, { high: p, low: p, last: p }).kind;
}

async function _tick() {
  if (_ticking || !_runners.length) return;
  _ticking = true;
  try {
    let all = await _load();
    if (!all.length) return;
    const now = Date.now();

    // Prune very old CLOSED trades from the hot store (keep them a few days).
    const before = all.length;
    all = all.filter(t => t.status === 'OPEN' || (now - (t.closedAt || 0)) < CLOSED_RETAIN_MS);

    const openTrades = all.filter(t => t.status === 'OPEN');
    if (!openTrades.length) { if (all.length !== before) await _save(all); return; }

    // Group by exchange|symbol|mode so we fetch each price once per tick.
    const groups = {};
    for (const t of openTrades) {
      const creds = t.mode === 'REAL' ? await getCreds(t.chatId, t.exchange) : null;
      const gk = `${t.exchange}|${t.symbol}|${t.mode}|${creds ? (creds.apiKey || '').slice(-6) : 'pub'}`;
      (groups[gk] = groups[gk] || { exchange: t.exchange, symbol: t.symbol, mode: t.mode, creds, trades: [] }).trades.push(t);
    }

    let dirty = false;
    for (const gk of Object.keys(groups)) {
      const g = groups[gk];
      // WICK-ACCURATE: pull the price RANGE (high/low since last check), not
      // just the snapshot — so a spike through SL/TP between polls is caught.
      let range = null;
      const since = Math.min(...g.trades.map(t => Number(t.lastCheck) || Number(t.openedAt) || (now - TICK_MS)));
      try { range = await fetchRange(g.exchange, g.symbol, { mode: g.mode, creds: g.creds, since }); }
      catch (_) { range = null; }
      if (!range || !Number.isFinite(range.last)) continue; // exchange downtime → skip gracefully
      const price = range.last;
      const exTime = range.exTime || now;

      for (const t of g.trades) {
        t.lastPrice = price; t.lastHigh = range.high; t.lastLow = range.low; t.lastCheck = now; dirty = true;
        const hit = _hitRange(t, range);
        if (!hit.kind) continue;
        // Idempotent: mark closing intent BEFORE alerting so a slow notifier
        // can't double-fire on the next tick.
        if (t._closing) continue;
        t._closing = true;
        try {
          // Fill AT the exact level (that's where the exchange triggers) and
          // stamp the close with EXCHANGE time before formatting the alert.
          await _finalizeClose(all, t, { reason: hit.kind, exitPrice: hit.fill, exTime });
          await _emit({ chatId: t.chatId, trade: t, event: { type: hit.kind, text: _formatHit(t, hit.kind, hit.fill, exTime) } });
        } catch (_) { t._closing = false; /* retry next tick */ }
        dirty = true;
      }
    }
    if (dirty) await _save(all);
  } catch (_) { /* never let the watcher die */ }
  finally { _ticking = false; }
}


// Register a notifier callback and (idempotently) start the 24/7 ticker.
function start(runner) {
  if (typeof runner === 'function' && !_runners.includes(runner)) _runners.push(runner);
  if (_timer) return;
  _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  _tick().catch(() => {});
}

function enabled() { return !!ccxt; }

// Test/maintenance helpers: clear the short-lived quote cache and force one
// watcher tick synchronously (used by the accuracy test for deterministic runs).
function _clearQuoteCache() { _quoteCache.clear(); }
async function _tickNow() { _quoteCache.clear(); await _tick(); }

module.exports = {
  enabled,
  SUPPORTED,
  getExchange,
  fetchPrice,
  fetchRange,
  fetchCandles,
  normSymbol,
  computePnl,
  // creds
  saveCreds, getCreds, hasCreds, clearCreds, connectedExchanges,
  // trades
  openTrade, closeTrade, listTrades, getTrade, stats, getEvents,
  // hit detection (exported for tests + analysis)
  _hit, _hitRange,
  // test helpers
  _clearQuoteCache, _tickNow,
  // watcher / notifiers
  start,
  // formatting helpers (reused by tools + REST)
  _fmt, _money, _humanDuration, _exLabel, _formatOpen, _formatHit,
  // tunables (exposed for tests)
  _internals: { PAPER_SLIPPAGE_PCT, TICK_MS, MAX_OPEN_PER_CHAT },
};
