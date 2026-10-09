'use strict';

process.env.MARKET_WATCH_TICK_MS = '20';
process.env.MARKET_WATCH_FEEDBACK_MS = '15000';
const watch = require('../services/marketWatch');

let price = 100;
watch.setPriceFetcher(async () => ({ price, source: 'mock-live' }));

(async () => {
  const parsed = watch.parseWatch('Watch BTC and update me every 30 seconds if it moves 1%');
  if (!parsed || parsed.symbol !== 'BTC' || parsed.feedbackMs !== 30000 || parsed.feedbackMovePct !== 1) {
    throw new Error('custom watch cadence/threshold parsing failed: ' + JSON.stringify(parsed));
  }

  const events = [];
  const chat = 'market-e2e-' + Date.now();
  await watch.add(chat, 'BTC', [{ type: 'above', price: 105, label: 'above' }], {
    feedback: true,
    feedbackMovePct: 0.5,
    feedbackMs: 15000,
  });
  watch.start(async e => { if (e.chatId === chat) events.push(e.event); return true; });

  price = 101;
  await new Promise(r => setTimeout(r, 100));
  if (!events.some(e => e.type === 'change' && e.price === 101)) {
    throw new Error('movement feedback alert did not fire');
  }

  price = 106;
  await new Promise(r => setTimeout(r, 100));
  if (!events.some(e => e.type === 'above' && e.target === 105)) {
    throw new Error('target crossing alert did not fire');
  }

  await watch.stopAll(chat);
  console.log('MARKET_WATCH_E2E_OK', JSON.stringify({ customCadence: true, movementAlert: true, targetAlert: true }));
})().catch(e => { console.error(e.stack || e); process.exit(1); });
