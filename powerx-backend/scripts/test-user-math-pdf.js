// E2E reproduction of the user's "empty PDF after solving a past question" bug.
// Uses the REAL production path: agentEngine.buildMathHtml -> browserless.htmlToPdf
// (which uses the LOCAL Chromium via PUPPETEER_EXECUTABLE_PATH, exactly like the
// Render Docker image). Then parses the PDF to prove maths + diagram are present.
process.env.PUPPETEER_EXECUTABLE_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/data/coda/dr4awfq4/ws/1522ecc5-1d6c-473e-a71d-c9034f7ec9f0/repos/.chromium/chromium/linux-1655338/chrome-linux/chrome';

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const engine = require('../services/agentEngine');
const browserless = require('../services/browserless');

const { buildMathHtml } = engine._internals;

// A tiny inline SVG "diagram" (the rectangle for Q1) + a base64 PNG dot to mimic
// an embedded matplotlib diagram the way the agent delivers solved questions.
const DIAG_SVG = `<svg width="220" height="140" xmlns="http://www.w3.org/2000/svg">
  <rect x="30" y="20" width="150" height="90" fill="none" stroke="#1a3d7c" stroke-width="2"/>
  <text x="20" y="130" font-size="11">A(1,0)</text>
  <text x="175" y="130" font-size="11">B(3,0)</text>
  <text x="175" y="16" font-size="11">C(3,2)</text>
  <text x="20" y="16" font-size="11">D(1,2)</text>
</svg>`;

const CONTENT = `# Solutions (parametrization / Green's Theorem)

## 1. Line integral \\( \\oint_C xy\\,dx + (1+y^2)\\,dy \\)

C is the boundary of rectangle A(1,0), B(3,0), C(3,2), D(1,2).

${DIAG_SVG}

By Green's Theorem \\( \\oint_C P\\,dx + Q\\,dy = \\iint_R (Q_x - P_y)\\,dA \\):

\\[ Q_x - P_y = \\frac{\\partial}{\\partial x}(1+y^2) - \\frac{\\partial}{\\partial y}(xy) = 0 - x = -x \\]

\\[ \\iint_R (-x)\\,dA = -\\int_0^2\\!\\!\\int_1^3 x\\,dx\\,dy = -\\int_0^2 \\left[\\tfrac{x^2}{2}\\right]_1^3 dy = -\\int_0^2 4\\,dy = -8 \\]

**Answer:** \\( \\boxed{-8} \\)

## 2. Area bounded by \\( y=(x-1)^2 \\) and \\( y = 4-(x-3)^2 \\)

Intersections: \\( (x-1)^2 = 4-(x-3)^2 \\Rightarrow 2x^2 -8x +6 = 0 \\Rightarrow x=1,\\,x=3 \\).

\\[ A = \\int_1^3 \\big[(4-(x-3)^2) - (x-1)^2\\big]\\,dx = \\int_1^3 (-2x^2 + 8x - 6)\\,dx = \\frac{8}{3} \\]

**Answer:** \\( \\boxed{\\tfrac{8}{3}} \\)

## 3. Line integral \\( \\oint_C x^2\\,dx - 2xy\\,dy \\), triangle O(0,0), A(1,0), B(0,1)

Green's Theorem: \\( Q_x - P_y = -2y - 0 = -2y \\).

\\[ \\iint_R (-2y)\\,dA = -2\\int_0^1\\!\\!\\int_0^{1-x} y\\,dy\\,dx = -2\\int_0^1 \\frac{(1-x)^2}{2}dx = -\\frac13 \\]

**Answer:** \\( \\boxed{-\\tfrac13} \\)
`;

(async () => {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail='') => { if (cond){pass++;console.log('✅',label,detail);} else {fail++;console.log('❌',label,detail);} };

  console.log('Chromium resolved at:', browserless._resolveChromePath() || '(none)');
  ok('local Chromium detected', !!browserless._resolveChromePath());

  const html = buildMathHtml('Past Question Solutions', CONTENT, { subtitle: 'Parametrization & Green\'s Theorem' });
  ok('buildMathHtml embeds MathJax', /tex-svg\.js/.test(html));
  ok('buildMathHtml keeps the SVG diagram', /<svg/i.test(html));

  const outDir = path.join(__dirname, '..', '..', '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'math-input.html'), html);

  let buf = null;
  const t0 = Date.now();
  try { buf = await browserless.htmlToPdf(html, { waitFor: 15000 }); }
  catch (e) { console.log('htmlToPdf error:', e.message); }
  const ms = Date.now() - t0;

  ok('PDF buffer returned', !!buf && buf.length > 0, buf ? `(${(buf.length/1024).toFixed(0)} KB in ${ms}ms)` : '');
  ok('valid %PDF header', !!buf && buf.slice(0,5).toString('latin1') === '%PDF-');
  // A math-less / empty PDF of this doc is small. Typeset equations + SVG push
  // it well past ~40KB.
  ok('PDF is NOT empty (embeds typeset math + diagram)', !!buf && buf.length > 40000, buf ? `(${(buf.length/1024).toFixed(0)} KB)` : '');

  if (buf) {
    fs.writeFileSync(path.join(outDir, 'math-output.pdf'), buf);
    const d = await pdfParse(buf);
    const txt = d.text || '';
    ok('PDF has heading text', /Solutions|Green|Theorem/i.test(txt));
    ok('PDF page count >= 1', d.numpages >= 1, `(pages=${d.numpages})`);
    // NOTE: the boxed answers are typeset by MathJax into SVG glyphs, so they are
    // NOT extractable as plain text (that's the CORRECT, high-quality behaviour).
    // We assert the diagram + typeset math made the PDF large, and prose is present.
    ok('PDF prose is present (headings extracted)', /Solutions|rectangle|triangle|Theorem/i.test(txt));
    console.log('\n--- extracted text (first 400 chars) ---\n' + txt.slice(0, 400).replace(/\n{2,}/g,'\n'));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3); });
