// ─────────────────────────────────────────────────────────────────────────────
// marketWatch.js — REAL-TIME MARKET WATCH + INSTANT SL/TP/TARGET ALERTS.
//
// This is the feature the product asked for: "ability to watch the market, to
// know when something hit SL or TP … schedule time to watch the market in real
// time … when market hits something the user wants, notify the user immediately."
//
// It complements agentScheduler.js:
//   • agentScheduler = fire a ONE-SHOT task at a set clock time.
//   • marketWatch     = CONTINUOUSLY poll a live price and fire the INSTANT a
//                       price crosses a target (TP / SL / above / below / touch).
//
// Design (identical safety model to agentScheduler):
//   • Zero new infra: ONE setInterval ticker + ONE Supabase JSON key.
//   • Crash-safe & best-effort: every store/read is guarded; a bad row can never
//     kill the ticker. Watches survive a redeploy (persisted in app_settings).
//   • Per-chat CRUD + cap so a user can't wedge the poller with 500 watches.
//   • Idempotent firing: a triggered leg is marked done BEFORE the notifier runs
//     so a slow notifier can't double-alert on the next tick.
//   • Price source is INJECTED (setPriceFetcher) so this module stays decoupled
//     from manusTools — the bot wires get_market_price in at boot.
//   • Notifiers are REGISTERED (start) exactly like the scheduler: Telegram and
//     WhatsApp each register one; the first that OWNS the chat handles it.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

const KEY = 'agent_market_watches';
// Poll cadence. 45s is a good default: fast enough to catch intraday TP/SL,
// gentle enough on the free Yahoo/CoinGecko endpoints. Configurable via env.
const TICK_MS = parseInt(process.env.MARKET_WATCH_TICK_MS || '45000', 10);
const MAX_PER_CHAT = parseInt(process.env.MARKET_WATCH_MAX_PER_CHAT || '20', 10);
// A watch auto-expires after this long so a forgotten watch can't poll forever.
const MAX_AGE_MS = parseInt(process.env.MARKET_WATCH_MAX_AGE_MS || String(7 * 24 * 60 * 60 * 1000), 10); // 7 days

// ── 🔁 PERIODIC FEEDBACK (the "recheck & tell me" requirement) ────────────────
// Even before any TP/SL level is hit, the user wants live feedback: the bot
// should RECHECK on a cadence and message them the current price / how it moved.
// Two feedback signals per watch:
//   • poll   → a heartbeat "still watching, price is now X" at FEEDBACK_MS.
//   • change → an immediate note when the price moved ≥ FEEDBACK_MOVE_PCT since
//              the last thing we reported, so a real move never goes unspoken.
const FEEDBACK_MS = parseInt(process.env.MARKET_WATCH_FEEDBACK_MS || String(5 * 60 * 1000), 10); // every 5 min
const FEEDBACK_MOVE_PCT = parseFloat(process.env.MARKET_WATCH_FEEDBACK_MOVE_PCT || '0.15'); // 0.15% move → tell them

let _timer = null;
let _runners = [];        // async ({ chatId, symbol, event, watch }) => bool|void
let _priceFetcher = null; // async (symbol) => { price:Number, source:String } | null
let _ticking = false;
let _cache = null;        // in-memory mirror so we work even if Supabase blips

