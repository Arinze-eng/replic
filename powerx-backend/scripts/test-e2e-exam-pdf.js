// End-to-end test of the REAL production flow: agentEngine.toolCreatePdf
// (rich-HTML path) -> browserless.htmlToPdf -> local Chromium. Uses the exact
// 3 calculus questions the user gave, each with MathJax + a diagram/chart.
process.env.PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/data/coda/dr4awfq4/ws/cc7e4ae7-a968-4b31-9c71-c3f115c9ed3b/work/.chrome/chrome/linux-150.0.7871.46/chrome-linux64/chrome';

const fs = require('fs');
const path = require('path');
const agent = require('../services/agentEngine');

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
 body{font-family:Georgia,'Segoe UI',serif;font-size:12pt;line-height:1.65;color:#1a1a1a;padding:6px 14px;}
 h1{font-size:19pt;color:#0d47a1;border-bottom:2px solid #0d47a1;padding-bottom:5px;margin-top:1.2em;}
 h2{font-size:14pt;color:#333;}
 .step{background:#f7f9fc;border-left:4px solid #1976d2;padding:8px 14px;margin:.6em 0;border-radius:4px;}
 .answer{background:#e8f5e9;border:1px solid #43a047;padding:8px 14px;border-radius:6px;font-weight:600;}
 .diagram{margin:1em 0;text-align:center;}
 canvas{max-width:100%;}
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
</head><body>

<h1>Q1 — Line Integral by Parametrization</h1>
<p>Evaluate \\( \\displaystyle\\oint_C xy\\,dx + (1+y^2)\\,dy \\) where C is the boundary of rectangle A(1,0), B(3,0), C(3,2), D(1,2).</p>
<div class="step">By Green's theorem \\( \\displaystyle\\oint_C P\\,dx+Q\\,dy=\\iint_R\\Big(\\frac{\\partial Q}{\\partial x}-\\frac{\\partial P}{\\partial y}\\Big)dA \\), with \\(P=xy,\\ Q=1+y^2\\Rightarrow Q_x=0,\\ P_y=x\\).</div>
<div class="step">\\( \\displaystyle\\int_1^3\\!\\!\\int_0^2(0-x)\\,dy\\,dx=-\\int_1^3 2x\\,dx=-\\big[x^2\\big]_1^3=-(9-1) \\)</div>
<p class="answer">Answer: −8</p>
<div class="diagram">
 <svg width="240" height="170" viewBox="0 0 240 170" xmlns="http://www.w3.org/2000/svg">
  <rect x="50" y="40" width="140" height="90" fill="#e3f2fd" stroke="#0d47a1" stroke-width="2"/>
  <circle cx="50" cy="130" r="3"/><text x="20" y="150" font-size="11">A(1,0)</text>
  <circle cx="190" cy="130" r="3"/><text x="175" y="150" font-size="11">B(3,0)</text>
  <circle cx="190" cy="40" r="3"/><text x="175" y="34" font-size="11">C(3,2)</text>
  <circle cx="50" cy="40" r="3"/><text x="20" y="34" font-size="11">D(1,2)</text>
 </svg>
</div>

<h1>Q2 — Area Between Two Parabolas</h1>
<p>Find the area bounded by \\(y=(x-1)^2\\) and \\(y=4-(x-3)^2\\).</p>
<div class="step">Intersect: \\((x-1)^2=4-(x-3)^2\\Rightarrow 2x^2-8x+6=0\\Rightarrow x=1,3\\).</div>
<div class="step">\\( \\displaystyle A=\\int_1^3\\Big[(4-(x-3)^2)-(x-1)^2\\Big]dx=\\int_1^3(-2x^2+8x-6)\\,dx=\\frac{8}{3} \\)</div>
<p class="answer">Answer: 8/3 ≈ 2.667 square units</p>
<div class="diagram"><canvas id="c2" width="480" height="290"></canvas></div>

<h1>Q3 — Line Integral over a Triangle</h1>
<p>Evaluate \\( \\displaystyle\\oint_C x^2\\,dx - 2xy\\,dy \\) over the triangle O(0,0), A(1,0), B(0,1).</p>
<div class="step">Green's: \\(P=x^2,\\ Q=-2xy\\Rightarrow Q_x-P_y=-2y\\).</div>
<div class="step">\\( \\displaystyle\\iint_R(-2y)\\,dA=-2\\int_0^1\\!\\!\\int_0^{1-x} y\\,dy\\,dx=-\\int_0^1(1-x)^2dx=-\\frac{1}{3} \\)</div>
<p class="answer">Answer: −1/3</p>
<div class="diagram">
 <svg width="180" height="170" viewBox="0 0 180 170" xmlns="http://www.w3.org/2000/svg">
  <polygon points="40,130 150,130 40,30" fill="#fff3e0" stroke="#e65100" stroke-width="2"/>
  <text x="18" y="145" font-size="11">O(0,0)</text>
  <text x="135" y="145" font-size="11">A(1,0)</text>
  <text x="18" y="28" font-size="11">B(0,1)</text>
 </svg>
</div>

<script>
(function(){
  function draw(){
    if(!window.Chart){ setTimeout(draw,150); return; }
    var xs=[],y1=[],y2=[];
    for(var x=0;x<=4;x+=0.1){ xs.push(x.toFixed(1)); y1.push(Math.pow(x-1,2)); y2.push(4-Math.pow(x-3,2)); }
    new Chart(document.getElementById('c2'),{type:'line',
      data:{labels:xs,datasets:[
        {label:'y=(x-1)^2',data:y1,borderColor:'#e53935',fill:false,pointRadius:0,tension:.2},
        {label:'y=4-(x-3)^2',data:y2,borderColor:'#1e88e5',fill:false,pointRadius:0,tension:.2}]},
      options:{animation:false,responsive:false,plugins:{legend:{position:'top'}},scales:{y:{min:-1,max:6}}}});
    window.__chartReady=true;
  }
  draw();
})();
</script>
</body></html>`;

// Fake ctx that captures the delivered PDF buffer to disk (mirrors ctx.deliverBuffer).
const outDir = path.join(__dirname, '..', '..', 'out');
fs.mkdirSync(outDir, { recursive: true });
const delivered = {};
const ctx = {
  async deliverBuffer(name, buf) {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, buf);
    delivered[name] = buf.length;
    return name;
  },
  fsx: {
    async exists() { return false; },
    async readText() { return ''; },
    async writeText() {},
    async downloadBuffer() { return Buffer.alloc(0); },
  },
};

(async () => {
  const t0 = Date.now();
  const res = await agent._internals.toolCreatePdf(
    { filename: 'exam-solutions.pdf', html, title: 'Calculus — Solved Past Questions' },
    ctx
  );
  console.log('[e2e] toolCreatePdf result:', res);
  console.log('[e2e] delivered:', JSON.stringify(delivered), 'in', Date.now()-t0, 'ms');
  const p = path.join(outDir, 'exam-solutions.pdf');
  if (fs.existsSync(p)) {
    const sz = fs.statSync(p).size;
    console.log('[e2e] file size:', sz, sz > 30000 ? 'OK (rich)' : 'SUSPICIOUS (too small)');
  } else {
    console.log('[e2e] NO FILE PRODUCED');
  }
})();
