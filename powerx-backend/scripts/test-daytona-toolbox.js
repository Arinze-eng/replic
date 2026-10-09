'use strict';
// Contract test: process/file toolbox calls must use the dedicated proxy template.
const assert = require('assert');
const http = require('http');
const { once } = require('events');

(async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.includes('/process/execute')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ exitCode: 0, result: 'PROXY_OK' }));
      }
      if (req.url.includes('/files/download')) return res.end(Buffer.from('download-ok'));
      if (req.url.includes('/files?')) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify([{ name: 'x.txt', size: 1, isDir: false }]));
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  process.env.DAYTONA_API_KEY = 'dtn_contract_test';
  process.env.DAYTONA_TOOLBOX_URL_TEMPLATE = `http://127.0.0.1:${port}/toolbox/{sandboxId}`;
  const daytona = require('../services/daytona');

  assert.strictEqual(daytona.toolboxBase('abc/123'), `http://127.0.0.1:${port}/toolbox/abc%2F123`);
  const exec = await daytona.exec('sandbox-7', 'printf PROXY_OK', { cwd: '/work dir', timeout: 9 });
  assert.deepStrictEqual(exec, { exitCode: 0, output: 'PROXY_OK' });
  await daytona.uploadFile('sandbox-7', '/work dir/a b.txt', Buffer.from('abc'), 'a b.txt');
  const downloaded = await daytona.downloadFile('sandbox-7', '/work dir/a b.txt');
  assert.strictEqual(downloaded.toString(), 'download-ok');
  const files = await daytona.listFiles('sandbox-7', '/work dir');
  assert.strictEqual(files.length, 1);

  assert.strictEqual(requests.length, 4);
  // Corrected contract (2026-07 fix): the proxy template already ends in
  // `/toolbox`, so per-call paths must NOT repeat `/toolbox` again.
  assert(requests.every(r => r.url.startsWith('/toolbox/sandbox-7/')));
  assert(requests.every(r => !r.url.includes('/toolbox/sandbox-7/toolbox/')));
  assert(requests.every(r => /^Bearer \S+$/.test(r.headers.authorization || '')));
  assert(requests[0].url.endsWith('/process/execute'));
  const executeBody = JSON.parse(requests[0].body.toString());
  assert(executeBody.command.includes("cd '/work dir'"));
  assert.strictEqual(executeBody.timeout, 9);
  assert(requests[1].url.includes('path=%2Fwork+dir%2Fa+b.txt'));
  assert(requests[2].url.includes('/files/download?path=%2Fwork+dir%2Fa+b.txt'));
  assert(requests[3].url.includes('/files?path=%2Fwork+dir'));

  await new Promise(resolve => server.close(resolve));
  console.log('EVIDENCE:TEST_PASSED Daytona toolbox proxy contract');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
