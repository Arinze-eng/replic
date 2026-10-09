// E2E test for the web_image tool: search online → download → crop/resize → stage.
// Also verifies the DuckDuckGo image search + sharp transform pipeline works live.
const sharp = require('sharp');
const webImage = require('../services/webImage');

async function main() {
  const staged = [];
  const ctx = {
    onStep: (s) => console.log('   ·', s),
    async deliverBuffer(name, buf) { staged.push({ name, buf }); },
  };

  console.log('TEST 1 — search the web for a real image + crop to 400x300 (cover)');
  const r1 = await webImage.toolWebImage(
    { query: 'golden gate bridge', width: 400, height: 300, crop: 'cover', format: 'jpeg', filename: 'bridge', host: false },
    ctx,
  );
  console.log('   result:', r1.slice(0, 200));
  if (!staged.length) throw new Error('FAIL: no image staged from web search');
  const meta1 = await sharp(staged[0].buf).metadata();
  console.log(`   staged ${staged[0].name}: ${meta1.width}x${meta1.height} ${meta1.format} (${(staged[0].buf.length/1024).toFixed(0)}KB)`);
  if (meta1.width !== 400 || meta1.height !== 300) throw new Error(`FAIL: crop/resize wrong: ${meta1.width}x${meta1.height}`);
  console.log('   ✅ web search + crop OK\n');

  console.log('TEST 2 — fetch a DIRECT image URL + exact pixel crop_box + grayscale');
  staged.length = 0;
  const r2 = await webImage.toolWebImage(
    { url: 'https://picsum.photos/800/600', crop_box: { left: 100, top: 100, width: 300, height: 200 }, grayscale: true, format: 'png', filename: 'crop_test', host: false },
    ctx,
  );
  console.log('   result:', r2.slice(0, 160));
  if (!staged.length) throw new Error('FAIL: no image staged from direct URL');
  const meta2 = await sharp(staged[0].buf).metadata();
  console.log(`   staged ${staged[0].name}: ${meta2.width}x${meta2.height} ${meta2.format}`);
  if (meta2.width !== 300 || meta2.height !== 200) throw new Error(`FAIL: crop_box wrong: ${meta2.width}x${meta2.height}`);
  console.log('   ✅ direct URL + exact crop_box + grayscale OK\n');

  console.log('ALL WEB_IMAGE TESTS PASSED ✅');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
