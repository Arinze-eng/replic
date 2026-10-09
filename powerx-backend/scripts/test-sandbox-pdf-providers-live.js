'use strict';
// Live E2E: upload the exact production renderer into fresh Novita and Upstash
// sandboxes, generate a math-heavy PDF, download it, and prove no raw LaTeX
// reached any visible content stream. Every created sandbox is deleted.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'latex_render.py'));
const source = String.raw`# Runge–Kutta 4th Order Numerical Solution

## Problem Statement

Find the approximate value of $y$ at $x=0.2$ using the fourth-order Runge–Kutta method, given

$$\frac{dy}{dx}=x+y, \qquad y(0)=1.$$

## Given Parameters

- Differential equation: $f(x,y)=x+y$
- Initial condition: $x_0=0,\;y_0=1$
- Step size: $h=0.2$
- Target value: $x=0.2$

## Runge–Kutta Formulas

\begin{align*}
k_1 &= h f(x_0,y_0),\\
k_2 &= h f\!\left(x_0+\frac h2,y_0+\frac{k_1}{2}\right),\\
k_3 &= h f\!\left(x_0+\frac h2,y_0+\frac{k_2}{2}\right),\\
k_4 &= h f(x_0+h,y_0+k_3).
\end{align*}

## Step-by-Step Calculation

$$k_1=0.2f(0,1)=0.2, \qquad k_2=0.2f(0.1,1.1)=0.24.$$

$$k_3=0.2f(0.1,1.12)=0.244, \qquad k_4=0.2f(0.2,1.244)=0.2888.$$

## Final Result

$$\boxed{y(0.2)\approx 1+\frac16\left(0.2+2(0.24)+2(0.244)+0.2888\right)=1.2428}$$
`;

function inspectPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1000 || buf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`invalid PDF (${buf ? buf.length : 0} bytes)`);
  }
  const binary = buf.toString('latin1');
  const hasPage = /\/Type\s*\/Page\b/.test(binary) ||
    (/\/Type\s*\/Pages\b/.test(binary) && /\/Count\s+[1-9][0-9]*\b/.test(binary)) ||
    (/startxref[\s\S]*%%EOF\s*$/.test(binary) && /\/Root\s+\d+\s+\d+\s+R/.test(binary));
  if (!hasPage) throw new Error('PDF has no pages or valid document root');
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let match; let visible = '';
  while ((match = streamRe.exec(binary))) {
    let part = Buffer.from(match[1], 'latin1');
    try { part = zlib.inflateSync(part); } catch (_) {}
    visible += part.toString('latin1') + '\n';
  }
  const leaked = visible.match(/\\(?:frac|sqrt|int|sum|begin|end|boxed|mystyle)\b/g) || [];
  if (leaked.length) throw new Error(`raw LaTeX leaked: ${[...new Set(leaked)].join(', ')}`);
  return { bytes: buf.length };
}

async function testProvider(name, modPath) {
  const provider = require(modPath);
  let id = null;
  try {
    if (!(await provider.enabledAsync())) throw new Error(`${name} key is not configured`);
    id = await provider.createSandbox({ labels: { purpose: 'pdf-e2e' } });
    const root = provider.WORKDIR;
    await provider.uploadFile(id, `${root}/latex_render.py`, renderer, 'latex_render.py');
    await provider.uploadFile(id, `${root}/quality.md`, Buffer.from(source), 'quality.md');
    const result = await provider.exec(id,
      `LATEX_AUTO_INSTALL=1 python3 latex_render.py quality.md quality.pdf 'Runge–Kutta Solution' && command -v pdflatex >/dev/null && test -s quality.pdf && printf PDF_OK`,
      { cwd: root, timeout: 1200 });
    if (result.exitCode !== 0 || !/PDF_OK/.test(result.output || '')) {
      throw new Error(`render command failed: ${(result.output || '').slice(-800)}`);
    }
    const pdf = await provider.downloadFile(id, `${root}/quality.pdf`);
    const info = inspectPdf(pdf);
    console.log(`PASS ${name}: ${Math.round(info.bytes / 1024)} KB textbook PDF via real pdflatex, no raw LaTeX`);
  } finally {
    if (id) await provider.deleteSandbox(id).catch(() => {});
  }
}

(async () => {
  await testProvider('Novita', '../services/novitaSandbox');
  await testProvider('Upstash', '../services/upstashBox');
  console.log('ALL LIVE SANDBOX PDF PROVIDER TESTS PASSED');
})().catch((e) => {
  const detail = e && e.result
    ? [e.result.error, e.result.stdout, e.result.stderr].filter(Boolean).join('\n')
    : (e && e.stack) || (e && e.message) || String(e);
  console.error('FAIL', detail);
  process.exit(1);
});
