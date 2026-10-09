// scripts/test-trading-analysis.js
// Self-contained, network-free accuracy test for services/tradingAnalysis.js.
// Verifies each indicator against hand-computed reference values, plus market
// structure, signal grading, position sizing, R:R, drawdown, performance and
// session context. NO network, NO Supabase.

'use strict';
const ta = require('../services/tradingAnalysis');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name, extra); } }
function approx(a, b, eps = 1e-6) { return a != null && b != null && Math.abs(a - b) < eps; }

// Build a candle array from close prices (o=h=l=c, vol=1) for simple indicator checks.
function candlesFromCloses(closes, vols) {
  return closes.map((c, i) => [i * 60000, c, c, c, c, vols ? vols[i] : 1]);
}
// Build candles with explicit OHLC.
function candlesOHLC(rows) { return rows.map((r, i) => [i * 60000, r[0], r[1], r[2], r[3], r[4] != null ? r[4] : 1]); }

console.log('── SMA / EMA ──');
{
  const sma = ta.SMA([1, 2, 3, 4, 5], 3); // [2,3,4]
  ok('SMA(3) values', JSON.stringify(sma) === JSON.stringify([2, 3, 4]), JSON.stringify(sma));
  // EMA seed = SMA of first 3 = 2; k=2/4=0.5; next: 4*0.5+2*0.5=3; next:5*0.5+3*0.5=4
  const ema = ta.EMA([1, 2, 3, 4, 5], 3);
  ok('EMA(3) seed=2', approx(ema[0], 2), JSON.stringify(ema));
  ok('EMA(3) second=3', approx(ema[1], 3), JSON.stringify(ema));
  ok('EMA(3) third=4', approx(ema[2], 4), JSON.stringify(ema));
}

console.log('── RSI (Wilder) ──');
{
  // Classic Wilder example series → RSI ≈ 70.53 on first value.
  const closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28];
  const rsi = ta.RSI(closes, 14);
  ok('RSI length = 1', rsi.length === 1, 'len=' + rsi.length);
  ok('RSI ≈ 70.5', rsi[0] > 69 && rsi[0] < 72, 'rsi=' + rsi[0]);
}

console.log('── ATR ──');
{
  // constant range candles: high-low = 2 everywhere, no gaps → ATR = 2.
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push([100, 101, 99, 100]);
  const atr = ta.ATR(candlesOHLC(rows).map(r => r[2]) && cols_high(rows), cols_low(rows), cols_close(rows), 14);
  ok('ATR of flat 2-range = 2', approx(atr, 2, 1e-6), 'atr=' + atr);
}
function cols_high(rows){ return rows.map(r=>r[1]); }
function cols_low(rows){ return rows.map(r=>r[2]); }
function cols_close(rows){ return rows.map(r=>r[3]); }

console.log('── MACD sign ──');
{
  // Steadily rising series → MACD histogram should be positive.
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const macd = ta.MACD(closes);
  ok('MACD computed', macd && macd.macd != null, JSON.stringify(macd));
  ok('MACD > 0 on uptrend', macd.macd > 0, 'macd=' + macd.macd);
}

console.log('── Bollinger ──');
{
  const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)); // oscillate
  const bb = ta.Bollinger(closes, 20, 2);
  ok('Bollinger mid ≈ 100', bb && bb.mid > 99 && bb.mid < 101, JSON.stringify(bb));
  ok('Bollinger upper > mid > lower', bb && bb.upper > bb.mid && bb.mid > bb.lower);
}

console.log('── ADX trending vs ranging ──');
{
  const up = []; for (let i = 0; i < 60; i++) up.push([100 + i, 100 + i + 1, 100 + i - 0.2, 100 + i + 0.8]);
  const adxUp = ta.ADX(cols_high(up), cols_low(up), cols_close(up), 14);
  ok('ADX high on strong trend', adxUp && adxUp.adx > 25, JSON.stringify(adxUp));
  ok('ADX +DI > -DI on uptrend', adxUp && adxUp.plusDI > adxUp.minusDI, JSON.stringify(adxUp));
}

console.log('── Supertrend direction ──');
{
  const up = []; for (let i = 0; i < 40; i++) up.push([100 + i, 100 + i + 1, 100 + i - 0.5, 100 + i + 0.9]);
  const st = ta.Supertrend(cols_high(up), cols_low(up), cols_close(up), 10, 3);
  ok('Supertrend up on uptrend', st && st.trend === 'up', JSON.stringify(st));
}

console.log('── OBV ──');
{
  const closes = [10, 11, 12, 11, 13];
  const vol = [100, 200, 150, 120, 300];
  // obv: +200 (11>10), +150 (12>11), -120 (11<12), +300 (13>11) = 530
  const obv = ta.OBV(closes, vol);
  ok('OBV value = 530', approx(obv.value, 530), JSON.stringify(obv));
  ok('OBV rising', obv.rising === true, JSON.stringify(obv));
}

console.log('── Market structure (uptrend HH/HL) ──');
{
  // zig-zag with rising peaks and troughs
  const seq = [10,12,9,14,11,16,13,18];
  const rows = seq.map(v => [v, v + 0.5, v - 0.5, v]);
  const ms = ta.marketStructure(candlesOHLC(rows.concat(rows))); // repeat for length
  ok('structure computed', ms != null, JSON.stringify(ms));
  ok('support < resistance', ms && ms.support <= ms.resistance);
}

