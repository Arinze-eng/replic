# TRADING.md — PAPER + REAL Trading Superpower

This document describes the **trading feature added to the WormGPT Agent** — it is
**additive and isolated**: no existing agent, brain, bot, web or admin logic was
changed in behaviour. It plugs into the SAME patterns the codebase already uses
(the `marketWatch.js` real-time engine, the `manusTools` agent tools, and the
Telegram/WhatsApp notifier registration).

## What it does

Gives the agent (Telegram bot, WhatsApp bot, and the web API/dashboard) the
ability to **PAPER trade** (test strategies) and **REAL trade** on:

- **Binance USDT-M Futures** (`binanceusdm`)
- **Bybit USDT Perpetual** (`bybit`)

…with a **24/7 watcher** that monitors every open trade against the live price
and fires an **instant Telegram/WhatsApp alert the moment SL or TP is hit**, with
realised **PnL and R multiple**.

## Files

| File | Role |
|------|------|
| `services/tradingEngine.js` | Core engine: `getExchange`, live price (ccxt.pro WebSocket → REST → public-price fallback), **wick-accurate `fetchRange` (high/low since last poll)**, **`fetchCandles` for analysis**, open/close, PnL/R math, 24/7 watcher, Supabase persistence, per-chat REAL API-key store. Sibling of `marketWatch.js`. |
| `services/tradingAnalysis.js` | **The ANALYSIS BRAIN.** Pure, deterministic, dependency-free indicator + structure + risk + performance library (all 6 pillars). Unit-tested against hand-computed reference values. |
| `services/manusTools.js` | Adds agent tools: `open_trade`, `close_trade`, `list_trades`, `trade_stats`, `connect_exchange`, `disconnect_exchange`, **`analyze_market`, `trade_signal`, `position_size`, `risk_check`, `performance_report`, `health_check`**. |
| `services/agentEngine.js` | Wires those tools into `dispatchTool` / `dispatchHostTool` and the valid-actions list. |
| `services/wormgptBot.js` | Registers a Telegram notifier so trade alerts reach the chat (same block as market-watch). |
| `services/whatsappBot.js` | Registers a WhatsApp notifier for trade alerts. |
| `prompts/agent_system_prompt.md` | Teaches the model the new tools + when to use PAPER vs REAL + analysis-first workflow. |
| `server.js` | REST API `GET/POST /api/trading/*` (scoped to the signed-in user). |
| `public/trading.html` | Web dashboard (open/close/monitor trades, connect keys, stats). |

## The ANALYSIS BRAIN (services/tradingAnalysis.js)

All six pillars, computed deterministically from OHLCV candles:

1. **Market data / structure** — swing highs/lows, HH/HL vs LH/LL trend, support/resistance, breakout detection, volume spikes + OBV.
2. **Technical indicators** — EMA 20/50/200, MACD, ADX (+DI/-DI), Supertrend, RSI, Stochastic, CCI, ROC, ATR, Bollinger, Keltner.
3. **Risk & management** — `positionSize` (risk % → size), `riskReward`, `suggestSlTp` (ATR- or structure-based), `drawdownMonitor` (loss-streak → auto size cut), **entry-quality grade A+…C-** with a confluence score.
4. **Sentiment & context** — market **regime** (trending/ranging via ADX) + volatility state (Bollinger bandwidth), trading-session/time filter (Asia/London/NY overlap, weekend & late-Friday warnings).
5. **Performance & feedback** — winrate, avg win/loss, **expectancy**, profit factor, avg R, **equity curve** (+ drawdown), winrate & PnL broken down by symbol / outcome / day-of-week.
6. **Execution & health** — engine status, price-feed reachability + **latency** (slippage-risk flag), exchange auth + balance check.

`signal(candles)` combines pillars 1–4 into a single `{ bias, grade, conviction, regime, votes, indicators, structure }` object — the one call the agent uses to decide.

## Accuracy design (upgraded)

