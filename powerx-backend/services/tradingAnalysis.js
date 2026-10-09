// ─────────────────────────────────────────────────────────────────────────────
// tradingAnalysis.js — the ANALYSIS BRAIN for the PowerX trading engine.
//
// This is a pure, dependency-free, deterministic library that turns raw OHLCV
// candles into the six analysis pillars the product requires:
//
//   1. MARKET DATA        — price action, S/R, breakouts, volume, structure
//   2. TECHNICAL INDICATORS — EMA/MACD/ADX/Supertrend, RSI/Stoch/CCI/ROC,
//                             ATR/Bollinger/Keltner, + confluence
//   3. RISK & MANAGEMENT   — entry-quality grade, position sizing, R:R,
//                             ATR/structure SL-TP, drawdown monitor
//   4. SENTIMENT & CONTEXT — market regime (trend/range/vol), session/time
//   5. PERFORMANCE         — winrate by setup, PnL by day/time, expectancy,
//                             equity curve (fed CLOSED trades)
//   6. EXECUTION HEALTH    — latency, error-rate, exchange status, balance
//
// Every function is null-safe and never throws on short/sparse data — it
// returns null for a metric it can't compute so the caller can degrade cleanly.
// All indicators are unit-tested against hand-computed values in
// scripts/test-trading-analysis.js.
//
// CANDLE FORMAT (ccxt native): rows of [ timestamp, open, high, low, close, volume ].
// Helper `candlesFromArrays({o,h,l,c,v,ts})` builds this from the app's Yahoo/
// public candle shape used by manusTools.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── tiny numeric helpers ─────────────────────────────────────────────────────
const num = (x) => (Number.isFinite(+x) ? +x : null);
const last = (a) => (a && a.length ? a[a.length - 1] : null);
const sum = (a) => a.reduce((s, x) => s + (+x || 0), 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
function stdev(a) {
  if (!a || a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) * (x - m))) / (a.length - 1));
}
function round(x, d = 6) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d; }

