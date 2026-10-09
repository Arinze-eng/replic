// End-to-end test of toolReadDocument + toolReadFile for a .docx in the workdir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const eng = require('../services/agentEngine');
const { toolReadDocument, toolReadFile } = eng._internals;

(async () => {
  let pass = 0, fail = 0;
  const check = (n, ok, extra='') => { if (ok) { pass++; console.log('  ✅', n, extra); } else { fail++; console.log('  ❌', n, extra); } };

  // Build a long .docx (~50 paragraphs) so we also confirm no early truncation.
  const docx = require('docx');
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx;
  const kids = [ new Paragraph({ text: 'Big Report', heading: HeadingLevel.HEADING_1 }) ];
  for (let i = 1; i <= 50; i++) {
    kids.push(new Paragraph({ children: [ new TextRun(`Section ${i}: This is paragraph number ${i} with meaningful content about topic ${i} that must be preserved fully without truncation.`) ] }));
  }
  const buf = await Packer.toBuffer(new Document({ sections: [{ children: kids }] }));

  // --- toolReadDocument (attachment path) ---
  console.log('\n[A] toolReadDocument with attached .docx');
  const ctxDoc = { attachments: [{ name: 'big.docx', buffer: buf, isImage: false }] };
  const out1 = await toolReadDocument({ name: 'big.docx' }, ctxDoc);
  check('contains "Section 1"', /Section 1:/.test(out1));
  check('contains "Section 50" (no truncation)', /Section 50:/.test(out1), `(out length ${out1.length})`);
  check('labelled as Word document', /Word document/.test(out1));

  // --- toolReadFile (workdir path) ---
  console.log('\n[B] toolReadFile with .docx in workdir');
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wftest_'));
  fs.writeFileSync(path.join(workdir, 'big.docx'), buf);
  const fsx = {
    async exists(rel) { return fs.existsSync(path.join(workdir, rel)); },
    async readText(rel) { return fs.readFileSync(path.join(workdir, rel), 'utf-8'); },
    async downloadBuffer(rel) { return fs.readFileSync(path.join(workdir, rel)); },
  };
  const out2 = await toolReadFile({ path: 'big.docx' }, { fsx });
  check('read_file extracts docx text', /Section 1:/.test(out2));
  check('read_file no truncation (Section 50)', /Section 50:/.test(out2));

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
