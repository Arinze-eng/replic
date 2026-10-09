// scripts/test-runloop-agent-e2e.js
// FULL "agent owns the computer" end-to-end test on the RUNLOOP backend.
// Deploys agent.py INTO a real Runloop devbox, drops a task into its inbox, and
// services the file-bridge (brain + host tools) from here — exactly like
// production. Proves the agent literally lives inside the Runloop sandbox and
// returns a real deliverable.
//
// Run: SANDBOX_BACKEND=runloop RUNLOOP_API_KEY=ak_... node scripts/test-runloop-agent-e2e.js

const crypto = require('crypto');
process.env.SANDBOX_BACKEND = 'runloop';
process.env.AGENT_BRIDGE_MODE = 'file'; // file-bridge: no sandbox egress needed

const runloop = require('../services/runloop');
const sandboxAgent = require('../services/sandboxAgent');

(async () => {
  console.log('▶ Runloop "agent owns the computer" E2E\n');
  if (!runloop.enabled()) { console.error('❌ Runloop not enabled (set RUNLOOP_API_KEY)'); process.exit(2); }

  const active = await sandboxAgent.resolveActiveBackend();
  console.log('  active backend:', active ? `${active.label} (${active.home})` : '(none)');
  if (!active || active.name !== 'runloop') {
    console.error('❌ expected Runloop to be the active backend'); process.exit(2);
  }

  const sessionKey = 'rl-integ:' + crypto.randomBytes(3).toString('hex');
  const task = 'Write a Python script that computes the first 10 Fibonacci numbers, run it inside the sandbox, save the comma-separated output to fib.txt, then finish and deliver fib.txt.';
  console.log('  session:', sessionKey);
  console.log('  task:', task, '\n');

  const t0 = Date.now();
  let res;
  try {
    res = await sandboxAgent.runAgentInSandbox({
      task, attachments: [], history: [], sessionKey,
      onStep: (n) => console.log('   ›', n),
    });
  } catch (e) {
    console.error('\n❌ runAgentInSandbox threw:', e.message);
    await runloop.endSession(sessionKey).catch(() => {});
    process.exit(1);
  }

  console.log('\n✔ final message:', (res.message || '').slice(0, 600));
  console.log('  files:', (res.files || []).map(f => f.name).join(', ') || '(none)');
  console.log('  steps:', res.steps);
  const fs = require('fs');
  const fib = (res.files || []).find(f => /fib\.txt/i.test(f.name));
  let fibOk = false;
  if (fib) {
    const txt = fs.readFileSync(fib.path, 'utf-8');
    console.log('  fib.txt contents:', txt.trim());
    fibOk = /0[,\s]+1[,\s]+1[,\s]+2[,\s]+3[,\s]+5[,\s]+8[,\s]+13[,\s]+21[,\s]+34/.test(txt);
  }
  console.log('  elapsed:', Math.round((Date.now() - t0) / 1000) + 's');

  console.log('\n[cleanup] ending session (shutting down devbox)…');
  await runloop.endSession(sessionKey).catch(() => {});

  const ok = res.message && (res.files || []).length > 0 && fibOk;
  if (ok) { console.log('\n✅ AGENT-IN-RUNLOOP PASS — the agent ran INSIDE the Runloop sandbox via the file-bridge + real brain, produced a correct deliverable.'); process.exit(0); }
  else { console.log('\n❌ AGENT-IN-RUNLOOP FAIL — no correct deliverable (fibOk=' + fibOk + ').'); process.exit(1); }
})().catch(e => { console.error('❌ test crashed:', e && e.stack || e); process.exit(1); });
