'use strict';

const assert = require('assert');

const store = new Map();
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  async getSetting(k) { return store.get(k) || null; },
  async setSetting(k, v) { store.set(k, String(v)); },
} };

const mw = require('../services/marketWatch');
mw.setPriceFetcher(async symbol => ({ price: 65000, source: 'cross-checked-test', symbol }));
const tools = require('../services/manusTools');

(async () => {
  const ctx = { chatId: 'trade-watch-test' };

  const feedback = await tools.toolTradeWatch({ symbol: 'BTC', intent: 'monitor' }, ctx);
  assert(/\[trade_watch\]/.test(feedback));
  assert(/all meaningful price changes/i.test(feedback));
  let watches = await mw.list(ctx.chatId);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].targets.length, 0);
  assert.equal(watches[0].feedback, true);

  await mw.stopAll(ctx.chatId);
  const levels = await tools.toolTradeWatch({ symbol: 'BTC', sl: 64000, tp: 68000, intent: 'monitor' }, ctx);
  assert(/SL 64000/.test(levels));
  assert(/TP 68000/.test(levels));
  watches = await mw.list(ctx.chatId);
  assert.equal(watches.length, 1);
  assert.equal(watches[0].targets.length, 2);

  const noReal = await tools.toolTradeWatch({ symbol: 'BTC', side: 'buy', amount: 0.01, sl: 64000, tp: 68000, intent: 'real' }, ctx);
  assert(!/Opened/.test(noReal), 'trade_watch must never infer a REAL order');

  await mw.stopAll(ctx.chatId);
  console.log('✅ trade_watch: feedback, SL/TP monitoring, and no-implicit-REAL safeguards passed');
})().catch(err => { console.error(err); process.exit(1); });
