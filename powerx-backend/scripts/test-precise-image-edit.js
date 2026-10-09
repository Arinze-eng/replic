'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const sharp = require('sharp');
const precise = require('../services/preciseImageEdit');

function sh(cmd, cwd) {
  return new Promise(resolve => exec(cmd, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ exitCode: err ? (err.code || 1) : 0, output: [stdout, stderr].filter(Boolean).join('\n') })));
}
function fsx(root) {
  const abs = rel => { const p = path.resolve(root, rel); if (p !== root && !p.startsWith(root + path.sep)) throw Error('traversal'); return p; };
  return {
    kind: 'sandbox-test',
    async sh(cmd) { return sh(cmd, root); },
    async exists(rel) { return fs.existsSync(abs(rel)); },
    async list() { return fs.readdirSync(root, { withFileTypes: true }).filter(x => x.isFile()).map(x => { const s = fs.statSync(abs(x.name)); return { rel: x.name, size: s.size, mtime: s.mtimeMs }; }); },
    async uploadBuffer(rel, buf) { fs.writeFileSync(abs(rel), buf); },
    async writeText(rel, text) { fs.writeFileSync(abs(rel), text); },
    async downloadBuffer(rel) { return fs.readFileSync(abs(rel)); },
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precise-image-'));
  try {
    const input = await sharp({ create: { width: 240, height: 160, channels: 4, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="240" height="160"><rect x="60" y="30" width="120" height="100" rx="12" fill="#e02020"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
    fs.writeFileSync(path.join(root, 'input.png'), input);
    const delivered = [];
    const ctx = { fsx: fsx(root), attachments: [{ name: 'input.png', buffer: input, isImage: true }], addFile: (rel, name) => delivered.push({ rel, name }), onStep: () => {} };

    assert.deepStrictEqual(precise.parsePrompt('resize to 120x80 and grayscale').map(x => x.type), ['resize', 'grayscale']);
    assert.deepStrictEqual(precise.parsePrompt('edit the Grant notification access to Grant county acess 😃😪'), [{
      type: 'replace_text', old_text: 'Grant notification access', new_text: 'Grant county acess 😃😪',
    }]);
    let result = await precise.toolEditImage({ operations: [{ type: 'resize', width: 120, height: 80 }, { type: 'grayscale' }], output: 'small.png' }, ctx);
    assert.match(result, /VERIFIED deterministic edit complete/);
    const small = await sharp(path.join(root, 'small.png')).metadata();
    assert.deepStrictEqual([small.width, small.height], [120, 80]);

    result = await precise.toolEditImage({ operations: [{ type: 'crop', x: 40, y: 20, width: 120, height: 100 }, { type: 'rotate', degrees: 90 }, { type: 'add_text', text: 'QA', x: 5, y: 5, font_size: 18 }], output: 'composed.png' }, ctx);
    assert.match(result, /operations=crop, rotate, add_text/);
    const composed = await sharp(path.join(root, 'composed.png')).metadata();
    assert.deepStrictEqual([composed.width, composed.height], [100, 120]);

    result = await precise.toolEditImage({ operations: [{ type: 'remove_background' }], output: 'transparent.png' }, ctx);
    assert.match(result, /VERIFIED deterministic edit complete/);
    const { data, info } = await sharp(path.join(root, 'transparent.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0; for (let i = 3; i < data.length; i += info.channels) if (data[i] < 255) transparent++;
    assert(transparent > 0, 'background removal must create transparent pixels');

    // Explicit boxes remain supported for designs where OCR is unavailable.
    // Validate a longer Unicode replacement plus a logo overlay and adjustment.
    const logo = await sharp({ create: { width: 30, height: 30, channels: 4, background: '#20c060' } }).png().toBuffer();
    fs.writeFileSync(path.join(root, 'logo.png'), logo);
    result = await precise.toolEditImage({ operations: [
      { type: 'replace_text', box: [10, 8, 205, 25], old_text: 'Grant notification access', new_text: 'Grant county acess 😃😪', font_size: 18, background: 'white', color: 'black', max_width: 225 },
      { type: 'overlay', source: 'logo.png', x: 200, y: 120, width: 25, height: 25, keep_aspect: false },
      { type: 'contrast', factor: 1.05 },
      { type: 'sharpen', radius: 1, percent: 120 },
    ], output: 'complex.png' }, ctx);
    assert.match(result, /operations=replace_text, overlay, contrast, sharpen/);
    const complex = await sharp(path.join(root, 'complex.png')).metadata();
    assert.deepStrictEqual([complex.width, complex.height], [240, 160]);

    assert(delivered.some(x => x.name === 'small.png'));
    assert(delivered.some(x => x.name === 'composed.png'));
    assert(delivered.some(x => x.name === 'transparent.png'));
    console.log('✅ deterministic image edit regression passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
