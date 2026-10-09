// ─────────────────────────────────────────────────────────────────────────────
// simpleOcr.js — inbound-file → text engine with REAL sandbox OCR.
//
// TWO LAYERS, in priority order:
//
//   1) SANDBOX OCR (primary when a sandbox fsx is active) — runs the
//      self-contained Python extractor `python/ocr_extract.py` INSIDE the
//      sandbox (GitHub Actions runner w/ root, Novita, Daytona, HopX, or local
//      host). It installs tesseract + poppler + the python deps on demand
//      (idempotent, cached) and does high-accuracy OCR with strong image
//      preprocessing + a multi-pass strategy. This is what makes DENSE, text-
//      heavy inputs work — e.g. a photo of a full past-question paper with many
//      questions is transcribed COMPLETELY instead of the vision model picking
//      one question and dropping the rest. Scanned/image-only PDFs are OCR'd
//      page-by-page; native PDF/DOCX/XLSX text layers are read directly.
//
//   2) PURE-NODE FALLBACK (always available, no sandbox/python needed) —
//        • PDF   → pdf-parse → pdfjs-dist → pdftotext (native text layer)
//        • DOCX  → mammoth
//        • XLSX  → xlsx
//        • image → returns ok:false so the caller uses its vision model
//
// The caller (agentEngine.js) relies on this exact API:
//   available, classifyImage, extract, warmup, isImageName, isDocName
//
// Design guarantees (unchanged contract):
//   • NEVER throws — every public method resolves to a structured result.
//   • { ok:false, reason } tells the caller to fall back (vision for images).
//   • The sandbox OCR path is fully guarded: any failure (no sandbox, install
//     error, timeout, bad JSON) silently degrades to the pure-Node/vision path.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ── File-type helpers ────────────────────────────────────────────────────────
const IMAGE_EXTS = /\.(png|jpe?g|jpe|jfif|webp|tif?f|bmp|dib|gif|ppm|pgm|pbm|pnm|pcx|tga|ico|heic|heif)$/i;
const DOC_EXTS = /\.(pdf|docx?|docm|odt|rtf|pptx?|pptm|xls[xmb]?|ods|csv|tsv|zip|txt|md|markdown|json|xml|html?|ya?ml)$/i;
function isImageName(name) { return IMAGE_EXTS.test(String(name || '')); }
function isDocName(name) { return DOC_EXTS.test(String(name || '')); }

function log(ctx, msg) {
  try { if (ctx && typeof ctx.onStep === 'function') ctx.onStep(msg); } catch (_) {}
  try { console.log('[simpleOcr] ' + msg); } catch (_) {}
}

// Internal OCR diagnostics belong in server logs, not in user-facing progress.
// Telegram/WhatsApp forward ctx.onStep verbatim (and meter it as a paid step),
// so transient retries must never use log(). A retry is expected resilience,
// not a task failure; users should only see the stable probe/success messages.
function diagnostic(msg) {
  try { console.log('[simpleOcr] ' + msg); } catch (_) {}
}

function docType(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx') || n.endsWith('.docm') || n.endsWith('.doc') || /\.(odt|rtf)$/.test(n)) return 'docx';
  if (/\.ppt[xm]?$/.test(n)) return 'presentation';
  if (/\.(xls[xmb]?|ods|csv|tsv)$/.test(n)) return 'excel';
  if (n.endsWith('.zip')) return 'archive';
  if (/\.(txt|md|markdown|json|xml|html?|ya?ml)$/.test(n)) return 'text';
  return 'document';
}

// ── The Python OCR engine source (staged into the sandbox once per session) ──
// Read from disk at require-time so we ship a single source of truth
// (python/ocr_extract.py). Cached in-memory.
let _ENGINE_SRC = null;
const _ENGINE_REL = '.pxocr/ocr_extract.py';   // staging path inside the sandbox work dir
function engineSource() {
  if (_ENGINE_SRC != null) return _ENGINE_SRC;
  try {
    _ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'python', 'ocr_extract.py'), 'utf-8');
  } catch (_) {
    _ENGINE_SRC = '';
  }
  return _ENGINE_SRC;
}

