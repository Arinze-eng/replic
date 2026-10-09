// test-browser-live.js — REAL end-to-end test of smart browser_action against
// a live login page using the actual Browserless API key.
//
// Target: https://the-internet.herokuapp.com/login  (public test login page)
//   valid creds: tomsmith / SuperSecretPassword!
// We do a smart_login with NO selectors and assert we land on /secure.
//
// Run: BROWSERLESS_API_KEY=xxx node scripts/test-browser-live.js
'use strict';

process.env.BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';
if (!process.env.BROWSERLESS_API_KEY) {
  console.error('Set BROWSERLESS_API_KEY env var to run the live test, e.g.:\n  BROWSERLESS_API_KEY=xxxx node scripts/test-browser-live.js');
  process.exit(2);
}

const manus = require('../services/manusTools');

(async () => {
  const ctx = {
    onStep(m) { console.log('   …' + m); },
    deliverBuffer: async (name) => { console.log('   [delivered] ' + name); },
  };

  console.log('\n=== TEST A: inspect a login page (no selectors) ===');
  const a = await manus.toolBrowserAction({
    url: 'https://the-internet.herokuapp.com/login',
    steps: [{ action: 'inspect' }],
  }, ctx);
  console.log(a.slice(0, 1500));

  console.log('\n=== TEST B: smart_login with NO selectors ===');
  const b = await manus.toolBrowserAction({
    url: 'https://the-internet.herokuapp.com/login',
    steps: [
      { action: 'smart_login', username: 'tomsmith', password: 'SuperSecretPassword!' },
      { action: 'wait', ms: 1500 },
    ],
    screenshot: true,
  }, ctx);
  console.log(b.slice(0, 1800));

  const loggedIn = /You logged into a secure area|secure/i.test(b);
  console.log('\n──────────────');
  console.log(loggedIn ? '✅ LIVE LOGIN SUCCEEDED (reached secure area without selectors)' : '❌ Live login did not confirm secure area — inspect output above');
  process.exit(loggedIn ? 0 : 1);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
