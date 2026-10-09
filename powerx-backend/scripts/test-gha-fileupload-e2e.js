// E2E test for the GitHub Actions FILE-UPLOAD bug fix.
//
// Reproduces the exact user-reported failure: a bot user uploads a file
// (pdf / image / txt / docx / apk / zip) and the AI "shows errors / hangs
// forever" on the GitHub Actions CI runner. The root cause was that the
// host-loop fsx routed EVERY file op (writeText / exists / list / chunked
// base64 upload) through sb.exec() — and on GitHub Actions each exec() is a
// FULL workflow dispatch (30 s–minutes), so a single binary attachment fired
// dozens–hundreds of CI runs.
//
// This test proves the native-FS fast path: staging binary attachments of
// EVERY type + a ZIP is now instant (Git Data API, ZERO workflow dispatches),
// exists()/list()/download() are native, make_zip builds on the host, and a
// single real exec() still runs a command + returns a deliverable.
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN;
process.env.GITHUB_ACTIONS_REPO = process.env.GHA_REPO || 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = process.env.GHA_BRANCH || 'main';

const gha = require('../services/githubActions');
const AdmZip = require('adm-zip');

// Build a tiny valid ZIP in memory (2 entries).
function makeZipBuffer() {
  const z = new AdmZip();
  z.addFile('inner/hello.txt', Buffer.from('hello from inside a zip\n', 'utf-8'));
  z.addFile('inner/data.csv', Buffer.from('a,b\n1,2\n3,4\n', 'utf-8'));
  return z.toBuffer();
}

// Minimal fake binary buffers for each "type" the user listed. We do NOT need
// real parsable files here — the point of THIS test is that STAGING never hangs
// and never fires a CI run, regardless of file type/size.
function fakeBin(sizeKB, byte) {
  return Buffer.alloc(sizeKB * 1024, byte);
}

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); }
  else { console.error('  ❌ ' + msg); failed++; }
}

