// FULL host-loop deliverable test on the PINNED GitHub Actions backend.
// Simulates exactly what agentEngine.runAgent does in the host loop:
//   1) acquire GHA fsx via the host-loop provisioning path (acquireSandboxFsx)
//   2) write an input file, run code that produces deliverables
//   3) list + download the deliverables to the host (what the bots then send)
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN;
process.env.GITHUB_ACTIONS_REPO = 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = 'main';
process.env.SANDBOX_BACKEND = 'githubactions';
process.env.AGENT_IN_SANDBOX = ''; // let sandboxAgent.enabled() decide (should be false for GHA)

const fs = require('fs');
const os = require('os');
const path = require('path');
const gha = require('../services/githubActions');

(async () => {
  const sessionKey = 'tg:hostloop-test';
  console.log('== 1) provision persistent GHA sandbox for the session ==');
  const { id, reused } = await gha.getOrCreateSessionSandbox(sessionKey, {});
  console.log('   sandbox id:', id, '| reused:', reused);

  console.log('\n== 2) run a real agent-style task (produce two deliverables) ==');
  const task = [
    'set -e',
    'echo "user asked: build a small report + data file"',
    'python3 - <<PY',
    'with open("summary.txt","w") as f:',
    '    f.write("PowerX host-loop delivery test\\n")',
    '    f.write("rows=" + str(sum(range(1,101))) + "\\n")',
    'print("wrote summary.txt")',
    'PY',
    'printf "col1,col2\\n1,2\\n3,4\\n" > data.csv',
    'echo "== files produced ==" ; ls -la',
  ].join('\n');
  const r = await gha.exec(id, task, { cwd: gha.WORKDIR, timeout: 300 });
  console.log('   exit:', r.exitCode);
  console.log('   output tail:\n' + (r.output || '').split('\n').slice(-8).map(l => '     ' + l).join('\n'));

  console.log('\n== 3) list deliverables (what the delivery loop iterates) ==');
  const files = await gha.listFiles(id, 'work');
  const deliverables = files.filter(f => !f.isDir && !f.name.startsWith('.'));
  console.log('   deliverables:', deliverables.map(f => f.name + ' (' + f.size + 'b)'));

  console.log('\n== 4) download each to a host stage dir (what bots send) ==');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wormstage_'));
  const sent = [];
  for (const f of deliverables) {
    const buf = await gha.downloadFile(id, gha.WORKDIR + '/' + f.name);
    const hp = path.join(stage, f.name);
    fs.writeFileSync(hp, buf);
    sent.push({ name: f.name, bytes: buf.length });
  }
  console.log('   staged for delivery:', sent);

  const ok = sent.some(s => s.name === 'summary.txt') && sent.some(s => s.name === 'data.csv') && r.exitCode === 0;
  console.log('\n' + (ok
    ? '✅ FULL HOST-LOOP DELIVERY PASSED — GHA runs the task, files land in git work tree, and download back to host for the bots to send.'
    : '❌ FAILED — deliverables did not materialize.'));
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
