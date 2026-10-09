#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const XLSX = require('xlsx');
const ocr = require('../services/simpleOcr');

const providerName = String(process.env.LIVE_OCR_PROVIDER || process.argv[2] || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  upstash: require('../services/upstashBox'), upstashbox: require('../services/upstashBox'),
  runloop: require('../services/runloop'), daytona: require('../services/daytona'),
};
const mod = providers[providerName];
if (!mod) throw new Error('LIVE_OCR_PROVIDER must be novita, upstash, runloop, or daytona');

function fsxFor(id) {
  const root = mod.WORKDIR;
  const abs = rel => `${root}/${String(rel).replace(/^\/+/, '')}`;
  return {
    kind: 'sandbox', backend: providerName, sandboxId: id, workdir: root,
    async sh(command) { return mod.exec(id, command, { cwd: root, timeout: 1200 }); },
    async uploadBuffer(rel, buf) { return mod.uploadFile(id, abs(rel), buf, path.posix.basename(rel)); },
    async readText(rel) { return (await mod.downloadFile(id, abs(rel))).toString('utf8'); },
  };
}

async function pageImage(index) {
  const marker = `SCANNED_PDF_PAGE_${index}_MARKER`;
  const svg = `<svg width="1800" height="2400" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="70"><text x="100" y="180">${marker}</text><text x="100" y="340">INVOICE ${1000 + index} TOTAL ${index * 125} DOLLARS</text><text x="100" y="500">QUESTION ${index}: CALCULATE ${index} PLUS ${index + 9}</text></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function scannedPdf() {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  for (let i = 1; i <= 3; i++) {
    const image = await pageImage(i);
    doc.addPage({ size: [612, 792] });
    doc.image(image, 0, 0, { width: 612, height: 792 });
  }
  doc.end();
  return done;
}

async function docxFixture() {
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun('DOCX_PROVIDER_MARKER_7788')] }),
    new Paragraph({ children: [new TextRun('Enterprise document extraction remains complete.')] }),
  ] }] });
  return Packer.toBuffer(doc);
}

function xlsxFixture() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Marker', 'Value'], ['XLSX_PROVIDER_MARKER_9911', 42], ['Complete', true],
  ]), 'Audit');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

(async () => {
  const keyTest = await mod.testKey();
  assert(keyTest && keyTest.ok, keyTest && keyTest.message || `${providerName} key test failed`);
  const existingId = String(process.env.LIVE_OCR_SANDBOX_ID || '').trim();
  const id = existingId || await mod.createSandbox({ labels: { session: `ocr-doc-live-${Date.now()}` } });
  if (existingId && mod.startSandbox) assert(await mod.startSandbox(id), `could not resume ${providerName} sandbox`);
  try {
    const ctx = { fsx: fsxFor(id), onStep: m => console.log('  ·', m) };
    const warm = await ocr.warmup(ctx);
    assert(warm.ok, warm.reason || 'OCR warmup failed');

    const pdf = await ocr.extract(ctx, await scannedPdf(), 'scanned-batch.pdf', { pages: 10 });
    assert(pdf.ok, pdf.reason || 'scanned PDF extraction failed');
    assert.strictEqual(pdf.meta.processed_pages, 3);
    assert.strictEqual(pdf.meta.extracted_pages, 3);
    assert.strictEqual(pdf.meta.complete, true);
    const normalizedPdf = pdf.text.toUpperCase().replace(/[^A-Z0-9]+/g, '');
    for (let i = 1; i <= 3; i++) assert(normalizedPdf.includes(`SCANNEDPDFPAGE${i}MARKER`), `missing scanned PDF page ${i}: ${JSON.stringify(pdf.text.slice(0, 500))}`);
    console.log(`✅ ${providerName}: scanned PDF retained 3/3 OCR pages`);

    const docx = await ocr.extract(ctx, await docxFixture(), 'enterprise.docx');
    assert(docx.ok && docx.text.toUpperCase().replace(/[^A-Z0-9]+/g, '').includes('DOCXPROVIDERMARKER7788'), docx.reason || 'DOCX marker missing');
    console.log(`✅ ${providerName}: DOCX extraction passed`);

    const xlsx = await ocr.extract(ctx, xlsxFixture(), 'enterprise.xlsx');
    assert(xlsx.ok && xlsx.text.toUpperCase().replace(/[^A-Z0-9]+/g, '').includes('XLSXPROVIDERMARKER9911') && xlsx.text.includes('Audit'), xlsx.reason || 'XLSX marker missing');
    console.log(`✅ ${providerName}: XLSX extraction passed`);
  } finally {
    try {
      if (existingId && mod.pauseSandbox) await mod.pauseSandbox(id);
      else if (!existingId) await mod.deleteSandbox(id);
    } catch (_) {}
  }
})().catch(error => { console.error('❌', error.stack || error); process.exit(1); });
