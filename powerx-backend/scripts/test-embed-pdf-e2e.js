// E2E: verify a REAL web image + a chart get EMBEDDED into a PDF.
// This exercises the exact chain the agent uses:
//   web_image → stage image  |  create_chart → stage chart PNG  |
//   build HTML with <img> for both → browserless.htmlToPdf → valid PDF.
const fs = require('fs');
const path = require('path');
const webImage = require('../services/webImage');
const manus = require('../services/manusTools');
const browserless = require('../services/browserless');

async function main() {
  const staged = {};
  const ctx = { onStep: (s) => console.log('   ·', s), async deliverBuffer(n, b) { staged[n] = b; } };

  console.log('STEP 1 — fetch a real web image + crop');
  await webImage.toolWebImage({ query: 'mountain landscape', width: 600, height: 360, crop: 'cover', format: 'jpeg', filename: 'photo', host: false }, ctx);
  const photo = Object.entries(staged).find(([n]) => n.startsWith('photo'));
  if (!photo) throw new Error('FAIL: no web image staged');
  console.log(`   photo ${photo[0]}: ${(photo[1].length/1024).toFixed(0)}KB`);

  console.log('STEP 2 — create a data chart PNG');
  await manus.toolCreateChart({ type: 'line', labels: ['Q1','Q2','Q3','Q4'], datasets: [{ label: 'Revenue ($k)', data: [40, 55, 48, 72] }], title: 'Revenue Trend', filename: 'chart.png' }, ctx);
  if (!staged['chart.png']) throw new Error('FAIL: no chart staged');
  console.log(`   chart.png: ${(staged['chart.png'].length/1024).toFixed(0)}KB`);

  console.log('STEP 3 — build HTML embedding BOTH images as data URIs → render PDF');
  const photoUri = `data:image/jpeg;base64,${photo[1].toString('base64')}`;
  const chartUri = `data:image/png;base64,${staged['chart.png'].toString('base64')}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#222}
    h1{color:#0b5} img{max-width:100%;border-radius:8px;margin:12px 0}
    .cap{color:#666;font-size:13px}</style></head><body>
    <h1>Embedded Media Report</h1>
    <p>This PDF embeds a REAL cropped web photo and a generated data chart.</p>
    <h2>Photo (from the web, cropped 600×360)</h2>
    <img src="${photoUri}"><div class="cap">Fig 1. Web image, cropped &amp; embedded.</div>
    <h2>Chart (generated from data)</h2>
    <img src="${chartUri}"><div class="cap">Fig 2. Revenue trend chart.</div>
    </body></html>`;

  const pdf = await browserless.htmlToPdf(html, { waitFor: 1500 });
  const outPath = path.join('/tmp', 'embed_test.pdf');
  fs.writeFileSync(outPath, pdf);
  const isPdf = pdf.slice(0, 5).toString() === '%PDF-';
  console.log(`   PDF: ${(pdf.length/1024).toFixed(0)}KB, header=${pdf.slice(0,5).toString()} → ${outPath}`);
  // The two images total ~40KB; if they embedded, the PDF should be > 30KB.
  if (!isPdf) throw new Error('FAIL: output is not a valid PDF');
  if (pdf.length < 25000) throw new Error(`FAIL: PDF too small (${pdf.length}B) — images likely NOT embedded`);
  console.log('   ✅ chart + web image embedded into a valid PDF\n');
  console.log('ALL EMBED-PDF TESTS PASSED ✅');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
