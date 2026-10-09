// ─────────────────────────────────────────────────────────────────────────────
// latexRender.js — make maths look PERFECT on chat platforms (WhatsApp/Telegram).
//
// Chat apps render plain text only, so a model reply full of raw LaTeX like
// "\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}" looks like garbage to the user. This helper:
//
//   1. detectMath(text)        → does the reply actually contain LaTeX/maths?
//   2. renderMathImage(text)   → render the WHOLE reply (markdown + MathJax) to a
//                                clean PNG via Browserless so every equation is
//                                beautifully typeset, returned as a Buffer.
//   3. toReadableText(text)    → a best-effort Unicode cleanup of the text reply
//                                (strip $ / \( \) delimiters, common commands →
//                                Unicode) so even the text caption reads nicely.
//
// The bots call detectMath() on the agent's final answer; if true they render an
// image and send it alongside the (cleaned) text. If Browserless is down they
// just fall back to the cleaned text — never a hard failure.
// ─────────────────────────────────────────────────────────────────────────────

const browserless = require('./browserless');

// ── 1) Detect real LaTeX / maths in a reply ─────────────────────────────────
// We look for $...$, $$...$$, \( \), \[ \], \begin{...}, or common TeX commands
// (\frac, \sqrt, \sum, superscripts/subscripts) — but ignore lone "$" used as a
// currency sign so we don't render every price as an image.
function detectMath(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/\$\$[\s\S]+?\$\$/.test(s)) return true;                 // $$ display $$  // eslint-disable-line no-useless-escape
  if (/\\\([\s\S]+?\\\)/.test(s)) return true;                 // \( inline \)
  if (/\\\[[\s\S]+?\\\]/.test(s)) return true;                 // \[ display \]
  if (/\\begin\{[a-z*]+\}/i.test(s)) return true;              // \begin{align} …
  if (/\\(frac|sqrt|sum|int|prod|lim|infty|alpha|beta|gamma|theta|pi|cdot|times|partial|nabla|vec|hat|bar|binom|matrix|pmatrix|bmatrix)\b/.test(s)) return true;
  // Inline $ … $ with at least one math-ish token inside (avoid "$5 and $10").
  const inline = s.match(/\$[^\$\n]{2,}\$/g) || [];  // eslint-disable-line no-useless-escape
  for (const m of inline) {
    if (/[\\^_{}=+\-*/]|\b(sin|cos|tan|log|ln|sqrt|frac)\b/.test(m.slice(1, -1))  // eslint-disable-line no-useless-escape
    ) return true;
  }
  return false;
}

// ── Minimal Markdown → HTML (headings, bold, italics, code, lists) ──────────
// Math delimiters are left untouched so MathJax can process them in the browser.
function mdToHtml(md) {
  const escapeOutsideMath = (line) => line
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = String(md || '').split('\n');
  let html = '';
  let inList = false, inCode = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const t = raw.replace(/\t/g, '    ');
    if (/^\s*```/.test(t)) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { closeList(); html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += escapeOutsideMath(raw) + '\n'; continue; }
    const tt = t.trim();
    if (!tt) { closeList(); html += '<br>'; continue; }
    let inline = escapeOutsideMath(tt)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (tt.startsWith('### ')) { closeList(); html += `<h3>${inline.slice(4)}</h3>`; }
    else if (tt.startsWith('## ')) { closeList(); html += `<h2>${inline.slice(3)}</h2>`; }
    else if (tt.startsWith('# ')) { closeList(); html += `<h1>${inline.slice(2)}</h1>`; }
    else if (/^[-*]\s+/.test(tt)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline.replace(/^[-*]\s+/, '')}</li>`;
    } else { closeList(); html += `<p>${inline}</p>`; }
  }
  if (inCode) html += '</code></pre>';
  closeList();
  return html;
}

