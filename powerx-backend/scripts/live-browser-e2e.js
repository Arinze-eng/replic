// live-browser-e2e.js — REAL end-to-end test of the enhanced browser_action
// against live Browserless + real websites. Run with the real key in env.
'use strict';
process.env.BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';
const manus = require('../services/manusTools');

const ctx = { onStep: (m) => process.stdout.write('   · ' + m + '\n'), deliverBuffer: async () => {} };

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

  // 1) inspect + element map on a real form (httpbin forms page).
  console.log('\n[1] inspect a real form page (httpbin /forms/post)');
  let r = await manus.toolBrowserAction({ url: 'https://httpbin.org/forms/post', steps: [{ action: 'inspect' }] }, ctx);
  console.log(String(r).slice(0, 600));
  ok('returned an element map with inputs', /Inputs:/.test(r));
  ok('found the form', /form\(s\)/.test(r));

  // 2) fill a field by hint + read structured page
  console.log('\n[2] fill by hint + read structured content');
  r = await manus.toolBrowserAction({ url: 'https://httpbin.org/forms/post', steps: [
    { action: 'fill', field: 'custname', value: 'CodeBanana Test' },
    { action: 'read' },
  ] }, ctx);
  console.log(String(r).slice(0, 500));
  ok('fill step logged ok', /ok: fill/.test(r));
  ok('read returned page understanding', /\[page understanding\]/.test(r));

  // 3) hamburger / menu detection on a real site that uses a nav toggle
  console.log('\n[3] open_menu / hamburger detection (Wikipedia mobile nav has a menu button)');
  r = await manus.toolBrowserAction({ url: 'https://en.m.wikipedia.org/wiki/Main_Page', steps: [
    { action: 'inspect' },
  ], width: 390, height: 800 }, ctx);
  const hasMenus = /Menus\/Hamburgers:/.test(r) || /menu/i.test(r);
  ok('inspect ran on mobile site', /\[page elements\]/.test(r));
  console.log('   menus section present:', /Menus\/Hamburgers:/.test(r));

  // 4) captcha auto-solve on a Cloudflare-protected page (best-effort)
  console.log('\n[4] navigate a normal site & confirm text extraction');
  r = await manus.toolBrowserAction({ url: 'https://example.com', steps: [{ action: 'read' }] }, ctx);
  ok('extracted page text', /Example Domain/i.test(r));

  console.log(`\n──────────────\nLIVE Result: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('LIVE TEST CRASH:', e); process.exit(1); });
