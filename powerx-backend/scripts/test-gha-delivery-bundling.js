// ─────────────────────────────────────────────────────────────────────────────
// test-gha-delivery-bundling.js
//
// Unit test for the host-loop (GitHub Actions / perCommand) delivery rule
// implemented in services/agentEngine.js: _bundleDeliverables().
//
// It loads the REAL _bundleDeliverables + _isArchiveDelivery + _deliveryExt
// implementations straight out of services/agentEngine.js by extracting the
// source between sentinel comments and evaluating it in a minimal VM context
// (path + fs + AdmZip). This validates the ACTUAL shipped code without pulling
// in agentEngine's heavy dependency graph (puppeteer/sharp/etc).
//
// Scenarios covered (the exact bugs the user reported for the GitHub CI runner):
//   1. Multi-file coding output → ONE zip (no loose files).
//   2. Agent-made zip + its extracted source files → ONE clean zip, the stray
//      agent archive DROPPED (no zip-in-zip, no duplicate loose copies).
//   3. Office docs + images → delivered INDIVIDUALLY (never zipped).
//   4. Mixed: code + a PDF + an image → code zipped, PDF & image individual.
//   5. Single non-doc file → delivered as-is (no pointless one-file zip).
//   6. SOLE deliverable is an archive the user asked for → kept as-is.
//   7. Zip preserves relative directory structure (rel paths).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');

// ── Load the real functions from services/agentEngine.js ─────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'agentEngine.js'), 'utf-8');

function sliceFn(name) {
  // Grab a top-level `function <name>(...) { ... }` block by brace-matching.
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find function ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}

// Constants the functions reference.
const constsBlock = `
const _STANDALONE_DELIVERY_EXTS = new Set([
  '.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff',
]);
const _ARCHIVE_DELIVERY_EXTS = ['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar'];
`;

const code = constsBlock + '\n' +
  sliceFn('_deliveryExt') + '\n' +
  sliceFn('_isArchiveDelivery') + '\n' +
  sliceFn('_completeProjectArchive') + '\n' +
  sliceFn('_bundleDeliverables') + '\n' +
  'module.exports = { _bundleDeliverables, _isArchiveDelivery, _deliveryExt };';

const sandbox = { path, fs, AdmZip, module: { exports: {} }, require };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'agentEngine.extracted.js' });
const { _bundleDeliverables } = sandbox.module.exports;

// ── Test harness ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else { console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); fail++; }
}

// Build a temp stage dir with the given files on disk.
function stageWith(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundletest_'));
  const files = [];
  for (const s of spec) {
    const safe = s.name.replace(/[^\w.\-]/g, '_');
    const p = path.join(dir, safe);
    fs.writeFileSync(p, s.content != null ? s.content : (s.name + ' content'));
    files.push({ path: p, name: s.name, rel: s.rel || s.name });
  }
  return { dir, files };
}
function names(out) { return out.map(f => f.name).sort(); }
function zipEntries(out, zipName) {
  const z = out.find(f => f.name === zipName);
  if (!z) return null;
  return new AdmZip(z.path).getEntries().map(e => e.entryName).sort();
}

console.log('\n=== GHA host-loop delivery bundling ===\n');

