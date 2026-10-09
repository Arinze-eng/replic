// E2E test for the visual-pdf-master wiring in agentEngine.
// Verifies: (1) create_pdf routes a direct `html` arg to Browserless verbatim,
// (2) ensureMathJax injects the runtime when missing / leaves it when present,
// (3) the `content` path still works (backward compat),
// (4) the visual-pdf-master skill is discoverable via list_skills.
const path = require('path');
const engine = require('../services/agentEngine');
const { toolCreatePdf, ensureMathJax } = engine._internals;
const browserless = require('../services/browserless');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`✅ ${label} ${detail || ''}`); }
  else { fail++; console.log(`❌ ${label} ${detail || ''}`); }
};

(async () => {
  // ── Mock Browserless so we can assert WHAT html was sent, without a key. ──
  let capturedHtml = null;
  const origPdf = browserless.htmlToPdf;
  browserless.htmlToPdf = async (html) => {
    capturedHtml = html;
    return Buffer.from('%PDF-1.7\n% fake pdf for test\n', 'latin1');
  };

  const delivered = new Map();
  const ctx = {
    onStep: () => {},
    async deliverBuffer(name, buf) { delivered.set(name, buf); },
  };

  // 1) ensureMathJax — injects when missing
  const injected = ensureMathJax('<!doctype html><html><head></head><body><p>\\(x^2\\)</p></body></html>');
  ok('ensureMathJax injects MathJax when missing', /tex-svg\.js/.test(injected) && /__mjReady/.test(injected));

  // 2) ensureMathJax — leaves existing MathJax but ensures readiness flag
  const already = ensureMathJax('<html><head><script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script></head><body>x</body></html>');
  const scriptCount = (already.match(/tex-svg\.js/g) || []).length;
  ok('ensureMathJax does not double-inject MathJax', scriptCount === 1, `(scripts=${scriptCount})`);
  ok('ensureMathJax adds readiness flag to existing-MathJax doc', /__mjReady/.test(already));

  // 3) Direct html path → rendered verbatim (diagram <img> + math survive)
  const richHtml = `<!doctype html><html><head><style>.q{border:1px solid #000}</style></head>
<body><div class="q"><h3>Q1</h3><p>Solve \\(x^2-3x+2=0\\)</p>
<img class="diag" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA"/>
<div class="ans">x = 1 or x = 2</div></div></body></html>`;
  delivered.clear(); capturedHtml = null;
  const r1 = await toolCreatePdf({ filename: 'solutions.pdf', html: richHtml }, ctx);
  ok('direct html path delivers a PDF', delivered.has('solutions.pdf'), r1.slice(0, 80));
  ok('direct html path keeps the embedded diagram <img>', /data:image\/png;base64/.test(capturedHtml || ''));
  ok('direct html path keeps the LaTeX math', /x\^2-3x\+2/.test(capturedHtml || ''));
  ok('direct html path keeps custom styles', /\.q\{border/.test(capturedHtml || ''));
  ok('direct html path ensured MathJax present', /tex-svg\.js/.test(capturedHtml || ''));

  // 4) Backward-compat: content path still builds MathJax HTML
  delivered.clear(); capturedHtml = null;
  const r2 = await toolCreatePdf({ filename: 'report.pdf', title: 'Report', content: '# Hello\n\nEquation: \\(a^2+b^2=c^2\\)' }, ctx);
  ok('content path still delivers a PDF', delivered.has('report.pdf'), r2.slice(0, 80));
  ok('content path builds MathJax doc', /tex-svg\.js/.test(capturedHtml || ''));
  ok('content path renders the title', /Report/.test(capturedHtml || ''));

  browserless.htmlToPdf = origPdf; // restore

  // 5) Skill discoverable
  const list = engine._internals ? null : null; // list_skills is via dispatch; check file exists
  const fs = require('fs');
  const skillPath = path.join(__dirname, '..', '.codebanana', '.skills', 'visual-pdf-master', 'SKILL.md');
  ok('visual-pdf-master skill file exists', fs.existsSync(skillPath));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'skills_index.md'), 'utf8');
  ok('visual-pdf-master listed in skills_index', /visual-pdf-master/.test(idx));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