// Build a compact, chat-friendly HTML doc (white card, MathJax typesetting).
function buildChatMathHtml(text) {
  const body = mdToHtml(text);
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#fff;}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:18px;line-height:1.5;color:#111;
       padding:22px 26px;display:inline-block;max-width:760px;}
  h1{font-size:24px;margin:.2em 0 .4em;} h2{font-size:21px;margin:.4em 0 .3em;} h3{font-size:19px;margin:.4em 0 .3em;}
  p{margin:.35em 0;} ul{margin:.3em 0 .5em 1.2em;padding:0;} li{margin:.15em 0;}
  code{background:#f3f3f3;padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:.92em;}
  pre{background:#f6f8fa;padding:10px 12px;border-radius:8px;overflow:auto;}
  pre code{background:none;padding:0;}
  mjx-container{margin:.15em 0;}
</style>
<script>
  window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']],displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'global'},
    startup:{pageReady(){return MathJax.startup.defaultPageReady().then(function(){window.__mjReady=true;});}}};
  setTimeout(function(){ if(!window.__mjReady) window.__mjReady=true; }, 6000);
</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
</head><body>${body}</body></html>`;
}

// ── 2) Render the whole reply to a clean PNG (Buffer) ───────────────────────
// Returns a PNG Buffer, or null if rendering isn't possible (no Browserless).
async function renderMathImage(text) {
  try {
    const html = buildChatMathHtml(text);
    const buf = await browserless.htmlToImage(html, { type: 'png', fullPage: true, width: 800 });
    if (buf && buf.length > 500) return buf;
  } catch (_) { /* fall through */ }
  return null;
}

// ── 3) Best-effort Unicode cleanup so the TEXT caption still reads well ─────
const GREEK = {
  alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',
  iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',pi:'π',rho:'ρ',sigma:'σ',
  tau:'τ',phi:'φ',chi:'χ',psi:'ψ',omega:'ω',
  Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
};
const SUP = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ','i':'ⁱ'};
const SUB = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','a':'ₐ','x':'ₓ'};

// Match balanced braces: given a string starting at position `pos` (which must
// be '{'), return the content inside the outermost braces, accounting for
// nesting. Returns null if pos is out of range or the char at pos isn't '{'.
function matchBraces(s, pos) {
  if (pos >= s.length || s[pos] !== '{') return null;
  let depth = 0, i = pos;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null; // unbalanced
  return s.slice(pos + 1, i);   // content between outer { }
}

function toReadableText(text) {
  let s = String(text || '');
  // Strip math-mode delimiters but keep the content.
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => ' ' + m.trim() + ' ');  // eslint-disable-line no-useless-escape
  s = s.replace(/\\\[[\s\S]+?\\\]/g, (_, m) => ' ' + m.trim() + ' ');
  s = s.replace(/\\\([\s\S]+?\\\)/g, (_, m) => m.trim());
  s = s.replace(/\$([^\$\n]+?)\$/g, (_, m) => m.trim());  // eslint-disable-line no-useless-escape

  // ── Common LaTeX → Unicode ──
  // Process \frac{...}{...} and \sqrt{...} with BALANCED brace matching so
  // nested expressions like \frac{-b\pm\sqrt{b^2-4ac}}{2a} work correctly.
  // The old [^{}]+ regex couldn't match braces inside braces, causing garbled
  // output like "x=\frac-b±√(b²-4ac)2a" instead of "(−b±√(b²−4ac))/(2a)".
  // We apply these substitutions REPEATEDLY until the string stabilises so
  // nested \frac/\sqrt inside \frac are resolved too (inner→outer).
  let prev;
  do {
    prev = s;
    // \frac{A}{B} → (A)/(B) — balanced braces
    s = s.replace(/\\frac\s*\{/, (m, offset) => {
      const braceStart = offset + m.length - 1; // -1 because '{' is last char of match
      const num = matchBraces(s, braceStart);
      if (!num) return m; // can't match — leave as-is
      // After the numerator braces, find the denominator braces
      let afterNum = braceStart + num.length + 2; // skip {content}
      // Skip whitespace between the two brace groups
      while (afterNum < s.length && /\s/.test(s[afterNum])) afterNum++;
      if (afterNum >= s.length || s[afterNum] !== '{') return m;
      const den = matchBraces(s, afterNum);
      if (!den) return m;
      const fullMatch = s.slice(offset, afterNum + den.length + 2);
      return `(${num})/(${den})`;
    });
    // \sqrt{A} → √(A) — balanced braces
    s = s.replace(/\\sqrt\s*\{/, (m, offset) => {
      const braceStart = offset + m.length - 1;
      const content = matchBraces(s, braceStart);
      if (!content) return m;
      return `√(${content})`;
    });
  } while (s !== prev);

  s = s.replace(/\\sqrt\s+(\w)/g, '√$1');
  s = s.replace(/\\(left|right)\b/g, '');
  s = s.replace(/\\pm\b/g, '±').replace(/\\mp\b/g, '∓');
  s = s.replace(/\\times\b/g, '×').replace(/\\div\b/g, '÷').replace(/\\cdot\b/g, '·');
  s = s.replace(/\\leq\b/g, '≤').replace(/\\geq\b/g, '≥').replace(/\\neq\b/g, '≠');
  s = s.replace(/\\approx\b/g, '≈').replace(/\\equiv\b/g, '≡');
  s = s.replace(/\\infty\b/g, '∞').replace(/\\partial\b/g, '∂').replace(/\\nabla\b/g, '∇');
  s = s.replace(/\\sum\b/g, '∑').replace(/\\prod\b/g, '∏').replace(/\\int\b/g, '∫');
  s = s.replace(/\\rightarrow\b|\\to\b/g, '→').replace(/\\Rightarrow\b/g, '⇒').replace(/\\leftarrow\b/g, '←');
  s = s.replace(/\\in\b/g, '∈').replace(/\\notin\b/g, '∉').replace(/\\subset\b/g, '⊂').replace(/\\cup\b/g, '∪').replace(/\\cap\b/g, '∩');
  // Greek letters.
  s = s.replace(/\\([A-Za-z]+)\b/g, (m, name) => GREEK[name] != null ? GREEK[name] : m);
  // Superscripts / subscripts (single char or braced).
  s = s.replace(/\^{([^{}]+)}/g, (_, m) => mapEach(m, SUP));
  s = s.replace(/\^(\w)/g, (_, c) => SUP[c] || ('^' + c));
  s = s.replace(/_{([^{}]+)}/g, (_, m) => mapEach(m, SUB));
  s = s.replace(/_(\w)/g, (_, c) => SUB[c] || ('_' + c));
  // Drop any remaining lone braces/backslashes from simple expressions.
  s = s.replace(/\\,/g, ' ').replace(/\\!/g, '').replace(/\\;/g, ' ');
  s = s.replace(/\{([^{}]*)\}/g, '$1');
  return s;
}

function mapEach(str, table) {
  let out = '';
  let ok = true;
  for (const ch of str) {
    if (table[ch] != null) out += table[ch];
    else { ok = false; break; }
  }
  // If every char mapped, return the unicode form, else keep a readable fallback.
  return ok ? out : str;
}

module.exports = { detectMath, renderMathImage, toReadableText, buildChatMathHtml };
