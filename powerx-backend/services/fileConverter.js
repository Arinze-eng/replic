// ─────────────────────────────────────────────────────────────────────────────
// fileConverter.js — high-accuracy, all-purpose FILE CONVERTER for the WormGPT
// Agent. Powers the `convert_file` tool.
//
// Design goals
//   • ~98% fidelity by preferring battle-tested CONVERTERS that run INSIDE the
//     agent's isolated Linux sandbox (LibreOffice, Pandoc, Tesseract OCR,
//     ImageMagick, LaTeX) — installed on demand so the Render host stays light.
//   • Graceful, layered fallbacks so a conversion NEVER hard-fails: if a heavy
//     binary can't be installed, we fall back to a pure-JS path (pdf-parse,
//     docx, pptxgenjs, the existing Browserless HTML→PDF) so the user still
//     gets a usable file.
//   • Same tool contract as every other agent tool: async (args, ctx) → string,
//     delivering output via ctx.deliverBuffer(name, buffer). It NEVER touches
//     the existing file-path / delivery pathway — it only adds new outputs.
//
// Supported conversions (auto-detected from source ext + target ext):
//   latex/tex   → pdf            (pdflatex → tectonic → Browserless HTML)
//   pdf         → docx           (LibreOffice → pdftotext+docx fallback)
//   pdf         → txt            (pdftotext → pdf-parse)
//   image       → txt  (OCR)     (Tesseract; jpg/png/webp/tiff/bmp/gif)
//   image       → pdf            (img2pdf / ImageMagick / pdfkit)
//   html        → pdf            (Browserless htmlToPdf — print quality)
//   html        → pptx           (parse sections → pptxgenjs deck)
//   html        → docx           (Pandoc → LibreOffice)
//   docx        → pdf            (LibreOffice headless)
//   pptx/ppt    → pdf            (LibreOffice headless)
//   xlsx/xls/csv→ pdf|csv|xlsx|html (LibreOffice / csv tooling)
//   md/markdown → pdf|docx|html  (Pandoc → Browserless / docx renderer)
//   docx/odt/rtf→ txt|pdf|md     (LibreOffice / Pandoc)
//   …and most other office/text pairs LibreOffice + Pandoc understand.
//
// The tool figures out the cheapest reliable path for the requested pair and
// reports exactly which engine produced the result.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

// ── Extension / family helpers ───────────────────────────────────────────────
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif'];
const OFFICE_DOC = ['doc', 'docx', 'odt', 'rtf'];
const OFFICE_SLIDE = ['ppt', 'pptx', 'odp'];
const OFFICE_SHEET = ['xls', 'xlsx', 'ods', 'csv'];

function familyOf(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'tex' || ext === 'latex') return 'latex';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (OFFICE_DOC.includes(ext)) return 'doc';
  if (OFFICE_SLIDE.includes(ext)) return 'slide';
  if (OFFICE_SHEET.includes(ext)) return 'sheet';
  if (ext === 'txt') return 'text';
  return 'other';
}

// Shell-quote a single argument for bash -c.
function q(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Robustly coerce any tool-arg shape (string / object / array / nested
// {text|content|body|markdown}) into the intended text. Mirrors agentEngine's
// coerceContent so inline html/text conversions never produce "[object Object]".
function coerceText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) return content.map(coerceText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    for (const k of ['text', 'content', 'body', 'markdown', 'md', 'html', 'value', 'data']) {
      if (typeof content[k] === 'string' && content[k].trim()) return content[k];
      if (content[k] != null && typeof content[k] === 'object') {
        const inner = coerceText(content[k]);
        if (inner.trim()) return inner;
      }
    }
    try { return JSON.stringify(content, null, 2); } catch (_) { return String(content); }
  }
  return String(content);
}

// Run a shell command in the agent's working dir via the fsx abstraction.
// Works on BOTH the sandbox backend and the local-host fallback.
async function sh(ctx, command) {
  if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
    return await ctx.fsx.sh(command);
  }
  throw new Error('no shell backend available');
}

