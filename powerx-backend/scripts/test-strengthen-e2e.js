'use strict';
// Heavy, no-mercy unit/e2e test for the strengthening work:
//   1. heavyTask classification (heavy vs light, coding vs not)
//   2. heavyTask.finishGuard (explore → implement → self-test enforcement)
//   3. qualityGate coding path (read-before-edit + verify)
//   4. simpleOcr document extraction (PDF/DOCX/XLSX) end-to-end
//   5. agentGraph builds & the cross-image synthesis helper is wired
//
// No external API keys required — pure logic + local file extraction.

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ✅', name); })
    .catch((e) => { fail++; console.log('  ❌', name, '\n     →', e.message); });
}

async function main() {
  console.log('\n=== 1. heavyTask.classify ===');
  const heavy = require('../services/heavyTask');

  await t('heavy: full-repo refactor is heavy+coding', () => {
    const r = heavy.classify('Refactor the entire codebase and fix all the bugs across multiple files');
    assert(r.heavy && r.coding, JSON.stringify(r));
  });
  await t('heavy: multi-goal coding build is heavy', () => {
    const r = heavy.classify('1. strengthen the ocr engine\n2. super strengthen the coding abilities to fix bugs, read code, edit code and build a system');
    assert(r.heavy && r.coding, JSON.stringify(r));
  });
  await t('light: trivial question is NOT heavy', () => {
    const r = heavy.classify('what is the capital of France?');
    assert(!r.heavy, JSON.stringify(r));
  });
  await t('light: one-line typo fix is NOT heavy', () => {
    const r = heavy.classify('fix a typo in the README, single line rename');
    assert(!r.heavy, JSON.stringify(r));
  });
  await t('non-coding heavy stays non-coding', () => {
    const r = heavy.classify('write a very long 20-page essay about the history of the Roman empire covering every emperor in full detail with citations and analysis of each period');
    assert(!r.coding, JSON.stringify(r));
  });

  console.log('\n=== 2. heavyTask.finishGuard ===');
  const info = heavy.classify('debug and fix the crash bug in the payment service across multiple files');
  await t('blocks finish when nothing explored', () => {
    const c = heavy.finishGuard(info, [], 0);
    assert(c && /explore/i.test(c), c);
  });
  await t('blocks finish when explored but not implemented', () => {
    const c = heavy.finishGuard(info, [{ tool: 'grep', result: 'found' }, { tool: 'read', result: 'code' }], 0);
    assert(c && /no implemented change/i.test(c), c);
  });
  await t('blocks finish when implemented but not tested', () => {
    const c = heavy.finishGuard(info, [{ tool: 'read', result: 'x' }, { tool: 'edit', result: '[edit] Replaced' }], 0);
    assert(c && /no evidence it runs/i.test(c), c);
  });
  await t('allows finish when explored + implemented + tested OK', () => {
    const c = heavy.finishGuard(info, [
      { tool: 'grep', result: 'match' },
      { tool: 'edit', result: '[edit] Replaced 1' },
      { tool: 'run_code', result: 'All tests passed exit 0' },
    ], 0);
    assert(c === null, 'expected null, got: ' + c);
  });
  await t('does not stall forever (budget respected)', () => {
    const c = heavy.finishGuard(info, [], 2);
    assert(c === null, 'expected null after budget, got: ' + c);
  });
  await t('ignores light tasks entirely', () => {
    const c = heavy.finishGuard(heavy.classify('what time is it'), [], 0);
    assert(c === null, c);
  });

  console.log('\n=== 3. qualityGate coding path ===');
  const gate = require('../services/qualityGate');
  await t('coding: no mutation → blocked', () => {
    const c = gate.evaluate('fix the bug in server.js', [{ tool: 'read', result: 'x' }], 'done');
    assert(c && /no code\/file modification/i.test(c), c);
  });
  await t('coding: edit without reading → blocked (read-first)', () => {
    const c = gate.evaluate('fix the bug in server.js', [{ tool: 'edit', result: '[edit] Replaced 1' }], 'done');
    assert(c && /reading\/exploring it first/i.test(c), c);
  });
  await t('coding: read+edit but not verified → blocked', () => {
    const c = gate.evaluate('fix the bug in server.js', [{ tool: 'read', result: 'x' }, { tool: 'edit', result: '[edit] Replaced 1' }], 'done');
    assert(c && /post-change test/i.test(c), c);
  });
  await t('coding: read+edit+run OK → passes', () => {
    const c = gate.evaluate('fix the bug in server.js', [
      { tool: 'read', result: 'x' },
      { tool: 'edit', result: '[edit] Replaced 1' },
      { tool: 'run_code', args: { command: 'npm test' }, result: '12 tests passed, exit 0' },
    ], 'done');
    assert(c === null, 'expected null, got: ' + c);
  });

  console.log('\n=== 4. simpleOcr document extraction (real files) ===');
  const ocr = require('../services/simpleOcr');
  // Build a real XLSX in-memory and extract it back.
  await t('XLSX round-trip extraction', async () => {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Score'], ['Ada', 99], ['Linus', 100]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = await ocr.extract({}, buf, 'results.xlsx');
    assert(r.ok && /Linus/.test(r.text) && /100/.test(r.text), JSON.stringify(r).slice(0, 200));
  });
  // Build a real PDF with pdfkit and extract the text layer.
  await t('PDF round-trip extraction', async () => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((res) => doc.on('end', res));
    doc.fontSize(20).text('POWERX OCR TEST 42', 100, 100);
    doc.end();
    await done;
    const buf = Buffer.concat(chunks);
    const r = await ocr.extract({}, buf, 'test.pdf');
    assert(r.ok && /POWERX OCR TEST 42/.test(r.text), 'PDF text not extracted: ' + JSON.stringify(r).slice(0, 200));
  });
  await t('image attempts deterministic OCR before vision fallback', async () => {
    const r = await ocr.extract({}, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'photo.png');
    assert(!r.ok && r.ocrAttempted === true && r.reason, JSON.stringify(r));
  });
  await t('classifyImage reports deterministic OCR unavailability explicitly', async () => {
    const r = await ocr.classifyImage({}, Buffer.from([0xff, 0xd8]), 'x.jpg');
    assert(!r.ok && r.hasText === false && r.reason, JSON.stringify(r));
  });

  console.log('\n=== 5. agentGraph wiring ===');
  await t('agentGraph builds a compiled graph', () => {
    const g = require('../services/agentGraph');
    const compiled = g.buildAgentGraph({
      brain: async () => '{"action":"finish","args":{"message":"ok"}}',
      systemPrompt: 'x',
      parseAction: () => ({ action: 'finish', args: { message: 'ok' } }),
      executeTool: async () => 'obs',
      ctx: { step: 0 },
      onStep: () => {},
      taskText: 'refactor the whole repo and fix bugs',
    });
    assert(compiled && typeof compiled.invoke === 'function', 'graph not compiled');
  });
  await t('agentEngine module loads (all tools wired)', () => {
    const eng = require('../services/agentEngine');
    assert(eng && eng._internals && typeof eng._internals.toolAnalyzeImage === 'function', 'toolAnalyzeImage not exported under _internals');
  });

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
