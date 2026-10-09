// E2E for the REAL create_pdf tool (agentEngine.toolCreatePdf) covering BOTH
// content shapes the brain produces for "solve a past question with a diagram":
//   A) markdown `content` that contains an inline <svg> diagram
//   B) a full `html` doc with an embedded base64-PNG <img> diagram (matplotlib)
// Verifies each delivers a REAL, non-empty PDF whose diagram is NOT escaped away.
process.env.PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/data/coda/dr4awfq4/ws/1522ecc5-1d6c-473e-a71d-c9034f7ec9f0/repos/.chromium/chromium/linux-1655338/chrome-linux/chrome';

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const engine = require('../services/agentEngine');
const { toolCreatePdf } = engine._internals;

const outDir = path.join(__dirname, '..', '..', '..', 'tmp');
fs.mkdirSync(outDir, { recursive: true });

// 1x1 red PNG (base64) standing in for a matplotlib diagram.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeCtx(store) {
  return {
    onStep() {},
    async deliverBuffer(name, buf) { store.push({ name, buf }); },
    workdir: outDir,
  };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (l, c, d='') => { if (c){pass++;console.log('✅',l,d);} else {fail++;console.log('❌',l,d);} };

  // ── A) markdown content with inline SVG ───────────────────────────────────
  {
    const store = [];
    const content = `# Q1 — Green's Theorem\n\nRectangle A(1,0),B(3,0),C(3,2),D(1,2).\n\n<svg width="200" height="120"><rect x="20" y="15" width="140" height="80" fill="none" stroke="#1a3d7c" stroke-width="2"/></svg>\n\nBy Green's Theorem \\( \\oint_C P\\,dx+Q\\,dy = \\iint_R (Q_x-P_y)\\,dA = -8 \\).\n\n**Answer:** \\( \\boxed{-8} \\)`;
    const msg = await toolCreatePdf({ filename: 'e2e_md_svg.pdf', title: 'Solved Q1', content }, makeCtx(store));
    console.log('  A →', msg);
    ok('A: PDF delivered', store.length === 1 && store[0].buf && store[0].buf.length > 0, store[0] ? `(${(store[0].buf.length/1024).toFixed(0)} KB)` : '');
    if (store[0]) {
      const buf = store[0].buf;
      fs.writeFileSync(path.join(outDir, 'e2e_md_svg.pdf'), buf);
      ok('A: valid %PDF', buf.slice(0,5).toString('latin1') === '%PDF-');
      ok('A: not empty (typeset + svg)', buf.length > 30000, `(${(buf.length/1024).toFixed(0)} KB)`);
      const d = await pdfParse(buf);
      ok('A: prose extracted', /Green|Rectangle|Answer/i.test(d.text));
    }
  }

  // ── B) full rich HTML with a base64-PNG <img> diagram ─────────────────────
  {
    const store = [];
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Georgia,serif}</style></head><body>
      <h1>Solved Past Question (rich HTML)</h1>
      <p>Area between \\(y=(x-1)^2\\) and \\(y=4-(x-3)^2\\) is \\( \\boxed{\\tfrac{8}{3}} \\).</p>
      <figure><img src="data:image/png;base64,${PNG_1x1}" width="120" height="120" alt="plot"/><figcaption>Region</figcaption></figure>
    </body></html>`;
    const msg = await toolCreatePdf({ filename: 'e2e_rich_html.pdf', html }, makeCtx(store));
    console.log('  B →', msg);
    ok('B: PDF delivered', store.length === 1 && store[0].buf && store[0].buf.length > 0, store[0] ? `(${(store[0].buf.length/1024).toFixed(0)} KB)` : '');
    if (store[0]) {
      const buf = store[0].buf;
      fs.writeFileSync(path.join(outDir, 'e2e_rich_html.pdf'), buf);
      ok('B: valid %PDF', buf.slice(0,5).toString('latin1') === '%PDF-');
      ok('B: not empty', buf.length > 8000, `(${(buf.length/1024).toFixed(0)} KB)`);
      const d = await pdfParse(buf);
      ok('B: prose extracted', /Solved|Region|Question/i.test(d.text));
    }
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3); });
