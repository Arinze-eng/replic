// ─────────────────────────────────────────────────────────────────────────────
// test-convert-e2e.js — REAL end-to-end test of the file converter.
//
// Exercises services/fileConverter.js against a LOCAL-shell fsx (same contract
// the sandbox fsx exposes) and asserts, for each conversion pair, that the
// output file is BOTH produced on disk AND queued for delivery (via
// ctx.addFile / ctx.deliverBuffer). This is the exact wiring the sandbox
// worker relies on — if delivery is queued here, the user receives the file.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const fileConverter = require('../services/fileConverter');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'convtest_'));
console.log('workdir:', WORK);

// A minimal fsx matching the sandbox fsx contract used by fileConverter.
const fsx = {
  workdir: WORK,
  async sh(command) {
    try {
      const out = execSync(command, { cwd: WORK, timeout: 180000, shell: '/bin/bash' }).toString();
      return { exitCode: 0, output: out };
    } catch (e) {
      return { exitCode: e.status || 1, output: (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '') };
    }
  },
  async exists(rel) { return fs.existsSync(path.join(WORK, rel)); },
  async readText(rel) { return fs.readFileSync(path.join(WORK, rel), 'utf-8'); },
  async writeText(rel, text) { fs.writeFileSync(path.join(WORK, rel), text == null ? '' : String(text)); },
  async downloadBuffer(rel) { return fs.readFileSync(path.join(WORK, rel)); },
  async uploadBuffer(rel, buf) { fs.writeFileSync(path.join(WORK, rel), buf); },
  async list() {
    const out = [];
    for (const f of fs.readdirSync(WORK)) {
      const st = fs.statSync(path.join(WORK, f));
      if (st.isFile()) out.push({ rel: f, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
    }
    return out;
  },
};

// Build a ctx that records deliveries the SAME way the sandbox worker does:
//   • addFile(rel,name)     → the worker later downloads rel and delivers it
//   • deliverBuffer(name,b) → the worker writes the buffer straight to WORK
// Our fix guarantees BOTH end up in the delivered set.
function makeCtx() {
  const delivered = new Map(); // name -> {source}
  return {
    fsx,
    onStep: (m) => process.stdout.write('   · ' + m + '\n'),
    onEvent: () => {},
    addFile(rel, name) {
      const deliverName = String(name || path.posix.basename(String(rel)));
      delivered.set(deliverName, { via: 'addFile', rel });
    },
    async deliverBuffer(fname, buffer) {
      const safe = String(fname).replace(/[^\w.\-]/g, '_');
      fs.writeFileSync(path.join(WORK, safe), buffer);
      delivered.set(safe, { via: 'deliverBuffer', bytes: buffer.length });
    },
    _delivered: delivered,
  };
}

// ── Create source fixtures with the installed libs ──────────────────────────
async function makeFixtures() {
  // DOCX via the `docx` lib
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
  const doc = new Document({
    sections: [{ children: [
      new Paragraph({ text: 'PowerX Conversion Test', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun('The quick brown fox jumps over the lazy dog. 1234567890.')] }),
      new Paragraph({ children: [new TextRun('Second paragraph with more content for layout fidelity.')] }),
    ] }],
  });
  fs.writeFileSync(path.join(WORK, 'sample.docx'), await Packer.toBuffer(doc));

  // HTML
  fs.writeFileSync(path.join(WORK, 'sample.html'),
    '<!doctype html><html><head><title>PowerX HTML</title></head><body>' +
    '<h1>PowerX HTML Report</h1><p>Rendered HTML to PDF end to end.</p>' +
    '<ul><li>Item one</li><li>Item two</li></ul></body></html>');

  // Markdown
  fs.writeFileSync(path.join(WORK, 'sample.md'),
    '# PowerX Markdown\n\nHello **world**. This is a *markdown* document.\n\n- a\n- b\n- c\n');

  // CSV / XLSX + PPTX are created via LibreOffice from simpler inputs to avoid
  // extra deps; we generate an XLSX from a CSV and a PPTX from a template.
  fs.writeFileSync(path.join(WORK, 'data.csv'), 'name,score\nAlice,90\nBob,75\nCara,88\n');
  // Make xlsx from csv using soffice (also validates csv->xlsx path indirectly)
  execSync(`export HOME=/tmp/lohome; mkdir -p /tmp/lohome; soffice --headless --convert-to xlsx --outdir . data.csv`, { cwd: WORK, timeout: 120000 });
  // Make a pptx from the html via soffice impress? Simpler: create a tiny odp->pptx.
  // We'll create a pptx by converting the docx to pptx is not valid; instead build
  // a minimal pptx with pptxgenjs if available, else skip pptx source test.
}

const RESULTS = [];
async function runCase(label, args, expectExt) {
  const ctx = makeCtx();
  let res;
  try { res = await fileConverter.toolConvertFile(args, ctx); }
  catch (e) { res = '[threw] ' + e.message; }

  // Determine expected output name
  const base = (args.filename || (args.source ? args.source.replace(/\.[^.]+$/, '') : 'output')).replace(/\.[^.]*$/, '');
  const expectedName = `${base}.${expectExt}`;

  const deliveredNames = [...ctx._delivered.keys()];
  const isDelivered = ctx._delivered.has(expectedName) ||
    deliveredNames.some(n => n.endsWith('.' + expectExt));
  // Also confirm the delivered file physically exists & is non-trivial.
  let onDisk = false, size = 0;
  const candidate = deliveredNames.find(n => n === expectedName) ||
    deliveredNames.find(n => n.endsWith('.' + expectExt));
  if (candidate) {
    const p = path.join(WORK, ctx._delivered.get(candidate).rel || candidate);
    if (fs.existsSync(p)) { onDisk = true; size = fs.statSync(p).size; }
  }
  const ok = String(res).includes('✅') && isDelivered && onDisk && size > 40;
  RESULTS.push({ label, ok, delivered: deliveredNames, size, res: String(res).slice(0, 200) });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  console.log('   result:', String(res).slice(0, 180));
  console.log('   delivered:', deliveredNames.join(', ') || '(none)', size ? `(${size} bytes)` : '');
  return ok;
}

(async () => {
  await makeFixtures();
  console.log('fixtures:', fs.readdirSync(WORK).join(', '));

  await runCase('docx → pdf',  { source: 'sample.docx', to: 'pdf' },  'pdf');
  await runCase('pdf → docx',  { source: 'sample.pdf',  to: 'docx', filename: 'roundtrip' }, 'docx'); // uses the pdf just produced
  await runCase('docx → txt',  { source: 'sample.docx', to: 'txt' },  'txt');
  await runCase('xlsx → pdf',  { source: 'data.xlsx',   to: 'pdf' },  'pdf');
  await runCase('csv → xlsx',  { source: 'data.csv',    to: 'xlsx', filename: 'data2' }, 'xlsx');
  await runCase('md → docx',   { source: 'sample.md',   to: 'docx' }, 'docx');
  await runCase('md → html',   { source: 'sample.md',   to: 'html' }, 'html');

  const passed = RESULTS.filter(r => r.ok).length;
  console.log(`\n════════════════════════════════════════`);
  console.log(`SUMMARY: ${passed}/${RESULTS.length} conversions delivered a real file`);
  RESULTS.forEach(r => console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}`));
  process.exit(passed === RESULTS.length ? 0 : 1);
})();
