// scripts/test-trading-engine.js
// Heavy, self-contained accuracy test for services/tradingEngine.js.
// Mocks the db (in-memory) and the ccxt price source so it runs with NO network
// and NO Supabase — verifying PnL/R math, SL/TP hit detection (long+short),
// paper slippage, the 24/7 watcher firing, idempotency, and stats.

'use strict';
const path = require('path');
const Module = require('module');

// ── 1) Mock ../db BEFORE requiring the engine ────────────────────────────────
const _store = new Map();
const dbMock = {
  getSetting: async (k) => (_store.has(k) ? _store.get(k) : null),
  setSetting: async (k, v) => { _store.set(k, v); return true; },
  nowISO: () => new Date().toISOString(),
};
const dbPath = path.resolve(__dirname, '../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// ── 1b) Mock ccxt so the engine's REAL fetchPrice returns controlled prices ──
// PRICE is keyed by "<exchangeId>|<UNIFIED SYMBOL>", e.g. "binanceusdm|BTC/USDT".
let PRICE = { 'binanceusdm|BTC/USDT': 65000, 'binanceusdm|ETH/USDT': 3000, 'bybit|SOL/USDT': 150 };
function makeMockExchange(id) {
  return class {
    constructor() { this.id = id; }
    milliseconds() { return Date.now(); }
    async fetchTicker(sym) {
      const price = PRICE[`${id}|${sym}`];
      if (price == null) throw new Error('no mock price for ' + id + '|' + sym);
      return { last: price, timestamp: Date.now(), symbol: sym };
    }
    async fetchBalance() { return { USDT: { free: 100000 } }; }
    async setLeverage() { return {}; }
    async createOrder(sym, type, side, amount) {
      const price = PRICE[`${id}|${sym}`];
      return { id: 'mock_' + Math.random().toString(36).slice(2, 8), average: price, timestamp: Date.now() };
    }
    // NOTE: no watchTicker → engine falls back to fetchTicker (REST path).
  };
}
const ccxtPath = require.resolve('ccxt');
require.cache[ccxtPath] = {
  id: ccxtPath, filename: ccxtPath, loaded: true,
  exports: {
    version: 'mock',
    binanceusdm: makeMockExchange('binanceusdm'),
    bybit: makeMockExchange('bybit'),
    // no `pro` → engine uses the REST class above
  },
};

const te = require('../services/tradingEngine');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra); } }
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

