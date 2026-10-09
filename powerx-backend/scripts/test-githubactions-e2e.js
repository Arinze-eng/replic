// E2E test for the GitHub Actions sandbox backend.
// Proves the agent gets a REAL Linux runner: testKey → createSandbox → exec a
// real task (build a file + run python) → read back the produced file & artifacts.
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN;
process.env.GITHUB_ACTIONS_REPO = 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = 'main';

const gha = require('../services/githubActions');

(async () => {
  console.log('== 1) testKey ==');
  const t = await gha.testKey();
  console.log(t);
  if (!t.ok) { console.error('testKey failed — aborting'); process.exit(1); }

  console.log('\n== 2) enabledAsync ==');
  console.log('enabled:', await gha.enabledAsync());

  console.log('\n== 3) createSandbox ==');
  const id = await gha.createSandbox({ labels: { session: 'e2e-test' } });
  console.log('sandbox id:', id);

  console.log('\n== 4) exec a REAL task (write a report + run python + produce a deliverable) ==');
  const task = `
set -e
echo "runner: $(uname -a)"
echo "whoami: $(whoami)"
python3 --version
node --version
echo "== building a deliverable =="
python3 - <<'PY'
data = [x*x for x in range(1, 11)]
with open("squares.txt", "w") as f:
    f.write("squares of 1..10:\\n")
    for i, v in enumerate(data, 1):
        f.write(f"{i}^2 = {v}\\n")
print("wrote squares.txt with", len(data), "lines")
PY
echo "== report.md =="
printf '# Agent Report\\n\\nGenerated on GitHub Actions runner.\\nSum of squares 1..10 = %s\\n' "$(python3 -c 'print(sum(x*x for x in range(1,11)))')" > report.md
ls -la
echo "TASK_DONE_OK"
`;
  const r = await gha.exec(id, task, { timeout: 600 });
  console.log('exitCode:', r.exitCode);
  console.log('--- output (last 2500 chars) ---');
  console.log((r.output || '').slice(-2500));

  console.log('\n== 5) downloadFile squares.txt ==');
  try {
    const buf = await gha.downloadFile(id, 'squares.txt');
    console.log('squares.txt (' + buf.length + ' bytes):\n' + buf.toString('utf-8'));
  } catch (e) { console.log('downloadFile error:', e.message); }

  console.log('\n== 6) listFiles ==');
  try { console.log(await gha.listFiles(id, 'work')); } catch (e) { console.log('listFiles error:', e.message); }

  console.log('\n== 7) getLatestArtifacts (deliverables) ==');
  try {
    const arts = await gha.getLatestArtifacts(id);
    console.log('artifacts:', arts.map(a => ({ name: a.name, bytes: a.buffer.length })));
  } catch (e) { console.log('artifacts error:', e.message); }

  console.log('\n✅ E2E PASSED — the agent has a real Linux computer on GitHub Actions.');
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
