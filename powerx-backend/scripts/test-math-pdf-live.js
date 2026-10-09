// Live E2E regression test for the MathJax HTML→PDF fix.
//
// Guards against the "empty / math-less PDF" bug: the plain Browserless `/pdf`
// endpoint does NOT execute client-side MathJax, so equations came out blank.
// The fix (services/browserless.js htmlToPdf) is a TWO-STEP pipeline:
//   /content (runs MathJax → bakes SVG) → freeze scripts → /pdf (static HTML).
//
// This test hits the REAL Browserless account. It is SKIPPED (soft-pass) if no
// Browserless key is configured, so it never blocks a keyless CI run.
const browserless = require('../services/browserless');
const pdfParse = require('pdf-parse');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`✅ ${label} ${detail || ''}`); }
  else { fail++; console.log(`❌ ${label} ${detail || ''}`); }
};

const MATH_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>body{font-family:Georgia,serif;font-size:12pt}h1{border-bottom:2px solid #222}
.q{background:#f7f9fc;border-left:4px solid #1a3d7c;padding:8px 12px}</style>
<script>
  window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']],displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'none'},
    startup:{pageReady(){return MathJax.startup.defaultPageReady().then(function(){window.__mjReady=true;});}}};
  setTimeout(function(){ if(!window.__mjReady) window.__mjReady=true; }, 6000);
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
</head><body>
<h1>Green's Theorem Solution</h1>
<div class="q">Evaluate \\(\\oint_C xy\\,dx+(1+y^2)\\,dy\\) over a rectangle.</div>
<p>\\[\\iint_R(0-x)\\,dA=-\\int_0^2\\!\\!\\int_1^3 x\\,dx\\,dy=-8\\]</p>
<svg width="180" height="100"><rect x="20" y="20" width="120" height="60" fill="none" stroke="#1a3d7c" stroke-width="2"/></svg>
<p>Answer: \\(\\boxed{-8}\\)</p>
</body></html>`;

(async () => {
  const key = await browserless.getKey().catch(() => '');
  if (!key) {
    console.log('⚠️  No Browserless key configured — skipping live PDF test (soft pass).');
    console.log('\n=== RESULT: skipped (no key) ===');
    process.exit(0);
  }

  // 1) helpers behave
  ok('_needsMathJax detects MathJax doc', browserless._needsMathJax(MATH_HTML) === true);
  ok('_needsMathJax false on plain doc', browserless._needsMathJax('<p>hi</p>') === false);

  // 2) /content actually typesets (the endpoint the fix relies on)
  let typeset = '';
  try { typeset = await browserless.renderTypesetContent(MATH_HTML, { waitFor: 15000 }); } catch (e) { /* below */ }
  ok('/content renders MathJax to SVG', /mjx-container/.test(typeset) && /<svg/i.test(typeset),
     `(svgCount=${(typeset.match(/<svg/g) || []).length})`);

  // 3) freeze strips the MathJax scripts but keeps the baked SVG
  const frozen = browserless._freezeTypesetHtml(typeset);
  ok('freeze removes MathJax loader script', !/tex-svg\.js/.test(frozen));
  ok('freeze keeps typeset SVG', /mjx-container|<svg/i.test(frozen));

  // 4) full htmlToPdf → a REAL, non-empty PDF with content
  let buf = null;
  try { buf = await browserless.htmlToPdf(MATH_HTML, { waitFor: 15000 }); } catch (e) { console.log('   htmlToPdf error:', e.message); }
  ok('htmlToPdf returns a PDF buffer', !!buf && buf.length > 0);
  ok('PDF is a valid %PDF file', !!buf && buf.slice(0, 5).toString('latin1') === '%PDF-');
  // A blank/math-less PDF of this doc is ~28 KB (just prose). A properly
  // typeset one embeds the equation SVGs (paths/glyphs) + the diagram, pushing
  // it well past that. 33 KB is a safe floor for THIS small test doc.
  ok('PDF embeds the typeset math (not blank)', !!buf && buf.length > 33000, `(${buf ? (buf.length / 1024).toFixed(0) : 0} KB)`);
  if (buf) {
    const d = await pdfParse(buf);
    ok('PDF has the heading text', /Green|Theorem|Solution/i.test(d.text));
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
