// Live test: run simpleOcr through the REAL Novita sandbox backend.
const fs = require('fs');
const path = require('path');

// Creds come from the environment ONLY — never hardcode secrets:
//   NOVITA_SANDBOX_API_KEY=sk_xxx node scripts/test-ocr-novita-live.js [imagePath] [name]
if (!process.env.NOVITA_SANDBOX_API_KEY && !process.env.NOVITA_API_KEY) {
  console.error('Set NOVITA_SANDBOX_API_KEY (or NOVITA_API_KEY) in the environment first.');
  process.exit(1);
}

const nv = require('../services/novitaSandbox');
const ocr = require('../services/simpleOcr');

function makeNvFsx(id) {
  const root = nv.WORKDIR;
  const absPath = (rel) => {
    const clean = path.posix.normalize('/' + (rel || '.')).replace(/^\/+/, '');
    return clean === '.' || clean === '' ? root : `${root}/${clean}`;
  };
  return {
    kind: 'sandbox', backend: 'Novita', workdir: root, sandboxId: id,
    async sh(command) {
      const r = await nv.exec(id, command, { cwd: root, timeout: 900 });
      return { exitCode: r.exitCode, output: (r.output || '').slice(0, 40000) || '(no output)' };
    },
    async uploadBuffer(rel, buf) { await nv.uploadFile(id, absPath(rel), buf, path.posix.basename(rel)); },
    async readText(rel) { const b = await nv.downloadFile(id, absPath(rel)); return b.toString('utf-8'); },
    async downloadBuffer(rel) { return nv.downloadFile(id, absPath(rel)); },
  };
}

(async () => {
  console.log('=== Novita sandbox OCR test ===');
  const t = await nv.testKey();
  console.log('testKey:', t.message);
  if (!t.ok) process.exit(1);

  console.log('creating sandbox…');
  const id = await nv.createSandbox({ labels: { session: 'ocr-selftest' } });
  console.log('sandbox id:', id);

  const fsx = makeNvFsx(id);
  const ctx = { fsx, onStep: (m) => console.log('STEP:', m) };
  const buf = fs.readFileSync(process.argv[2] || '/data/coda/dr4awfq4/ws/b2c46431-dfa3-40ec-b0b5-8bda90904adc/tmp/exam.png');
  const name = process.argv[3] || 'exam.png';

  console.log('running classifyImage (first run installs tesseract — may take 1-2 min)…');
  const c = await ocr.classifyImage(ctx, buf, name);
  console.log('classify:', JSON.stringify({ ok: c.ok, hasText: c.hasText, wc: c.wordCount, conf: c.confidence, engine: c.engine }));

  console.log('running extract…');
  const e = await ocr.extract(ctx, buf, name, { mode: 'auto' });
  console.log('extract:', JSON.stringify({ ok: e.ok, engine: e.engine, type: e.type, len: (e.text || '').length, reason: e.reason }));
  console.log('--- extracted text (first 600 chars) ---');
  console.log((e.text || '').slice(0, 600));

  try { await nv.deleteSandbox(id); } catch (_) {}
  console.log('=== done ===');
  process.exit(0);
})().catch((err) => { console.error('FATAL', err && err.stack || err); process.exit(1); });
