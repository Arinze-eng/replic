#!/usr/bin/env node
/* eslint-disable no-console */
// End-to-end test for the simpleOcr engine (the OmniOCR replacement).
//
// Verifies:
//   1. PDF  → text   (pdf-parse native layer)
//   2. DOCX → text   (mammoth)
//   3. XLSX → text   (xlsx → CSV)
//   4. image → classifyImage always runs deterministic OCR first
//   5. blank image → extract reports OCR no-text (AI is only a caller-level last resort)
//   6. unsupported/empty buffers fail gracefully (never throw)
//   7. API surface matches the old omniOcr (drop-in compatible)
//
// Pure Node, no network, no sandbox. Run: node scripts/test-simple-ocr-e2e.js

const assert = require('assert');
const ocr = require('../services/simpleOcr');

let pass = 0;
let fail = 0;
function ok(name) { console.log(`  ✅ ${name}`); pass++; }
function bad(name, e) { console.log(`  ❌ ${name}: ${e && e.message ? e.message : e}`); fail++; }
async function test(name, fn) {
  try { await fn(); ok(name); } catch (e) { bad(name, e); }
}

// ── Build tiny real sample files in-memory ───────────────────────────────────
const SAMPLE_TEXT = 'Hello OCR World 12345';

function buildPdf() {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument();
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.fontSize(24).text(SAMPLE_TEXT, 72, 700);
      doc.end();
    } catch (e) { reject(e); }
  });
}

async function buildDocx() {
  // Use the `docx` lib if present; otherwise hand-roll a minimal DOCX zip.
  try {
    const { Document, Packer, Paragraph, TextRun } = require('docx');
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(SAMPLE_TEXT)] })] }] });
    return await Packer.toBuffer(doc);
  } catch (_) {
    // Hand-rolled minimal docx (zip with word/document.xml) using the `xlsx`
    // lib's bundled zip? Simpler: use Node's zlib + a tiny store-only zip.
    return buildMinimalDocx(SAMPLE_TEXT);
  }
}

function buildMinimalDocx(text) {
  // Build a store-only (no compression) .docx zip by hand.
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  return makeStoreZip(files);
}

function makeStoreZip(files) {
  const zlib = require('zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  const crc32 = (buf) => {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return ~crc >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
    void zlib; // keep require to silence lint, store-only here
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function buildXlsx() {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Name', 'Value'], ['Alpha', SAMPLE_TEXT], ['Beta', 999]]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildPng() {
  // 1x1 transparent PNG.
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
}

(async () => {
  console.log('\n=== simpleOcr E2E ===\n');
  const ctx = { onStep: (m) => console.log('   ·', m) };

  // API surface
  await test('API: exports available/classifyImage/extract/warmup/isImageName/isDocName', () => {
    ['available', 'classifyImage', 'extract', 'warmup', 'isImageName', 'isDocName'].forEach((k) => {
      assert.strictEqual(typeof ocr[k], 'function', `missing ${k}`);
    });
  });

  await test('available() → true', async () => {
    assert.strictEqual(await ocr.available(ctx), true);
  });

  await test('isImageName / isDocName', () => {
    assert.ok(ocr.isImageName('photo.jpg'));
    assert.ok(ocr.isImageName('shot.PNG'));
    assert.ok(!ocr.isImageName('file.pdf'));
    assert.ok(ocr.isDocName('report.pdf'));
    assert.ok(ocr.isDocName('memo.docx'));
    assert.ok(ocr.isDocName('data.xlsx'));
    assert.ok(!ocr.isDocName('pic.png'));
  });

  await test('PDF → text contains sample', async () => {
    const buf = await buildPdf();
    const ex = await ocr.extract(ctx, buf, 'sample.pdf', { mode: 'auto', pages: 30 });
    assert.ok(ex.ok, `extract failed: ${ex.reason}`);
    assert.strictEqual(ex.type, 'pdf');
    assert.ok(ex.text.includes('Hello OCR World'), `text was: ${JSON.stringify(ex.text.slice(0, 120))}`);
  });

  await test('DOCX → text contains sample', async () => {
    const buf = await buildDocx();
    const ex = await ocr.extract(ctx, buf, 'sample.docx', { mode: 'auto' });
    assert.ok(ex.ok, `extract failed: ${ex.reason}`);
    assert.strictEqual(ex.type, 'docx');
    assert.ok(ex.text.includes(SAMPLE_TEXT), `text was: ${JSON.stringify(ex.text.slice(0, 120))}`);
  });

  await test('XLSX → text contains sample + sheet name', async () => {
    const buf = buildXlsx();
    const ex = await ocr.extract(ctx, buf, 'data.xlsx', { mode: 'auto' });
    assert.ok(ex.ok, `extract failed: ${ex.reason}`);
    assert.strictEqual(ex.type, 'excel');
    assert.ok(ex.text.includes(SAMPLE_TEXT), `text was: ${JSON.stringify(ex.text.slice(0, 200))}`);
    assert.ok(ex.text.includes('Sheet1'));
  });

  await test('image classifyImage → hasText:false after OCR probe', async () => {
    const cls = await ocr.classifyImage(ctx, buildPng(), 'photo.png');
    assert.ok(cls.ok);
    assert.strictEqual(cls.hasText, false);
  });

  await test('blank image extract → OCR attempted before no-text result', async () => {
    const ex = await ocr.extract(ctx, buildPng(), 'photo.png', {});
    assert.strictEqual(ex.ok, false);
    assert.strictEqual(ex.ocrAttempted, true);
    assert.match(ex.reason, /no-meaningful-text|ocr-no-text/);
  });

  await test('sandbox retry diagnostics are not emitted as user-facing steps', async () => {
    const steps = [];
    const noText = '<<<PXOCR_JSON_BEGIN>>>\n' + JSON.stringify({
      ok: true, text: '', has_text: false, reason: 'no-meaningful-text', engine: 'tesseract',
    }) + '\n<<<PXOCR_JSON_END>>>';
    const state = { runs: 0, timeout: null };
    const retryCtx = {
      onStep: (m) => steps.push(String(m)),
      fsx: {
        async uploadBuffer() {},
        async sh(command, options) {
          if (/--mode/.test(command)) { state.runs++; state.timeout = options && options.timeout; }
          return { exitCode: 0 };
        },
        async readText(rel) { return String(rel).endsWith('.result') ? noText : ''; },
      },
    };
    const ex = await ocr.extract(retryCtx, buildPng(), 'telegram-image.png', {});
    assert.strictEqual(ex.ok, false);
    assert.strictEqual(state.runs, 1, 'valid no-text result must not be retried');
    assert.strictEqual(state.timeout, 45, 'sandbox OCR command must be time-bounded');
    assert.ok(!steps.some((m) => /sandbox OCR attempt|sandbox OCR exhausted|no-meaningful-text/.test(m)), steps.join('\n'));
  });

  await test('empty buffer → ok:false (no throw)', async () => {
    const ex = await ocr.extract(ctx, Buffer.alloc(0), 'x.pdf', {});
    assert.strictEqual(ex.ok, false);
  });

  await test('garbage pdf → ok:false (no throw)', async () => {
    const ex = await ocr.extract(ctx, Buffer.from('not a real pdf'), 'bad.pdf', {});
    assert.strictEqual(ex.ok, false);
  });

  await test('warmup() → ok:true no-op', async () => {
    const w = await ocr.warmup(ctx);
    assert.ok(w.ok);
  });

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
