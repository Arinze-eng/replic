// scripts/test-file-content.js
// Regression test for the "{} / [object Object]" file-content bug.
// Verifies that create_pdf / create_docx / write_file produce files containing
// the ACTUAL text even when the model passes `content` as an object / array /
// nested wrapper instead of a plain string.
const fs = require('fs');
const os = require('os');
const path = require('path');
const agent = require('../services/agentEngine');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Minimal in-memory ctx that captures delivered buffers + written files.
function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbtest_'));
  const delivered = {};   // name -> Buffer
  const written = {};     // rel -> string
  return {
    dir, delivered, written,
    fsx: {
      workdir: dir,
      async writeText(rel, text) { written[rel] = text; },
      async uploadBuffer() {},
      async list() { return []; },
    },
    addFile() {},
    async deliverBuffer(name, buffer) { delivered[name] = buffer; },
    onStep() {},
  };
}

(async () => {
  console.log('— coerceContent file-output regression tests —\n');

  // 1) write_file with an OBJECT wrapper { text: ... }
  {
    const ctx = makeCtx();
    await agent._internals.toolWriteFile({ filename: 'a.txt', content: { text: 'Hello from object' } }, ctx);
    const v = ctx.written['a.txt'] || '';
    check('write_file unwraps {text}', v === 'Hello from object', JSON.stringify(v));
    check('write_file not [object Object]', !/\[object Object\]/.test(v) && v !== '{}', v);
  }

  // 2) write_file with an ARRAY of lines
  {
    const ctx = makeCtx();
    await agent._internals.toolWriteFile({ filename: 'b.txt', content: ['line1', 'line2'] }, ctx);
    const v = ctx.written['b.txt'] || '';
    check('write_file joins array lines', v === 'line1\nline2', JSON.stringify(v));
  }

  // 3) create_pdf with an OBJECT content (forces pdfkit path via math:false)
  {
    const ctx = makeCtx();
    const realText = 'This is the real PDF body that must not become a brace.';
    await agent._internals.toolCreatePdf(
      { filename: 'c.pdf', title: 'T', math: false, content: { content: realText } }, ctx);
    const buf = ctx.delivered['c.pdf'];
    check('create_pdf produced a buffer', Buffer.isBuffer(buf) && buf.length > 200, buf && buf.length);
    const head = buf ? buf.slice(0, 5).toString('latin1') : '';
    check('create_pdf is a valid PDF (%PDF header)', head.startsWith('%PDF'), head);
    // pdfkit writes text as hex-encoded TJ arrays inside FlateDecode streams.
    // Decompress every stream and decode the <hex> tokens back to text.
    const zlib = require('zlib');
    let pdfText = '';
    {
      const raw = buf.toString('latin1');
      const re = /stream\r?\n([\s\S]*?)endstream/g; let m;
      while ((m = re.exec(raw)) !== null) {
        try {
          const d = zlib.inflateSync(Buffer.from(m[1].replace(/^\r?\n/, ''), 'latin1')).toString('latin1');
          d.replace(/<([0-9a-fA-F]+)>/g, (_, hex) => {
            pdfText += Buffer.from(hex, 'hex').toString('latin1'); return '';
          });
        } catch (_) {}
      }
    }
    check('create_pdf embeds the real text', pdfText.includes('real PDF body'), 'decoded: ' + JSON.stringify(pdfText.slice(0, 80)));
    check('create_pdf not [object Object]/{}', !pdfText.includes('[object Object]') && pdfText.replace(/Title|T/g, '').trim() !== '{}', pdfText.slice(0, 40));
  }

  // 4) create_docx with a nested { body: { markdown: ... } }
  {
    const ctx = makeCtx();
    await agent._internals.toolCreateDocx(
      { filename: 'd.docx', title: 'Doc', content: { body: { markdown: '# Heading\n\nParagraph text here.' } } }, ctx);
    const buf = ctx.delivered['d.docx'];
    check('create_docx produced a buffer', Buffer.isBuffer(buf) && buf.length > 500, buf && buf.length);
    // docx is a zip (PK header). Real content => unzip contains "Paragraph text here.".
    const head = buf ? buf.slice(0, 2).toString('latin1') : '';
    check('create_docx is a valid .docx (PK zip)', head === 'PK', head);
    try {
      const AdmZip = require('adm-zip');
      const xml = new AdmZip(buf).readAsText('word/document.xml');
      check('create_docx embeds the real text', xml.includes('Paragraph text here'), 'not in document.xml');
      check('create_docx not [object Object]', !xml.includes('[object Object]'), 'found [object Object]');
    } catch (e) {
      check('create_docx unzip', false, e.message);
    }
  }

  console.log(`\n${fail === 0 ? '🎉 ALL PASSED' : '⚠️ FAILURES'} — ${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
