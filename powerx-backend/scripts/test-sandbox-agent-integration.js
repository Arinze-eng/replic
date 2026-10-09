// scripts/test-sandbox-agent-integration.js
// TRUE integration test of the file-bridge "agent owns the computer" flow.
// Calls services/sandboxAgent.runAgentInSandbox directly with the REAL brain
// (this host can reach the AI gateway). The worker runs INSIDE a real Daytona
// sandbox in FILE-bridge mode; sandboxAgent services its brain/tool requests
// over the Daytona toolbox channel (no sandbox egress needed).
//
// Env: DAYTONA_API_KEY, DAYTONA_ORG_ID  (brain uses the built-in gateways)
// Run: DAYTONA_API_KEY=... DAYTONA_ORG_ID=... node scripts/test-sandbox-agent-integration.js

const crypto = require('crypto');
const daytona = require('../services/daytona');
const sandboxAgent = require('../services/sandboxAgent');

(async () => {
  if (!daytona.enabled()) { console.error('❌ Daytona not enabled'); process.exit(2); }
  const sessionKey = 'integ:' + crypto.randomBytes(3).toString('hex');
  const task = 'Write a Python script that computes the first 10 Fibonacci numbers, run it inside the sandbox, save the output to fib.txt, then finish and deliver fib.txt.';
  console.log('▶ running in-sandbox agent for', sessionKey);
  console.log('  task:', task, '\n');

  const t0 = Date.now();
  let res;
  try {
    res = await sandboxAgent.runAgentInSandbox({
      task,
      attachments: [],
      history: [],
      sessionKey,
      onStep: (n) => console.log('   ›', n),
    });
  } catch (e) {
    console.error('\n❌ runAgentInSandbox threw:', e.message);
    await daytona.endSession(sessionKey).catch(() => {});
    process.exit(1);
  }

  console.log('\n✔ final message:', (res.message || '').slice(0, 500));
  console.log('  files:', (res.files || []).map(f => f.name).join(', ') || '(none)');
  const fs = require('fs');
  const fib = (res.files || []).find(f => /fib\.txt/i.test(f.name));
  if (fib) {
    const txt = fs.readFileSync(fib.path, 'utf-8');
    console.log('  fib.txt:\n' + txt.split('\n').map(l => '    ' + l).join('\n'));
  }
  console.log('  elapsed:', Math.round((Date.now() - t0) / 1000) + 's');

  const ok = res.message && (res.files || []).length > 0;
  await daytona.endSession(sessionKey).catch(() => {});
  if (ok) { console.log('\n✅ INTEGRATION PASS — agent ran inside the sandbox via the file-bridge + real brain and returned a deliverable.'); }
  else { console.log('\n❌ INTEGRATION FAIL — no deliverable.'); process.exit(1); }
})().catch(e => { console.error('❌ test error:', e.message); process.exit(1); });
