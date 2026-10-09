// ─────────────────────────────────────────────────────────────────────────────
// test-gha-delivery-live.js  —  REAL end-to-end on the GitHub Actions runner.
//
// Proves the WHOLE GitHub-CI-runner delivery chain now behaves correctly:
//   1) create a GHA sandbox (namespaced folder in the runner repo),
//   2) dispatch a REAL workflow that produces a multi-file coding project,
//      PLUS an agent-made project.zip, PLUS a PDF (office doc),
//   3) download every produced file back to the host via the real provider
//      (exactly what agentEngine's host loop does),
//   4) feed them through the SHIPPED _bundleDeliverables() and assert:
//        • the code files collapse into ONE zip,
//        • the stray agent-made project.zip is DROPPED (no zip-in-zip / no loose dup),
//        • the PDF ships individually.
//
// Requires: GHA_TOKEN env (a ghp_ PAT with repo+workflow scope).
// ─────────────────────────────────────────────────────────────────────────────
process.env.GITHUB_ACTIONS_TOKEN = process.env.GHA_TOKEN;
process.env.GITHUB_ACTIONS_REPO = process.env.GHA_REPO || 'Arinze-eng/powerx-sandbox';
process.env.GITHUB_ACTIONS_BRANCH = process.env.GHA_BRANCH || 'main';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');
const gha = require('../services/githubActions');

// Load the shipped _bundleDeliverables from source (no heavy deps).
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'agentEngine.js'), 'utf-8');
function sliceFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { if (--depth === 0) { i++; break; } } }
  return SRC.slice(start, i);
}
const bundleCode = `
const _STANDALONE_DELIVERY_EXTS = new Set(['.pdf','.docx','.doc','.pptx','.ppt','.xlsx','.xls','.png','.jpg','.jpeg','.gif','.webp','.bmp','.tiff']);
const _ARCHIVE_DELIVERY_EXTS = ['.zip','.tar','.gz','.tgz','.bz2','.xz','.7z','.rar'];
${sliceFn('_deliveryExt')}
${sliceFn('_isArchiveDelivery')}
${sliceFn('_bundleDeliverables')}
module.exports = { _bundleDeliverables };`;
const sb = { path, fs, AdmZip, module: { exports: {} }, require };
vm.createContext(sb); vm.runInContext(bundleCode, sb);
const { _bundleDeliverables } = sb.module.exports;

(async () => {
  if (!process.env.GHA_TOKEN) { console.error('❌ set GHA_TOKEN'); process.exit(2); }
  console.log('== GitHub Actions LIVE delivery e2e ==');
  console.log('repo:', process.env.GITHUB_ACTIONS_REPO);

  const id = 's-e2e' + Math.random().toString(16).slice(2, 8);
  console.log('creating sandbox', id, '…');
  await gha.createSandbox(id);

  // A real task: build a small multi-file python project, ALSO zip it itself
  // (simulating an over-eager agent), ALSO emit a PDF-like office doc.
  const cmd = [
    'set -e',
    'mkdir -p calc',
    'echo "def add(a,b): return a+b" > calc/core.py',
    'echo "from core import add" > calc/main.py',
    'echo "# Calc" > calc/README.md',
    // agent self-zips (the thing we must DROP):
    'zip -qr project.zip calc',
    // a fake but valid-enough PDF header office doc:
    'printf "%%PDF-1.4\\n%%fake\\n" > report.pdf',
    'ls -R .',
  ].join('\n');

  console.log('dispatching real workflow (this launches a GitHub runner)…');
  const r = await gha.exec(id, cmd, { timeout: 300 });
  console.log('exec exitCode:', r.exitCode);
  console.log('runner output tail:\n', (r.output || '').split('\n').slice(-12).join('\n'));

  // List everything the task produced under the work tree, download to host.
  const listed = await gha.listFilesRecursive(id);
  console.log('\nfiles in work tree:', listed.map(f => f.rel));

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ghae2e_'));
  const hostFiles = [];
  for (const f of listed) {
    // mirror agentEngine's internal-artifact skip + keep rel for structure
    if (/(^|\/)(\.git|node_modules)(\/|$)/.test(f.rel) || /(^|\/)_step/.test(f.rel) || /(^|\/)\.keep$/.test(f.rel)) continue;
    try {
      const buf = await gha.downloadFile(id, f.rel);
      const safe = path.posix.basename(f.rel).replace(/[^\w.\-]/g, '_');
      const hp = path.join(stage, safe);
      fs.writeFileSync(hp, buf);
      hostFiles.push({ path: hp, name: path.posix.basename(f.rel), rel: f.rel.replace(/^work\//, '') });
    } catch (e) { console.log('  (skip', f.rel, e.message + ')'); }
  }
  console.log('downloaded to host:', hostFiles.map(f => f.name));

  // THE FIX under test: bundle exactly like every other sandbox.
  const out = _bundleDeliverables(hostFiles, stage);
  const outNames = out.map(f => f.name).sort();
  console.log('\nFINAL DELIVERABLES:', outNames);

  let ok = true;
  const zipEntry = out.find(f => /\.zip$/.test(f.name));
  const hasPdf = out.some(f => f.name === 'report.pdf');
  const looseCode = out.some(f => /\.(py|md)$/.test(f.name));
  const strayAgentZip = out.filter(f => /\.zip$/.test(f.name)).length > 1;

  const c1 = !!zipEntry;              console.log((c1?'✅':'❌')+' code collapsed into ONE zip'); ok = ok && c1;
  const c2 = hasPdf;                  console.log((c2?'✅':'❌')+' PDF delivered individually'); ok = ok && c2;
  const c3 = !looseCode;              console.log((c3?'✅':'❌')+' NO loose .py/.md files delivered'); ok = ok && c3;
  const c4 = !strayAgentZip;          console.log((c4?'✅':'❌')+' NO duplicate/stray agent zip'); ok = ok && c4;
  if (zipEntry) {
    const ents = new AdmZip(zipEntry.path).getEntries().map(e => e.entryName);
    const nested = ents.some(e => /\.zip$/.test(e));
    const c5 = !nested;              console.log((c5?'✅':'❌')+' delivered zip has NO nested zip (no zip-in-zip): '+ents.join(',')); ok = ok && c5;
  }

  try { await gha.deleteSandbox(id); } catch (_) {}
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + (ok ? '✅ LIVE GHA DELIVERY E2E PASSED' : '❌ LIVE GHA DELIVERY E2E FAILED'));
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
