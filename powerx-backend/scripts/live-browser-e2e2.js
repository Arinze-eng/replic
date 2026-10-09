// live-browser-e2e2.js — deterministic REAL Browserless E2E using a data: URL
// page we control (form + hamburger + radio quiz). Proves fill / open_menu /
// read+answer_question actually work in real headless Chrome.
'use strict';
const manus = require('../services/manusTools');
const ctx = { onStep: (m) => process.stdout.write('   · ' + m + '\n'), deliverBuffer: async () => {} };

const dataUrl = 'https://prd-tc-intl-cdn.codebanana.com/cb-user-uploads/5b4f59b4-bc4f-4844-9b7d-1ab6bdcf3025/work/e2e_lab.html';

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };

  console.log('\n[E2E] full register + menu + exam flow on a controlled real page');
  const r = await manus.toolBrowserAction({
    url: dataUrl,
    steps: [
      { action: 'inspect' },
      { action: 'fill', field: 'full name', value: 'Ada Lovelace' },
      { action: 'fill', field: 'email', value: 'ada@example.com' },
      { action: 'fill', field: 'password', value: 'S3cret!23' },
      { action: 'check', field: 'terms' },
      { action: 'open_menu' },
      { action: 'read' },
      { action: 'answer_question', question: 'capital of France', option: 'paris' },
      { action: 'click', text: 'Create account' },
      { action: 'wait_for_text', text: 'Account created' },
    ],
  }, ctx);
  console.log(String(r).slice(0, 1400));

  ok('inspect found the signup inputs', /Inputs:/.test(r) && /fullname|Full name|name/i.test(r));
  ok('inspect detected the hamburger menu', /Menus\/Hamburgers:/.test(r));
  ok('filled full name', /ok: fill/.test(r));
  ok('checked the terms box', /ok: check/.test(r));
  ok('opened the hamburger menu', /ok: open_menu/.test(r));
  ok('read detected the exam question', /capital of France/i.test(r) && /question group/i.test(r));
  ok('answered the question', /ok: answer_question/.test(r));
  ok('clicked create account', /ok: click/.test(r));
  ok('saw the success text (full flow worked)', /Account created successfully/.test(r));

  console.log(`\n──────────────\nLIVE E2E Result: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('LIVE E2E CRASH:', e); process.exit(1); });
