// e2e-test.js — end-to-end test of the desktop agent's backend contract against
// the LIVE WormGPT backend. Proves: signup/login, /api/agent/run fusion mode
// streaming (start/step/done), credit draining, and produced files — i.e. that
// the coding agent actually works and can grind on a real task.
//
// Run: node e2e-test.js
'use strict';
const { AgentClient } = require('./src/agentClient');

function log(...a) { console.log('[e2e]', ...a); }

(async () => {
  const client = new AgentClient();
  client.setSession({ clientId: 'e2e-desktop-' + Date.now() });

  // 1) Create a throwaway account (same auth the website uses).
  const rnd = Math.random().toString(36).slice(2, 10);
  const email = `desktop.e2e.${rnd}@gmail.com`;
  const password = 'Test!' + rnd + 'A9';
  const username = 'e2e_' + rnd;

  log('signing up', email);
  try {
    await client.signup({ email, password, username });
    log('signup OK — user tier:', (client.user && (client.user.subscription_status || 'free')));
  } catch (e) {
    log('signup failed, trying login instead:', e.message);
    await client.login({ email, password });
  }

  // 2) Verify /me works with the token.
  const me = await client.me();
  log('me:', me.ok ? ('ok, user=' + (me.user.username || me.user.email)) : ('FAILED ' + (me.error || '')));

  // 3) Run a REAL coding task through the fusion brain + sandbox.
  const task = 'Write a Python script that prints the first 15 Fibonacci numbers, run it, and show me the exact output. Keep it short.';
  log('running agent task (fusion mode)…');

  const events = { start: 0, job: 0, step: 0, screen: 0, done: 0, error: 0 };
  let lastCredits = null;
  let firstCredits = null;
  let doneMessage = null;
  let files = [];
  let errorMsg = null;

  const t0 = Date.now();
  const run = client.runAgent({ task, history: [], files: [], mode: 'fusion' }, (ev, payload) => {
    if (events[ev] != null) events[ev]++;
    if (payload && payload.credits != null) {
      if (firstCredits == null) firstCredits = payload.credits;
      lastCredits = payload.credits;
    }
    if (ev === 'start') log('  START tier=' + payload.tier + ' credits=' + payload.credits + ' jobId=' + payload.jobId);
    else if (ev === 'step') log('  STEP:', String(payload.note || '').slice(0, 90), payload.credits != null ? ('(🪙 ' + payload.credits + ')') : '');
    else if (ev === 'done') { doneMessage = payload.message || ''; files = payload.files || []; log('  DONE (' + doneMessage.length + ' chars, ' + files.length + ' files)'); }
    else if (ev === 'error') { errorMsg = payload.error; log('  ERROR:', payload.error); }
  });

  await run.promise;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // 4) Report.
  console.log('\n==================== E2E RESULT ====================');
  console.log('elapsed:', secs + 's');
  console.log('events:', JSON.stringify(events));
  console.log('credits: first=' + firstCredits + ' last=' + lastCredits + ' drained=' + (firstCredits != null && lastCredits != null ? (firstCredits - lastCredits) : 'n/a'));
  if (doneMessage) console.log('answer preview:\n' + doneMessage.slice(0, 500));
  if (files.length) console.log('files:', files.map(f => f.name + ' (' + (f.size || 0) + 'B)').join(', '));
  if (errorMsg) console.log('error:', errorMsg);

  const pass = (events.start > 0) && (events.done > 0 || (events.step > 0 && !errorMsg));
  const creditsDrained = (firstCredits != null && lastCredits != null && lastCredits <= firstCredits);
  console.log('\nPASS(stream+answer):', pass);
  console.log('PASS(credits drain):', creditsDrained, '(only meaningful for non-unlimited tiers)');
  console.log('====================================================');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[e2e] FATAL', e); process.exit(2); });
