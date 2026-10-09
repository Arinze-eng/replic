'use strict';

// Automatic, best-effort publishing for educational STEM solutions.
// A qualifying answer is always made available as:
//   1) a readable PDF (existing agent PDF preferred; generated only if missing),
//   2) a responsive Cloudflare Pages solution page with MathJax, tables,
//      Mermaid diagrams, charts, long-answer scrolling, and an embedded PDF.
// Publishing never blocks the answer, never runs for stopped/failed tasks, and
// refuses content that resembles credentials or private/authentication data.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const cloudflarePages = require('./cloudflarePages');
const browserless = require('./browserless');

const STEM_TERMS = /\b(math(?:s|ematics|ematical)?|algebra|calculus|geometry|trigonometry|statistics|probability|equation|integral|derivative|matrix|vector|physics|mechanics|electricity|magnetism|thermodynamics|optics|quantum|chemistry|chemical|moles?|molarity|stoichiometry|reaction|periodic|engineering|circuit|structural|fluid|kinematics|dynamics|force|velocity|acceleration|voltage|current|resistance|momentum|energy|torque)\b/i;
const STEM_VERBS = /\b(solve|calculate|compute|derive|prove|evaluate|simplify|find|determine|explain|show\s+(?:all|the)\s+work|step[ -]?by[ -]?step)\b/i;
const FORMULA_SIGNAL = /(?:\d\s*[+*/^=]\s*\d|\b(?:sin|cos|tan|log|ln|sqrt)\s*\(|\\(?:frac|int|sum|sqrt|begin)|\$[^$]+\$)/i;
const DOCUMENT_SIGNAL = /\b(pdf|report|worksheet|solution\s+sheet|past\s+questions?|exam\s+solutions?|diagram|chart|graph|table)\b/i;
const SOFTWARE_TASK = /\b(repository|repo|github|git\b|deploy|render\.com|cloudflare\s+pages|website|web\s*app|api\b|database|server|frontend|backend|source\s+code|bug|commit|pull\s+request|docker|npm|node\.js|python\s+(?:file|script)|flutter|android)\b/i;
const FAILURE_SIGNAL = /^(?:\s*[❌⚠️🛑]|\s*(?:sorry|error|failed|stopped)\b)/i;
const SECRET_SIGNAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|service[_ -]?key|private[_ -]?key|access[_ -]?token|api[_ -]?key|authorization)\s*[:=]|\b(?:ghp|github_pat|sk|sbp|cfut|rnd|dtn|box|hopx_live)_[A-Za-z0-9._-]{12,}|\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

const SYSTEM_PROMPT_CONTRACT = `
## AUTOMATIC STEM SOLUTION CONTRACT
When the CURRENT TASK is a mathematics, physics, chemistry, or engineering question:
- Never return only the final answer. State givens/unknowns, choose and justify the governing principle or formula, substitute values with units, show every meaningful algebra/calculation step, verify the result (units, sign, scale, or an independent check), and clearly box/state the final answer.
- For multiple questions, solve every numbered item in order and include a compact answer summary table.
- Create one polished PDF containing the complete solution, with properly typeset LaTeX equations and tables.
- When a diagram, graph, chart, circuit, free-body diagram, geometry figure, reaction scheme, or data plot improves correctness, create and label it, then include it in the PDF. Never invent measured data.
- Long question sets must remain complete; use a content file and multiple append steps instead of truncating.
- Do not expose credentials, private keys, tokens, passwords, or private source material in any public page.
The host automatically publishes the completed educational solution to a responsive Cloudflare Pages view, so the final message should retain a useful solution summary and must not omit the reasoning merely because a PDF was created.`;

function classifyTask(task) {
  const text = String(task || '').trim();
  if (!text || SOFTWARE_TASK.test(text)) return { publish: false, reason: 'non-educational-or-software' };
  if (SECRET_SIGNAL.test(text)) return { publish: false, reason: 'sensitive' };
  const stem = STEM_TERMS.test(text) || FORMULA_SIGNAL.test(text);
  const actionable = STEM_VERBS.test(text) || /\?/.test(text) || FORMULA_SIGNAL.test(text);
  const document = DOCUMENT_SIGNAL.test(text) && !/\b(?:edit|merge|convert|sign|fill)\b/i.test(text);
  return { publish: !!((stem && actionable) || (stem && document)), stem, document, reason: 'stem-solution' };
}

