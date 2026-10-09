// scripts/test-trading-live.js
// LIVE integration test: hits the REAL Binance USDM + Bybit public APIs via
// ccxt (no keys, no orders) to prove fetchPrice works end-to-end, then opens a
// PAPER trade at the live price and confirms the watcher tracks it. Uses the
// in-memory db mock so no Supabase is needed. Safe: PAPER only, zero real orders.

'use strict';
const path = require('path');
const _store = new Map();
const dbMock = {
  getSetting: async (k) => (_store.has(k) ? _store.get(k) : null),
  setSetting: async (k, v) => { _store.set(k, v); return true; },
  nowISO: () => new Date().toISOString(),
};
const dbPath = path.resolve(__dirname, '../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

const te = require('../services/tradingEngine');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e); } };

async function main() {
  if (!te.enabled()) { console.log('ccxt not installed — skipping live test'); process.exit(0); }

  console.log('── LIVE price fetch (real exchanges, public) ──');
  let btc = null, sol = null;
  try {
    btc = await te.fetchPrice('binance', 'BTC/USDT', { mode: 'PAPER' });
    console.log('   Binance BTC/USDT:', btc.price, '(', btc.source, ')');
    ok('binance BTC price > 0', btc && btc.price > 0);
    ok('binance exchange time present', btc && btc.exTime > 0);
  } catch (e) { fail++; console.log('  ❌ binance fetch:', e.message); }
  try {
    sol = await te.fetchPrice('bybit', 'SOL/USDT', { mode: 'PAPER' });
    console.log('   Bybit SOL/USDT:', sol.price, '(', sol.source, ')');
    ok('bybit SOL price > 0', sol && sol.price > 0);
  } catch (e) { fail++; console.log('  ❌ bybit fetch:', e.message); }

  if (btc && btc.price > 0) {
    console.log('── open a PAPER trade at live BTC price + watch it ──');
    const chat = 'live:test';
    const alerts = [];
    te.start(async ({ chatId, event }) => { if (chatId === chat) { alerts.push(event.type); return true; } return false; });
    // Long with TP just above and SL just below live price so we don't accidentally hit.
    const p = btc.price;
    const t = await te.openTrade({
      chatId: chat, exchange: 'binance', symbol: 'BTC/USDT', side: 'buy',
      amount: 0.001, sl: +(p * 0.95).toFixed(2), tp: +(p * 1.05).toFixed(2), mode: 'PAPER',
    });
    ok('paper trade opened at ~live price', Math.abs(t.entry - p) / p < 0.01, 'entry=' + t.entry + ' live=' + p);
    ok('trade is OPEN', t.status === 'OPEN');
    ok('OPEN alert fired', alerts.includes('OPEN'));

    // Run a real watcher tick — should fetch the live price again and NOT close
    // (targets are ±5% away), proving the loop reads live prices without error.
    await te._tickNow();
    const stillOpen = await te.listTrades(chat, { status: 'OPEN' });
    ok('trade still open after live tick (no false SL/TP)', stillOpen.some(x => x.id === t.id));
    console.log('   live price now tracked as:', stillOpen[0] && stillOpen[0].lastPrice);

    // Force a TP by opening a trade whose TP is BELOW live (already satisfied for a long? no)
    // Instead: open a SHORT whose TP is just ABOVE current (so a long-style). We prove
    // an immediate hit by setting TP at live-1 for a long → tp<=entry is rejected, so
    // use a long with sl just ABOVE live via a manual close to keep it safe.
    const closed = await te.closeTrade(chat, t.id, { reason: 'MANUAL' });
    ok('manual close works on live price', closed.status === 'CLOSED' && Number.isFinite(closed.pnl), 'pnl=' + closed.pnl);
    console.log('   closed pnl:', closed.pnl, 'exit:', closed.exit);
  }

  console.log('\n──────────────────────────');
  console.log(`LIVE RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('LIVE TEST CRASHED:', e); process.exit(1); });