- **WICK-ACCURATE SL/TP detection.** The watcher now evaluates the price
  **RANGE (high/low)** that occurred since the previous poll — not just the
  `last` snapshot — via `fetchRange` (ticker + most-recent 1-minute candle
  high/low). A spike that pierces SL/TP between two 1-second polls and recovers
  is **still caught**, exactly like a real exchange fills on the wick.
- **Conservative same-candle resolution.** If one candle touches BOTH SL and TP,
  the **SL is assumed to fill first** (worst case for the trader) unless
  `TRADING_TP_FIRST=1` — no optimistic "TP filled first" assumption that could
  hide a blowup.
- **Level-exact fills.** An SL/TP hit fills AT the level (no simulated slippage
  distorting the recorded exit); slippage is applied only to market/manual
  closes, so PnL on a level hit matches the level precisely.
- **Exchange time** (ticker timestamp) is used for "time in trade" and hit
  timestamps — not local time — and is stamped BEFORE the alert is formatted.
- **1s watch loop**, prices grouped by symbol (one API hit per symbol per tick).
- **Idempotent close**: a trade is flagged closing BEFORE the alert fires, so a
  slow notifier can never double-alert.
- **Crash-safe**: every store/read is guarded; a bad row can't kill the ticker;
  trades survive a redeploy (persisted in Supabase `app_settings`, zero new
  tables/migration).
- **Geo-block resilience**: on hosts where `fapi.binance.com` / `api.bybit.com`
  are geo-blocked (Render Frankfurt returns 451/403), price reads **fall back to
  the app's proven keyless chain** (coingecko → coinbase → binance.us) and
  candles fall back to Yahoo, so PAPER monitoring + analysis never go dark. In
  the price-only fallback the range collapses to `last` (never fakes a wick
  hit). REAL order placement still requires a reachable authenticated endpoint.

## Agent tool examples

```
open_trade   {exchange:"binance", symbol:"BTC/USDT", side:"buy", amount:0.01, sl:64000, tp:70000, mode:"PAPER"}
list_trades  {status:"OPEN"}
close_trade  {id:"t_..."}
trade_stats  {}
connect_exchange {exchange:"binance", apiKey:"...", secret:"..."}   # REAL mode
```

The bot also understands natural language ("open a paper long on BTC with SL
64000 TP 70000", "close my trades", "my winrate", "connect binance") because the
model is taught these tools in the system prompt.

## REST API (all require a Bearer token)

```
GET  /api/trading/status                 → engine + connected exchanges + stats
GET  /api/trading/price?exchange&symbol   → live price
GET  /api/trading/trades?status=OPEN|CLOSED
POST /api/trading/trades                  → open   {exchange,symbol,side,amount,entry?,sl?,tp?,mode,leverage?}
POST /api/trading/trades/:id/close        → manual close
GET  /api/trading/stats                   → winrate, total PnL, avg R
GET  /api/trading/events                  → recent open/close/hit log
POST /api/trading/connect                 → save REAL keys {exchange,apiKey,secret}
POST /api/trading/disconnect              → remove REAL keys {exchange?}
```

## Tests

```
npm run test:trading         # 35 assertions: PnL/R math, long+short SL/TP hits, slippage, watcher, idempotency, stats, creds
npm run test:trading-tools   # 7 assertions: the agent tools via a chat ctx
npm run test:trading-live    # live: real prices via ccxt+fallback, open→watch→close a PAPER trade
```

All three pass. The live server was verified end-to-end against the real
Supabase + live market prices: a PAPER trade auto-closed on a TP hit within
seconds with correct PnL/R, persisted and logged.

## Safety

- REAL API keys are entered at RUNTIME (never in env/source) and scoped per chat.
- The agent is instructed to always warn users to use FUTURES-trade-only keys
  with NO withdrawal permission, and to never place a REAL trade without explicit
  confirmation of side/size/SL/TP.
- If ccxt is somehow unavailable, every entry point degrades gracefully with a
  clear message — it can never crash the app.

## Dependency

- `ccxt` `^4.5.66` (Node) — ships `ccxt.pro` with the same WebSocket
  `watchTicker` API the Python spec described; used as the fully-compatible
  Node equivalent.
