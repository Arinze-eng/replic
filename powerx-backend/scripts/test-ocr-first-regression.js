#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const ocr = require('../services/simpleOcr');
const agent = require('../services/agentEngine');

async function makeImage(file, text) {
  const lines = String(text).split('\n');
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg width="1800" height="900" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="54">${lines.map((line, i) => `<text x="70" y="${100 + i * 90}">${escape(line)}</text>`).join('')}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
function makePdf(file, pages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    pages.forEach((text, i) => { doc.addPage(); doc.fontSize(20).text(`PAGE_${i + 1} ${text}`, 70, 100); });
    doc.end(); out.on('finish', resolve); out.on('error', reject);
  });
}
function brokenFsx() {
  return {
    async uploadBuffer() { throw new Error('simulated sandbox outage'); },
    async readText() { throw new Error('not reached'); },
    async sh() { throw new Error('simulated sandbox outage'); },
  };
}
function staleWorkspaceFsx() {
  const state = { uploads: 0, runs: 0 };
  return {
    state,
    __pxocrStaged: true, // engine existed in the previous task, then was cleared
    async uploadBuffer(rel) { if (/ocr_extract\.py$/.test(rel)) state.uploads++; },
    async readText() { throw new Error('result file missing after workspace reset'); },
    async sh(command) { if (/--mode/.test(command)) state.runs++; return 'PXOCR_DONE'; },
  };
}
function concurrencySensitiveFsx() {
  const state = { active: 0, maxActive: 0, runs: 0 };
  const payload = '\n<<<PXOCR_JSON_BEGIN>>>\n' + JSON.stringify({
    ok: true, type: 'image', text: 'SERIALIZED SANDBOX OCR', has_text: true,
    word_count: 3, confidence: 99, engine: 'mock-tesseract', meta: {}, reason: '',
  }) + '\n<<<PXOCR_JSON_END>>>\n';
  return {
    state,
    async uploadBuffer() {},
    async readText(rel) { if (/\.result$/.test(rel)) return payload; return ''; },
    async sh(command) {
      if (/--mode/.test(command)) {
        state.runs++;
        state.active++;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise(resolve => setTimeout(resolve, 20));
        state.active--;
      }
      return { exitCode: 0, output: 'PXOCR_DONE' };
    },
  };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'px-ocr-first-'));
  try {
    const imageTexts = [
      'ALPHA DOCUMENT PAGE ONE\nInvoice number 1001\nTotal amount 245 dollars',
      'BETA DOCUMENT PAGE TWO\nQuestion 2 calculate 18 plus 24\nAnswer field',
      'GAMMA DOCUMENT PAGE THREE\nCustomer reference ZX 9007\nFinal statement',
    ];
    const images = [];
    for (let i = 0; i < imageTexts.length; i++) {
      const file = path.join(tmp, `page-${i + 1}.png`);
      await makeImage(file, imageTexts[i]);
      images.push(file);
    }

    // Sandbox failure must fall back to the real local OCR engine, not an LLM.
    for (let i = 0; i < images.length; i++) {
      const result = await ocr.extract({ fsx: brokenFsx(), onStep() {} }, fs.readFileSync(images[i]), path.basename(images[i]));
      assert(result.ok, `image ${i + 1} OCR failed: ${result.reason}`);
      assert(/tesseract/i.test(result.engine), `image ${i + 1} did not use Tesseract: ${result.engine}`);
      assert(result.text.includes(['ALPHA', 'BETA', 'GAMMA'][i]), `image ${i + 1} marker missing`);
    }
    console.log('PASS multi-image OCR: 3/3 retained via Tesseract after sandbox failure');

    // A long-lived sandbox object may retain __pxocrStaged after task cleanup
    // deleted the actual engine file. Sandbox OCR must retry and restage before
    // deterministic host OCR rescues the request.
    const stale = staleWorkspaceFsx();
    const staleSteps = [];
    const staleResult = await ocr.extract({ fsx: stale, onStep(step) { staleSteps.push(step); } }, fs.readFileSync(images[0]), 'image.jpg');
    assert(staleResult.ok && staleResult.text.includes('ALPHA'), staleResult.reason || 'stale workspace OCR failed');
    assert(stale.state.runs >= 3, `expected sandbox retries, got ${stale.state.runs}`);
    assert(stale.state.uploads >= 2, `expected forced engine restaging, got ${stale.state.uploads}`);
    assert.strictEqual(staleResult.meta.via, 'host-ocr');
    assert(!staleSteps.some(s => /sandbox OCR attempt|sandbox OCR exhausted|no-meaningful-text/.test(s)),
      'internal retry diagnostics leaked into user-facing progress');
    console.log('PASS stale sandbox workspace: retried/restaged quietly before host OCR recovery');

    // Multi-image calls sharing one provider must not run package bootstrap or
    // command channels concurrently. Different provider sandboxes still run in
    // parallel because the lock is scoped to the fsx object.
    const serialized = concurrencySensitiveFsx();
    const batchResults = await Promise.all(Array.from({ length: 9 }, (_, i) =>
      ocr.extract({ fsx: serialized, onStep() {} }, fs.readFileSync(images[i % images.length]), `batch-${i + 1}.png`)));
    assert(batchResults.every(r => r.ok && r.meta.via === 'sandbox-ocr'));
    assert.strictEqual(serialized.state.runs, 9);
    assert.strictEqual(serialized.state.maxActive, 1, `sandbox OCR overlapped ${serialized.state.maxActive} commands`);
    console.log('PASS multi-image sandbox queue: 9/9 serialized with no provider command overlap');

    const pdf = path.join(tmp, 'batch.pdf');
    await makePdf(pdf, ['PDF FIRST MARKER', 'PDF SECOND MARKER', 'PDF THIRD MARKER']);
    const pdfResult = await ocr.extract({ fsx: brokenFsx(), onStep() {} }, fs.readFileSync(pdf), 'batch.pdf');
    assert(pdfResult.ok, pdfResult.reason);
    assert.strictEqual(pdfResult.meta.processed_pages, 3);
    assert.strictEqual(pdfResult.meta.extracted_pages, 3);
    for (let i = 1; i <= 3; i++) assert(pdfResult.text.includes(`PAGE ${i}/3`));
    assert(pdfResult.text.includes('PDF FIRST MARKER') && pdfResult.text.includes('PDF THIRD MARKER'));
    console.log('PASS multi-page PDF OCR/text extraction: 3/3 pages retained');

    // Empty current-task registration is authoritative; bridge recovery must not
    // rediscover files from a previous task in a persistent sandbox.
    agent.registerSandboxAttachments('isolation-test', [{ name: 'old.png', buffer: fs.readFileSync(images[0]), isImage: true }]);
    assert.strictEqual(agent.getSandboxAttachments('isolation-test').length, 1);
    agent.registerSandboxAttachments('isolation-test', []);
    assert.deepStrictEqual(agent.getSandboxAttachments('isolation-test'), []);
    console.log('PASS current-task attachment registry clears previous files');

    // Generated PDF bytes must be valid and non-empty; exercise the exact worker
    // delivery allow-list through its existing Python regression separately.
    const pdfBytes = fs.readFileSync(pdf);
    assert(pdfBytes.length > 1000 && pdfBytes.subarray(0, 4).toString() === '%PDF');
    console.log('PASS PDF fixture is valid and deliverable');

    console.log('ALL OCR-FIRST REGRESSION TESTS PASSED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
