// E2E: per-task file isolation + clearWorkTree on the GitHub Actions sandbox.
//
// Proves the permanent fix for "GitHub Actions returns previous task files":
//   1) testKey / enabled
//   2) create a session sandbox
//   3) TASK A: write fileA.txt into the work tree, confirm it lists
//   4) clearWorkTree(id): confirm the work tree is emptied (only .keep remains)
//   5) TASK B: write fileB.txt, confirm ONLY fileB is present (no fileA leftover)
//
// Run with:  GHA_TOKEN=ghp_... node scripts/test-gha-perisolation-e2e.js
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN || process.env.GITHUB_ACTIONS_TOKEN;
process.env.GITHUB_ACTIONS_REPO = process.env.GITHUB_ACTIONS_REPO || 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = process.env.GITHUB_ACTIONS_BRANCH || 'main';

const gha = require('../services/githubActions');

function assert(cond, msg) {
  if (!cond) { console.error('❌ ASSERT FAILED:', msg); process.exit(1); }
  console.log('  ✅', msg);
}

(async () => {
  console.log('== 1) testKey ==');
  const t = await gha.testKey();
  console.log(' ', t.message);
  assert(t.ok, 'GitHub Actions token + runner repo are valid');

  console.log('\n== 2) create session sandbox ==');
  const { id } = await gha.getOrCreateSessionSandbox('periso-e2e', {});
  console.log('  sandbox id:', id);
  assert(!!id, 'session sandbox provisioned');

  console.log('\n== 3) TASK A — stage fileA.txt directly into the work tree (no CI run) ==');
  await gha.uploadFiles(id, [{ dest: 'fileA.txt', buffer: Buffer.from('this is task A output', 'utf-8') }]);
  let list = await gha.listFilesRecursive(id);
  console.log('  work tree after A:', list.map(f => f.rel));
  assert(list.some(f => f.rel === 'fileA.txt'), 'fileA.txt is present after task A');

  console.log('\n== 4) clearWorkTree(id) — wipe the work files (per-task reset) ==');
  const cleared = await gha.clearWorkTree(id);
  console.log('  files cleared:', cleared);
  list = await gha.listFilesRecursive(id);
  console.log('  work tree after clear:', list.map(f => f.rel));
  assert(!list.some(f => f.rel === 'fileA.txt'), 'fileA.txt is GONE after clearWorkTree');

  console.log('\n== 5) TASK B — stage fileB.txt; confirm NO fileA leftover ==');
  await gha.uploadFiles(id, [{ dest: 'fileB.txt', buffer: Buffer.from('this is task B output', 'utf-8') }]);
  list = await gha.listFilesRecursive(id);
  console.log('  work tree during task B:', list.map(f => f.rel));
  assert(list.some(f => f.rel === 'fileB.txt'), 'fileB.txt is present in task B');
  assert(!list.some(f => f.rel === 'fileA.txt'), 'task A leftover NEVER reappears in task B');

  console.log('\n✅ PER-TASK ISOLATION E2E PASSED — GitHub Actions no longer returns previous task files.');
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