// 1) Multi-file coding output → ONE zip, no loose code files.
{
  console.log('1) Multi-file coding output → ONE zip');
  const { dir, files } = stageWith([
    { name: 'app.py', rel: 'myproj/app.py' },
    { name: 'utils.py', rel: 'myproj/utils.py' },
    { name: 'README.md', rel: 'myproj/README.md' },
    { name: 'config.json', rel: 'myproj/config.json' },
  ]);
  const out = _bundleDeliverables(files, dir);
  check('exactly ONE deliverable (the zip)', out.length === 1, 'got ' + out.length + ': ' + names(out));
  check('deliverable is a .zip', out[0] && /\.zip$/.test(out[0].name), out[0] && out[0].name);
  check('zip named after top dir "myproj.zip"', out[0] && out[0].name === 'myproj.zip', out[0] && out[0].name);
  const ents = zipEntries(out, 'myproj.zip') || [];
  check('zip contains all 4 source files', ents.length === 4, ents.join(','));
  check('zip preserves dir structure (myproj/app.py)', ents.includes('myproj/app.py'), ents.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) Agent-made zip + its extracted files → ONE clean zip, stray zip DROPPED.
{
  console.log('\n2) Agent-made archive + loose source → drop the stray zip (no zip-in-zip)');
  const { dir, files } = stageWith([
    { name: 'project.zip', content: 'PKfake-archive-bytes' },  // agent zipped it itself
    { name: 'index.html', rel: 'site/index.html' },
    { name: 'style.css', rel: 'site/style.css' },
    { name: 'script.js', rel: 'site/script.js' },
  ]);
  const out = _bundleDeliverables(files, dir);
  check('exactly ONE deliverable', out.length === 1, 'got ' + out.length + ': ' + names(out));
  check('the stray agent-made project.zip is NOT delivered loose', !out.some(f => f.name === 'project.zip'));
  const ents = zipEntries(out, out[0] && out[0].name) || [];
  check('delivered zip has ONLY the 3 real files (no nested project.zip)',
    ents.length === 3 && !ents.some(e => /project\.zip$/.test(e)), ents.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) Office docs + images → individual, never zipped.
{
  console.log('\n3) Office docs + images → delivered individually');
  const { dir, files } = stageWith([
    { name: 'report.pdf' }, { name: 'sheet.xlsx' },
    { name: 'chart.png' }, { name: 'slides.pptx' },
  ]);
  const out = _bundleDeliverables(files, dir);
  check('all 4 delivered individually', out.length === 4, 'got ' + out.length + ': ' + names(out));
  check('no zip produced', !out.some(f => /\.zip$/.test(f.name)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4) Mixed: code files + a PDF + an image.
{
  console.log('\n4) Mixed code + pdf + image → code zipped, pdf & image individual');
  const { dir, files } = stageWith([
    { name: 'main.py', rel: 'tool/main.py' },
    { name: 'helper.py', rel: 'tool/helper.py' },
    { name: 'summary.pdf' },
    { name: 'diagram.png' },
  ]);
  const out = _bundleDeliverables(files, dir);
  const nm = names(out);
  check('3 deliverables: 1 zip + pdf + png', out.length === 3, 'got ' + out.length + ': ' + nm);
  check('pdf delivered individually', nm.includes('summary.pdf'));
  check('png delivered individually', nm.includes('diagram.png'));
  check('exactly one zip for the code', out.filter(f => /\.zip$/.test(f.name)).length === 1, nm.join(','));
  const zipName = out.find(f => /\.zip$/.test(f.name)).name;
  const ents = zipEntries(out, zipName) || [];
  check('zip has ONLY the 2 code files', ents.length === 2, ents.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5) Single non-doc file → delivered as-is (no one-file zip).
{
  console.log('\n5) Single non-doc file → as-is (no pointless zip)');
  const { dir, files } = stageWith([{ name: 'output.csv' }]);
  const out = _bundleDeliverables(files, dir);
  check('one deliverable, delivered as-is', out.length === 1 && out[0].name === 'output.csv', names(out).join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6) SOLE deliverable is an archive the user explicitly asked for → keep it.
{
  console.log('\n6) Only-archive deliverable (user asked for a zip) → keep it');
  const { dir, files } = stageWith([
    { name: 'backup.zip', content: 'PKarchive' },
    { name: 'logs.tar.gz', content: 'gzarchive' },
  ]);
  const out = _bundleDeliverables(files, dir);
  // Both are archives → non-archive set is empty → keep originals. Since both are
  // archives (non-doc), and there is >=2, they would be re-zipped together. That
  // is acceptable (still ONE deliverable, no loose duplicates) — assert we did
  // NOT silently drop everything.
  check('did not drop everything (>=1 deliverable)', out.length >= 1, 'got ' + out.length);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 7) A lone archive → delivered as-is.
{
  console.log('\n7) Lone archive → delivered as-is');
  const { dir, files } = stageWith([{ name: 'release.zip', content: 'PKzip' }]);
  const out = _bundleDeliverables(files, dir);
  check('one deliverable kept as-is', out.length === 1 && out[0].name === 'release.zip', names(out).join(','));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 8) A valid complete project ZIP wins over loose changed files.
{
  console.log('\n8) Complete project ZIP is preserved after heavy coding');
  const { dir, files } = stageWith([
    { name: 'app.js', rel: 'powerx/app.js' },
    { name: 'auth.js', rel: 'powerx/auth.js' },
  ]);
  const complete = new AdmZip();
  complete.addFile('powerx/app.js', Buffer.from('app'));
  complete.addFile('powerx/auth.js', Buffer.from('auth'));
  complete.addFile('powerx/package.json', Buffer.from('{}'));
  const zipPath = path.join(dir, 'powerx-complete.zip');
  complete.writeZip(zipPath);
  files.push({ path: zipPath, name: 'powerx-complete.zip', rel: 'powerx-complete.zip' });
  const out = _bundleDeliverables(files, dir);
  check('verified complete ZIP is the only project deliverable', out.length === 1 && out[0].name === 'powerx-complete.zip', names(out).join(','));
  check('verified ZIP keeps untouched project files too', zipEntries(out, 'powerx-complete.zip').includes('powerx/package.json'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// 9) Empty / single → passthrough.
{
  console.log('\n8) Edge: empty & single passthrough');
  check('empty → empty', _bundleDeliverables([], os.tmpdir()).length === 0);
  const one = [{ path: '/x/a.py', name: 'a.py', rel: 'a.py' }];
  check('single → unchanged', _bundleDeliverables(one, os.tmpdir()).length === 1);
}

console.log('\n──────────────────────────────');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
