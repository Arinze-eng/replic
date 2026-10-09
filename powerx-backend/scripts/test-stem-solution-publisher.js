'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stem = require('../services/stemSolutionPublisher');

(async () => {
  // Classification: educational STEM is included; ordinary conversation,
  // software deployments, and secrets are never auto-published.
  assert.equal(stem.classifyTask('Solve 2x + 7 = 19 step by step').publish, true);
  assert.equal(stem.classifyTask('A 5 kg block accelerates at 3 m/s^2. Find the force.').publish, true);
  assert.equal(stem.classifyTask('Calculate the molarity of 2 moles in 500 mL').publish, true);
  assert.equal(stem.classifyTask('Fix my Node.js repository and deploy it').publish, false);
  assert.equal(stem.classifyTask('What is the weather?').publish, false);
  assert.equal(stem.classifyTask('Solve x=2 using api_key=sk_super_secret_value_123456').publish, false);

  const md = [
    '# Solution',
    'Use **Newton’s second law**: \\(F=ma\\).',
    '',
    '| Quantity | Value |',
    '|---|---|',
    '| Mass | 5 kg |',
    '| Acceleration | 3 m/s² |',
    '',
    '```mermaid',
    'flowchart LR',
    'A[Given] --> B[Substitute] --> C[Answer]',
    '```',
  ].join('\n');
  const rendered = stem.markdownToHtml(md);
  assert.match(rendered, /<table>/);
  assert.match(rendered, /class="mermaid"/);
  assert.match(rendered, /\\\(F=ma\\\)/);

  const html = stem.buildSolutionHtml({
    title: 'Force calculation', task: 'Find force', answer: md, pdfName: 'solution.pdf',
  });
  assert.match(html, /MathJax/);
  assert.match(html, /mermaid\.min\.js/);
  assert.match(html, /chart\.umd\.min\.js/);
  assert.match(html, /overflow-x:auto/);
  assert.match(html, /<iframe[^>]+solution\.pdf/);

  // End-to-end post-processing with deterministic injected PDF/deploy adapters.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stem-publisher-test-'));
  const fakePdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1800, 65)]);
  let deployedFiles = null;
  const result = await stem.postProcessResult({
    task: 'A 5 kg block accelerates at 3 m/s^2. Calculate force and show every step.',
    sessionKey: 'tg:test-user', onStep: () => {},
  }, {
    message: '## Given\n$m=5\\,kg$, $a=3\\,m/s^2$\n\n## Calculation\n$F=ma=5\\times3=15\\,N$\n\n**Answer: 15 N**',
    files: [], workdir: dir, brain: 'test',
  }, {
    htmlToPdf: async (page) => { assert.match(page, /15\\,N/); return fakePdf; },
    deploy: async ({ userKey, files }) => {
      assert.equal(userKey, 'tg:test-user');
      deployedFiles = files;
      return { url: 'https://site-test.pages.dev', projectUrl: 'https://site-test.pages.dev' };
    },
  });

  assert.equal(result.solutionUrl, 'https://site-test.pages.dev');
  assert.match(result.message, /https:\/\/site-test\.pages\.dev/);
  assert.ok(result.files.some(f => /\.pdf$/i.test(f.name)));
  assert.ok(deployedFiles.some(f => f.rel === 'index.html'));
  assert.ok(deployedFiles.some(f => /\.pdf$/i.test(f.rel)));
  const deployedHtml = deployedFiles.find(f => f.rel === 'index.html').buffer.toString();
  assert.match(deployedHtml, /Step-by-step reasoning/);
  assert.match(deployedHtml, /Download PDF/);

  // Idempotence prevents duplicate deploys when Capy wrapper + engine wrapper
  // both observe the same already-published result.
  let duplicateCalls = 0;
  const twice = await stem.postProcessResult({ task: 'Solve x+1=2' }, result, {
    deploy: async () => { duplicateCalls++; return { url: 'bad' }; },
  });
  assert.equal(duplicateCalls, 0);
  assert.equal(twice.solutionUrl, result.solutionUrl);

  // A stopped task and a sensitive answer must not publish.
  let blockedCalls = 0;
  const blocked = async (task, message, extra = {}) => stem.postProcessResult({ task }, { message, files: [], ...extra }, {
    deploy: async () => { blockedCalls++; return { url: 'bad' }; },
    htmlToPdf: async () => fakePdf,
  });
  await blocked('Solve x+1=2', '🛑 Stopped.', { stopped: true });
  await blocked('Solve x+1=2', 'password=do_not_publish_123456');
  assert.equal(blockedCalls, 0);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✅ STEM solution publisher tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
