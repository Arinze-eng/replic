// Test: verify office-document extraction (docx/xlsx/pptx) works end to end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractOfficeText, isOfficeDoc } = require('../services/agentEngine')._internals;

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra='') => { if (ok) { pass++; console.log('  ✅', name, extra); } else { fail++; console.log('  ❌', name, extra); } };

  // ---- 1) Build a real .docx with the `docx` lib and extract it ----
  console.log('\n[1] DOCX extraction');
  try {
    const docx = require('docx');
    const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docx;
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ text: 'Solar Energy Collector Report', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [ new TextRun('This experiment evaluates the thermal efficiency of a focusing solar collector.') ] }),
      new Paragraph({ text: 'Procedures', heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [ new TextRun('The collector was aligned to the sun and irradiance recorded every 5 minutes.') ] }),
    ]}]});
    const buf = await Packer.toBuffer(doc);
    const res = await extractOfficeText(buf, 'report.docx');
    check('isOfficeDoc(report.docx)', isOfficeDoc('report.docx'));
    check('docx returns text', !!(res && res.text && res.text.trim()), `(${res && res.text ? res.text.length : 0} chars)`);
    check('docx contains "thermal efficiency"', /thermal efficiency/i.test(res.text));
    check('docx contains heading "Procedures"', /Procedures/.test(res.text));
  } catch (e) { fail++; console.log('  ❌ docx test threw:', e.message); }

  // ---- 2) Build a real .xlsx and extract it ----
  console.log('\n[2] XLSX extraction');
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Time','Irradiance','Temp'],[0,650,25],[10,720,35]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await extractOfficeText(buf, 'data.xlsx');
    check('xlsx returns text', !!(res && res.text && res.text.trim()), `(${res && res.text ? res.text.length : 0} chars)`);
    check('xlsx contains "Irradiance"', /Irradiance/.test(res.text));
    check('xlsx contains "720"', /720/.test(res.text));
  } catch (e) { fail++; console.log('  ❌ xlsx test threw:', e.message); }

  // ---- 3) CSV passthrough ----
  console.log('\n[3] CSV extraction');
  try {
    const buf = Buffer.from('a,b,c\n1,2,3\n', 'utf-8');
    const res = await extractOfficeText(buf, 'x.csv');
    check('csv returns text', !!(res && /1,2,3/.test(res.text)));
  } catch (e) { fail++; console.log('  ❌ csv test threw:', e.message); }

  // ---- 4) Non-office returns null ----
  console.log('\n[4] Non-office passthrough');
  check('isOfficeDoc(foo.pdf) is false', isOfficeDoc('foo.pdf') === false);
  check('extract(foo.txt) is null', (await extractOfficeText(Buffer.from('hi'), 'foo.txt')) === null);

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})();
