'use strict';
// Live provider-neutral image editing test. Usage:
// LIVE_IMAGE_PROVIDER=novita|upstash|runloop|daytona|githubactions node scripts/test-image-edit-provider-live.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const name = String(process.env.LIVE_IMAGE_PROVIDER || '').toLowerCase();
const modules = {
  novita: '../services/novitaSandbox', upstash: '../services/upstashBox', upstashbox: '../services/upstashBox',
  runloop: '../services/runloop', daytona: '../services/daytona', githubactions: '../services/githubActions',
};
if (!modules[name]) throw new Error('LIVE_IMAGE_PROVIDER must be novita, upstash, runloop, daytona, or githubactions');
const provider = require(modules[name]);
const engine = fs.readFileSync(path.join(__dirname, '..', 'python', 'precise_image_edit.py'));
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

(async () => {
  if (!(await Promise.resolve(provider.enabledAsync ? provider.enabledAsync() : provider.enabled()))) throw new Error(`${name} is not configured`);
  let id;
  try {
    id = await provider.createSandbox({ labels: { test: 'image-edit' } });
    const root = provider.WORKDIR;
    const input = await sharp(Buffer.from(`<svg width="1000" height="560" xmlns="http://www.w3.org/2000/svg"><rect width="1000" height="560" fill="#0f172a"/><rect x="70" y="70" width="860" height="420" rx="24" fill="#fff"/><text x="120" y="160" font-family="DejaVu Sans" font-size="38" font-weight="bold">Notification Settings</text><text x="120" y="260" font-family="DejaVu Sans" font-size="34">Grant notification access</text><text x="120" y="320" font-family="DejaVu Sans" font-size="22" fill="#64748b">Receive important alerts securely.</text><rect x="120" y="375" width="190" height="62" rx="14" fill="#2563eb"/><text x="170" y="416" font-family="DejaVu Sans" font-size="24" fill="#fff">Continue</text></svg>`)).png().toBuffer();
    const logo = await sharp({ create: { width: 80, height: 80, channels: 4, background: '#20c060' } }).png().toBuffer();
    const job = Buffer.from(JSON.stringify({ source: 'input.png', output: 'verified.png', operations: [
      { type: 'replace_text', old_text: 'Grant notification access', new_text: 'Grant county acess 😃😪', font_size: 34, color: '#111827', background: 'white', max_width: 700 },
      { type: 'overlay', source: 'logo.png', x: 800, y: 380, width: 55, height: 55, keep_aspect: false, opacity: 0.85 },
      { type: 'contrast', factor: 1.03 }, { type: 'sharpen', radius: 1, percent: 115 },
    ] }));
    await provider.uploadFile(id, `${root}/input.png`, input, 'input.png');
    await provider.uploadFile(id, `${root}/logo.png`, logo, 'logo.png');
    await provider.uploadFile(id, `${root}/precise_image_edit.py`, engine, 'precise_image_edit.py');
    await provider.uploadFile(id, `${root}/job.json`, job, 'job.json');
    const cmd = `set -e; SU=; [ "$(id -u)" = 0 ] || SU=sudo; if ! python3 -c "import PIL" 2>/dev/null; then (($SU apt-get update -qq && $SU apt-get install -y -qq python3-pil python3-pip) || true); fi; python3 -c "import PIL" 2>/dev/null || (python3 -m pip install -q --break-system-packages Pillow 2>/dev/null || python3 -m pip install -q Pillow); if ! command -v tesseract >/dev/null 2>&1; then $SU apt-get update -qq && $SU apt-get install -y -qq tesseract-ocr; fi; python3 -c "import pytesseract" 2>/dev/null || (python3 -m pip install -q --break-system-packages pytesseract 2>/dev/null || python3 -m pip install -q pytesseract); python3 precise_image_edit.py job.json --workdir .`;
    const run = await provider.exec(id, cmd, { cwd: root, timeout: 600 });
    assert.strictEqual(run.exitCode, 0, run.output);
    const line = String(run.output).trim().split('\n').reverse().find(x => x.trim().startsWith('{') && x.includes('"ok"'));
    const report = JSON.parse(line);
    assert(report.ok, run.output);
    assert.deepStrictEqual(report.operations.map(x => x.type), ['replace_text', 'overlay', 'contrast', 'sharpen']);
    assert.strictEqual(report.operations[0].located_by, 'ocr_phrase');
    const out = await provider.downloadFile(id, `${root}/verified.png`);
    const meta = await sharp(out).metadata();
    assert.deepStrictEqual([meta.width, meta.height], [1000, 560]);
    assert(out.length > 10000, 'complex output is unexpectedly small');
    const diff = await sharp(input).composite([{ input: out, blend: 'difference' }]).stats();
    assert(diff.channels.some(c => c.mean > 0.5), 'output pixels did not materially change');
    console.log(`✅ ${name} exact text + complex image editing passed (${out.length} bytes, ${meta.width}x${meta.height})`);
  } finally {
    if (id) await provider.deleteSandbox(id).catch(() => {});
  }
})().catch(e => { console.error(e); process.exit(1); });