function containsSensitive(text) {
  return SECRET_SIGNAL.test(String(text || ''));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  const math = [];
  const placeholder = (m) => { math.push(m); return `\u0000MATH${math.length - 1}\u0000`; };
  let out = String(text || '').replace(/\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$\$[\s\S]*?\$\$|\$(?!\s)[^$\n]+?\$/g, placeholder);
  out = escapeHtml(out)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out.replace(/\u0000MATH(\d+)\u0000/g, (_, i) => escapeHtml(math[Number(i)] || ''));
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let html = '';
  let list = null;
  let code = null;
  let codeLang = '';
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const flushCode = () => {
    if (code === null) return;
    const body = code.join('\n');
    if (/^(mermaid|diagram)$/i.test(codeLang)) {
      html += `<div class="diagram-card"><div class="mermaid">${escapeHtml(body)}</div></div>`;
    } else if (/^(chart|chartjs)$/i.test(codeLang)) {
      const id = `chart-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}`;
      html += `<div class="diagram-card"><canvas id="${id}" aria-label="Solution chart"></canvas><script type="application/json" data-chart-for="${id}">${escapeHtml(body)}</script></div>`;
    } else {
      html += `<pre><code>${escapeHtml(body)}</code></pre>`;
    }
    code = null; codeLang = '';
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const fence = t.match(/^```\s*([\w-]*)/);
    if (fence) {
      closeList();
      if (code !== null) flushCode(); else { code = []; codeLang = fence[1] || ''; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }
    if (!t) { closeList(); continue; }

    if (/\|/.test(t) && lines[i + 1] && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      closeList();
      const cells = (s) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(x => x.trim());
      const heads = cells(t);
      let table = '<div class="table-wrap"><table><thead><tr>' + heads.map(x => `<th>${inlineMarkdown(x)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        const row = cells(lines[i]);
        table += '<tr>' + heads.map((_, n) => `<td>${inlineMarkdown(row[n] || '')}</td>`).join('') + '</tr>';
        i++;
      }
      i--;
      html += table + '</tbody></table></div>';
      continue;
    }
    const heading = t.match(/^(#{1,5})\s+(.+)/);
    if (heading) { closeList(); const n = Math.min(heading[1].length + 1, 6); html += `<h${n}>${inlineMarkdown(heading[2])}</h${n}>`; continue; }
    const bullet = t.match(/^[-*+]\s+(.+)/);
    const numbered = t.match(/^\d+[.)]\s+(.+)/);
    if (bullet || numbered) {
      const kind = numbered ? 'ol' : 'ul';
      if (list !== kind) { closeList(); list = kind; html += `<${kind}>`; }
      html += `<li>${inlineMarkdown((numbered || bullet)[1])}</li>`;
      continue;
    }
    closeList();
    if (/^>\s?/.test(t)) html += `<blockquote>${inlineMarkdown(t.replace(/^>\s?/, ''))}</blockquote>`;
    else if (/^---+$/.test(t)) html += '<hr>';
    else html += `<p>${inlineMarkdown(t)}</p>`;
  }
  closeList();
  flushCode();
  return html;
}

function deriveTitle(task, answer) {
  const heading = String(answer || '').match(/^\s*#{1,3}\s+(.{4,100})$/m);
  if (heading) return heading[1].replace(/[*_`]/g, '').trim();
  const first = String(task || '').replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '');
  return (first || 'Step-by-step STEM solution').slice(0, 100);
}

function buildSolutionHtml({ title, task, answer, pdfName }) {
  const answerHtml = markdownToHtml(answer);
  const pdfBlock = pdfName ? `<section class="pdf-section" aria-labelledby="pdf-title"><div class="section-head"><div><span class="eyebrow">Printable version</span><h2 id="pdf-title">Complete solution PDF</h2></div><a class="button" href="${encodeURIComponent(pdfName)}" download>Download PDF</a></div><iframe src="${encodeURIComponent(pdfName)}#view=FitH" title="Complete solution PDF"></iframe></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title>
<style>
:root{--ink:#172033;--muted:#68738a;--line:#dfe5ef;--paper:#fff;--accent:#3157d5;--accent2:#19a78b;--wash:#f4f7fc;--shadow:0 18px 55px rgba(26,42,78,.12)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(135deg,#edf3ff 0,#f8fbff 40%,#eefaf7 100%);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.68}.shell{width:min(1160px,calc(100% - 28px));margin:0 auto;padding:34px 0 72px}.hero,.solution,.pdf-section{background:rgba(255,255,255,.96);border:1px solid rgba(223,229,239,.95);border-radius:24px;box-shadow:var(--shadow)}.hero{padding:clamp(28px,5vw,60px);position:relative;overflow:hidden}.hero:after{content:"";position:absolute;width:260px;height:260px;border-radius:50%;right:-90px;top:-110px;background:linear-gradient(135deg,rgba(49,87,213,.18),rgba(25,167,139,.18))}.eyebrow{display:block;color:var(--accent);font-size:.77rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px}h1{font-size:clamp(2rem,5vw,4rem);line-height:1.08;max-width:900px;margin:0 0 22px;letter-spacing:-.045em}.question{max-width:900px;padding:16px 18px;border-left:4px solid var(--accent2);border-radius:0 12px 12px 0;background:var(--wash);white-space:pre-wrap;color:#34405a}.solution,.pdf-section{margin-top:22px;padding:clamp(22px,4vw,44px)}.solution{max-height:none;overflow:visible}.solution h2,.solution h3,.solution h4{line-height:1.25;letter-spacing:-.02em;margin-top:1.8em;scroll-margin-top:20px}.solution h2:first-child{margin-top:0}.solution p{font-size:1.04rem;margin:.8em 0}.solution code{background:#eef2f8;border:1px solid #e0e6f0;border-radius:6px;padding:2px 6px}.solution pre{overflow:auto;background:#152038;color:#eaf0ff;padding:18px;border-radius:14px}.solution blockquote{margin:18px 0;padding:12px 18px;border-left:4px solid var(--accent);background:#f7f9ff;color:#3f4a63}.table-wrap{overflow-x:auto;margin:20px 0;border:1px solid var(--line);border-radius:14px}table{width:100%;border-collapse:collapse;min-width:520px}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#eef3ff;font-size:.86rem;text-transform:uppercase;letter-spacing:.04em}tr:last-child td{border-bottom:0}.diagram-card{overflow:auto;margin:24px 0;padding:20px;border:1px solid var(--line);border-radius:16px;background:#fff}.section-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin-bottom:18px}.section-head h2{margin:0;font-size:clamp(1.45rem,3vw,2.2rem)}.button{display:inline-flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:750;padding:11px 16px;border-radius:11px;white-space:nowrap}.pdf-section iframe{display:block;width:100%;height:min(78vh,920px);min-height:560px;border:1px solid var(--line);border-radius:14px;background:#f2f4f8}.footer{text-align:center;color:var(--muted);font-size:.86rem;padding-top:28px}@media(max-width:680px){.shell{width:min(100% - 16px,1160px);padding-top:8px}.hero,.solution,.pdf-section{border-radius:18px}.section-head{align-items:stretch;flex-direction:column}.pdf-section iframe{min-height:72vh}h1{font-size:2.15rem}}@media print{body{background:#fff}.shell{width:100%;padding:0}.hero,.solution{box-shadow:none;border:0}.pdf-section,.footer{display:none}}
</style>
<script>window.MathJax={tex:{inlineMath:[["\\(","\\)"],["$","$"]],displayMath:[["\\[","\\]"],["$$","$$"]],processEscapes:true},svg:{fontCache:"global"},options:{skipHtmlTags:["script","noscript","style","textarea","pre","code"]}};</script><script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script><script defer src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" onload="mermaid.initialize({startOnLoad:true,theme:'neutral',securityLevel:'strict'})"></script><script defer src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head><body><main class="shell"><header class="hero"><span class="eyebrow">Worked solution</span><h1>${escapeHtml(title)}</h1><div class="question"><strong>Question</strong><br>${escapeHtml(task)}</div></header><article class="solution" id="solution"><span class="eyebrow">Step-by-step reasoning</span>${answerHtml}</article>${pdfBlock}<footer class="footer">Equations rendered with MathJax · diagrams and tables remain scrollable on small screens</footer></main>
<script>window.addEventListener('load',()=>{document.querySelectorAll('script[data-chart-for]').forEach(n=>{try{const cfg=JSON.parse(n.textContent);const el=document.getElementById(n.dataset.chartFor);if(el&&window.Chart)new Chart(el,cfg)}catch(e){console.warn('Chart configuration skipped')}})});</script></body></html>`;
}

function bestPdf(files) {
  return (Array.isArray(files) ? files : []).find(f => f && /\.pdf$/i.test(f.name || f.path || '') && (f.path || f.buffer || f.b64));
}

async function readFileBuffer(file) {
  if (!file) return null;
  if (Buffer.isBuffer(file.buffer)) return file.buffer;
  if (file.b64) return Buffer.from(file.b64, 'base64');
  if (file.path && fs.existsSync(file.path)) return fs.readFileSync(file.path);
  return null;
}

async function extractPdfText(buffer) {
  if (!buffer || buffer.length < 1000) return '';
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return String(parsed && parsed.text || '').trim();
  } catch (_) { return ''; }
}

function appendLink(message, url) {
  const text = String(message || '✅ Solution complete.').trim();
  if (!url || text.includes(url)) return text;
  return `${text}\n\n🌐 Interactive step-by-step solution: ${url}`;
}

async function postProcessResult(opts, result, deps = {}) {
  const out = result && typeof result === 'object' ? result : { message: String(result || '') };
  try {
    if (out.solutionUrl) return out;
    const task = String(opts && opts.task || '');
    const classification = classifyTask(task);
    if (!classification.publish || out.stopped || FAILURE_SIGNAL.test(String(out.message || ''))) return out;
    if (containsSensitive(task) || containsSensitive(out.message)) return out;
    if (opts && opts.signal && opts.signal.aborted) return out;

    const onStep = opts && typeof opts.onStep === 'function' ? opts.onStep : () => {};
    const files = Array.isArray(out.files) ? out.files.slice() : [];
    let pdf = bestPdf(files);
    let pdfBuffer = await readFileBuffer(pdf);
    let answer = String(out.message || '').trim();
    if (pdfBuffer) {
      const extracted = await extractPdfText(pdfBuffer);
      if (extracted && (answer.length < 700 || /attached|pdf|complete/i.test(answer))) answer = extracted;
    }
    if (!answer) answer = 'The complete worked solution is provided in the PDF below.';
    const title = deriveTitle(task, answer);

    // Render the exact same responsive solution page to PDF when the agent did
    // not already produce one. Failure is non-fatal: the web page still deploys.
    let pdfName = pdfBuffer ? String(pdf.name || 'solution.pdf').replace(/[^\w.-]/g, '_') : 'worked_solution.pdf';
    let html = buildSolutionHtml({ title, task, answer, pdfName: pdfBuffer ? pdfName : null });
    if (!pdfBuffer) {
      try {
        onStep('📄 creating the complete worked-solution PDF…');
        const renderPdf = deps.htmlToPdf || browserless.htmlToPdf;
        pdfBuffer = await renderPdf(html, { waitFor: 4500 });
        if (pdfBuffer && pdfBuffer.length > 1000) {
          const dir = out.workdir && fs.existsSync(out.workdir) ? out.workdir : fs.mkdtempSync(path.join(os.tmpdir(), 'stem_solution_'));
          const pdfPath = path.join(dir, pdfName);
          fs.writeFileSync(pdfPath, pdfBuffer);
          files.push({ path: pdfPath, name: pdfName, rel: pdfName });
          out.workdir = dir;
          html = buildSolutionHtml({ title, task, answer, pdfName });
        } else pdfBuffer = null;
      } catch (_) { pdfBuffer = null; }
    }

    const siteFiles = [{ rel: 'index.html', buffer: Buffer.from(html, 'utf8') }];
    if (pdfBuffer) siteFiles.push({ rel: pdfName, buffer: pdfBuffer });
    const deployer = deps.deploy || cloudflarePages.deploy;
    if (!(deps.deploy || cloudflarePages.enabled())) return { ...out, files };
    onStep('🌐 publishing the interactive solution to Cloudflare Pages…');
    const deployed = await deployer({
      userKey: String(opts.sessionKey || opts.userKey || 'anon'),
      files: siteFiles,
      onStep,
    });
    const url = deployed && (deployed.projectUrl || deployed.url);
    return { ...out, message: appendLink(out.message, url), files, solutionUrl: url || null };
  } catch (e) {
    try { if (opts && typeof opts.onStep === 'function') opts.onStep(`⚠️ solution publishing was skipped: ${String(e.message || e).slice(0, 100)}`); } catch (_) {}
    return out;
  }
}

module.exports = {
  SYSTEM_PROMPT_CONTRACT,
  classifyTask,
  containsSensitive,
  markdownToHtml,
  buildSolutionHtml,
  appendLink,
  postProcessResult,
};
