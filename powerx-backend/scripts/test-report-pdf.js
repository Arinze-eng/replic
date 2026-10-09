// Test: report -> PDF "always return a PDF" safety net + create_pdf fallback.
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../services/agentEngine');
const { toolCreatePdf } = engine._internals;

(async () => {
  let pass = 0, fail = 0;
  const expect = (label, cond, detail) => {
    if (cond) { pass++; console.log(`✅ ${label} ${detail || ''}`); }
    else { fail++; console.log(`❌ ${label} ${detail || ''}`); }
  };

  // Mock ctx mirroring the real deliverBuffer (writes to a host stage dir and
  // registers the file), so we can assert a PDF buffer was actually produced.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdftest_'));
  const delivered = new Map();
  const ctx = {
    onStep: (m) => console.log('   · ' + m),
    async deliverBuffer(name, buffer) {
      const safe = String(name).replace(/[^\w.\-]/g, '_');
      const p = path.join(stageDir, safe);
      fs.writeFileSync(p, buffer);
      delivered.set(safe, { path: p, size: buffer.length });
    },
  };

  // A realistic lab-report-style message (the kind the agent emits before finish).
  const report = `# Determination of the Acceleration Due to Gravity Using a Simple Pendulum

## Abstract
This experiment determined the acceleration due to gravity (g) using a simple pendulum by measuring the period of oscillation for several lengths. ${'The pendulum was set into small-angle oscillation and the time for twenty oscillations recorded. '.repeat(30)}

## Aim / Objectives
1. To determine the acceleration due to gravity g.
2. To verify the relationship T = 2*pi*sqrt(L/g).

## Introduction / Theory
${'A simple pendulum consists of a point mass suspended by an inextensible string. '.repeat(60)}

## Procedures
1. The length of the pendulum was measured and recorded.
2. The bob was displaced through a small angle and released.
3. The time for twenty complete oscillations was recorded.

## Apparatus
Retort stand, pendulum bob, inextensible string, metre rule, stopwatch.

## Results
| L (m) | t for 20 osc (s) | T (s) | T^2 (s^2) |
|-------|------------------|-------|-----------|
| 0.20  | 17.9             | 0.895 | 0.801     |
| 0.40  | 25.3             | 1.265 | 1.600     |

A graph of T^2 against L was plotted; the gradient was used to compute g = 4*pi^2 / slope.

## Analysis / Discussion
${'The graph produced a straight line through the origin, confirming the theory. '.repeat(20)}

## Precautions
1. Oscillations were kept small.
2. Timing started after steady motion.

## Conclusion
${'The experiment successfully determined g to within experimental error. '.repeat(25)}

## References
1. Practical Manual, Department of Physics.
2. Halliday, Resnick & Walker, Fundamentals of Physics.`;

  // Replicate the safety-net detection logic used in runAgent's finally block.
  const wordCount = (report.trim().match(/\S+/g) || []).length;
  const looksLikeReport = /\b(abstract|introduction|theory|procedure|apparatus|results?|analysis|discussion|precaution|conclusion|references?|aim|objective)\b/i.test(report);
  expect('report detected as report-style', looksLikeReport && wordCount >= 250, `words=${wordCount}`);

  // Now actually run the PDF generation the safety net would call.
  const res = await toolCreatePdf({ filename: 'report.pdf', title: 'Pendulum Report', content: report, math: true }, ctx);
  console.log('   create_pdf →', String(res).slice(0, 120));

  const got = delivered.get('report.pdf');
  expect('PDF was delivered', !!got, got ? `(${(got.size/1024).toFixed(0)} KB)` : '(none)');
  if (got) {
    const head = fs.readFileSync(got.path).slice(0, 5).toString('latin1');
    expect('delivered file is a valid PDF (%PDF header)', head.startsWith('%PDF'), `head="${head}"`);
    expect('PDF is non-trivial size (>3KB)', got.size > 3000, `${got.size} bytes`);
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
