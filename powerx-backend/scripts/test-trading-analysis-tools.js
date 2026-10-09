// scripts/test-trading-analysis-tools.js
// Verifies the new AGENT TOOLS (analyze_market, trade_signal, position_size,
// risk_check, performance_report, health_check) via manusTools, using a mocked
// candle source so it runs OFFLINE. Mocks db + tradingEngine.fetchCandles.

'use strict';
const path = require('path');

// ── Mock ../db ───────────────────────────────────────────────────────────────
const _store = new Map();
const dbMock = { getSetting: async k => (_store.has(k) ? _store.get(k) : null), setSetting: async (k, v) => { _store.set(k, v); return true; }, nowISO: () => new Date().toISOString() };
const dbPath = path.resolve(__dirname, '../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

const manus = require('../services/manusTools');
const te = require('../services/tradingEngine');

// Force fetchCandles to return a synthetic uptrend so tools are deterministic.
te.fetchCandles = async () => {
  const rows = [];
  for (let i = 0; i < 220; i++) { const b = 100 + i * 0.5; rows.push([i * 60000, b, b + 0.6, b - 0.3, b + 0.4, 100 + (i % 5)]); }
  return rows;
};

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra); } }

async function main() {
  const ctx = { chatId: 'ana:chat' };

  // Seed closed trades BEFORE any engine _load() so the perf report sees them.
  const seed = [
    { id: 't1', chatId: 'perf:chat', status: 'CLOSED', pnl: 100, r: 2, symbol: 'BTC/USDT', closeReason: 'TP', openedAt: 1, closedAt: Date.UTC(2026,0,5) },
    { id: 't2', chatId: 'perf:chat', status: 'CLOSED', pnl: -50, r: -1, symbol: 'BTC/USDT', closeReason: 'SL', openedAt: 2, closedAt: Date.UTC(2026,0,6) },
  ];
  _store.set('agent_trades', JSON.stringify(seed));

  console.log('── analyze_market ──');
  const am = await manus.toolAnalyzeMarket({ symbol: 'BTC', timeframe: '15m' }, ctx);
  ok('analyze_market returns analysis', /MARKET ANALYSIS/.test(am), am.slice(0, 80));
  ok('analyze_market shows a GRADE', /GRADE:/.test(am));
  ok('analyze_market shows BIAS LONG', /BIAS: LONG/.test(am), am);

  console.log('── trade_signal ──');
  const ts = await manus.toolTradeSignal({ symbol: 'BTC', timeframe: '15m', rr: 2 }, ctx);
  ok('trade_signal returns a plan', /TRADE SIGNAL/.test(ts), ts.slice(0, 80));
  ok('trade_signal has Entry/SL/TP', /Entry:/.test(ts) && /SL:/.test(ts) && /TP:/.test(ts), ts);

  console.log('── position_size ──');
  const psz = await manus.toolPositionSize({ account: 10000, riskPct: 1, entry: 100, sl: 98 }, ctx);
  ok('position_size computes 50 units', /Size: 50/.test(psz), psz);

  console.log('── risk_check ──');
  const rc = await manus.toolRiskCheck({ side: 'buy', entry: 100, sl: 98, tp: 106 }, { chatId: 'perf:chat' });
  ok('risk_check returns R:R', /R:R = 3/.test(rc), rc);
  ok('risk_check has session', /Session:/.test(rc), rc);

  console.log('── performance_report (with trades) ──');
  const pr = await manus.toolPerformanceReport({}, { chatId: 'perf:chat' });
  ok('performance_report shows winrate', /Winrate:/.test(pr), pr);
  ok('performance_report shows expectancy', /Expectancy/.test(pr), pr);
  ok('performance_report handles empty chat', /No closed trades/.test(await manus.toolPerformanceReport({}, { chatId: 'empty:chat' })));

  console.log('\n──────────────────────────');
  console.log(`ANALYSIS-TOOLS RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('CRASH:', e); process.exit(1); });