function _uid() {
  return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function _load() {
  if (_cache) return _cache;
  let list = [];
  try {
    if (db && db.getSetting) {
      const raw = await db.getSetting(KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; }
    }
  } catch (_) { list = []; }
  _cache = list;
  return _cache;
}

async function _save(list) {
  _cache = Array.isArray(list) ? list : [];
  try { if (db && db.setSetting) await db.setSetting(KEY, JSON.stringify(_cache)); } catch (_) {}
}

// ── Inject the live-price source (manusTools.getSpot in the bot boot). ───────
function setPriceFetcher(fn) { if (typeof fn === 'function') _priceFetcher = fn; }

// ── NATURAL-LANGUAGE PARSER ──────────────────────────────────────────────────
// Detects an intent to WATCH the market and extracts the symbol + targets.
// Examples it understands:
//   "watch XAUUSD and alert me when it hits TP 2650 and SL 2600"
//   "monitor EURUSD, tell me if it goes above 1.0950 or below 1.0800"
//   "watch BTC live, notify me at 70000"
//   "keep an eye on gold, target 2700 stop 2620"
//   "watch gold, if it breaks 2650 then tell me and also check if RSI is above 70"
//   "watch the market for BTC, if it drops below 60000 alert me and if it goes above 65000 too"
//   "track XAUUSD, give me updates every 30 minutes and alert at 2700"
//   "watch oil, USOIL, if it breaks 80 then tell me and keep monitoring"
//   "monitor the whole crypto market, alert me if BTC, ETH or SOL move more than 5%"
//   "watch S&P500, I want to know if it goes above 5500 or below 5300, and check every 15 min"
//   "track gold, if it moves 1% in either direction tell me immediately"
//   "watch GBPUSD, alert me if it hits 1.30 or 1.28, and keep me updated every hour"
//   "monitor NASDAQ, give me a summary at market close"
// Returns { symbol, targets:[{type,price,label}], interval, feedback, conditions } or null.
function parseWatch(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();

  // Must express a "watch the market" intent — otherwise leave it to the agent.
  const watchIntent = /\b(watch|monitor|keep an eye|track|alert me|notify me|tell me|let me know|ping me|wake me)\b/.test(t)
    && /\b(market|price|when it|if it|hits?|reach(?:es)?|goes? (?:above|below)|tp|sl|take ?profit|stop ?loss|target|above|below|breaks?|at \d|mov(?:e|es?|ement)|change)\b/.test(t);
  if (!watchIntent) return null;

  // Symbol: prefer an explicit known/ticker-shaped token, else a friendly name.
  const KNOWN = ['XAUUSD','GOLD','XAGUSD','SILVER','EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','NZDUSD','USDCHF','EURJPY','GBPJPY','NAS100','NASDAQ','US30','DOW','SPX','SP500','US500','GER40','UK100','USOIL','UKOIL','BTCUSD','BTCUSDT','BTC','ETHUSD','ETH','SOL','BNB','XRP','DOGE','ADA','DOT','LINK','AVAX','MATIC'];
  let symbol = null;
  const up = raw.toUpperCase();
  for (const k of KNOWN) { if (new RegExp('\\b' + k + '\\b').test(up)) { symbol = k; break; } }
  if (!symbol) {
    const m = up.match(/\b([A-Z]{3,6}(?:USDT?|USD)?)\b/);
    if (m && !['THE','AND','FOR','SET','TP','SL','BUY','SELL','WHEN','ALERT','WATCH','PRICE','ABOVE','BELOW','TARGET','STOP','LOSS','TAKE','MOVE','MOVEMENT','CHANGE','EVERY'].includes(m[1])) symbol = m[1];
  }
  if (!symbol) {
    if (/\bgold\b/.test(t)) symbol = 'XAUUSD';
    else if (/\bsilver\b/.test(t)) symbol = 'XAGUSD';
    else if (/\bbitcoin\b/.test(t)) symbol = 'BTC';
    else if (/\bethereum\b/.test(t)) symbol = 'ETH';
    else if (/\boil\b/.test(t)) symbol = 'USOIL';
    else if (/\bsp500|s&p|spx\b/.test(t)) symbol = 'SP500';
    else if (/\bnasdaq|nas100\b/.test(t)) symbol = 'NAS100';
    else if (/\bdow|us30\b/.test(t)) symbol = 'US30';
  }
  if (!symbol) return null;

  const targets = [];
  const numRe = '(-?\\d{1,7}(?:[.,]\\d+)?)';
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));

  // Explicit TP / take-profit
  let m;
  const tpRe = new RegExp('(?:tp|take[\\s-]?profit|target|profit)\\s*(?:at|=|:|of)?\\s*' + numRe, 'gi');
  while ((m = tpRe.exec(raw))) targets.push({ type: 'tp', price: num(m[1]), label: 'TP' });
  // Explicit SL / stop-loss
  const slRe = new RegExp('(?:sl|stop[\\s-]?loss|stop)\\s*(?:at|=|:|of)?\\s*' + numRe, 'gi');
  while ((m = slRe.exec(raw))) targets.push({ type: 'sl', price: num(m[1]), label: 'SL' });
  // above / below / breaks / rises / drops
  const aboveRe = new RegExp('(?:above|over|breaks?(?: above)?|rises? to|climbs? to|goes? above|moves? (?:up|above)|rally to|surge to|pump to)\\s*' + numRe, 'gi');
  while ((m = aboveRe.exec(raw))) targets.push({ type: 'above', price: num(m[1]), label: 'above' });
  const belowRe = new RegExp('(?:below|under|drops? to|falls? to|goes? below|dips? to|moves? (?:down|below)|dump to|crashes? to|plunges? to)\\s*' + numRe, 'gi');
  while ((m = belowRe.exec(raw))) targets.push({ type: 'below', price: num(m[1]), label: 'below' });
  // generic "hits / reaches / at N" → decide direction at fire time (touch).
  const hitRe = new RegExp("(?:hits?|reach(?:es)?|touch(?:es)?|when it(?:'s| is)?(?: at)?|at)\\s*" + numRe, 'gi');
  while ((m = hitRe.exec(raw))) {
    const p = num(m[1]);
    if (!targets.some(x => Math.abs(x.price - p) < 1e-9)) targets.push({ type: 'touch', price: p, label: 'level' });
  }

  // 🔬 ADVANCED CONDITIONS — check for percentage-based moves
  const pctMoveMatch = t.match(/\b(mov(?:e|es?|ement)|chang(?:e|es?)|shift)\b.*?\b(?:more than|by|of|at least|over|>)?\s*(\d+(?:\.\d+)?)\s*%\b/i);
  if (pctMoveMatch && !targets.length) {
    const pct = parseFloat(pctMoveMatch[2]);
    if (pct > 0 && pct < 100) {
      targets.push({ type: 'pct_move', pct: pct, label: pct + '% move' });
    }
  }

  // Detect "every N minutes/hours" feedback interval
  const everyRe = t.match(/\bevery\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  let feedbackMs = FEEDBACK_MS;
  if (everyRe) {
    const val = parseFloat(everyRe[1]);
    const unit = (everyRe[2] || '').toLowerCase();
    if (unit.startsWith('h')) feedbackMs = val * 60 * 60 * 1000;
    else if (unit.startsWith('s')) feedbackMs = val * 1000;
    else feedbackMs = val * 60 * 1000;
    feedbackMs = Math.max(15000, Math.min(Math.round(feedbackMs), 24 * 3600000));
  }
  const moveThreshold = t.match(/(?:moves?|changes?|movement|shift)\s*(?:by|at least|over|more than)?\s*(\d+(?:\.\d+)?)\s*%/i);
  const feedbackMovePct = moveThreshold
    ? Math.max(0.01, Math.min(100, parseFloat(moveThreshold[1])))
    : (pctMoveMatch ? Math.max(0.01, Math.min(100, parseFloat(pctMoveMatch[2]))) : null);

  // Optional interval hint
  let interval = '15m';
  const iv = t.match(/\b(1m|5m|15m|30m|1h|4h|1d)\b/);
  if (iv) interval = iv[1];

  // De-dupe on (type,price)
  const seen = new Set();
  const clean = targets.filter(x => {
    if (x.type === 'pct_move') return true;
    if (!Number.isFinite(x.price)) return false;
    const k = x.type + ':' + x.price;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  // 🔁 FEEDBACK-ONLY WATCH. The user asked to 'monitor X and give me feedback'
  if (!clean.length) {
    const feedbackIntent = /\b(feedback|update|change[sd]?|moves?|movement|how it(?:\'s| is)? (?:doing|going)|price|keep me posted|report|recheck|check (?:again|back)|summary|status)\b/.test(t);
    if (feedbackIntent) {
      return { symbol, targets: [], interval, feedback: true, feedbackMs, feedbackMovePct };
    }
    return null;
  }

  return { symbol, targets: clean, interval, feedback: true, feedbackMs, feedbackMovePct };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
async function add(chatId, symbol, targets, extra = {}) {
  const list = await _load();
  const mine = list.filter(w => String(w.chatId) === String(chatId));
  if (mine.length >= MAX_PER_CHAT) {
    throw new Error(`You already have ${mine.length} active market watches (max ${MAX_PER_CHAT}). Send /stopwatch to clear some.`);
  }
  // Snapshot the current price so a "touch" target knows which side it started.
  let startPrice = null, startSrc = null;
  if (_priceFetcher) {
    try { const q = await _priceFetcher(symbol); if (q && Number.isFinite(q.price)) { startPrice = q.price; startSrc = q.source || null; } } catch (_) {}
  }
  const entry = {
    id: _uid(),
    chatId: String(chatId),
    symbol: String(symbol || '').toUpperCase().slice(0, 20),
    interval: extra.interval || '15m',
    // Each target leg carries a `fired` flag so we alert once per leg.
    targets: (targets || []).map(x => ({
      type: x.type, price: Number(x.price) || 0, label: x.label || x.type, fired: false,
      // For a bare "touch", remember which side of the level we started on.
      startAbove: startPrice != null ? (startPrice >= Number(x.price)) : null,
      // For percentage-based moves, store the pct and starting price
      pct: x.pct || null,
      pctStartPrice: startPrice,
    })),
    startPrice, startSrc,
    createdAt: Date.now(),
    notify: extra.notify !== false,
    // When true, after the alert we ALSO run an interactive agent follow-up
    // (fresh analysis / next-move suggestion). Off by default = pure alert.
    interactive: !!extra.interactive,
    // 🔁 Periodic feedback: on by default so EVERY watch rechecks and reports
    // the live price + moves on a cadence (the "give me feedback" requirement).
    // A pure feedback watch (no fixed target) relies on this exclusively.
    feedback: extra.feedback !== false,
    feedbackMs: Number.isFinite(extra.feedbackMs) ? Math.max(15000, Math.min(24 * 3600000, extra.feedbackMs)) : FEEDBACK_MS,
    feedbackMovePct: Number.isFinite(extra.feedbackMovePct) ? Math.max(0.01, Math.min(100, extra.feedbackMovePct)) : FEEDBACK_MOVE_PCT,
    lastFeedbackAt: Date.now(),
    lastFeedbackPrice: startPrice,
    lastPrice: startPrice,
    lastCheck: Date.now(),
    checks: 0,
  };
  list.push(entry);
  await _save(list);
  return entry;
}

async function list(chatId) {
  const all = await _load();
  const mine = all.filter(w => String(w.chatId) === String(chatId));
  mine.sort((a, b) => a.createdAt - b.createdAt);
  return mine;
}

async function stopAll(chatId) {
  const all = await _load();
  const before = all.length;
  const kept = all.filter(w => String(w.chatId) !== String(chatId));
  await _save(kept);
  return before - kept.length;
}

async function stopOne(chatId, id) {
  const all = await _load();
  const kept = all.filter(w => !(w.id === id && String(w.chatId) === String(chatId)));
  const removed = all.length - kept.length;
  await _save(kept);
  return removed;
}

// ── Decide whether a leg has triggered given the latest price. ───────────────
function _legTriggered(leg, price) {
  if (leg.fired) return false;
  const p = Number(price);
  switch (leg.type) {
    case 'tp':      // take-profit: reached or exceeded to the upside OR downside
    case 'touch': {
      // If we know the starting side, fire when we cross it; else fire on touch.
      if (leg.startAbove === true)  return p <= leg.price;   // was above → came down to level
      if (leg.startAbove === false) return p >= leg.price;   // was below → rose to level
      return Math.abs(p - leg.price) / Math.max(1e-9, Math.abs(leg.price)) < 0.0005 || false;
    }
    case 'above':   return p >= leg.price;
    case 'below':   return p <= leg.price;
    case 'sl':      // stop-loss: fire if price is at/below (long) — but we don't
                    // know direction, so fire on touch of the level from either side.
      if (leg.startAbove === true)  return p <= leg.price;
      if (leg.startAbove === false) return p >= leg.price;
      return p <= leg.price;
    case 'pct_move': {
      // Percentage-based move: fire when price has moved more than leg.pct% from startPrice
      // This is tracked in the watch's _pctStartPrice
      const base = Number.isFinite(leg.pctStartPrice) ? leg.pctStartPrice : leg.startPrice;
      if (!base || !Number.isFinite(base)) return false;
      const movePct = Math.abs((p - base) / base) * 100;
      return movePct >= (leg.pct || 1);
    }
    default:        return false;
  }
}

function _fmt(p) {
  if (p == null || !Number.isFinite(p)) return String(p);
  const abs = Math.abs(p);
  const dec = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return (+p).toFixed(dec);
}

// ── TICKER ───────────────────────────────────────────────────────────────────
async function _tick() {
  if (_ticking || !_runners.length || !_priceFetcher) return;
  _ticking = true;
  try {
    let all = await _load();
    if (!all.length) return;
    const now = Date.now();

    // Drop expired / fully-fired watches up front.
    all = all.filter(w => (now - (w.createdAt || 0)) < MAX_AGE_MS);

    // Group by symbol so we hit each price API ONCE per tick (rate-friendly).
    const bySym = {};
    for (const w of all) { (bySym[w.symbol] = bySym[w.symbol] || []).push(w); }

    let dirty = false;
    for (const symbol of Object.keys(bySym)) {
      let quote = null;
      try { quote = await _priceFetcher(symbol); } catch (_) { quote = null; }
      if (!quote || !Number.isFinite(quote.price)) continue;
      const price = Number(quote.price);

      for (const w of bySym[symbol]) {
        const prevPrice = Number.isFinite(w.lastPrice) ? w.lastPrice : price;
        w.lastPrice = price; w.lastCheck = now; w.checks = (w.checks || 0) + 1; dirty = true;

        // Helper: hand an event to the runners; first owner handles it.
        const emit = async (event) => {
          for (const run of _runners) {
            try { const handled = await run({ chatId: w.chatId, symbol: w.symbol, event, watch: w }); if (handled) break; }
            catch (_) { /* a failed runner never blocks the others */ }
          }
        };

        // ── 1) FIXED TARGET LEGS (TP / SL / above / below / touch) ──────────
        for (const leg of w.targets) {
          if (_legTriggered(leg, price)) {
            leg.fired = true; leg.firedAt = now; leg.firedPrice = price; dirty = true;

            const emoji = leg.type === 'tp' ? '🎯' : leg.type === 'sl' ? '🛑' : leg.type === 'pct_move' ? '📊' : '🔔';
            const verb = leg.type === 'tp' ? 'hit TAKE-PROFIT' : leg.type === 'sl' ? 'hit STOP-LOSS' :
                         leg.type === 'above' ? 'broke ABOVE' : leg.type === 'below' ? 'dropped BELOW' :
                         leg.type === 'pct_move' ? `moved ${leg.pct}%` : 'reached your level';
            await emit({
              type: leg.type,
              label: leg.label,
              target: leg.price,
              price,
              source: quote.source || 'live',
              text: `${emoji} *${w.symbol}* ${verb} *${_fmt(leg.price)}*\n` +
                    `Live price: *${_fmt(price)}* (${quote.source || 'live'})\n` +
                    `Time: ${new Date(now).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
            });
          }
        }

        // ── 2) 🔁 PERIODIC FEEDBACK (recheck → tell the user) ───────────────
        // The core "give me feedback" requirement: even before a target hits,
        // report the live price. Two triggers, throttled so we never spam:
        //   • CHANGE: price moved ≥ FEEDBACK_MOVE_PCT since we last reported.
        //   • POLL:   at least feedbackMs elapsed since the last feedback.
        if (w.feedback) {
          const base = Number.isFinite(w.lastFeedbackPrice) ? w.lastFeedbackPrice : prevPrice;
          const movePct = base ? Math.abs((price - base) / base) * 100 : 0;
          const dueByTime = (now - (w.lastFeedbackAt || 0)) >= (w.feedbackMs || FEEDBACK_MS);
          const dueByMove = base != null && movePct >= (Number.isFinite(w.feedbackMovePct) ? w.feedbackMovePct : FEEDBACK_MOVE_PCT);
          // Don't double-message in the same tick as a target-hit for this watch.
          const firedThisTick = w.targets.some(l => l.firedAt === now);

          if ((dueByMove || dueByTime) && !firedThisTick) {
            const dir = base == null ? '' : price > base ? '📈 up' : price < base ? '📉 down' : '➡️ flat';
            const deltaTxt = base == null ? '' :
              ` (${dir} ${movePct.toFixed(2)}% from ${_fmt(base)})`;
            const kind = dueByMove ? 'change' : 'poll';
            const head = dueByMove ? `🔁 *${w.symbol}* price update` : `⏱️ *${w.symbol}* still watching`;
            await emit({
              type: kind,
              label: kind,
              target: null,
              price,
              source: quote.source || 'live',
              text: `${head}\n` +
                    `Live price: *${_fmt(price)}* (${quote.source || 'live'})${deltaTxt}\n` +
                    `Time: ${new Date(now).toISOString().replace('T', ' ').slice(0, 19)} UTC`,
            });
            w.lastFeedbackAt = now;
            w.lastFeedbackPrice = price;
            dirty = true;
          }
        }
      }
    }

    // Keep a watch alive while it still has an un-fired target OR it's a live
    // feedback watch that hasn't expired — so periodic feedback keeps flowing.
    const kept = all.filter(w =>
      w.targets.some(l => !l.fired) ||
      (w.feedback && (now - (w.createdAt || 0)) < MAX_AGE_MS)
    );
    if (kept.length !== all.length || dirty) await _save(kept);
  } catch (_) { /* never let the ticker die */ }
  finally { _ticking = false; }
}

// Register a notifier callback and (idempotently) start the ticker.
function start(runner) {
  if (typeof runner === 'function' && !_runners.includes(runner)) _runners.push(runner);
  if (_timer) return;
  _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  _tick().catch(() => {});
}

// A friendly one-line summary of a watch (for /watches).
function describe(w) {
  const legs = (w.targets || []).map(l => {
    const badge = l.type === 'tp' ? 'TP' : l.type === 'sl' ? 'SL' : l.type === 'above' ? '≥' : l.type === 'below' ? '≤' : l.type === 'pct_move' ? `${l.pct}%` : '@';
    const val = l.type === 'pct_move' ? `${l.pct}% move` : _fmt(l.price);
    return `${badge} ${val}${l.fired ? ' ✅' : ''}`;
  }).join(', ');
  const last = w.lastPrice != null ? ` | last ${_fmt(w.lastPrice)}` : '';
  if (!legs) {
    // Feedback-only watch: no fixed target, just periodic price updates.
    const every = Math.round((w.feedbackMs || FEEDBACK_MS) / 60000);
    return `${w.symbol}: 🔁 live feedback every ~${every}m${last}`;
  }
  return `${w.symbol}: ${legs}${w.feedback ? ' | 🔁 feedback on' : ''}${last}`;
}

module.exports = {
  parseWatch,
  setPriceFetcher,
  add,
  list,
  stopAll,
  stopOne,
  start,
  describe,
  _fmt,
};
