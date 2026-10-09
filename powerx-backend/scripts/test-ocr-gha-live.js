// Live test: run simpleOcr through the REAL GitHub Actions sandbox backend.
const fs = require('fs');
const path = require('path');

// Creds come from the environment ONLY — never hardcode secrets:
//   GITHUB_ACTIONS_TOKEN=ghp_xxx GITHUB_ACTIONS_REPO=owner/runner-repo \
//     node scripts/test-ocr-gha-live.js [imagePath] [name]
process.env.GITHUB_ACTIONS_BRANCH = process.env.GITHUB_ACTIONS_BRANCH || 'main';
if (!process.env.GITHUB_ACTIONS_TOKEN || !process.env.GITHUB_ACTIONS_REPO) {
  console.error('Set GITHUB_ACTIONS_TOKEN and GITHUB_ACTIONS_REPO in the environment first.');
  process.exit(1);
}

const gha = require('../services/githubActions');
const ocr = require('../services/simpleOcr');

// Build a sandbox fsx that mirrors agentEngine.makeSandboxFsx (the subset
// simpleOcr needs: sh, uploadBuffer, readText, downloadBuffer, list).
function makeGhaFsx(id) {
  const root = gha.WORKDIR;
  const absPath = (rel) => {
    const clean = path.posix.normalize('/' + (rel || '.')).replace(/^\/+/, '');
    return clean === '.' || clean === '' ? root : `${root}/${clean}`;
  };
  return {
    kind: 'sandbox', backend: 'GitHubActions', workdir: root, sandboxId: id, nativeFs: !!gha.nativeFs,
    async sh(command) {
      const r = await gha.exec(id, command, { cwd: root, timeout: 900 });
      return { exitCode: r.exitCode, output: (r.output || '').slice(0, 40000) || '(no output)' };
    },
    async uploadBuffer(rel, buf) { await gha.uploadFile(id, absPath(rel), buf, path.posix.basename(rel)); },
    async readText(rel) { const b = await gha.downloadFile(id, absPath(rel)); return b.toString('utf-8'); },
    async downloadBuffer(rel) { return gha.downloadFile(id, absPath(rel)); },
    async list() { return gha.listFilesRecursive(id); },
  };
}

(async () => {
  console.log('=== GitHub Actions sandbox OCR test ===');
  const t = await gha.testKey();
  console.log('testKey:', t.message);
  if (!t.ok) process.exit(1);

  console.log('creating sandbox…');
  const id = await gha.createSandbox({ labels: { session: 'ocr-selftest' } });
  console.log('sandbox id:', id);

  const fsx = makeGhaFsx(id);
  const ctx = { fsx, onStep: (m) => console.log('STEP:', m) };
  const buf = fs.readFileSync(process.argv[2] || '/data/coda/dr4awfq4/ws/b2c46431-dfa3-40ec-b0b5-8bda90904adc/tmp/exam.png');
  const name = process.argv[3] || 'exam.png';

  console.log('running classifyImage (this dispatches a real CI run — may take 1-3 min)…');
  const c = await ocr.classifyImage(ctx, buf, name);
  console.log('classify:', JSON.stringify({ ok: c.ok, hasText: c.hasText, wc: c.wordCount, conf: c.confidence, engine: c.engine }));

  console.log('running extract…');
  const e = await ocr.extract(ctx, buf, name, { mode: 'auto' });
  console.log('extract:', JSON.stringify({ ok: e.ok, engine: e.engine, type: e.type, len: (e.text || '').length, reason: e.reason }));
  console.log('--- extracted text (first 600 chars) ---');
  console.log((e.text || '').slice(0, 600));

  // Cleanup
  try { await gha.deleteSandbox(id); } catch (_) {}
  console.log('=== done ===');
  process.exit(0);
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