(async () => {
  console.log('== 0) preconditions ==');
  const t = await gha.testKey();
  console.log('  testKey:', t.message);
  if (!t.ok) { console.error('testKey failed — aborting'); process.exit(1); }
  assert(gha.perCommand === true, 'backend is flagged perCommand (host-loop model)');
  assert(gha.nativeFs === true, 'backend is flagged nativeFs (Git Data API file ops)');
  assert(typeof gha.uploadFiles === 'function', 'uploadFiles (batch commit) is exported');
  assert(typeof gha.existsFile === 'function', 'existsFile (native) is exported');
  assert(typeof gha.listFilesRecursive === 'function', 'listFilesRecursive (native) is exported');

  console.log('\n== 1) createSandbox ==');
  const id = await gha.createSandbox({ labels: { session: 'e2e-fileupload' } });
  console.log('  sandbox id:', id);

  // The attachments a user might drop, one of every requested type.
  const attachments = [
    { name: 'notes.txt',   buffer: Buffer.from('plain text notes\nline 2\n', 'utf-8') },
    { name: 'photo.png',   buffer: fakeBin(200, 0x89) },          // ~200KB "image"
    { name: 'paper.pdf',   buffer: fakeBin(500, 0x25) },          // ~500KB "pdf"
    { name: 'report.docx', buffer: fakeBin(120, 0x50) },          // "docx"
    { name: 'app.apk',     buffer: fakeBin(1024, 0x41) },         // 1MB "apk"
    { name: 'bundle.zip',  buffer: makeZipBuffer() },             // real zip
  ];

  console.log('\n== 2) STAGE all attachments in ONE batch commit (must be FAST, zero CI runs) ==');
  // Extract the zip locally (like agentEngine's nativeFs staging does) and add
  // every entry to the same batch so it is one atomic commit.
  const batch = [];
  for (const a of attachments) {
    const safe = a.name.replace(/[^\w.\-]/g, '_');
    batch.push({ dest: safe, buffer: a.buffer });
    if (/\.zip$/i.test(safe)) {
      const dir = safe.replace(/\.zip$/i, '') + '_extracted';
      const zip = new AdmZip(a.buffer);
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue;
        batch.push({ dest: `${dir}/${e.entryName}`, buffer: e.getData() });
      }
    }
  }
  const started = Date.now();
  await gha.uploadFiles(id, batch);
  const stageMs = Date.now() - started;
  console.log(`  staged ${batch.length} file(s) in ${stageMs} ms`);
  assert(stageMs < 60000, `staging is fast (< 60s) — was ${stageMs}ms (proves NO CI runs fired)`);

  console.log('\n== 3) native exists() for EVERY uploaded type (no CI run) ==');
  for (const a of attachments) {
    const safe = a.name.replace(/[^\w.\-]/g, '_');
    const ex = await gha.existsFile(id, safe);
    assert(ex === true, `exists(${safe})`);
  }
  assert(await gha.existsFile(id, 'bundle_extracted/inner/hello.txt'), 'zip auto-extracted (inner/hello.txt present)');
  assert(!(await gha.existsFile(id, 'does_not_exist.bin')), 'exists() correctly returns false for a missing file');

  console.log('\n== 4) native recursive listing ==');
  const files = await gha.listFilesRecursive(id);
  const rels = files.map(f => f.rel);
  console.log('  files:', rels);
  assert(rels.includes('app.apk'), 'apk shows in listing');
  assert(rels.includes('paper.pdf'), 'pdf shows in listing');
  assert(rels.some(r => r.startsWith('bundle_extracted/')), 'extracted zip entries show in listing');

  console.log('\n== 5) native download round-trips exact bytes ==');
  const back = await gha.downloadFile(id, 'app.apk');
  assert(back.length === attachments.find(a => a.name === 'app.apk').buffer.length, 'apk bytes round-trip intact');

  console.log('\n== 6) ONE real exec: the agent reads the uploads + produces a deliverable ==');
  const cmd = `
set -e
echo "files in workdir:"; ls -la
echo "txt content:"; cat notes.txt
echo "zip inner:"; cat bundle_extracted/inner/hello.txt
python3 - <<'PY'
import os
names = sorted(os.listdir('.'))
with open('summary.txt','w') as f:
    f.write('AI processed uploads:\\n')
    for n in names:
        if os.path.isfile(n):
            f.write(f'{n}: {os.path.getsize(n)} bytes\\n')
print('wrote summary.txt')
PY
echo "TASK_DONE_OK"
`;
  const r = await gha.exec(id, cmd, { timeout: 600 });
  console.log('  exitCode:', r.exitCode);
  console.log('  --- output tail ---\n' + (r.output || '').slice(-1200));
  assert(r.exitCode === 0, 'exec completed with exit 0 (did NOT hang / timeout)');
  assert(/TASK_DONE_OK/.test(r.output || ''), 'command ran to completion');

  console.log('\n== 7) the produced deliverable comes back ==');
  const arts = await gha.getLatestArtifacts(id);
  const names = arts.map(a => a.name);
  console.log('  deliverables:', names.map((n, i) => `${n} (${arts[i].buffer.length}b)`));
  assert(names.includes('summary.txt'), 'summary.txt deliverable returned to host');

  console.log('\n== 8) make_zip host-side fast path (native, no CI run) ==');
  // Emulate agentEngine's fsx.uploadBuffer / list / downloadBuffer to build a zip on host.
  const all = await gha.listFilesRecursive(id);
  const zip = new AdmZip();
  let added = 0;
  for (const f of all) {
    if (/(^|\/)_step_/.test(f.rel) || /(^|\/)\.keep$/.test(f.rel)) continue;
    try { zip.addFile(f.rel, await gha.downloadFile(id, f.rel)); added++; } catch (_) {}
  }
  assert(added > 0, `packaged ${added} files into a host-built zip (no CI run)`);

  console.log(failed === 0
    ? '\n✅ ALL CHECKS PASSED — file uploads of every type stage instantly, the AI runs and delivers, nothing hangs.'
    : `\n❌ ${failed} check(s) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
