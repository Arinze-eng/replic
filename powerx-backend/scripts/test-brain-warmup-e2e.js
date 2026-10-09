// E2E through the REAL brain.processFile() pipeline — the exact path a WhatsApp/
// Telegram/web user file takes. Proves: warm-up → sandbox OCR → context block.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const brain = require('../services/brain');
const SAMPLES = path.join(__dirname, '..', 'python', 'omni_ocr', 'test_samples');
const log = (...a) => console.log(...a);

(async () => {
  log('=== brain warm-up + processFile E2E ===');

  // 1) Warm-up (what server.js calls at boot).
  log('\n[1] warmupOcrSandbox()…');
  const w = await brain.warmupOcrSandbox({ onStep: (m) => log('  ·', m) });
  log('warm-up:', JSON.stringify(w));

  // 2) Now process a real text-image the way a user upload would be handled.
  log('\n[2] processFile(printed.png) via the real pipeline…');
  const ctx = { fsx: brain._internals.makeLocalFsx(), attachments: [], onStep: (m) => log('  ·', m) };
  const buf = fs.readFileSync(path.join(SAMPLES, 'printed.png'));
  const t0 = Date.now();
  const r = await brain.processFile(ctx, { name: 'printed.png', buffer: buf, isImage: true, mime: 'image/png' });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log(`\n[result] engine=${r.engine} sentToVision=${r.sentToVision} took=${dt}s`);
  log('context block (first 300 chars):\n' + String(r.contextBlock || '').slice(0, 300));

  try { await ctx.fsx.cleanup && ctx.fsx.cleanup(); } catch (_) {}

  const okOmni = /omni_ocr/.test(r.engine || '') && /OmniOCR Precision Test|quick brown fox/i.test(r.contextBlock || '');
  log(`\n=== ${okOmni ? '✅ PASS (OCR via OmniOCR' + (/_sandbox/.test(r.engine || '') ? ' [sandbox]' : ' [local]') + ')' : '⚠️ OCR not via OmniOCR (engine=' + r.engine + ')'} ===`);
  process.exit(okOmni ? 0 : 1);
})().catch(e => { console.error('ERR', e); process.exit(3); });