console.log('── signal() end-to-end (uptrend → LONG bias) ──');
{
  const up = []; for (let i = 0; i < 220; i++) { const b = 100 + i * 0.5; up.push([b, b + 0.6, b - 0.3, b + 0.4, 100 + (i % 5)]); }
  const sig = ta.signal(candlesOHLC(up));
  ok('signal computed', sig != null);
  ok('bias = LONG on uptrend', sig && sig.bias === 'LONG', sig && sig.bias);
  ok('grade present', sig && typeof sig.grade === 'string', sig && sig.grade);
  ok('regime trending', sig && sig.regime === 'trending', sig && sig.regime);
  ok('has indicators + structure', sig && sig.indicators && sig.structure);
}

console.log('── position sizing ──');
{
  // account 10000, risk 1% = $100, entry 100, sl 98 → per-unit risk 2 → size 50
  const ps = ta.positionSize({ account: 10000, riskPct: 1, entry: 100, sl: 98 });
  ok('size = 50', approx(ps.size, 50), JSON.stringify(ps));
  ok('riskAmount = 100', approx(ps.riskAmount, 100), JSON.stringify(ps));
  ok('notional = 5000', approx(ps.notional, 5000), JSON.stringify(ps));
  const bad = ta.positionSize({ account: 10000, riskPct: 1, entry: 100, sl: 100 });
  ok('rejects entry==sl', bad.valid === false, JSON.stringify(bad));
}

console.log('── risk:reward ──');
{
  const rr = ta.riskReward({ side: 'buy', entry: 100, sl: 98, tp: 106 }); // risk 2 reward 6 → 3R
  ok('R:R = 3', approx(rr.rr, 3), JSON.stringify(rr));
  ok('dirOK true', rr.dirOK === true);
  const wrong = ta.riskReward({ side: 'buy', entry: 100, sl: 102, tp: 106 });
  ok('dirOK false when SL above entry (long)', wrong.dirOK === false);
}

console.log('── suggestSlTp (ATR) ──');
{
  const up = []; for (let i = 0; i < 60; i++) { const b = 100 + i; up.push([b, b + 1, b - 1, b]); }
  const plan = ta.suggestSlTp(candlesOHLC(up), { side: 'buy', rr: 2, method: 'atr' });
  ok('plan has sl<entry<tp (long)', plan && plan.sl < plan.entry && plan.tp > plan.entry, JSON.stringify(plan));
  ok('plan R:R ≈ 2', plan && approx(plan.riskReward.rr, 2, 0.05), JSON.stringify(plan.riskReward));
}

console.log('── drawdown monitor ──');
{
  const closed = [{ pnl: -10 }, { pnl: -5 }, { pnl: -8 }]; // 3-loss streak
  const dd = ta.drawdownMonitor(closed);
  ok('loss streak = 3', dd.lossStreak === 3, JSON.stringify(dd));
  ok('reduceSize true', dd.reduceSize === true);
  ok('sizeMultiplier = 0.5', approx(dd.sizeMultiplier, 0.5));
}

console.log('── performance / expectancy ──');
{
  const closed = [
    { status: 'CLOSED', pnl: 100, r: 2, symbol: 'BTC/USDT', closeReason: 'TP', closedAt: Date.UTC(2026,0,5) }, // Monday
    { status: 'CLOSED', pnl: -50, r: -1, symbol: 'BTC/USDT', closeReason: 'SL', closedAt: Date.UTC(2026,0,6) },
    { status: 'CLOSED', pnl: 200, r: 2, symbol: 'ETH/USDT', closeReason: 'TP', closedAt: Date.UTC(2026,0,7) },
    { status: 'CLOSED', pnl: -50, r: -1, symbol: 'ETH/USDT', closeReason: 'SL', closedAt: Date.UTC(2026,0,8) },
  ];
  const p = ta.performance(closed);
  ok('trades = 4', p.trades === 4, JSON.stringify(p));
  ok('winrate = 50%', approx(p.winrate, 50), 'wr=' + p.winrate);
  // avgWin = (100+200)/2 = 150; avgLoss = (-50-50)/2 = -50
  ok('avgWin = 150', approx(p.avgWin, 150), 'avgWin=' + p.avgWin);
  ok('avgLoss = -50', approx(p.avgLoss, -50), 'avgLoss=' + p.avgLoss);
  // expectancy = 0.5*150 - 0.5*50 = 50
  ok('expectancy = 50', approx(p.expectancy, 50), 'exp=' + p.expectancy);
  // profit factor = 300/100 = 3
  ok('profit factor = 3', approx(p.profitFactor, 3), 'pf=' + p.profitFactor);
  ok('total PnL = 200', approx(p.totalPnl, 200), 'tot=' + p.totalPnl);
  ok('equity curve length = 4', p.equityCurve.length === 4);
}

console.log('── session context ──');
{
  const s = ta.sessionContext(Date.UTC(2026, 0, 6, 14, 0, 0)); // Tue 14:00 UTC → NY + overlap
  ok('session = New York', s.session === 'New York', JSON.stringify(s));
  ok('overlap flagged', !!s.overlap, JSON.stringify(s));
  const wk = ta.sessionContext(Date.UTC(2026, 0, 3, 12, 0, 0)); // Saturday
  ok('weekend flagged', wk.weekendUTC === true, JSON.stringify(wk));
}

console.log('\n──────────────────────────');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