async function main() {
  console.log('── PnL / R math ──');
  // Long BTC: entry 60000, sl 59000, tp 62000, amount 0.5
  {
    const t = { side: 'buy', entry: 60000, sl: 59000, tp: 62000, amount: 0.5 };
    const win = te.computePnl(t, 62000); // +2000*0.5 = +1000, risk=1000*0.5=500 → R=2
    ok('long win pnl = +1000', approx(win.pnl, 1000), JSON.stringify(win));
    ok('long win R = 2', approx(win.r, 2), JSON.stringify(win));
    const loss = te.computePnl(t, 59000); // -1000*0.5=-500 → R=-1
    ok('long loss pnl = -500', approx(loss.pnl, -500), JSON.stringify(loss));
    ok('long loss R = -1', approx(loss.r, -1), JSON.stringify(loss));
  }
  // Short ETH: entry 3000, sl 3100, tp 2800, amount 2
  {
    const t = { side: 'sell', entry: 3000, sl: 3100, tp: 2800, amount: 2 };
    const win = te.computePnl(t, 2800); // (3000-2800)*2 = +400, risk=100*2=200 → R=2
    ok('short win pnl = +400', approx(win.pnl, 400), JSON.stringify(win));
    ok('short win R = 2', approx(win.r, 2), JSON.stringify(win));
    const loss = te.computePnl(t, 3100); // -200 → R=-1
    ok('short loss pnl = -200', approx(loss.pnl, -200), JSON.stringify(loss));
  }

  console.log('── symbol normalisation ──');
  ok('btc → BTC/USDT', te.normSymbol('btc') === 'BTC/USDT');
  ok('ETHUSDT → ETH/USDT', te.normSymbol('ETHUSDT') === 'ETH/USDT');
  ok('SOL-USD → SOL/USDT', te.normSymbol('SOL-USD') === 'SOL/USDT');
  ok('passthrough BTC/USDT', te.normSymbol('BTC/USDT') === 'BTC/USDT');

  console.log('── open PAPER trade (slippage applied) ──');
  PRICE['binanceusdm|BTC/USDT'] = 65000;
  const chat = 'test:chat1';
  const alerts = [];
  te.start(async ({ chatId, event, trade }) => { if (chatId === chat) { alerts.push({ type: event.type, text: event.text }); return true; } return false; });
  const t1 = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'BTC', side: 'buy', amount: 0.1, sl: 64000, tp: 67000, mode: 'PAPER' });
  // buy slippage: entry = 65000 + 0.05% = 65032.5
  ok('paper long entry has +slippage', approx(t1.entry, 65000 + 0.0005 * 65000, 1e-3), 'entry=' + t1.entry);
  ok('trade is OPEN', t1.status === 'OPEN');
  ok('open alert fired', alerts.some(a => a.type === 'OPEN'), JSON.stringify(alerts.map(a => a.type)));
  ok('open alert text format', alerts.find(a => a.type === 'OPEN').text.includes('TRADE OPENED'));

  console.log('── SL/TP hit rejection (wrong side) ──');
  let threw = false;
  try { await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'BTC', side: 'buy', amount: 0.1, sl: 66000, tp: 67000, mode: 'PAPER' }); }
  catch (_) { threw = true; }
  ok('rejects long SL above entry', threw);

  console.log('── 24/7 watcher: TP hit (long) ──');
  alerts.length = 0;
  PRICE['binanceusdm|BTC/USDT'] = 67000; // hit TP
  // Manually invoke a tick by nudging the ticker: call the internal loop via a fresh price + short wait.
  await tickOnce();
  const openAfter = await te.listTrades(chat, { status: 'OPEN' });
  const closedAfter = await te.listTrades(chat, { status: 'CLOSED' });
  ok('trade closed after TP', closedAfter.length >= 1, 'closed=' + closedAfter.length);
  const tpTrade = closedAfter.find(t => t.id === t1.id);
  ok('closed reason = TP', tpTrade && tpTrade.closeReason === 'TP', tpTrade && tpTrade.closeReason);
  ok('TP HIT alert fired', alerts.some(a => a.type === 'TP'), JSON.stringify(alerts.map(a => a.type)));
  ok('TP alert format', alerts.find(a => a.type === 'TP') && alerts.find(a => a.type === 'TP').text.includes('TP HIT'));
  ok('TP pnl positive', tpTrade && tpTrade.pnl > 0, 'pnl=' + (tpTrade && tpTrade.pnl));

  console.log('── 24/7 watcher: SL hit (short) ──');
  alerts.length = 0;
  PRICE['bybit|SOL/USDT'] = 150;
  const t2 = await te.openTrade({ chatId: chat, exchange: 'bybit', symbol: 'SOL', side: 'sell', amount: 5, sl: 155, tp: 140, mode: 'PAPER' });
  PRICE['bybit|SOL/USDT'] = 156; // short SL is ABOVE → hit
  await tickOnce();
  const slTrade = (await te.listTrades(chat, { status: 'CLOSED' })).find(t => t.id === t2.id);
  ok('short trade closed via SL', slTrade && slTrade.closeReason === 'SL', slTrade && slTrade.closeReason);
  ok('SL HIT alert fired', alerts.some(a => a.type === 'SL'), JSON.stringify(alerts.map(a => a.type)));
  ok('SL pnl negative', slTrade && slTrade.pnl < 0, 'pnl=' + (slTrade && slTrade.pnl));

  console.log('── idempotency: second tick does not re-close / re-alert ──');
  alerts.length = 0;
  await tickOnce();
  ok('no duplicate alerts on re-tick', alerts.length === 0, 'alerts=' + alerts.length);

  console.log('── manual close ──');
  PRICE['binanceusdm|ETH/USDT'] = 3000;
  const t3 = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'ETH', side: 'buy', amount: 1, sl: 2900, tp: 3200, mode: 'PAPER' });
  PRICE['binanceusdm|ETH/USDT'] = 3100;
  te._clearQuoteCache(); // ensure the close fetches the NEW live price
  const closed3 = await te.closeTrade(chat, t3.id, { reason: 'MANUAL' });
  ok('manual close sets CLOSED', closed3.status === 'CLOSED');
  ok('manual close reason', closed3.closeReason === 'MANUAL');
  ok('manual close pnl ~ +100 (minus slippage)', closed3.pnl > 80 && closed3.pnl < 100, 'pnl=' + closed3.pnl);

  console.log('── stats ──');
  const s = await te.stats(chat);
  ok('stats has closed count', s.closed >= 3, JSON.stringify(s));
  ok('winrate is a %', s.winrate != null && s.winrate >= 0 && s.winrate <= 100, 'winrate=' + s.winrate);
  ok('avgR computed', s.avgR != null, 'avgR=' + s.avgR);
  console.log('    stats:', JSON.stringify(s));

  console.log('── creds (REAL mode gating) ──');
  ok('no creds initially', !(await te.hasCreds(chat, 'binance')));
  await te.saveCreds(chat, 'binance', 'KEYabc12345', 'SECRETxyz67890');
  ok('creds saved', await te.hasCreds(chat, 'binance'));
  ok('connectedExchanges lists binance', (await te.connectedExchanges(chat)).includes('binanceusdm'));
  await te.clearCreds(chat, 'binance');
  ok('creds cleared', !(await te.hasCreds(chat, 'binance')));

  console.log('\n──────────────────────────');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// Force one watcher tick by temporarily registering + relying on the internal
// setInterval. Simplest deterministic approach: re-require the private _tick via
// a tiny delay after start(); but _tick isn't exported, so we trigger it by
// calling start() (idempotent) and waiting one TICK_MS window.
async function tickOnce() {
  // Deterministic: clear the quote cache and run one watcher tick synchronously.
  await te._tickNow();
}

main().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
