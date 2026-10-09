#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph } = require('docx');
const XLSX = require('xlsx');
const ocr = require('../services/simpleOcr');
const agent = require('../services/agentEngine');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✅', name); }
  catch (e) { console.error('  ❌', name, '-', e.message); throw e; }
}
function python(file, name) {
  const out = execFileSync('python3', ['python/ocr_extract.py', '--file', file, '--mode', 'extract'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const a = out.indexOf('<<<PXOCR_JSON_BEGIN>>>');
  const b = out.indexOf('<<<PXOCR_JSON_END>>>');
  assert(a >= 0 && b > a, `${name}: missing engine result`);
  return JSON.parse(out.slice(a + '<<<PXOCR_JSON_BEGIN>>>'.length, b).trim());
}
function pdfBuffer(pages = 3) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    for (let i = 1; i <= pages; i++) { doc.addPage(); doc.fontSize(18).text(`Question ${i}: deterministic page marker PX-${i}`, 70, 90); }
    doc.end();
  });
}
(async () => {
  console.log('\n=== Deterministic ingestion regression ===\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'px-ingest-'));
  try {
    await test('PDF preserves every page boundary and completeness metadata', async () => {
      const file = path.join(tmp, 'exam.pdf'); fs.writeFileSync(file, await pdfBuffer(4));
      const r = python(file, 'pdf');
      assert(r.ok && r.pages === 4 && r.meta.processed_pages === 4 && r.meta.extracted_pages === 4 && r.meta.complete === true);
      for (let i = 1; i <= 4; i++) { assert(r.text.includes(`PAGE ${i}/4`)); assert(r.text.includes(`PX-${i}`)); }
    });

    await test('DOCX extracts paragraphs without an AI model', async () => {
      const file = path.join(tmp, 'lesson.docx');
      fs.writeFileSync(file, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Class note deterministic DOCX marker')] }] })));
      const r = python(file, 'docx'); assert(r.ok && /deterministic DOCX marker/.test(r.text) && /^docx/.test(r.engine));
    });

    await test('XLSX extracts every worksheet', async () => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Question', 'Answer'], [1, 'Alpha']]), 'One');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Question', 'Answer'], [2, 'Beta']]), 'Two');
      const file = path.join(tmp, 'book.xlsx'); fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
      const r = python(file, 'xlsx'); assert(r.ok && r.meta.sheets === 2 && /Sheet: One/.test(r.text) && /Sheet: Two/.test(r.text));
    });

    await test('PPTX OOXML extraction preserves all slide markers', async () => {
      const zip = new AdmZip();
      for (let i = 1; i <= 3; i++) zip.addFile(`ppt/slides/slide${i}.xml`, Buffer.from(`<p:sld xmlns:p="p" xmlns:a="a"><a:t>Slide marker ${i}</a:t></p:sld>`));
      const file = path.join(tmp, 'deck.pptx'); zip.writeZip(file);
      const r = python(file, 'pptx'); assert(r.ok && r.meta.items === 3 && r.meta.complete === true);
      for (let i = 1; i <= 3; i++) assert(r.text.includes(`SLIDE ${i}/3`) && r.text.includes(`Slide marker ${i}`));
    });

    await test('ZIP inventory reports entries and expanded size', async () => {
      const zip = new AdmZip(); zip.addFile('docs/a.txt', Buffer.from('a')); zip.addFile('docs/b.txt', Buffer.from('bb'));
      const file = path.join(tmp, 'files.zip'); zip.writeZip(file);
      const r = python(file, 'zip'); assert(r.ok && r.meta.entries === 2 && r.meta.expanded_bytes === 3 && /docs\/a.txt/.test(r.text));
    });

    await test('archive guard blocks zip-slip and expansion limits', async () => {
      const safe = new AdmZip(); safe.addFile('folder/a.txt', Buffer.from('safe'));
      assert.strictEqual(agent._internals._safeZipEntries(safe.toBuffer()).length, 1);
      const bomb = new AdmZip(); bomb.addFile('large.txt', Buffer.alloc(2048, 65));
      const old = process.env.ARCHIVE_MAX_EXPANDED_BYTES; process.env.ARCHIVE_MAX_EXPANDED_BYTES = '1024';
      try { assert.throws(() => agent._internals._safeZipEntries(bomb.toBuffer()), /expands beyond/); }
      finally { if (old == null) delete process.env.ARCHIVE_MAX_EXPANDED_BYTES; else process.env.ARCHIVE_MAX_EXPANDED_BYTES = old; }
    });

    await test('sandbox result transport does not truncate large extraction', async () => {
      const huge = Array.from({ length: 9 }, (_, i) => `=== PAGE ${i + 1}/9 ===\n` + `QUESTION_${i + 1} `.repeat(2500)).join('\n');
      const payload = { ok: true, type: 'image', text: huge, has_text: true, word_count: 22500, confidence: 98, engine: 'mock-tesseract', meta: { complete: true } };
      const files = new Map();
      const ctx = { fsx: {
        async uploadBuffer(rel, buf) { files.set(rel, Buffer.from(buf)); },
        async readText(rel) { return files.get(rel).toString('utf8'); },
        async sh(cmd) {
          const m = cmd.match(/> '([^']+\.result)'/); if (m) files.set(m[1], Buffer.from(`<<<PXOCR_JSON_BEGIN>>>\n${JSON.stringify(payload)}\n<<<PXOCR_JSON_END>>>`));
          return { output: 'PXOCR_DONE'.slice(0, 12) };
        },
      }, onStep() {} };
      const r = await ocr.extract(ctx, Buffer.from('image'), 'exam.png');
      assert(r.ok && r.text.length === huge.trim().length && r.text.includes('QUESTION_9'));
    });

    await test('nine deterministic files retain source order', async () => {
      const files = Array.from({ length: 9 }, (_, i) => ({ name: `page-${i + 1}.txt`, buffer: Buffer.from(`QUESTION ${i + 1}`) }));
      const blocks = await Promise.all(files.map(f => ocr.extract({}, f.buffer, f.name)));
      assert.strictEqual(blocks.length, 9);
      blocks.forEach((r, i) => assert(r.ok && r.text === `QUESTION ${i + 1}`));
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`\n=== ${passed} deterministic ingestion tests passed ===\n`);
})().catch(e => { console.error(e.stack || e); process.exit(1); });
