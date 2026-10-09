// E2E: agentEngine.clearSessionFiles() — the /clearfiles backend on GitHub Actions.
// Run with:  GHA_TOKEN=ghp_... node scripts/test-clearsessionfiles-e2e.js
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN || process.env.GITHUB_ACTIONS_TOKEN;
process.env.GITHUB_ACTIONS_REPO = process.env.GITHUB_ACTIONS_REPO || 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = process.env.GITHUB_ACTIONS_BRANCH || 'main';
process.env.SANDBOX_BACKEND = 'githubactions';

const gha = require('../services/githubActions');
const agent = require('../services/agentEngine');

function assert(cond, msg) {
  if (!cond) { console.error('❌ ASSERT FAILED:', msg); process.exit(1); }
  console.log('  ✅', msg);
}

(async () => {
  const sessionKey = 'clearfiles-e2e';
  console.log('== 1) provision session sandbox + stage 2 files ==');
  const { id } = await gha.getOrCreateSessionSandbox(sessionKey, {});
  await gha.uploadFiles(id, [
    { dest: 'keepme.txt', buffer: Buffer.from('x', 'utf-8') },
    { dest: 'sub/dir/deep.txt', buffer: Buffer.from('y', 'utf-8') },
  ]);
  let list = await gha.listFilesRecursive(id);
  console.log('  before:', list.map(f => f.rel));
  assert(list.length >= 2, 'files staged in the session sandbox');

  console.log('\n== 2) agent.clearSessionFiles(sessionKey) ==');
  const res = await agent.clearSessionFiles(sessionKey);
  console.log('  result:', res);
  assert(res.ok, 'clearSessionFiles reported ok');
  assert(res.backend === 'githubactions', 'cleared on the githubactions backend');

  console.log('\n== 3) verify the work tree is empty ==');
  list = await gha.listFilesRecursive(id);
  console.log('  after:', list.map(f => f.rel));
  assert(list.length === 0, 'ALL work files cleared (memory/sandbox untouched)');

  console.log('\n✅ clearSessionFiles E2E PASSED — /clearfiles wipes files only, keeps the sandbox.');
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