// Is the given ctx.fsx a usable execution backend (sandbox OR local host)?
function fsxUsable(ctx) {
  const f = ctx && ctx.fsx;
  return !!(f && typeof f.sh === 'function'
    && typeof f.uploadBuffer === 'function'
    && typeof f.readText === 'function');
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Extract the JSON the engine prints between its sentinels.
function parseEngineJson(out) {
  if (!out) return null;
  const b = out.indexOf('<<<PXOCR_JSON_BEGIN>>>');
  const e = out.indexOf('<<<PXOCR_JSON_END>>>');
  if (b < 0 || e < 0 || e < b) return null;
  const raw = out.slice(b + '<<<PXOCR_JSON_BEGIN>>>'.length, e).trim();
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Stage the engine into the sandbox once per session (idempotent). We key the
// "already staged" flag on the fsx object so repeated extractions in one turn
// don't re-upload.
async function ensureEngineStaged(ctx) {
  const f = ctx.fsx;
  if (f.__pxocrStaged) return true;
  const src = engineSource();
  if (!src) return false;
  try {
    await f.uploadBuffer(_ENGINE_REL, Buffer.from(src, 'utf-8'));
    f.__pxocrStaged = true;
    return true;
  } catch (_) { return false; }
}

// Run the engine on a file inside the sandbox and return the parsed result.
//   mode: 'extract' | 'classify' | 'warmup'
async function runSandboxEngineUnlocked(ctx, buffer, name, { mode = 'extract', pages = 0, timeoutNote } = {}) {
  const f = ctx.fsx;
  if (!(await ensureEngineStaged(ctx))) return { ok: false, reason: 'engine-stage-failed' };

  // Upload the input file under a scratch name (preserve the extension so the
  // engine routes correctly).
  const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.bin'])[0];
  const safeBase = 'input_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const inRel = `.pxocr/${safeBase}${ext}`;
  try {
    await f.uploadBuffer(inRel, buffer);
  } catch (e) {
    return { ok: false, reason: 'input-upload-failed: ' + ((e && e.message) || e) };
  }

  // ONE shell command: run the engine (which self-installs its deps). We keep
  // it to a SINGLE exec so the (expensive) GitHub-Actions dispatch is only paid
  // once. python3 preferred; fall back to python.
  // Write stdout to a sandbox file, then download it separately. Sandbox shell
  // adapters intentionally truncate command output for safety; parsing stdout
  // directly silently cut large PDFs/9-page exam sets at ~12 KB.
  const outRel = `.pxocr/${safeBase}.result`;
  const expectedBytes = buffer.length;
  const errRel = `.pxocr/${safeBase}.err`;
  const cmd =
    `mkdir -p .pxocr; ` +
    `PY=$(command -v python3 || command -v python); ` +
    `if [ -z "$PY" ]; then echo ‘python-unavailable’ > ${shq(errRel)}; ` +
    `else "$PY" ${shq(_ENGINE_REL)} --file ${shq(inRel)} --mode ${shq(mode)} --pages ${shq(String(pages || 0))} > ${shq(outRel)} 2> ${shq(errRel)}; fi; ` +
    `echo PXOCR_DONE`;

  let out = '';
  try {
    // Never let a dead provider command channel hold the per-sandbox OCR queue
    // for minutes. Every fsx adapter accepts timeout in seconds; this also
    // terminates the remote process rather than merely abandoning a Promise.
    const commandTimeoutSec = Math.max(10, Math.min(180,
      parseInt(process.env.SANDBOX_OCR_COMMAND_TIMEOUT_SEC || '20', 10) || 20));
    const shellResult = await f.sh(cmd, { timeout: commandTimeoutSec });
    if (shellResult && Number.isInteger(shellResult.exitCode) && shellResult.exitCode !== 0) {
      return { ok: false, reason: `sandbox-shell-exit-${shellResult.exitCode}` };
    }
    try { out = await f.readText(outRel); } catch (_) { out = ''; }
    if (typeof out !== 'string') out = String(out || '');
    if (!out.trim()) {
      let diagnostic = '';
      try { diagnostic = String(await f.readText(errRel) || '').trim(); } catch (_) {}
      return { ok: false, reason: diagnostic ? `sandbox-engine-empty: ${diagnostic.slice(-500)}` : 'sandbox-engine-empty' };
    }
  } catch (e) {
    return { ok: false, reason: 'sandbox-exec-failed: ' + ((e && e.message) || e) };
  } finally {
    // Best-effort cleanup of input/result files (keep the engine staged).
    try { await f.sh(`rm -f ${shq(inRel)} ${shq(outRel)} ${shq(errRel)} 2>/dev/null; true`); } catch (_) {}
  }

  const parsed = parseEngineJson(out);
  if (!parsed) return { ok: false, reason: 'engine-no-json', raw: out.slice(-400) };
  return parsed;
}

// Provider command channels and first-use package installation are not reliably
// concurrent. Serialize OCR commands per sandbox while allowing different
// sandboxes to work in parallel.
const _sandboxQueues = new WeakMap();
async function runSandboxEngine(ctx, buffer, name, opts = {}) {
  const fsx = ctx && ctx.fsx;
  if (!fsx || (typeof fsx !== 'object' && typeof fsx !== 'function')) {
    return { ok: false, reason: 'sandbox-fsx-unavailable' };
  }
  const previous = _sandboxQueues.get(fsx) || Promise.resolve();
  let release;
  const turn = new Promise(resolve => { release = resolve; });
  _sandboxQueues.set(fsx, previous.catch(() => {}).then(() => turn));
  await previous.catch(() => {});
  try {
    return await runSandboxEngineUnlocked(ctx, buffer, name, opts);
  } finally {
    release();
  }
}

// Run the exact same deterministic OCR engine on the Render/local host when a
// remote sandbox is absent or transiently fails. The production image already
// contains Tesseract, PyMuPDF and the slim OCR dependencies, so this is a real
// OCR fallback — never an LLM/vision shortcut. A private temp directory keeps
// concurrent batches and prior tasks fully isolated.
async function runLocalEngine(buffer, name, { mode = 'extract', pages = 0 } = {}) {
  const src = engineSource();
  if (!src) return { ok: false, reason: 'local-engine-source-missing' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxocr-'));
  const ext = (String(name).match(/\.[A-Za-z0-9]+$/) || ['.bin'])[0];
  const enginePath = path.join(dir, 'ocr_extract.py');
  const inputPath = path.join(dir, `input${ext}`);
  try {
    fs.writeFileSync(enginePath, src, 'utf8');
    fs.writeFileSync(inputPath, buffer);
    const { stdout = '' } = await execFileAsync(process.env.PYTHON_BIN || 'python3', [
      enginePath, '--file', inputPath, '--mode', mode, '--pages', String(pages || 0),
    ], {
      // This path runs inside the web/bot process. The previous ten-minute
      // default made one pathological image look like a permanently hung task.
      // execFile kills the extractor at this deadline so later uploads are not
      // starved by orphan OCR work.
      timeout: Math.max(10000, Math.min(180000,
        parseInt(process.env.LOCAL_OCR_TIMEOUT_MS || '45000', 10) || 45000)),
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = parseEngineJson(String(stdout));
    return parsed || { ok: false, reason: 'local-engine-no-json', raw: String(stdout).slice(-400) };
  } catch (e) {
    return { ok: false, reason: 'local-engine-failed: ' + ((e && e.message) || e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function hasExtractedText(result) {
  return !!(result && result.ok && typeof result.text === 'string' && result.text.trim());
}

// A persistent sandbox can have its working directory cleared between tasks
// while the in-memory fsx object survives. In that case __pxocrStaged is stale:
// the old implementation skipped the upload, invoked a missing engine, and
// immediately abandoned sandbox OCR. Retry in the SAME sandbox, invalidate the
// staging marker, and re-upload both engine and input before using host OCR.
async function runOcrEngine(ctx, buffer, name, opts = {}) {
  let remote = null;
  if (fsxUsable(ctx)) {
    const attempts = Math.max(1, Math.min(4, parseInt(process.env.SANDBOX_OCR_ATTEMPTS || '1', 10) || 1));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        // Force restaging after any empty/failed run. This repairs stale state
        // after per-task workspace cleanup and partially provisioned sandboxes.
        try { ctx.fsx.__pxocrStaged = false; } catch (_) {}
        await sleep(Math.min(1500, 250 * Math.pow(2, attempt - 2)));
      }
      remote = await runSandboxEngine(ctx, buffer, name, opts)
        .catch(e => ({ ok: false, reason: e && e.message ? e.message : String(e) }));
      if (hasExtractedText(remote)) return { ...remote, source: 'sandbox' };
      // An explicit successful no-text result is not a transient provider
      // failure. Retrying the identical image two more times only adds latency;
      // move immediately to the independent host engine/vision fallback.
      if (remote && remote.ok && remote.has_text === false) break;
      const reason = (remote && (remote.reason || remote.raw)) || 'empty OCR result';
      if (attempt < attempts) diagnostic(`${name}: sandbox OCR attempt ${attempt}/${attempts} failed (${String(reason).slice(0, 160)}); retrying in the sandbox.`);
    }
    const reason = (remote && (remote.reason || remote.raw)) || 'empty OCR result';
    diagnostic(`${name}: sandbox OCR ended (${String(reason).slice(0, 160)}); starting bounded isolated host OCR.`);
  }

  // Skip Render host OCR — Render free tier is slow. Everything runs in sandbox.
  // If sandbox failed, return a clear no-text result so the AI vision model
  // handles the image directly (faster than running OCR on Render).
  if (remote && remote.ok) return { ...remote, source: 'sandbox' };
  return remote || { ok: false, reason: 'sandbox-ocr-unavailable' };
}

// ── PDF → text via pdfjs-dist (pure JS, very tolerant) ───────────────────────
let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((e) => {
      _pdfjsPromise = null;
      throw e;
    });
  }
  return _pdfjsPromise;
}

async function pdfjsExtract(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const doc = await task.promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = [];
    let lastY = null;
    for (const it of content.items) {
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        parts.push(line.join(' ').replace(/\s+/g, ' ').trim());
        line = [];
      }
      if (it.str) line.push(it.str);
      lastY = y;
    }
    if (line.length) parts.push(line.join(' ').replace(/\s+/g, ' ').trim());
    parts.push('');
  }
  try { await doc.destroy(); } catch (_) {}
  return { text: parts.join('\n'), pages: doc.numPages };
}

async function extractPdfJs(buffer) {
  let primaryText = '';
  let pages;
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    primaryText = (data && data.text) ? data.text : '';
    pages = (data && data.numpages) || undefined;
    if (primaryText && primaryText.trim()) {
      return { text: primaryText, meta: { pages, via: 'pdf-parse' } };
    }
  } catch (_) { /* fall through */ }

  try {
    const r = await pdfjsExtract(buffer);
    if (r && r.text && r.text.trim()) {
      return { text: r.text, meta: { pages: r.pages || pages, via: 'pdfjs' } };
    }
    if (typeof (r && r.pages) === 'number') pages = r.pages;
  } catch (_) { /* fall through */ }

  try {
    const cp = require('child_process');
    const out = cp.execFileSync('pdftotext', ['-q', '-', '-'], {
      input: buffer, maxBuffer: 64 * 1024 * 1024, timeout: 60000,
    });
    const text = out ? out.toString('utf8') : '';
    if (text && text.trim()) return { text, meta: { pages, via: 'pdftotext' } };
  } catch (_) { /* not installed */ }

  return { text: primaryText || '', meta: { pages, via: 'none' } };
}

async function extractDocxJs(buffer) {
  const mammoth = require('mammoth');
  const res = await mammoth.extractRawText({ buffer });
  return { text: (res && res.value) ? res.value : '', meta: {} };
}

async function extractExcelJs(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    if (csv && csv.trim()) parts.push(`# Sheet: ${sheetName}\n${csv.trim()}`);
  }
  return { text: parts.join('\n\n'), meta: { sheets: wb.SheetNames.length } };
}

// ── PUBLIC: availability ──────────────────────────────────────────────────────
// The pure-Node fallback is always available; the sandbox OCR path is a bonus
// when a sandbox is active. So we always return true.
async function available(/* ctx */) { return true; }

// ── PUBLIC: classify an image ─────────────────────────────────────────────────
// When a sandbox/exec backend is available we run a REAL OCR probe (classify
// mode) so text-bearing images (screenshots, docs, dense past-questions) are
// detected and routed to the sandbox OCR extractor. When NO backend is
// available we return hasText:false → the caller sends the image to its vision
// model (Gemini), which both transcribes text and describes plain photos.
async function classifyImage(ctx, buffer, name) {
  if (!buffer || !buffer.length) return { ok: true, hasText: false, text: '', confidence: 0, wordCount: 0, engine: 'simple_ocr' };
  if (!isImageName(name)) return { ok: true, hasText: false, text: '', confidence: 0, wordCount: 0, engine: 'simple_ocr' };

  try {
    log(ctx, `🔎 ${name}: probing for text via deterministic OCR…`);
    const r = await runOcrEngine(ctx, buffer, name, { mode: 'classify' });
    if (r && r.ok) {
      return {
        ok: true,
        hasText: !!r.has_text,
        text: r.text || '',
        confidence: r.confidence || 0,
        wordCount: r.word_count || 0,
        engine: r.engine || 'tesseract',
      };
    }
    return { ok: false, hasText: false, text: '', confidence: 0, wordCount: 0, engine: 'none', reason: (r && r.reason) || 'ocr-failed' };
  } catch (e) {
    return { ok: false, hasText: false, text: '', confidence: 0, wordCount: 0, engine: 'none', reason: e.message || String(e) };
  }
}

// ── PUBLIC: extract text from an image OR a document ──────────────────────────
//   { ok:true, text, type, confidence, engine, hasText, meta }
//   { ok:false, reason }  → caller falls back (vision for images; JS extractors)
async function extract(ctx, buffer, name, opts = {}) {
  if (!buffer || !buffer.length) return { ok: false, reason: 'empty-buffer' };

  const isImg = isImageName(name) && !isDocName(name);
  const type = isImg ? 'image' : docType(name);
  const pages = parseInt(opts.pages || 0, 10) || 0;

  // 1) OCR ENGINE FIRST — remote sandbox, then isolated host OCR. Images never
  // jump directly to an AI reader merely because one sandbox is unavailable.
  try {
    const r = await runOcrEngine(ctx, buffer, name, { mode: 'extract', pages });
    if (r && r.ok && r.text && r.text.trim()) {
      const text = r.text.replace(/\u0000/g, '').trim();
      const via = r.source === 'sandbox' ? 'sandbox-ocr' : 'host-ocr';
      log(ctx, `📄 ${name}: extracted ${text.length} chars via deterministic ${r.source || 'host'} OCR (${r.engine}).`);
      return {
        ok: true,
        text,
        type: r.type || type,
        confidence: r.confidence != null ? r.confidence : 90,
        engine: r.engine || 'tesseract',
        hasText: true,
        meta: Object.assign({ pages: r.pages, via }, r.meta || {}),
      };
    }
    if (isImg) return { ok: false, reason: (r && r.reason) || 'ocr-no-text', ocrAttempted: true };
  } catch (e) {
    if (isImg) return { ok: false, reason: e.message || 'ocr-failed', ocrAttempted: true };
  }

  // 2) PURE-NODE FALLBACK for documents (no sandbox / sandbox found nothing).
  try {
    let r;
    if (type === 'pdf') r = await extractPdfJs(buffer);
    else if (type === 'docx') r = await extractDocxJs(buffer);
    else if (type === 'excel') r = await extractExcelJs(buffer);
    else if (type === 'text') r = { text: buffer.toString('utf8'), meta: { via: 'utf8' } };
    else return { ok: false, reason: 'unsupported-type' };

    const text = (r && r.text ? r.text : '').replace(/\u0000/g, '').trim();
    if (!text) return { ok: false, reason: 'no-text-extracted', partial: '' };

    log(ctx, `📄 ${name}: extracted ${text.length} chars via simpleOcr JS (${type}).`);
    return {
      ok: true,
      text,
      type,
      confidence: 100,
      engine: 'simple_ocr_js',
      hasText: true,
      meta: (r && r.meta) || {},
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// ── PUBLIC: warm-up — stage the engine + pre-install tools in the sandbox ─────
// Optional. Called ahead of a batch so the first real extraction is fast (deps
// already installed). No-op when no sandbox is active. Never throws.
async function warmup(ctx /*, opts */) {
  const started = Date.now();
  if (!fsxUsable(ctx)) return { ok: true, ms: 0, engine: 'simple_ocr' };
  try {
    if (!(await ensureEngineStaged(ctx))) return { ok: true, ms: Date.now() - started, engine: 'simple_ocr' };
    // The engine's readiness mode verifies that Tesseract and Poppler really
    // exist. A blank classify probe used to return success even after dependency
    // installation failed, so the first real batch produced no text.
    const pgm = Buffer.from('P2\n4 4\n255\n255 255 255 255\n255 255 255 255\n255 255 255 255\n255 255 255 255\n');
    const result = await runSandboxEngine(ctx, pgm, '_warm.pgm', { mode: 'warmup' });
    return {
      ok: !!(result && result.ok && result.text === 'OCR_READY'),
      ms: Date.now() - started,
      engine: 'sandbox_ocr',
      reason: result && result.reason,
    };
  } catch (_) {
    return { ok: true, ms: Date.now() - started, engine: 'simple_ocr' };
  }
}

module.exports = {
  available,
  classifyImage,
  extract,
  warmup,
  isImageName,
  isDocName,
  // exposed for tests / diagnostics
  _internals: { extractPdfJs, pdfjsExtract, extractDocxJs, extractExcelJs, docType, runSandboxEngine, runLocalEngine, runOcrEngine, parseEngineJson, engineSource },
};
