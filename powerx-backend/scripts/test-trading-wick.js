// scripts/test-trading-wick.js
// Proves the WICK-ACCURATE SL/TP detection fix: a price that SPIKES through the
// SL or TP between two polls (but where `last` has already recovered) MUST still
// trigger a hit — this is the #1 accuracy bug in naive last-price pollers.
// Mocks db + ccxt (with fetchOHLCV returning a wick) so it runs offline.

'use strict';
const path = require('path');

// ── Mock ../db ───────────────────────────────────────────────────────────────
const _store = new Map();
const dbMock = {
  getSetting: async (k) => (_store.has(k) ? _store.get(k) : null),
  setSetting: async (k, v) => { _store.set(k, v); return true; },
  nowISO: () => new Date().toISOString(),
};
const dbPath = path.resolve(__dirname, '../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// ── Mock ccxt: fetchTicker returns `last`, fetchOHLCV returns the recent candle
//    whose HIGH/LOW is the wick that happened since the last poll. ────────────
let TICKER = { 'binanceusdm|BTC/USDT': 65000 };
let CANDLE = { 'binanceusdm|BTC/USDT': { high: 65000, low: 65000 } }; // [ts,o,h,l,c,v]
function makeMockExchange(id) {
  return class {
    constructor() { this.id = id; }
    milliseconds() { return Date.now(); }
    async fetchTicker(sym) {
      const price = TICKER[`${id}|${sym}`];
      if (price == null) throw new Error('no mock ticker ' + id + '|' + sym);
      return { last: price, high: undefined, low: undefined, timestamp: Date.now(), symbol: sym };
    }
    async fetchOHLCV(sym, tf, since, limit) {
      const c = CANDLE[`${id}|${sym}`];
      const last = TICKER[`${id}|${sym}`];
      if (!c) throw new Error('no mock candle');
      // one in-progress candle: [ts, open, high, low, close, vol]
      return [[Date.now(), last, c.high, c.low, last, 10]];
    }
    async fetchBalance() { return { USDT: { free: 100000 } }; }
    async createOrder(sym) { return { id: 'mock', average: TICKER[`${id}|${sym}`], timestamp: Date.now() }; }
  };
}
const ccxtPath = require.resolve('ccxt');
require.cache[ccxtPath] = {
  id: ccxtPath, filename: ccxtPath, loaded: true,
  exports: { version: 'mock', binanceusdm: makeMockExchange('binanceusdm'), bybit: makeMockExchange('bybit') },
};

const te = require('../services/tradingEngine');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra); } }

async function main() {
  const chat = 'wick:chat';
  const alerts = [];
  te.start(async ({ chatId, event }) => { if (chatId === chat) { alerts.push(event.type); return true; } return false; });

  console.log('── LONG: wick DOWN through SL, last recovers above SL ──');
  // Open long entry 65000, SL 64000, TP 70000. last stays 65000.
  TICKER['binanceusdm|BTC/USDT'] = 65000;
  CANDLE['binanceusdm|BTC/USDT'] = { high: 65000, low: 65000 };
  const t1 = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'BTC', side: 'buy', amount: 0.1, sl: 64000, tp: 70000, mode: 'PAPER' });
  alerts.length = 0;
  // Price WICKED to 63900 (below SL) then recovered to 65100 — a naive poller
  // that only reads `last`=65100 would MISS this. The candle low = 63900.
  TICKER['binanceusdm|BTC/USDT'] = 65100;
  CANDLE['binanceusdm|BTC/USDT'] = { high: 65200, low: 63900 };
  await te._tickNow();
  const c1 = (await te.listTrades(chat, { status: 'CLOSED' })).find(t => t.id === t1.id);
  ok('wick-down SL caught for long', c1 && c1.closeReason === 'SL', c1 && c1.closeReason);
  ok('SL alert fired', alerts.includes('SL'), JSON.stringify(alerts));
  ok('exit filled AT the SL level (no slippage)', c1 && c1.exit === 64000, 'exit=' + (c1 && c1.exit));

  console.log('── SHORT: wick UP through SL, last recovers below SL ──');
  TICKER['binanceusdm|ETH/USDT'] = 3000; CANDLE['binanceusdm|ETH/USDT'] = { high: 3000, low: 3000 };
  te._clearQuoteCache();
  const t2b = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'ETH', side: 'sell', amount: 1, sl: 3100, tp: 2800, mode: 'PAPER' });
  alerts.length = 0;
  // wick UP to 3150 (above SL 3100), last recovers to 2990
  TICKER['binanceusdm|ETH/USDT'] = 2990;
  CANDLE['binanceusdm|ETH/USDT'] = { high: 3150, low: 2985 };
  await te._tickNow();
  const c2 = (await te.listTrades(chat, { status: 'CLOSED' })).find(t => t.id === t2b.id);
  ok('wick-up SL caught for short', c2 && c2.closeReason === 'SL', c2 && c2.closeReason);
  ok('short SL exit AT level 3100', c2 && c2.exit === 3100, 'exit=' + (c2 && c2.exit));

  console.log('── same-candle SL+TP → conservative SL-first ──');
  TICKER['binanceusdm|BTC/USDT'] = 65000; CANDLE['binanceusdm|BTC/USDT'] = { high: 65000, low: 65000 };
  te._clearQuoteCache();
  const t3 = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'BTC', side: 'buy', amount: 0.1, sl: 64000, tp: 66000, mode: 'PAPER' });
  alerts.length = 0;
  // violent candle: low 63900 (SL) AND high 66100 (TP) in the same bar.
  TICKER['binanceusdm|BTC/USDT'] = 65000;
  CANDLE['binanceusdm|BTC/USDT'] = { high: 66100, low: 63900 };
  await te._tickNow();
  const c3 = (await te.listTrades(chat, { status: 'CLOSED' })).find(t => t.id === t3.id);
  ok('ambiguous candle resolves to SL (conservative)', c3 && c3.closeReason === 'SL', c3 && c3.closeReason);

  console.log('── no false hit when wick does NOT reach level ──');
  TICKER['binanceusdm|BTC/USDT'] = 65000; CANDLE['binanceusdm|BTC/USDT'] = { high: 65000, low: 65000 };
  te._clearQuoteCache();
  const t4 = await te.openTrade({ chatId: chat, exchange: 'binance', symbol: 'BTC', side: 'buy', amount: 0.1, sl: 60000, tp: 70000, mode: 'PAPER' });
  alerts.length = 0;
  TICKER['binanceusdm|BTC/USDT'] = 65200; CANDLE['binanceusdm|BTC/USDT'] = { high: 65500, low: 64800 };
  await te._tickNow();
  const still = (await te.listTrades(chat, { status: 'OPEN' })).find(t => t.id === t4.id);
  ok('trade stays OPEN when no level touched', !!still, 'open? ' + !!still);
  ok('no spurious alert', alerts.length === 0, JSON.stringify(alerts));

  console.log('\n──────────────────────────');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
