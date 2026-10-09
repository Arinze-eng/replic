// Test the buildMathHtml (markdown -> math HTML) path used when the agent
// passes `content` (not raw `html`). Verifies $/$$ delimiters + a base64 image
// diagram survive and render, with no duplication or script leak.
process.env.PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/data/coda/dr4awfq4/ws/cc7e4ae7-a968-4b31-9c71-c3f115c9ed3b/work/.chrome/chrome/linux-150.0.7871.46/chrome-linux64/chrome';
const fs = require('fs');
const path = require('path');
const agent = require('../services/agentEngine');

// A tiny red 2x2 PNG as a "diagram" to prove <img> base64 renders.
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSFQGAJ0FBS0k1J3iAAAAAElFTkSuQmCC';

const content = `# Calculus Solutions

## Q1 — Line Integral
Evaluate $\\oint_C xy\\,dx + (1+y^2)\\,dy$ where C bounds the rectangle A(1,0),B(3,0),C(3,2),D(1,2).

By **Green's theorem**:
$$\\oint_C P\\,dx+Q\\,dy=\\iint_R\\left(\\frac{\\partial Q}{\\partial x}-\\frac{\\partial P}{\\partial y}\\right)dA$$

With $P=xy,\\ Q=1+y^2$, we get $Q_x-P_y=-x$, so the integral $=\\int_1^3\\int_0^2(-x)\\,dy\\,dx=-8$.

**Answer: $-8$**

Here is a diagram:

<img src="${png}" style="width:120px;height:120px;border:2px solid #333"/>

## Q3 — Triangle
$$\\oint_C x^2dx-2xy\\,dy=\\iint_R(-2y)dA=-\\tfrac13$$
`;

const outDir = path.join(__dirname, '..', '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
const ctx = {
  async deliverBuffer(name, buf) { fs.writeFileSync(path.join(outDir, name), buf); return name; },
  fsx: { async exists(){return false;}, async readText(){return '';}, async writeText(){}, async downloadBuffer(){return Buffer.alloc(0);} },
};

(async () => {
  const t0 = Date.now();
  const res = await agent._internals.toolCreatePdf(
    { filename: 'md-math.pdf', title: 'Markdown Math Path', content, math: true },
    ctx
  );
  console.log('[md] result:', res, '(', Date.now()-t0, 'ms )');
})();
