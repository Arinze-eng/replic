#!/usr/bin/env node
'use strict';

const assert = require('assert');
const attachmentText = require('../services/attachmentText');

(async () => {
  const files = [
    { name: 'first.txt', buffer: Buffer.from('FIRST ATTACHMENT MARKER 1001') },
    { name: 'second.md', buffer: Buffer.from('SECOND ATTACHMENT MARKER 2002') },
  ];
  const steps = [];
  const out = await attachmentText.extractAttachments(files, {
    perFileMs: 10000, concurrency: 2, onStep: s => steps.push(String(s)),
  });
  assert.strictEqual(out.extractedCount, 2);
  assert(out.context.includes('FIRST ATTACHMENT MARKER 1001'));
  assert(out.context.includes('SECOND ATTACHMENT MARKER 2002'));
  assert(out.context.indexOf('first.txt') < out.context.indexOf('second.md'), 'source order changed');
  assert(steps.some(s => /Extracted readable text from 2\/2/.test(s)));

  const timed = await attachmentText._internals.bounded(new Promise(() => {}), 20);
  assert.strictEqual(timed.ok, false);
  assert.match(timed.reason, /pre-ingestion-timeout/);

  const packed = attachmentText._internals.packBlocks([
    'A'.repeat(10000), 'B'.repeat(10000),
  ], 12000);
  assert(packed.includes('TEXT TRUNCATED'));
  assert(packed.includes('A') && packed.includes('B'));

  console.log('✅ attachment pre-ingestion: ordered text injected with hard timeout and fair packing');
})().catch(e => { console.error(e); process.exit(1); });