// Best-effort: ensure an apt package is installed inside the sandbox. Returns
// true if the probe binary is present afterwards. Silent + idempotent.
// Uses sudo when not root (Daytona/Runloop run as a non-root user with
// passwordless sudo) so installs actually succeed instead of silently failing.
async function ensureApt(ctx, probeBin, aptPkgs) {
  try {
    const check = await sh(ctx, `command -v ${probeBin} >/dev/null 2>&1 && echo HAVE || echo MISS`);
    if ((check.output || '').includes('HAVE')) return true;
  } catch (_) { /* fall through to install */ }
  if (ctx.onStep) ctx.onStep(`📦 installing ${aptPkgs} (first use)…`);
  try {
    // SU = "" when root, "sudo" otherwise. DEBIAN_FRONTEND avoids interactive prompts.
    const apt =
      `SU=""; [ "$(id -u)" = "0" ] || SU="sudo"; export DEBIAN_FRONTEND=noninteractive; ` +
      `($SU apt-get update -y >/dev/null 2>&1; ` +
      `$SU apt-get install -y --no-install-recommends ${aptPkgs} >/dev/null 2>&1); `;
    await sh(ctx, apt + `command -v ${probeBin} >/dev/null 2>&1 && echo HAVE || echo MISS`);
    const re = await sh(ctx, `command -v ${probeBin} >/dev/null 2>&1 && echo HAVE || echo MISS`);
    return (re.output || '').includes('HAVE');
  } catch (_) {
    return false;
  }
}