// Extract column arrays from ccxt candles.
function cols(candles) {
  const c = Array.isArray(candles) ? candles : [];
  return {
    ts: c.map(r => num(r[0])),
    open: c.map(r => num(r[1])),
    high: c.map(r => num(r[2])),
    low: c.map(r => num(r[3])),
    close: c.map(r => num(r[4])),
    vol: c.map(r => num(r[5])),
  };
}
function candlesFromArrays({ o = [], h = [], l = [], c = [], v = [], ts = [] } = {}) {
  const n = c.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([ts[i] || i, o[i] != null ? o[i] : c[i], h[i] != null ? h[i] : c[i],
      l[i] != null ? l[i] : c[i], c[i], v[i] != null ? v[i] : 0]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. TECHNICAL INDICATORS (all take a numeric series unless noted)
// ─────────────────────────────────────────────────────────────────────────────

// Simple Moving Average series.
function SMA(src, period) {
  if (!src || src.length < period) return [];
  const out = [];
  let acc = 0;
  for (let i = 0; i < src.length; i++) {
    acc += src[i];
    if (i >= period) acc -= src[i - period];
    if (i >= period - 1) out.push(acc / period);
  }
  return out;
}

// Exponential Moving Average series (Wilder-style seed = SMA of first `period`).
function EMA(src, period) {
  if (!src || src.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = mean(src.slice(0, period));
  out.push(ema);
  for (let i = period; i < src.length; i++) {
    ema = src[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}
const emaLast = (src, p) => last(EMA(src, p));

// RSI (Wilder smoothing). Returns the series aligned to src[period..].
function RSI(close, period = 14) {
  if (!close || close.length < period + 1) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  const out = [avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)];
  for (let i = period + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return out;
}

// MACD → { macd, signal, hist } (last values).
function MACD(close, fast = 12, slow = 26, signal = 9) {
  if (!close || close.length < slow + signal) return null;
  const emaF = EMA(close, fast);
  const emaS = EMA(close, slow);
  // align: emaF is longer; trim front so both correspond to the same bars
  const offset = emaF.length - emaS.length;
  const macdLine = emaS.map((s, i) => emaF[i + offset] - s);
  const sig = EMA(macdLine, signal);
  const off2 = macdLine.length - sig.length;
  const macd = last(macdLine);
  const signalV = last(sig);
  const hist = macd != null && signalV != null ? macd - signalV : null;
  const prevHist = (macdLine.length >= 2 && sig.length >= 2)
    ? macdLine[macdLine.length - 2] - sig[sig.length - 2] : null;
  return { macd: round(macd), signal: round(signalV), hist: round(hist), prevHist: round(prevHist), _off: off2 };
}

// True Range series + ATR (Wilder).
function trueRanges(high, low, close) {
  const tr = [];
  for (let i = 0; i < close.length; i++) {
    if (i === 0) { tr.push(high[i] - low[i]); continue; }
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  return tr;
}
function ATR(high, low, close, period = 14) {
  if (!close || close.length < period + 1) return null;
  const tr = trueRanges(high, low, close);
  let atr = mean(tr.slice(1, period + 1));
  for (let i = period + 1; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return round(atr);
}

// ADX + DI (Wilder). Returns { adx, plusDI, minusDI }.
function ADX(high, low, close, period = 14) {
  const n = close.length;
  if (n < 2 * period) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const dn = low[i - 1] - low[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  const wilder = (arr) => {
    let s = sum(arr.slice(0, period));
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pDI = 100 * pS[i] / trS[i];
    const mDI = 100 * mS[i] / trS[i];
    const denom = pDI + mDI;
    dx.push(denom === 0 ? 0 : 100 * Math.abs(pDI - mDI) / denom);
  }
  if (dx.length < period) return null;
  let adx = mean(dx.slice(0, period));
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  const li = trS.length - 1;
  return { adx: round(adx), plusDI: round(100 * pS[li] / trS[li]), minusDI: round(100 * mS[li] / trS[li]) };
}

// Bollinger Bands (last). { mid, upper, lower, bandwidth, pctB }
function Bollinger(close, period = 20, mult = 2) {
  if (!close || close.length < period) return null;
  const win = close.slice(-period);
  const mid = mean(win);
  const sd = stdev(win);
  if (sd == null) return null;
  const upper = mid + mult * sd, lower = mid - mult * sd;
  const price = last(close);
  return {
    mid: round(mid), upper: round(upper), lower: round(lower),
    bandwidth: round((upper - lower) / mid),
    pctB: round((price - lower) / (upper - lower)),
  };
}

// Keltner Channels (EMA mid + ATR bands). { mid, upper, lower }
function Keltner(high, low, close, period = 20, mult = 2) {
  const mid = emaLast(close, period);
  const atr = ATR(high, low, close, period);
  if (mid == null || atr == null) return null;
  return { mid: round(mid), upper: round(mid + mult * atr), lower: round(mid - mult * atr), atr };
}

// Stochastic %K/%D (last). 
function Stochastic(high, low, close, kPeriod = 14, dPeriod = 3) {
  if (close.length < kPeriod + dPeriod) return null;
  const ks = [];
  for (let i = kPeriod - 1; i < close.length; i++) {
    const hh = Math.max(...high.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...low.slice(i - kPeriod + 1, i + 1));
    ks.push(hh === ll ? 50 : 100 * (close[i] - ll) / (hh - ll));
  }
  const d = SMA(ks, dPeriod);
  return { k: round(last(ks)), d: round(last(d)) };
}

// CCI (last).
function CCI(high, low, close, period = 20) {
  if (close.length < period) return null;
  const tp = close.map((c, i) => (high[i] + low[i] + c) / 3);
  const win = tp.slice(-period);
  const m = mean(win);
  const md = mean(win.map(x => Math.abs(x - m)));
  if (!md) return null;
  return round((last(tp) - m) / (0.015 * md));
}

// Rate of Change (%).
function ROC(close, period = 12) {
  if (close.length < period + 1) return null;
  const prev = close[close.length - 1 - period];
  if (!prev) return null;
  return round(100 * (last(close) - prev) / prev, 4);
}

// Supertrend (last). Returns { trend: 'up'|'down', value }.
function Supertrend(high, low, close, period = 10, mult = 3) {
  const n = close.length;
  if (n < period + 1) return null;
  const atrSeries = [];
  const tr = trueRanges(high, low, close);
  let atr = mean(tr.slice(1, period + 1));
  atrSeries[period] = atr;
  for (let i = period + 1; i < n; i++) { atr = (atr * (period - 1) + tr[i]) / period; atrSeries[i] = atr; }
  let trendUp = true, finalUpper = null, finalLower = null, st = null;
  for (let i = period; i < n; i++) {
    const hl2 = (high[i] + low[i]) / 2;
    const a = atrSeries[i];
    const bUpper = hl2 + mult * a;
    const bLower = hl2 - mult * a;
    finalUpper = (finalUpper == null || bUpper < finalUpper || close[i - 1] > finalUpper) ? bUpper : finalUpper;
    finalLower = (finalLower == null || bLower > finalLower || close[i - 1] < finalLower) ? bLower : finalLower;
    if (close[i] > finalUpper) trendUp = true;
    else if (close[i] < finalLower) trendUp = false;
    st = trendUp ? finalLower : finalUpper;
  }
  return { trend: trendUp ? 'up' : 'down', value: round(st) };
}

// OBV (On-Balance Volume) last + slope sign.
function OBV(close, vol) {
  if (!close || close.length < 2) return null;
  let obv = 0; const series = [0];
  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) obv += (vol[i] || 0);
    else if (close[i] < close[i - 1]) obv -= (vol[i] || 0);
    series.push(obv);
  }
  const recent = series.slice(-10);
  const slope = recent.length >= 2 ? (last(recent) - recent[0]) : 0;
  return { value: round(obv, 2), rising: slope > 0, slope: round(slope, 2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. MARKET STRUCTURE — swing points, HH/HL/LH/LL, S/R, range/breakout, volume
// ─────────────────────────────────────────────────────────────────────────────

// Fractal swing highs/lows with a `left/right` window.
function swings(high, low, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < high.length - right; i++) {
    let isH = true, isL = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (high[j] >= high[i]) isH = false;
      if (low[j] <= low[i]) isL = false;
    }
    if (isH) highs.push({ i, price: high[i] });
    if (isL) lows.push({ i, price: low[i] });
  }
  return { highs, lows };
}

function marketStructure(candles) {
  const { high, low, close, vol } = cols(candles);
  if (close.length < 10) return null;
  const { highs, lows } = swings(high, low, 2, 2);
  const lastHighs = highs.slice(-2), lastLows = lows.slice(-2);
  let trend = 'range', detail = '';
  const hh = lastHighs.length === 2 && lastHighs[1].price > lastHighs[0].price;
  const hl = lastLows.length === 2 && lastLows[1].price > lastLows[0].price;
  const lh = lastHighs.length === 2 && lastHighs[1].price < lastHighs[0].price;
  const ll = lastLows.length === 2 && lastLows[1].price < lastLows[0].price;
  if (hh && hl) { trend = 'uptrend'; detail = 'HH + HL'; }
  else if (lh && ll) { trend = 'downtrend'; detail = 'LH + LL'; }
  else { trend = 'range'; detail = 'no clean HH/HL or LH/LL'; }

  // Support/resistance from recent swing clusters + rolling extremes.
  const recentHigh = Math.max(...high.slice(-30));
  const recentLow = Math.min(...low.slice(-30));
  const resistance = highs.length ? last(highs).price : recentHigh;
  const support = lows.length ? last(lows).price : recentLow;
  const price = last(close);

  // Range detection: is price boxed between recent S/R with low ADX-ish spread?
  const rangePct = (recentHigh - recentLow) / price;
  const inRange = trend === 'range';

  // Breakout: close beyond the prior swing high/low by > 0.1%.
  let breakout = null;
  if (highs.length && price > last(highs).price * 1.001) breakout = 'up';
  else if (lows.length && price < last(lows).price * 0.999) breakout = 'down';

  // Volume: current vs 20-bar average + spike flag.
  const vAvg = mean(vol.slice(-20).filter(x => x != null));
  const vNow = last(vol);
  const volSpike = vAvg && vNow ? vNow > vAvg * 1.8 : false;

  return {
    trend, detail,
    support: round(support), resistance: round(resistance),
    recentHigh: round(recentHigh), recentLow: round(recentLow),
    rangePct: round(rangePct, 4), inRange,
    breakout,
    swingHighs: highs.slice(-3).map(h => round(h.price)),
    swingLows: lows.slice(-3).map(l => round(l.price)),
    volume: { now: round(vNow, 2), avg20: round(vAvg, 2), spike: volSpike },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL INDICATOR SNAPSHOT (pillar 2 in one object)
// ─────────────────────────────────────────────────────────────────────────────
function indicators(candles) {
  const { high, low, close, vol } = cols(candles);
  if (close.length < 30) return null;
  const price = last(close);
  return {
    price: round(price),
    ema20: round(emaLast(close, 20)),
    ema50: round(emaLast(close, 50)),
    ema200: close.length >= 200 ? round(emaLast(close, 200)) : null,
    rsi: round(last(RSI(close, 14))),
    macd: MACD(close),
    adx: ADX(high, low, close, 14),
    atr: ATR(high, low, close, 14),
    bollinger: Bollinger(close, 20, 2),
    keltner: Keltner(high, low, close, 20, 2),
    stochastic: Stochastic(high, low, close, 14, 3),
    cci: CCI(high, low, close, 20),
    roc: ROC(close, 12),
    supertrend: Supertrend(high, low, close, 10, 3),
    obv: OBV(close, vol),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLUENCE + REGIME + ENTRY-QUALITY GRADE (pillars 2 & 4 & 3)
// ─────────────────────────────────────────────────────────────────────────────
// Builds a directional bias by scoring each indicator's vote, then grades the
// setup A+ … C- based on how many agree (confluence) and trend strength.
function signal(candles) {
  const ind = indicators(candles);
  const struct = marketStructure(candles);
  if (!ind || !struct) return null;
  const price = ind.price;
  const votes = []; // { name, dir: +1|-1|0, weight }

  const addVote = (name, dir, weight = 1) => votes.push({ name, dir, weight });

  // Trend group
  if (ind.ema20 != null && ind.ema50 != null) addVote('EMA20/50', ind.ema20 > ind.ema50 ? 1 : -1, 1.2);
  if (ind.ema200 != null) addVote('EMA200', price > ind.ema200 ? 1 : -1, 1.2);
  if (ind.macd && ind.macd.hist != null) addVote('MACD', ind.macd.hist > 0 ? 1 : -1, 1);
  if (ind.supertrend) addVote('Supertrend', ind.supertrend.trend === 'up' ? 1 : -1, 1.2);
  if (struct.trend === 'uptrend') addVote('Structure', 1, 1.5);
  else if (struct.trend === 'downtrend') addVote('Structure', -1, 1.5);

  // Momentum group (mean-reversion aware: extreme RSI votes AGAINST continuation)
  if (ind.rsi != null) {
    if (ind.rsi > 70) addVote('RSI', -1, 0.8);
    else if (ind.rsi < 30) addVote('RSI', 1, 0.8);
    else addVote('RSI', ind.rsi > 50 ? 1 : -1, 0.6);
  }
  if (ind.stochastic && ind.stochastic.k != null) {
    if (ind.stochastic.k > 80) addVote('Stoch', -1, 0.6);
    else if (ind.stochastic.k < 20) addVote('Stoch', 1, 0.6);
    else addVote('Stoch', ind.stochastic.k > 50 ? 1 : -1, 0.4);
  }
  if (ind.cci != null) addVote('CCI', ind.cci > 100 ? 1 : ind.cci < -100 ? -1 : (ind.cci > 0 ? 0.5 : -0.5), 0.5);
  if (ind.roc != null) addVote('ROC', ind.roc > 0 ? 1 : -1, 0.5);

  // Volume confirmation
  if (ind.obv) addVote('OBV', ind.obv.rising ? 1 : -1, 0.7);
  if (struct.volume && struct.volume.spike) addVote('VolSpike', struct.breakout === 'up' ? 1 : struct.breakout === 'down' ? -1 : 0, 0.6);

  const bullScore = sum(votes.filter(v => v.dir > 0).map(v => v.weight * Math.abs(v.dir)));
  const bearScore = sum(votes.filter(v => v.dir < 0).map(v => v.weight * Math.abs(v.dir)));
  const net = bullScore - bearScore;
  const totalW = sum(votes.map(v => v.weight));
  const conviction = totalW ? Math.abs(net) / totalW : 0; // 0..1

  const bias = net > 0.5 ? 'LONG' : net < -0.5 ? 'SHORT' : 'NEUTRAL';
  const agree = votes.filter(v => (bias === 'LONG' ? v.dir > 0 : bias === 'SHORT' ? v.dir < 0 : false)).length;

  // Regime (pillar 4): trend vs range vs volatility state from ADX + Bollinger.
  const adxV = ind.adx ? ind.adx.adx : null;
  let regime = 'undetermined';
  if (adxV != null) {
    if (adxV >= 25) regime = 'trending';
    else if (adxV < 18) regime = 'ranging';
    else regime = 'transitioning';
  }
  let volState = 'normal';
  if (ind.bollinger && ind.atr != null) {
    if (ind.bollinger.bandwidth != null) {
      if (ind.bollinger.bandwidth > 0.08) volState = 'high';
      else if (ind.bollinger.bandwidth < 0.025) volState = 'low (squeeze)';
    }
  }

  // Entry-quality grade: combine conviction, confluence count, and trend
  // strength. A+ needs strong conviction + trending regime + volume.
  const gradeScore =
    conviction * 55 +
    Math.min(agree, 6) / 6 * 25 +
    (regime === 'trending' ? 12 : regime === 'transitioning' ? 5 : 0) +
    ((ind.obv && ((bias === 'LONG' && ind.obv.rising) || (bias === 'SHORT' && !ind.obv.rising))) ? 8 : 0);
  const grade = _grade(gradeScore, bias);

  return {
    bias, conviction: round(conviction, 3),
    grade: grade.label, gradeScore: round(gradeScore, 1),
    agree, totalSignals: votes.length,
    bullScore: round(bullScore, 2), bearScore: round(bearScore, 2),
    regime, volState,
    votes: votes.map(v => ({ name: v.name, dir: v.dir > 0 ? 'bull' : v.dir < 0 ? 'bear' : 'neutral' })),
    indicators: ind,
    structure: struct,
    summary: _signalSummary(bias, grade.label, agree, votes.length, regime, volState),
  };
}

function _grade(score, bias) {
  if (bias === 'NEUTRAL') return { label: 'NO-TRADE' };
  if (score >= 80) return { label: 'A+' };
  if (score >= 70) return { label: 'A' };
  if (score >= 60) return { label: 'B+' };
  if (score >= 50) return { label: 'B' };
  if (score >= 40) return { label: 'C+' };
  if (score >= 30) return { label: 'C' };
  return { label: 'C-' };
}
function _signalSummary(bias, grade, agree, total, regime, volState) {
  if (bias === 'NEUTRAL') return `No clean edge — indicators are split. Regime: ${regime}, volatility: ${volState}. Best to wait.`;
  return `${grade} ${bias} setup — ${agree}/${total} signals agree. Regime: ${regime}, volatility: ${volState}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RISK & TRADE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Position sizing: risk a % of account per trade.
//   size = (account * riskPct) / |entry - sl|
// Returns { size, riskAmount, notional, valid }.
function positionSize({ account, riskPct = 1, entry, sl, leverage = 1 }) {
  const acc = num(account), e = num(entry), s = num(sl), rp = num(riskPct);
  if (acc == null || e == null || s == null || rp == null) return { valid: false, reason: 'account, entry and sl are required.' };
  const perUnitRisk = Math.abs(e - s);
  if (perUnitRisk <= 0) return { valid: false, reason: 'entry and sl must differ.' };
  const riskAmount = acc * (rp / 100);
  const size = riskAmount / perUnitRisk;
  const notional = size * e;
  const marginUsed = notional / (leverage || 1);
  return {
    valid: true,
    size: round(size, 6),
    riskAmount: round(riskAmount, 2),
    perUnitRisk: round(perUnitRisk),
    notional: round(notional, 2),
    marginUsed: round(marginUsed, 2),
    leverage: leverage || 1,
  };
}

// R:R and expected value for a given entry/SL/TP.
function riskReward({ side = 'buy', entry, sl, tp }) {
  const e = num(entry), s = num(sl), t = num(tp);
  if (e == null || s == null || t == null) return null;
  const risk = Math.abs(e - s);
  const reward = Math.abs(t - e);
  if (risk <= 0) return null;
  const rr = reward / risk;
  // sanity: SL/TP on correct side
  const dirOK = side === 'buy' ? (s < e && t > e) : (s > e && t < e);
  return { rr: round(rr, 2), risk: round(risk), reward: round(reward), dirOK, quality: rr >= 2 ? 'good' : rr >= 1 ? 'ok' : 'poor' };
}

// Suggest ATR- and structure-based SL/TP for a side.
//   method 'atr'      → sl = entry ∓ atrMult*ATR, tp = entry ± atrMult*ATR*rr
//   method 'structure'→ sl beyond nearest swing, tp at next S/R with min rr
function suggestSlTp(candles, { side = 'buy', entry = null, atrMult = 1.5, rr = 2, method = 'atr' } = {}) {
  const { high, low, close } = cols(candles);
  const price = entry != null ? num(entry) : last(close);
  const atr = ATR(high, low, close, 14);
  if (price == null || atr == null) return null;
  const struct = marketStructure(candles);
  let sl, tp;
  if (method === 'structure' && struct) {
    if (side === 'buy') {
      sl = Math.min(struct.support, price - 0.5 * atr);
      tp = price + rr * (price - sl);
    } else {
      sl = Math.max(struct.resistance, price + 0.5 * atr);
      tp = price - rr * (sl - price);
    }
  } else {
    const dist = atrMult * atr;
    if (side === 'buy') { sl = price - dist; tp = price + rr * dist; }
    else { sl = price + dist; tp = price - rr * dist; }
  }
  return { entry: round(price), sl: round(sl), tp: round(tp), atr, method, rr, riskReward: riskReward({ side, entry: price, sl, tp }) };
}

// Drawdown monitor: given the recent CLOSED trades (newest last), flag streaks.
function drawdownMonitor(closedTrades = [], { lossStreakCut = 3, sizeCutPct = 50 } = {}) {
  const closed = closedTrades.filter(t => Number.isFinite(t.pnl));
  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (closed[i].pnl < 0) streak++; else break;
  }
  const totalPnl = sum(closed.map(t => t.pnl));
  // equity curve peak-to-trough drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of closed) { equity += t.pnl; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity); }
  const action = streak >= lossStreakCut ? `Reduce position size by ${sizeCutPct}% — ${streak} losses in a row.` : 'Normal sizing OK.';
  return { lossStreak: streak, maxDrawdown: round(maxDD, 2), totalPnl: round(totalPnl, 2), reduceSize: streak >= lossStreakCut, sizeMultiplier: streak >= lossStreakCut ? (1 - sizeCutPct / 100) : 1, action };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SENTIMENT & CONTEXT — trading session / time filter (UTC based)
// ─────────────────────────────────────────────────────────────────────────────
function sessionContext(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const h = d.getUTCHours(), day = d.getUTCDay(); // 0=Sun..6=Sat
  let session = 'Off-hours';
  if (h >= 0 && h < 8) session = 'Asia';
  else if (h >= 7 && h < 13) session = 'London';
  else if (h >= 12 && h < 21) session = 'New York';
  const overlap = (h >= 12 && h < 16) ? 'London/NY overlap (highest liquidity)' : null;
  const weekend = day === 0 || day === 6;
  const fridayLate = day === 5 && h >= 19; // Fri late NY
  const warnings = [];
  if (weekend) warnings.push('Weekend — crypto only; forex/indices closed.');
  if (fridayLate) warnings.push('Late Friday — thin liquidity, avoid new swing entries.');
  return { session, overlap, weekendUTC: weekend, warnings, utcHour: h };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PERFORMANCE & FEEDBACK — winrate by setup, PnL by day, expectancy, equity
// ─────────────────────────────────────────────────────────────────────────────
function performance(closedTrades = []) {
  const closed = closedTrades.filter(t => t.status === 'CLOSED' && Number.isFinite(t.pnl));
  if (!closed.length) return { trades: 0, note: 'No closed trades yet.' };
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const winrate = wins.length / closed.length;
  const avgWin = wins.length ? mean(wins.map(t => t.pnl)) : 0;
  const avgLoss = losses.length ? mean(losses.map(t => t.pnl)) : 0; // negative
  // Expectancy = (winrate * avgWin) - (lossrate * |avgLoss|)
  const expectancy = winrate * avgWin - (1 - winrate) * Math.abs(avgLoss);
  const totalPnl = sum(closed.map(t => t.pnl));

  // Winrate by "setup" — use closeReason as a proxy setup key, and by symbol.
  const byKey = (keyFn) => {
    const m = {};
    for (const t of closed) {
      const k = keyFn(t) || 'unknown';
      (m[k] = m[k] || { n: 0, wins: 0, pnl: 0 });
      m[k].n++; if (t.pnl > 0) m[k].wins++; m[k].pnl += t.pnl;
    }
    return Object.entries(m).map(([k, v]) => ({ key: k, trades: v.n, winrate: round(100 * v.wins / v.n, 1), pnl: round(v.pnl, 2) }))
      .sort((a, b) => b.pnl - a.pnl);
  };
  const bySymbol = byKey(t => t.symbol);
  const byReason = byKey(t => t.closeReason);
  const byDay = byKey(t => new Date(t.closedAt || t.closedExTime || t.openedAt).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }));

  // Equity curve points (cumulative pnl).
  let eq = 0; const equityCurve = closed
    .slice()
    .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))
    .map(t => { eq += t.pnl; return round(eq, 2); });
  const peak = Math.max(0, ...equityCurve);
  const curEquity = last(equityCurve) || 0;
  const inDrawdown = curEquity < peak;

  const rVals = closed.filter(t => Number.isFinite(t.r)).map(t => t.r);
  const avgR = rVals.length ? mean(rVals) : null;
  const profitFactor = Math.abs(avgLoss * losses.length) > 0
    ? round(sum(wins.map(t => t.pnl)) / Math.abs(sum(losses.map(t => t.pnl))), 2) : null;

  return {
    trades: closed.length,
    wins: wins.length, losses: losses.length,
    winrate: round(100 * winrate, 1),
    avgWin: round(avgWin, 2), avgLoss: round(avgLoss, 2),
    expectancy: round(expectancy, 2),
    profitFactor,
    totalPnl: round(totalPnl, 2),
    avgR: avgR != null ? round(avgR, 2) : null,
    bySymbol, byReason, byDay,
    equityCurve, peakEquity: round(peak, 2), inDrawdown,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. EXECUTION & HEALTH — latency, error rate, exchange reachability, balance
// ─────────────────────────────────────────────────────────────────────────────
async function health(tradingEngine, { chatId = null, exchange = 'binance', symbol = 'BTC/USDT', creds = null } = {}) {
  const out = { checks: [], ok: true };
  const push = (name, ok, detail) => { out.checks.push({ name, ok, detail }); if (!ok) out.ok = false; };

  // ccxt available?
  push('engine', !!(tradingEngine && tradingEngine.enabled && tradingEngine.enabled()), tradingEngine && tradingEngine.enabled && tradingEngine.enabled() ? 'ccxt loaded' : 'ccxt missing');

  // price latency (round-trip to fetch a live price / range)
  if (tradingEngine && tradingEngine.fetchRange) {
    const t0 = Date.now();
    try {
      const r = await tradingEngine.fetchRange(exchange, symbol, { mode: 'PAPER', creds });
      const ms = Date.now() - t0;
      push('price_feed', Number.isFinite(r.last), `${symbol} @ ${r.last} via ${r.source} in ${ms}ms`);
      push('latency', ms < 3000, `${ms}ms (${ms < 800 ? 'excellent' : ms < 3000 ? 'ok' : 'SLOW — slippage risk'})`);
      out.latencyMs = ms;
    } catch (e) {
      push('price_feed', false, 'price feed unreachable: ' + (e.message || e));
    }
  }

  // balance (REAL only)
  if (creds && creds.apiKey && tradingEngine && tradingEngine.getExchange) {
    try {
      const inst = tradingEngine.getExchange(exchange, { mode: 'REAL', creds });
      const bal = await inst.fetchBalance();
      const free = (bal && bal.USDT && (bal.USDT.free != null ? bal.USDT.free : (bal.free && bal.free.USDT))) || 0;
      push('balance', Number(free) > 0, `free USDT: ${Number(free).toFixed(2)}`);
      out.freeUsdt = Number(free);
    } catch (e) {
      push('balance', false, 'balance/auth failed: ' + (e.message || e));
    }
  }
  return out;
}

module.exports = {
  // helpers
  candlesFromArrays, cols,
  // indicators
  SMA, EMA, emaLast, RSI, MACD, ATR, ADX, Bollinger, Keltner, Stochastic, CCI, ROC, Supertrend, OBV,
  // structure + snapshot + signal
  swings, marketStructure, indicators, signal,
  // risk
  positionSize, riskReward, suggestSlTp, drawdownMonitor,
  // context + performance + health
  sessionContext, performance, health,
  // numeric utils (for tests)
  _util: { mean, stdev, round },
};
