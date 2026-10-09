'use strict';
const assert = require('assert');
const sharp = require('sharp');
const deapi = require('../services/deapi');

(async () => {
  if (!(await deapi.enabled())) throw new Error('Set DEAPI_API_KEY to run the live test.');
  const source = await sharp(Buffer.from('<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#dbeafe"/><rect x="136" y="170" width="240" height="190" rx="22" fill="#ffffff" stroke="#1e3a8a" stroke-width="8"/><polygon points="120,190 256,80 392,190" fill="#ef4444"/><rect x="225" y="260" width="62" height="100" fill="#92400e"/><circle cx="330" cy="245" r="25" fill="#bfdbfe"/></svg>')).png().toBuffer();
  const result = await deapi.editImage(source,
    'Transform this simple blue-background house illustration into a cozy house at sunset. Add a clearly visible leafy green tree on the LEFT side of the house. Keep the house centered and recognizable.',
    { timeoutMs: 240000 });
  assert(result.buffer.length > 10000, 'live output is unexpectedly small');
  const meta = await sharp(result.buffer).metadata();
  assert(meta.width >= 256 && meta.height >= 256, 'live output dimensions are invalid');
  const diff = await sharp(source).resize(meta.width, meta.height).composite([{ input: result.buffer, blend: 'difference' }]).stats();
  assert(diff.channels.some(channel => channel.mean > 2), 'live provider returned an unchanged image');
  console.log(`✅ live deAPI image edit passed (${result.model}, ${meta.width}x${meta.height}, ${result.buffer.length} bytes)`);
})().catch(error => { console.error(error); process.exit(1); });