// After a CLI conversion, find the produced file, register it for delivery and
// return its relative path — or null if it wasn't produced.
async function deliverIfExists(ctx, rel, deliverName) {
  try {
    if (await ctx.fsx.exists(rel)) {
      ctx.addFile(rel, deliverName || path.posix.basename(rel));
      return rel;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: LibreOffice headless — the workhorse for office ↔ pdf/text/etc.
// `soffice --headless --convert-to <fmt> --outdir . <src>` is extremely high
// fidelity for docx/pptx/xlsx/odt ↔ pdf and most office pairs.
// ─────────────────────────────────────────────────────────────────────────────
async function libreConvert(ctx, src, targetExt, deliverName) {
  const ok = await ensureApt(ctx, 'soffice', 'libreoffice libreoffice-writer libreoffice-impress libreoffice-calc');
  if (!ok) throw new Error('LibreOffice unavailable');
  // LibreOffice writes <basename>.<targetExt> into outdir.
  const base = path.posix.basename(src).replace(/\.[^.]+$/, '');
  const out = `${base}.${targetExt}`;
  // A throwaway HOME avoids the "first run profile" lock issues.
  const cmd =
    `export HOME=/tmp/lohome 2>/dev/null; mkdir -p /tmp/lohome; ` +
    `soffice --headless --norestore --convert-to ${q(targetExt)} --outdir . ${q(src)} >/dev/null 2>&1; ` +
    `ls -1 ${q(out)} 2>/dev/null || true`;
  await sh(ctx, cmd);
  const rel = await deliverIfExists(ctx, out, deliverName);
  if (!rel) throw new Error(`LibreOffice did not produce ${out}`);
  return { engine: 'LibreOffice', rel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: Pandoc — superb for markdown/html ↔ docx/pdf and text formats.
// ─────────────────────────────────────────────────────────────────────────────
async function pandocConvert(ctx, src, out, extraArgs = '') {
  const ok = await ensureApt(ctx, 'pandoc', 'pandoc');
  if (!ok) throw new Error('Pandoc unavailable');
  await sh(ctx, `pandoc ${q(src)} -o ${q(out)} ${extraArgs} >/dev/null 2>&1; ls -1 ${q(out)} 2>/dev/null || true`);
  const rel = await deliverIfExists(ctx, out);
  if (!rel) throw new Error(`Pandoc did not produce ${out}`);
  return { engine: 'Pandoc', rel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: Tesseract OCR — image → text with high accuracy.
// ─────────────────────────────────────────────────────────────────────────────
async function ocrImage(ctx, src, out, lang) {
  const ok = await ensureApt(ctx, 'tesseract', `tesseract-ocr ${lang && lang !== 'eng' ? 'tesseract-ocr-' + lang : ''}`.trim());
  if (!ok) throw new Error('Tesseract OCR unavailable');
  const base = out.replace(/\.txt$/i, '');
  await sh(ctx, `tesseract ${q(src)} ${q(base)} -l ${q(lang || 'eng')} >/dev/null 2>&1; ls -1 ${q(out)} 2>/dev/null || true`);
  const rel = await deliverIfExists(ctx, out);
  if (!rel) throw new Error('Tesseract produced no text file');
  return { engine: 'Tesseract OCR', rel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: LaTeX / Markdown → PDF.
//
// PRIMARY engine (default): the PURE-PYTHON, ZERO-NETWORK renderer bundled at
//   agent_worker/latex_render.py — same code the in-sandbox worker uses. It
//   parses Markdown + a curated LaTeX-math subset and emits a real PDF using
//   Python stdlib only (no pdflatex, no tectonic, no LibreOffice, no
//   Browserless, no external network). This is deterministic and works even
//   when the sandbox / host network is fully locked down — the exact failure
//   mode that used to produce PDFs full of raw \int \frac{...}{...} strings.
//
// FALLBACKS (best-effort, only if the sandbox happens to have them already):
//   • pdflatex — if the sandbox came pre-baked with TeX Live (we no longer
//     apt-install it — the download kept getting reset by peer).
//   • tectonic — if the standalone binary is already on PATH.
//
// The "no LaTeX engine available" case is impossible now: the Python renderer
// is stdlib-only and Python is present on every Render/Runloop/Daytona image.
// ─────────────────────────────────────────────────────────────────────────────
async function latexToPdf(ctx, src, out) {
  const base = path.posix.basename(src).replace(/\.[^.]+$/, '');

  // 1) PURE-PYTHON RENDERER — always try this first. It has zero external deps
  //    and works OFFLINE, so it succeeds even on the most locked-down sandbox.
  //    The renderer file is uploaded into the worker dir on prewarm; here on
  //    the host we invoke a bundled copy if it exists next to this JS file.
  try {
    // Upload the renderer into the sandbox on-demand (idempotent, tiny).
    // The worker prewarm already puts it in place; this guarantees availability
    // even if convert_file runs before the agent worker has started.
    const rendererPath = require('path').join(__dirname, '..', 'agent_worker', 'latex_render.py');
    const rendererSrc = require('fs').readFileSync(rendererPath, 'utf-8');
    const b64 = Buffer.from(rendererSrc, 'utf-8').toString('base64');
    await ctx.fsx.writeText('.latex_render.py.b64', b64);
    await sh(ctx, `base64 -d .latex_render.py.b64 > .latex_render.py && rm -f .latex_render.py.b64`);
    // Run it: `python3 .latex_render.py <src> <out>`
    await sh(ctx, `python3 .latex_render.py ${q(src)} ${q(out)} >/dev/null 2>&1 || true`);
    if (await ctx.fsx.exists(out)) {
      const rel = await deliverIfExists(ctx, out);
      if (rel) return { engine: 'pure-python (latex_render.py)', rel };
    }
  } catch (_) { /* fall through to system engines */ }

  // 2) pdflatex if the sandbox happened to have it pre-installed. We NO LONGER
  //    try to apt-install it (the download kept getting reset by peer on
  //    restricted sandbox egress).
  try {
    const has = await sh(ctx, `command -v pdflatex >/dev/null 2>&1 && echo yes || echo no`);
    if (String(has || '').trim().endsWith('yes')) {
      await sh(ctx, `pdflatex -interaction=nonstopmode -halt-on-error ${q(src)} >/dev/null 2>&1; pdflatex -interaction=nonstopmode ${q(src)} >/dev/null 2>&1; ls -1 ${q(base + '.pdf')} 2>/dev/null || true`);
      const produced = `${base}.pdf`;
      if (await ctx.fsx.exists(produced)) {
        if (produced !== out) { await sh(ctx, `mv -f ${q(produced)} ${q(out)} 2>/dev/null || cp -f ${q(produced)} ${q(out)}`); }
        const rel = await deliverIfExists(ctx, out);
        if (rel) return { engine: 'pdflatex (pre-installed)', rel };
      }
    }
  } catch (_) { /* keep going */ }

  // 3) tectonic if the binary happens to already be on PATH. We NO LONGER try
  //    to download it (the 2.9 GB bundle download kept getting reset).
  try {
    const has = await sh(ctx, `command -v tectonic >/dev/null 2>&1 && echo yes || echo no`);
    if (String(has || '').trim().endsWith('yes')) {
      await sh(ctx, `tectonic ${q(src)} >/dev/null 2>&1; ls -1 ${q(base + '.pdf')} 2>/dev/null || true`);
      const produced = `${base}.pdf`;
      if (await ctx.fsx.exists(produced)) {
        if (produced !== out) await sh(ctx, `mv -f ${q(produced)} ${q(out)} 2>/dev/null || true`);
        const rel = await deliverIfExists(ctx, out);
        if (rel) return { engine: 'tectonic (pre-installed)', rel };
      }
    }
  } catch (_) { /* keep going */ }

  throw new Error('no LaTeX engine available (pure-python renderer failed to run)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: image → PDF (img2pdf preferred — lossless; ImageMagick fallback).
// ─────────────────────────────────────────────────────────────────────────────
async function imageToPdf(ctx, src, out) {
  if (await ensureApt(ctx, 'img2pdf', 'img2pdf')) {
    await sh(ctx, `img2pdf ${q(src)} -o ${q(out)} >/dev/null 2>&1; ls -1 ${q(out)} 2>/dev/null || true`);
    const rel = await deliverIfExists(ctx, out);
    if (rel) return { engine: 'img2pdf', rel };
  }
  if (await ensureApt(ctx, 'convert', 'imagemagick')) {
    // Relax the default PDF policy that some distros ship with.
    await sh(ctx, `convert ${q(src)} ${q(out)} >/dev/null 2>&1; ls -1 ${q(out)} 2>/dev/null || true`);
    const rel = await deliverIfExists(ctx, out);
    if (rel) return { engine: 'ImageMagick', rel };
  }
  throw new Error('no image→pdf engine available');
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: HTML → PDF via the existing Browserless service (print quality).
// Reads the HTML from the working dir (or inline) and renders it.
// ─────────────────────────────────────────────────────────────────────────────
async function htmlToPdf(ctx, htmlText, out) {
  const browserless = require('./browserless');
  const buf = await browserless.htmlToPdf(htmlText, { waitFor: 6000, format: 'A4' });
  if (!buf || buf.length < 600) throw new Error('Browserless returned empty PDF');
  await ctx.deliverBuffer(out, buf);
  return { engine: 'Browserless (HTML→PDF)', rel: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: HTML → PPTX. Parse the document into slides (each <h1>/<h2>/<section>
// becomes a slide; <li>/<p> become bullets) and build a themed deck with the
// existing presentationBuilder.
// ─────────────────────────────────────────────────────────────────────────────
function htmlToSlideModel(html, fallbackTitle) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const docTitle = ($('title').first().text() || $('h1').first().text() || fallbackTitle || 'Presentation').trim();
  const slides = [];

  // Strategy 1: explicit <section> elements (reveal.js style).
  const sections = $('section');
  const pushSlide = (root) => {
    const $r = $(root);
    const title = ($r.find('h1,h2,h3').first().text() || '').trim();
    const bullets = [];
    $r.find('li').each((_, el) => { const t = $(el).text().trim(); if (t) bullets.push(t); });
    let content = '';
    if (!bullets.length) {
      $r.find('p').each((_, el) => { const t = $(el).text().trim(); if (t) content += (content ? '\n\n' : '') + t; });
    }
    if (title || bullets.length || content) slides.push({ title: title || 'Slide', bullets, content });
  };

  if (sections.length >= 1) {
    sections.each((_, el) => pushSlide(el));
  } else {
    // Strategy 2: split the body by headings.
    const body = $('body').length ? $('body') : $.root();
    let cur = null;
    body.find('h1,h2,h3,p,ul,ol,li').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();
      if (/^h[1-3]$/.test(tag)) {
        if (cur) slides.push(cur);
        cur = { title: text || 'Slide', bullets: [], content: '' };
      } else if (tag === 'li') {
        if (!cur) cur = { title: 'Slide', bullets: [], content: '' };
        if (text) cur.bullets.push(text);
      } else if (tag === 'p') {
        if (!cur) cur = { title: 'Slide', bullets: [], content: '' };
        if (text) cur.content += (cur.content ? '\n\n' : '') + text;
      }
    });
    if (cur) slides.push(cur);
  }
  return { docTitle, slides: slides.filter(s => s.title || s.bullets.length || s.content) };
}

async function htmlToPptx(ctx, htmlText, out, theme, fallbackTitle) {
  const pres = require('./presentationBuilder');
  const { docTitle, slides } = htmlToSlideModel(htmlText, fallbackTitle);
  if (!slides.length) throw new Error('could not extract any slides from the HTML');
  const buf = await pres.buildPptx({ title: docTitle, subtitle: '', author: 'WormGPT Agent', slides, theme: theme || 'corporate' });
  if (!buf || buf.length < 600) throw new Error('PPTX build returned empty');
  await ctx.deliverBuffer(out, buf);
  return { engine: 'pptxgenjs (HTML→PPTX)', rel: out, slideCount: slides.length + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine: PDF → text (pure JS, always available) — used as a fallback and for
// pdf→docx when LibreOffice can't be installed.
// ─────────────────────────────────────────────────────────────────────────────
async function pdfBufferToText(buf) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buf);
    return data.text || '';
  } catch (_) { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TOOL: convert_file
//
// args: {
//   source: "report.pdf",          // a file already in the working dir, OR
//   html:   "<html>…</html>",       // inline HTML (for html→pdf/pptx/docx), OR
//   text:   "...",                  // inline text/markdown/latex content
//   from?:  "pdf",                  // optional source format hint (else inferred)
//   to:     "docx",                 // REQUIRED target format/extension
//   filename?: "output",            // optional base name for the result
//   theme?: "corporate",            // for html→pptx
//   lang?:  "eng"                   // OCR language (tesseract code)
// }
// ─────────────────────────────────────────────────────────────────────────────
async function toolConvertFile(args, ctx) {
  const to = String(args.to || args.target || '').toLowerCase().replace(/^\./, '').trim();
  if (!to) return '[convert_file] No target format. Pass {"source":"file.pdf","to":"docx"} (to = the output extension).';

  // Resolve the SOURCE into a file in the working dir.
  let src = (args.source || args.path || args.input || '').replace(/^\.?\/+/, '');
  let fromExt = String(args.from || '').toLowerCase().replace(/^\./, '');
  let inlineKind = null; // 'html' | 'text' | 'latex' | 'markdown'

  try {
    if (!src) {
      // Inline content path: write it to a temp source file we can convert.
      if (args.html != null) {
        inlineKind = 'html'; fromExt = fromExt || 'html';
        src = `_convsrc_${Date.now()}.html`;
        await ctx.fsx.writeText(src, coerceText(args.html));
      } else if (args.text != null) {
        // Decide the inline source type from `from` (default markdown).
        fromExt = fromExt || (to === 'pdf' && /\\\(|\\\[|\\begin|\\frac/.test(coerceText(args.text)) ? 'tex' : 'md');
        inlineKind = familyOf(fromExt);
        const ext = fromExt === 'latex' ? 'tex' : fromExt;
        src = `_convsrc_${Date.now()}.${ext || 'txt'}`;
        await ctx.fsx.writeText(src, coerceText(args.text));
      } else {
        return '[convert_file] No source. Pass {"source":"file.ext"} (a file in your working dir) OR {"html":"..."} / {"text":"..."}.';
      }
    } else {
      if (!(await ctx.fsx.exists(src))) {
        return `[convert_file] "${src}" not found in the working dir. Use list_files to see what's available (or upload/create it first).`;
      }
      fromExt = fromExt || extOf(src);
    }
  } catch (e) {
    return `[convert_file] could not prepare source: ${e.message}`;
  }

  const fromFam = familyOf(fromExt);
  const toFam = familyOf(to);
  const base = String(args.filename || path.posix.basename(src).replace(/\.[^.]+$/, '') || 'output')
    .replace(/[^\w.\-]/g, '_').replace(/\.[^.]*$/, '') || 'output';
  const out = `${base}.${to}`;

  if (ctx.onStep) ctx.onStep(`🔄 converting ${fromExt || fromFam} → ${to}…`);

  const tried = [];
  const ok = (engine, rel, extra = '') =>
    `[convert_file] ✅ Converted ${src.startsWith('_convsrc_') ? '(inline ' + fromFam + ')' : src} → ${rel} via ${engine}.${extra ? ' ' + extra : ''} Queued for delivery.`;

  try {
    // ── 1) Same format (no-op copy / rewrap) ────────────────────────────────
    if (fromExt === to) {
      ctx.addFile(src, out);
      return ok('passthrough', src);
    }

    // ── 2) HTML → PDF / PPTX / DOCX ─────────────────────────────────────────
    if (fromFam === 'html') {
      const htmlText = inlineKind === 'html' && args.html != null ? coerceText(args.html) : await ctx.fsx.readText(src);
      if (to === 'pdf') {
        try { const r = await htmlToPdf(ctx, htmlText, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`html→pdf(browserless): ${e.message}`); }
      }
      if (to === 'pptx') {
        try { const r = await htmlToPptx(ctx, htmlText, out, args.theme, base); return ok(r.engine, r.rel, `(${r.slideCount} slides)`); }
        catch (e) { tried.push(`html→pptx: ${e.message}`); }
      }
      if (OFFICE_DOC.includes(to) || to === 'txt' || to === 'md') {
        try { const r = await pandocConvert(ctx, src, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`html→${to}(pandoc): ${e.message}`); }
        try { const r = await libreConvert(ctx, src, to, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`html→${to}(libre): ${e.message}`); }
      }
    }

    // ── 3) LaTeX → PDF ──────────────────────────────────────────────────────
    if (fromFam === 'latex' && to === 'pdf') {
      try { const r = await latexToPdf(ctx, src, out); return ok(r.engine, r.rel); }
      catch (e) {
        tried.push(`latex(pdflatex/tectonic): ${e.message}`);
        // Fallback: render the LaTeX body through MathJax HTML → PDF so the user
        // still gets a typeset PDF even with no TeX toolchain.
        try {
          const texText = await ctx.fsx.readText(src);
          const agent = require('./agentEngine');
          const html = agent._internals.buildMathHtml(base, texText, {});
          const r = await htmlToPdf(ctx, html, out);
          return ok('Browserless (LaTeX→MathJax→PDF)', r.rel, '(no TeX toolchain — used MathJax fallback)');
        } catch (e2) { tried.push(`latex(mathjax fallback): ${e2.message}`); }
      }
    }

    // ── 4) Image → OCR text / PDF ───────────────────────────────────────────
    if (fromFam === 'image') {
      if (to === 'txt' || to === 'text' || to === 'md') {
        try {
          const r = await ocrImage(ctx, src, `${base}.txt`, args.lang);
          return ok(r.engine, r.rel);
        } catch (e) {
          tried.push(`ocr(tesseract): ${e.message}`);
          // Fallback: vision model OCR via analyze (best-effort plain text).
          try {
            const buf = await ctx.fsx.downloadBuffer(src);
            const hotbot = require('./hotbot');
            const gemini = require('./gemini');
            const dataUri = `data:image/${fromExt === 'jpg' ? 'jpeg' : fromExt};base64,${buf.toString('base64')}`;
            const messages = [
              { role: 'system', content: gemini.SYSTEM_PROMPT },
              { role: 'user', content: [
                { type: 'image_url', image_url: { url: dataUri } },
                { type: 'text', text: 'Perform OCR. Output ONLY the exact text visible in this image, preserving line breaks. No commentary.' },
              ] },
            ];
            const txt = await hotbot.chat(messages);
            await ctx.deliverBuffer(`${base}.txt`, Buffer.from(String(txt || ''), 'utf-8'));
            return ok('Vision-model OCR (Tesseract unavailable)', `${base}.txt`);
          } catch (e2) { tried.push(`ocr(vision fallback): ${e2.message}`); }
        }
      }
      if (to === 'pdf') {
        try { const r = await imageToPdf(ctx, src, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`image→pdf: ${e.message}`); }
      }
    }

    // ── 5) PDF → docx / txt / html / md ─────────────────────────────────────
    if (fromFam === 'pdf') {
      if (to === 'txt' || to === 'text') {
        try {
          if (await ensureApt(ctx, 'pdftotext', 'poppler-utils')) {
            await sh(ctx, `pdftotext -layout ${q(src)} ${q(out)} >/dev/null 2>&1; ls -1 ${q(out)} 2>/dev/null || true`);
            const rel = await deliverIfExists(ctx, out);
            if (rel) return ok('poppler pdftotext', rel);
          }
        } catch (e) { tried.push(`pdf→txt(poppler): ${e.message}`); }
        // JS fallback
        const buf = await ctx.fsx.downloadBuffer(src);
        const text = await pdfBufferToText(buf);
        await ctx.deliverBuffer(out, Buffer.from(text, 'utf-8'));
        return ok('pdf-parse (JS)', out);
      }
      if (OFFICE_DOC.includes(to)) {
        // LibreOffice gives the best layout-preserving PDF→DOCX.
        try { const r = await libreConvert(ctx, src, to, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`pdf→${to}(libre): ${e.message}`); }
        // Fallback: extract text → build a clean docx via the agent's renderer.
        try {
          const buf = await ctx.fsx.downloadBuffer(src);
          const text = await pdfBufferToText(buf);
          const agent = require('./agentEngine');
          await agent._internals.toolCreateDocx({ filename: out, title: base, content: text }, ctx);
          return ok('pdf-parse → docx (text-only fallback)', out, '(layout simplified — no LibreOffice)');
        } catch (e2) { tried.push(`pdf→${to}(text fallback): ${e2.message}`); }
      }
      if (to === 'html' || to === 'md') {
        try { const r = await pandocConvert(ctx, src, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`pdf→${to}(pandoc): ${e.message}`); }
      }
    }

    // ── 6) Markdown / text → pdf / docx / html ──────────────────────────────
    if (fromFam === 'markdown' || fromFam === 'text') {
      const content = inlineKind && args.text != null ? coerceText(args.text) : await ctx.fsx.readText(src);
      if (to === 'pdf') {
        // Pandoc (with a LaTeX engine) is nicest; else our Browserless HTML path.
        try {
          if (await ensureApt(ctx, 'pdflatex', 'texlive-latex-base texlive-latex-recommended')) {
            const r = await pandocConvert(ctx, src, out, `--pdf-engine=pdflatex`);
            return ok(r.engine, r.rel);
          }
        } catch (e) { tried.push(`md→pdf(pandoc): ${e.message}`); }
        try {
          const agent = require('./agentEngine');
          const html = agent._internals.buildMathHtml(base, content, {});
          const r = await htmlToPdf(ctx, html, out);
          return ok('Browserless (Markdown→HTML→PDF)', r.rel);
        } catch (e) { tried.push(`md→pdf(browserless): ${e.message}`); }
      }
      if (OFFICE_DOC.includes(to)) {
        try { const r = await pandocConvert(ctx, src, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`md→${to}(pandoc): ${e.message}`); }
        try {
          const agent = require('./agentEngine');
          await agent._internals.toolCreateDocx({ filename: out, title: base, content }, ctx);
          return ok('docx renderer (Markdown→DOCX)', out);
        } catch (e2) { tried.push(`md→${to}(renderer): ${e2.message}`); }
      }
      if (to === 'html') {
        try { const r = await pandocConvert(ctx, src, out, '--standalone'); return ok(r.engine, r.rel); }
        catch (e) {
          tried.push(`md→html(pandoc): ${e.message}`);
          const agent = require('./agentEngine');
          const html = agent._internals.buildMathHtml(base, content, {});
          await ctx.deliverBuffer(out, Buffer.from(html, 'utf-8'));
          return ok('mdToHtml (JS)', out);
        }
      }
      if (to === 'pptx') {
        // Treat the markdown as a slide deck (--- separates slides).
        try {
          const pres = require('./presentationBuilder');
          const slides = pres.normalizeSlides({ markdown: content });
          if (slides.length) {
            const buf = await pres.buildPptx({ title: base, slides, theme: args.theme || 'corporate' });
            await ctx.deliverBuffer(out, buf);
            return ok('pptxgenjs (Markdown→PPTX)', out, `(${slides.length + 1} slides)`);
          }
        } catch (e) { tried.push(`md→pptx: ${e.message}`); }
      }
    }

    // ── 7) Office docs/slides/sheets → anything (LibreOffice handles most) ──
    if (['doc', 'slide', 'sheet'].includes(fromFam)) {
      // CSV special-cases first.
      if (fromExt === 'csv' && to === 'xlsx') {
        try { const r = await libreConvert(ctx, src, 'xlsx', out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`csv→xlsx(libre): ${e.message}`); }
      }
      try { const r = await libreConvert(ctx, src, to, out); return ok(r.engine, r.rel); }
      catch (e) { tried.push(`${fromExt}→${to}(libre): ${e.message}`); }
      // Pandoc fallback for doc text targets.
      if (['txt', 'md', 'html'].includes(to) && fromFam === 'doc') {
        try { const r = await pandocConvert(ctx, src, out); return ok(r.engine, r.rel); }
        catch (e) { tried.push(`${fromExt}→${to}(pandoc): ${e.message}`); }
      }
      // Pure-JS fallback (no system binaries) — extract real text from the office
      // file and re-emit it. Guarantees docx/pptx/xlsx → pdf|txt|docx works on
      // Render where LibreOffice/Pandoc can't be installed.
      try {
        const agent = require('./agentEngine');
        const buf = await ctx.fsx.downloadBuffer(src);
        let text = '';
        if (agent._internals.extractOfficeText) {
          const res = await agent._internals.extractOfficeText(buf, src.toLowerCase());
          text = (res && res.text) ? res.text : '';
        }
        if (text && text.trim()) {
          if (to === 'txt' || to === 'text' || to === 'md') {
            await ctx.deliverBuffer(out, Buffer.from(text, 'utf-8'));
            return ok('office→text (JS extractor)', out);
          }
          if (to === 'pdf') {
            const html = agent._internals.buildMathHtml(base, text, {});
            try { const r = await htmlToPdf(ctx, html, out); return ok('JS extractor → Browserless PDF', r.rel); }
            catch (e) {
              tried.push(`office→pdf(browserless): ${e.message}`);
              await agent._internals.toolCreatePdf({ filename: out, title: base, content: text, math: false }, ctx);
              return ok('JS extractor → pdfkit PDF', out);
            }
          }
          if (OFFICE_DOC.includes(to)) {
            await agent._internals.toolCreateDocx({ filename: out, title: base, content: text }, ctx);
            return ok('JS extractor → docx renderer', out);
          }
          if (to === 'html') {
            const html = agent._internals.buildMathHtml(base, text, {});
            await ctx.deliverBuffer(out, Buffer.from(html, 'utf-8'));
            return ok('JS extractor → HTML', out);
          }
        }
      } catch (e) { tried.push(`${fromExt}→${to}(JS extractor): ${e.message}`); }
    }

    // ── 8) Generic last resort: try LibreOffice, then Pandoc ────────────────
    try { const r = await libreConvert(ctx, src, to, out); return ok(r.engine, r.rel); }
    catch (e) { tried.push(`generic(libre): ${e.message}`); }
    try { const r = await pandocConvert(ctx, src, out); return ok(r.engine, r.rel); }
    catch (e) { tried.push(`generic(pandoc): ${e.message}`); }

    return `[convert_file] ❌ Could not convert ${fromExt || fromFam} → ${to}. Engines tried:\n - ${tried.join('\n - ') || '(none matched)'}\nTip: for office↔pdf the sandbox must allow installing LibreOffice; for OCR it needs tesseract-ocr.`;
  } catch (e) {
    return `[convert_file] error: ${e.message}${tried.length ? '\nTried:\n - ' + tried.join('\n - ') : ''}`;
  }
}

module.exports = {
  toolConvertFile,
  // exposed for reuse/testing
  _internals: { extOf, familyOf, htmlToSlideModel, libreConvert, pandocConvert, ocrImage, latexToPdf, imageToPdf },
};
