// Verify the HOST-LOOP fsx path works with the GitHub Actions backend AND that
// a pinned GHA backend never drifts to another sandbox.
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN;
process.env.GITHUB_ACTIONS_REPO = 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = 'main';
process.env.SANDBOX_BACKEND = 'githubactions'; // admin PINS GitHub Actions

const sandboxAgent = require('../services/sandboxAgent');

(async () => {
  console.log('== A) enabled() must be FALSE for per-command GHA (forces host loop) ==');
  const en = await sandboxAgent.enabled();
  console.log('sandboxAgent.enabled() =>', en, en === false ? 'PASS ✅' : 'FAIL ❌ (would wrongly try in-sandbox worker)');

  console.log('\n== B) resolveActiveBackend must be githubactions (pinned honoured) ==');
  const active = await sandboxAgent.resolveActiveBackend();
  console.log('active backend =>', active && active.name, (active && active.name === 'githubactions') ? 'PASS ✅' : 'FAIL ❌');

  console.log('\n== C) pinned chain must contain ONLY githubactions (no fallback drift) ==');
  // resolveBackendChain isn't exported; probe via the module internals through enabled path.
  // Instead, assert the host-loop cascade in agentEngine returns only GHA.
  const agentEngine = require('../services/agentEngine');
  const c = await agentEngine.resolveBackendCascade(null);
  console.log('cascade =>', c.map(x => x.name), (c.length === 1 && c[0].name === 'githubactions') ? 'PASS ✅' : 'FAIL ❌');

  console.log('\n✅ Host-loop routing checks done.');
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
