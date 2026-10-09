#!/usr/bin/env node
'use strict';
const assert = require('assert');
const c = require('../services/extractionCompleteness');

const pages = Array.from({ length: 10 }, (_, i) => ({
  name: `exam-page-${i + 1}.png`,
  text: `Question ${i + 1}. Calculate ${i + 2}x + ${i + 3} = ${i + 4}.\n(a) Show every step.\n(b) Verify the answer.`,
  engine: 'mock-tesseract', confidence: 92,
}));

const ordered = c.orderImages(pages);
assert.deepStrictEqual(ordered.map(x => x.name), pages.map(x => x.name), 'upload order must be preserved');
const out = c.renderPageReport(ordered);
assert.strictEqual(out.manifest.expectedPages, 10);
assert.strictEqual(out.manifest.representedPages, 10);
assert.strictEqual(out.manifest.missingPages.length, 0);
assert.strictEqual(out.manifest.weakPages.length, 0);
assert.strictEqual(out.manifest.complete, true);
for (let i = 1; i <= 10; i++) {
  assert(out.report.includes(`SOURCE IMAGE ${i}/10`), `missing source boundary ${i}`);
  assert(out.report.includes(`Question ${i}.`), `missing question ${i}`);
}
assert(out.manifest.mathPages.length === 10, 'all calculation pages must be classified as math');

const weak = c.buildManifest([...pages.slice(0, 9), { name: 'exam-page-10.png', text: '??', confidence: 12 }]);
assert.strictEqual(weak.complete, false);
assert.deepStrictEqual(weak.weakPages, [10]);
assert(c.completenessInstruction(weak).includes('weak_pages=10'));

const missing = c.buildManifest([...pages.slice(0, 4), { name: 'exam-page-5.png', text: '' }, ...pages.slice(5)]);
assert.deepStrictEqual(missing.missingPages, [5]);
assert.strictEqual(missing.complete, false);

console.log('✅ multi-image completeness: 10/10 pages retained, weak/missing pages detected');
