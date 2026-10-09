'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

(async () => {
  const source = await sharp({ create: { width: 320, height: 240, channels: 4, background: '#2563eb' } }).png().toBuffer();
  const edited = await sharp(source).composite([{ input: Buffer.from('<svg width="320" height="240"><circle cx="160" cy="120" r="55" fill="#facc15"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
  let submitted = false, submissionAttempts = 0, polls = 0, pollFailures = 0, downloadAttempts = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v2/models')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: [{ name: 'FLUX.2 Klein 4B BF16', slug: 'Flux_2_Klein_4B_BF16', inference_types: ['txt2img', 'img2img'] }] }));
    }
    if (req.url === '/api/v2/images/edits' && req.method === 'POST') {
      let body = Buffer.alloc(0);
      req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
      return req.on('end', () => {
        const text = body.toString('latin1');
        assert.match(text, /Flux_2_Klein_4B_BF16/);
        assert.match(text, /Content-Disposition: form-data; name="prompt"/i);
        assert.match(text, /filename="source.png"/);
        submitted = true;
        submissionAttempts++;
        res.setHeader('content-type', 'application/json');
        if (submissionAttempts === 1) {
          res.statusCode = 503;
          return res.end(JSON.stringify({ message: 'temporary provider overload' }));
        }
        res.end(JSON.stringify({ data: { request_id: 'job-123' } }));
      });
    }
    if (req.url === '/api/v2/jobs/job-123') {
      res.setHeader('content-type', 'application/json');
      if (pollFailures++ === 0) {
        res.statusCode = 502;
        return res.end(JSON.stringify({ message: 'temporary poll failure' }));
      }
      polls++;
      return res.end(JSON.stringify({ data: polls > 1 ? { status: 'done', progress: 100, result_url: `http://127.0.0.1:${server.address().port}/result.png` } : { status: 'processing', progress: 50 } }));
    }
    if (req.url === '/result.png') {
      downloadAttempts++;
      if (downloadAttempts === 1) { res.statusCode = 503; return res.end('temporary download failure'); }
      res.setHeader('content-type', 'image/png');
      return res.end(edited);
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.DEAPI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.DEAPI_API_KEY = 'test-key';
  try {
    const deapi = require('../services/deapi');
    const keyTest = await deapi.testKey();
    assert.strictEqual(keyTest.ok, true, keyTest.message);
    const result = await deapi.editImage(source, 'add a yellow circle', { timeoutMs: 30000 });
    assert(submitted, 'multipart edit request was not submitted');
    assert.strictEqual(submissionAttempts, 2, 'transient submission failure was not retried');
    assert.strictEqual(pollFailures, 3, 'transient polling failure did not recover');
    assert.strictEqual(downloadAttempts, 2, 'transient result download failure was not retried');
    assert.strictEqual(result.model, 'Flux_2_Klein_4B_BF16');
    assert.strictEqual(result.mime, 'image/png');
    assert(result.buffer.length > 500);
    const diff = await sharp(source).composite([{ input: result.buffer, blend: 'difference' }]).stats();
    assert(diff.channels.some(channel => channel.mean > 1), 'edited pixels did not change');

    // End-to-end tool routing: free-form prompt must invoke generative editing,
    // persist the result, and queue it for delivery. Deterministic operations are
    // covered separately by test-precise-image-edit.js.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deapi-tool-'));
    try {
      const input = path.join(root, 'input.png'); fs.writeFileSync(input, source);
      const delivered = [];
      const abs = rel => path.join(root, rel);
      const ctx = {
        attachments: [{ name: 'input.png', isImage: true, mime: 'image/png', buffer: source }],
        fsx: {
          exists: async rel => fs.existsSync(abs(rel)), list: async () => [{ rel: 'input.png', mtime: Date.now() }],
          uploadBuffer: async (rel, data) => fs.writeFileSync(abs(rel), data), downloadBuffer: async rel => fs.readFileSync(abs(rel)),
          writeText: async (rel, text) => fs.writeFileSync(abs(rel), text), sh: async () => ({ exitCode: 0, output: '' }),
        },
        addFile: (rel, name) => delivered.push({ rel, name }), onStep: () => {},
      };
      const precise = require('../services/preciseImageEdit');
      const promptCases = [
        'add a yellow circle',
        'remove the background',
        'resize this image to 512x512',
        'change the text OLD to NEW',
        'crop this image to 200x200',
      ];
      for (const prompt of promptCases) {
        submitted = false;
        const before = delivered.length;
        const message = await precise.toolEditImage({ prompt, output: `edited-${before}.png` }, ctx);
        assert.match(message, /Generative image edit complete/, `prompt bypassed deAPI: ${prompt}`);
        assert.strictEqual(submitted, true, `deAPI was not submitted for: ${prompt}`);
        assert.strictEqual(delivered.length, before + 1);
        assert(fs.existsSync(abs(delivered.at(-1).rel)));
      }
      assert.deepStrictEqual(precise.normalizeOperations({ prompt: 'remove the background' }), [], 'prompt must not become sandbox operations before API execution');
      assert.deepStrictEqual(precise.normalizeOperations({ operations: [{ type: 'grayscale' }] }), [{ type: 'grayscale' }], 'explicit operations must remain supported');

      // When every API attempt fails, only an exactly expressible operation may
      // use the deterministic fallback. The stub proves retries happened first.
      const deapiModule = require('../services/deapi');
      const originalEditImage = deapiModule.editImage;
      let exhaustedCalls = 0;
      let shellCalled = false;
      deapiModule.editImage = async () => { exhaustedCalls++; const error = new Error('temporary provider outage'); error.retryable = true; throw error; };
      ctx.fsx.sh = async command => {
        shellCalled = true;
        const jobFile = fs.readdirSync(root).find(name => name.startsWith('.precise_image_job_'));
        if (!jobFile) return { exitCode: 1, output: 'missing image-edit job' };
        const job = JSON.parse(fs.readFileSync(abs(jobFile), 'utf8'));
        fs.writeFileSync(abs(job.output), edited);
        return { exitCode: 0, output: JSON.stringify({ ok: true, before: { size: [320, 240] }, after: { size: [320, 240], mode: 'RGBA', bytes: edited.length }, operations: job.operations }) };
      };
      try {
        const fallbackMessage = await precise.toolEditImage({ prompt: 'grayscale this image', output: 'fallback.png' }, ctx);
        assert.strictEqual(exhaustedCalls, 1, 'tool should delegate the retry budget to deAPI exactly once');
        assert.strictEqual(shellCalled, true, 'deterministic fallback did not run after API exhaustion');
        assert.match(fallbackMessage, /VERIFIED deterministic edit complete/);
      } finally { deapiModule.editImage = originalEditImage; }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    console.log('✅ deAPI image-edit provider and tool delivery regression passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exit(1); });
