// ─────────────────────────────────────────────────────────────────────────────
// services/brain.js — canonical "HotBot (GPT-5) as the brain" pipeline.
//
// Decision tree (the architecture spec the user asked for):
//
//                       ┌──────────────┐
//   incoming task ─────▶│  classify    │
//                       └──────┬───────┘
//                              │
//   ┌──────────── plain text? ─┴─── attached file? ────────────┐
//   │                                                          │
//   ▼                                                          ▼
//  DeepSeek (brain)                                      file kind?
//                                          ┌───────┬───────┴──────┬─────────┐
//                                          ▼       ▼              ▼         ▼
//                                  PDF / DOCX /   image with     pure       other
//                                    XLSX / TXT     text         picture    (skip)
//                                          │         │             │
//                                  OmniOCR         OmniOCR     Gemini
//                                  → text          → text      vision
//                                          │         │             │
//                                          └────┬────┘             │
//                                               ▼                  ▼
//                                          DeepSeek (brain)   reply directly
//                                          gets EXTRACTED
//                                          TEXT + question
//                                               │
//                                               ▼
//                                       final reply to user
//
// On every step:
//   • OmniOCR failure / unavailable / empty result → fall back to:
//       - pdf-parse (PDF)  /  mammoth (DOCX)  /  xlsx (XLSX)  /  utf-8 (text)
//       - Gemini vision (image)
//   • DeepSeek failure → fall back to HotBot, then Gemini (already handled
//     inside services/agentEngine.js but we replicate the chain here so this
//     module is usable standalone, including from public HTTP endpoints).
//
// Public surface (called from server.js routes):
//   answer({ message, files, history }) → { reply, brain, used }
//
// Each `file` is { name, buffer, mime? }. Files are processed sequentially,
// extraction text is concatenated and prepended to the conversation as a
// CONTEXT block, then DeepSeek answers based on the user's `message`.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const deepseek = require('./deepseek');
const gemini = require('./gemini');
const hotbot = require('./hotbot');
const sakana = require('./sakana');   // ── HEAD BRAIN: Sakana (Namazu) — text + document analysis
const capy = require('./capy');       // ── LONG-RUNNING AGENT: Capy.ai sandbox (polls up to 15 min, returns files)
let sandboxBrain = null;              // ── SELF-HOSTED sandbox fallback (HopX → Runloop → Daytona). Lazy to avoid cycles.
try { sandboxBrain = require('./sandboxBrain'); } catch (_) { sandboxBrain = null; }
const cloudflare = require('./cloudflare'); // ── MAIN BRAIN: DeepSeek R1 on Cloudflare Workers AI ──
const omniOcr = require('./simpleOcr'); // simple Node engine (was OmniOCR/Python)

// Lazily required to avoid a circular dependency (agentEngine → … → brain is
// not a cycle today, but requiring lazily keeps this module import-light and
// safe if the graph changes).
let _agentEngine = null;
function agentEngine() {
  if (_agentEngine === null) {
    try { _agentEngine = require('./agentEngine'); } catch (_) { _agentEngine = false; }
  }
  return _agentEngine || null;
}


// ── Local fsx for OmniOCR (when no remote sandbox is active) ────────────────
// OmniOCR needs ctx.fsx with sh / uploadBuffer / exists / list / readText /
// writeText / downloadBuffer. We give it a minimal local-host implementation
// that runs inside a per-call temp dir so concurrent requests don't collide.
function makeLocalFsx() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain_fsx_'));
  return {
    kind: 'local',
    workdir,
    sandboxId: 'host:' + path.basename(workdir),
    async sh(cmd) {
      try {
        const out = execSync(`cd "${workdir}" && ( ${cmd} ) 2>&1`, {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          timeout: 5 * 60 * 1000,
        });
        return { output: out };
      } catch (e) {
        return { output: (e.stdout || '') + (e.stderr || '') + (e.message || '') };
      }
    },
    async uploadBuffer(rel, buf) {
      const t = path.join(workdir, rel);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, buf);
    },
    async exists(rel) { return fs.existsSync(path.join(workdir, rel)); },
    async list() {
      const out = [];
      const walk = (d) => {
        for (const n of fs.readdirSync(d)) {
          const full = path.join(d, n);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full);
          else out.push({ rel: path.relative(workdir, full), size: st.size });
        }
      };
      try { walk(workdir); } catch (_) {}
      return out;
    },
    async downloadBuffer(rel) { return fs.readFileSync(path.join(workdir, rel)); },
    async readText(rel) { return fs.readFileSync(path.join(workdir, rel), 'utf-8'); },
    async writeText(rel, text) {
      const t = path.join(workdir, rel);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, text);
    },
    async cleanup() {
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

// ── File-kind detection ─────────────────────────────────────────────────────
const IMAGE_EXTS = /\.(png|jpe?g|jpe|jfif|webp|tif?f|bmp|dib|gif|ppm|pgm|pbm|pnm|pcx|tga|ico|heic|heif)$/i;
const PDF_EXTS = /\.pdf$/i;
const DOC_EXTS = /\.(docx?|docm|odt|rtf)$/i;
const SHEET_EXTS = /\.(xls[xmb]?|csv|ods)$/i;
const TXT_EXTS = /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|html?|js|ts|py|java|c|cpp|go|rs|sh|sql|xml)$/i;

function classifyFile(name, buffer) {
  const n = String(name || '').toLowerCase();
  if (IMAGE_EXTS.test(n)) return 'image';
  if (PDF_EXTS.test(n)) return 'pdf';
  if (DOC_EXTS.test(n)) return 'doc';
  if (SHEET_EXTS.test(n)) return 'sheet';
  if (TXT_EXTS.test(n)) return 'text';
  // Fallback: sniff magic bytes
  if (buffer && buffer.length >= 4) {
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf'; // %PDF
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image'; // PNG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image'; // JPEG
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image'; // GIF
    if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'doc';   // PK (zip → assume office)
  }
  return 'other';
}

function sniffMime(buffer, fallback) {
  if (!buffer || buffer.length < 4) return fallback || 'application/octet-stream';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
  if (buffer.length > 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer[0] === 0x25 && buffer[1] === 0x50) return 'application/pdf';
  return fallback || 'application/octet-stream';
}

// ── JS-level fallback extractors (when OmniOCR is unavailable) ──────────────
async function fallbackExtract(name, buffer) {
  const kind = classifyFile(name, buffer);
  try {
    if (kind === 'pdf') {
      try {
        const pdfParse = require('pdf-parse');
        const data = await pdfParse(buffer);
        return { ok: !!(data.text && data.text.trim()), text: (data.text || '').trim(), engine: 'pdf-parse' };
      } catch (e) { return { ok: false, reason: 'pdf-parse: ' + e.message }; }
    }
    if (kind === 'doc' && /\.docx$/i.test(name)) {
      try {
        const mammoth = require('mammoth');
        const r = await mammoth.extractRawText({ buffer });
        return { ok: !!(r.value && r.value.trim()), text: (r.value || '').trim(), engine: 'mammoth' };
      } catch (e) { return { ok: false, reason: 'mammoth: ' + e.message }; }
    }
    if (kind === 'sheet') {
      try {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const out = [];
        for (const sn of wb.SheetNames) {
          const ws = wb.Sheets[sn];
          out.push(`### Sheet: ${sn}\n\n${XLSX.utils.sheet_to_csv(ws)}`);
        }
        const text = out.join('\n\n').trim();
        return { ok: !!text, text, engine: 'xlsx' };
      } catch (e) { return { ok: false, reason: 'xlsx: ' + e.message }; }
    }
    if (kind === 'text') {
      const text = buffer.toString('utf-8').trim();
      return { ok: !!text, text, engine: 'utf8' };
    }
  } catch (e) { return { ok: false, reason: e.message }; }
  return { ok: false, reason: 'no-fallback-for-kind:' + kind };
}

// ── Vision (Gemini) for pure images ─────────────────────────────────────────
async function geminiVision(buffer, mime, question) {
  const data = await gemini.generate([
    { inline_data: { mime_type: mime, data: buffer.toString('base64') } },
    { text: question || 'Describe what is in this image in detail.' },
  ]);
  return gemini.extractText(data) || '';
}

// ── OmniOCR with sandbox fallback ───────────────────────────────────────────
// Run OmniOCR on the LOCAL host first (fast when the host has the toolchain,
// e.g. the Docker image bakes in tesseract/python). If the local engine is
// unavailable or returns nothing AND a remote sandbox backend (HopX / Runloop /
// Daytona — the same boxes the AI agent runs in) is configured, transparently
// retry the SAME extraction INSIDE that sandbox, where OmniOCR can apt/pip-
// install its deps with root. The sandbox fsx is acquired once per answer()
// call and cached on `ctx.__sandbox` so multiple files reuse one box.
//
// Returns whatever omniOcr.extract returns ({ ok, text, ... } | { ok:false }).
async function ensureSandboxCtx(ctx) {
  if (ctx.__sandboxPromise) return ctx.__sandboxPromise;
  if (ctx.__sandboxTried) return ctx.__sandbox; // already attempted (may be null)
  ctx.__sandboxTried = true;
  const ae = agentEngine();
  if (!ae || typeof ae.acquireSandboxFsx !== 'function') { ctx.__sandbox = null; return null; }
  ctx.__sandboxPromise = (async () => {
  // Hard cap on sandbox PROVISIONING. A cold HopX/Runloop/Daytona VM can take
  // 30-60s to boot, which would blow straight past Render's ~50s HTTP gateway
  // timeout (→ 502). We time-box acquisition so that if a fresh box can't come
  // up quickly, we abandon it and fall back to the fast local-host OCR / JS
  // extractors / Gemini vision instead. The box keeps provisioning in the
  // background and will be ready for the NEXT request.
  const ACQUIRE_BUDGET_MS = parseInt(process.env.BRAIN_SANDBOX_ACQUIRE_MS || '18000', 10);
  try {
    // Cheap probe first so we never pay provisioning cost when nothing is set up.
    if (ae.anySandboxConfigured && !(await ae.anySandboxConfigured())) { ctx.__sandbox = null; return null; }
    // REUSE the persistent `ocr-warm` session box that the boot warm-up
    // provisioned + dep-installed. This is the key to first-request speed:
    // instead of spinning a FRESH box (cold → 25s pip install → 502 on Render),
    // we reconnect to the already-warm box where OmniOCR is ready, so OCR is
    // effectively instant. Falls back to a fresh box only if the session can't
    // be reused. Override the key via OCR_WARM_SESSION_KEY.
    const sessionKey = process.env.OCR_WARM_SESSION_KEY || 'ocr-warm';
    const fsx = await Promise.race([
      ae.acquireSandboxFsx({ onStep: ctx.onStep, sessionKey }),
      new Promise((resolve) => setTimeout(() => resolve(null), ACQUIRE_BUDGET_MS)),
    ]);
    if (fsx) {
      ctx.__sandbox = { fsx, attachments: [], onStep: ctx.onStep || (() => {}) };
      console.log('[brain] OCR sandbox ready:', fsx.backend || fsx.kind, fsx.sandboxId);
    } else {
      console.warn(`[brain] OCR sandbox not ready within ${ACQUIRE_BUDGET_MS}ms — using fast fallbacks this call.`);
      ctx.__sandbox = null;
    }
  } catch (e) {
    console.warn('[brain] sandbox OCR fallback unavailable:', e.message);
    ctx.__sandbox = null;
  }
  return ctx.__sandbox;
  })();
  try { return await ctx.__sandboxPromise; }
  finally { ctx.__sandboxPromise = null; }
}

// Should OCR run inside the sandbox FIRST (instead of the local host)?
//
// On Render's free tier the host has limited ephemeral storage and a hard ~50s
// HTTP gateway timeout, so a first-use apt/pip OCR install can blow the budget
// or fail on disk. To avoid that, when a remote sandbox backend (HopX / Runloop
// / Daytona) is configured we run OmniOCR THERE first and only use the local
// host as a fallback. Controlled by:
//   • BRAIN_OCR_PREFER_SANDBOX = 1/on  → always prefer sandbox when configured
//   • BRAIN_OCR_PREFER_SANDBOX = 0/off → always prefer local host
//   • (unset)                          → AUTO: prefer sandbox on Render
//                                        (RENDER env is set by the platform),
//                                        prefer local host elsewhere.
function preferSandboxOcr() {
  const v = String(process.env.BRAIN_OCR_PREFER_SANDBOX || '').toLowerCase().trim();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  // AUTO: Render sets RENDER=true (and RENDER_SERVICE_ID) in every service.
  return !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
}

async function ocrExtract(ctx, buffer, name, opts) {
  // On Render, execute deterministic OCR in a real sandbox first. This avoids
  // installing heavyweight OCR packages on the web host and keeps AI vision as
  // a last resort only. Local extraction remains the normal path in development.
  if (preferSandboxOcr()) {
    try {
      const sb = await ensureSandboxCtx(ctx);
      if (sb) {
        const ex = await omniOcr.extract(sb, buffer, name, opts);
        if (ex && ex.ok) return { ...ex, __viaSandbox: true };
      }
    } catch (_) {}
    if (/^(0|false|off|no)$/i.test(String(process.env.BRAIN_OCR_LOCAL_FALLBACK || '0'))) {
      return { ok: false, reason: 'sandbox-ocr-unavailable' };
    }
  }
  try {
    const ex = await omniOcr.extract(ctx, buffer, name, opts);
    return ex || { ok: false, reason: 'no-output' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

async function ocrClassify(ctx, buffer, name) {
  if (preferSandboxOcr()) {
    try {
      const sb = await ensureSandboxCtx(ctx);
      if (sb) {
        const cls = await omniOcr.classifyImage(sb, buffer, name);
        if (cls && cls.ok) return { ...cls, __viaSandbox: true };
      }
    } catch (_) {}
    if (/^(0|false|off|no)$/i.test(String(process.env.BRAIN_OCR_LOCAL_FALLBACK || '0'))) {
      return { ok: false, reason: 'sandbox-ocr-unavailable' };
    }
  }
  try {
    const cls = await omniOcr.classifyImage(ctx, buffer, name);
    return cls || { ok: false, reason: 'no-output' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// ── Per-file pipeline ───────────────────────────────────────────────────────
//
// Returns { kind, name, contextBlock, sentToVision, engine }
// `contextBlock` is the text we'll inject into DeepSeek's prompt. For pure
// images that go to Gemini, contextBlock contains Gemini's description so the
// brain can still reason about them in the same conversation.
async function processFile(ctx, file, question, opts = {}) {
  const { name, buffer } = file;
  const kind = classifyFile(name, buffer);
  const mime = file.mime || sniffMime(buffer);

  // ── Documents (PDF / DOCX / XLSX / TXT) → text ──────────────────────────
  if (kind === 'pdf' || kind === 'doc' || kind === 'sheet' || kind === 'text') {
    // TXT-family: pure UTF-8, never needs OCR — handle instantly.
    if (kind === 'text') {
      const fb = await fallbackExtract(name, buffer);
      if (fb.ok && fb.text) {
        return {
          kind, name, sentToVision: false, engine: fb.engine,
          contextBlock: `### Attached file: ${name} (${kind}, extracted via ${fb.engine})\n${fb.text}`,
        };
      }
    }

    // DOCX / XLSX are DIGITAL office formats — the pure-JS extractors
    // (mammoth / xlsx) are reliable, instant, and need NO OCR toolchain. Try
    // them FIRST so a cold host (where OmniOCR's tesseract/python deps aren't
    // warmed up yet) never stalls the request. OmniOCR is reserved for the
    // cases that genuinely benefit from it (scanned PDFs, image-bearing pages).
    if (kind === 'doc' || kind === 'sheet') {
      const fb = await fallbackExtract(name, buffer);
      if (fb.ok && fb.text) {
        return {
          kind, name, sentToVision: false, engine: fb.engine,
          contextBlock: `### Attached file: ${name} (${kind}, extracted via ${fb.engine})\n${fb.text}`,
        };
      }
      // JS extractor came up empty (e.g. legacy .doc, image-only spreadsheet) →
      // let OmniOCR have a shot (local first, then sandbox, timeout-guarded).
      try {
        const ex = await ocrExtract(ctx, buffer, name, { mode: 'auto', pages: 30, tables: true });
        if (ex && ex.ok && ex.text && ex.text.trim()) {
          return {
            kind, name, sentToVision: false, engine: (ex.engine || 'omni_ocr') + (ex.__viaSandbox ? '_sandbox' : ''),
            contextBlock: `### Attached file: ${name} (${kind}, extracted via OmniOCR${ex.__viaSandbox ? ' [sandbox]' : ''}, conf ${ex.confidence ?? '?'}%)\n${ex.text.trim()}`,
          };
        }
      } catch (_) { /* fall through */ }
      return {
        kind, name, sentToVision: false, engine: 'none',
        contextBlock: `### Attached file: ${name} (${kind})\n[unable to extract text — file may be empty, encrypted, or corrupt: ${fb.reason || 'unknown'}]`,
      };
    }

    // PDF strategy:
    //   • PDF_TEXT_FIRST (default ON via env on Render): try the INSTANT pure-JS
    //     extractor (pdf-parse) FIRST. Almost every real-world PDF has a digital
    //     text layer, so this returns immediately and avoids the slow cold
    //     sandbox-OCR boot that can exceed the ~50s HTTP gateway. Only if
    //     pdf-parse yields NOTHING (a scanned/image PDF) do we fall through to
    //     OmniOCR (local → sandbox), which genuinely needs OCR.
    //   • Otherwise: OmniOCR first (legacy behaviour), pdf-parse as fallback.
    const PDF_TEXT_FIRST = /^(1|true|on|yes)$/i.test(
      String(process.env.BRAIN_PDF_TEXT_FIRST != null ? process.env.BRAIN_PDF_TEXT_FIRST : '1'));

    if (PDF_TEXT_FIRST) {
      const fbFirst = await fallbackExtract(name, buffer);
      if (fbFirst.ok && fbFirst.text) {
        return {
          kind, name, sentToVision: false, engine: fbFirst.engine,
          contextBlock: `### Attached file: ${name} (${kind}, extracted via ${fbFirst.engine})\n${fbFirst.text}`,
        };
      }
      // No digital text layer → scanned/image PDF → OmniOCR (local → sandbox).
      try {
        const ex = await ocrExtract(ctx, buffer, name, { mode: 'auto', pages: 30, tables: true });
        if (ex && ex.ok && ex.text && ex.text.trim()) {
          return {
            kind, name, sentToVision: false, engine: (ex.engine || 'omni_ocr') + (ex.__viaSandbox ? '_sandbox' : ''),
            contextBlock: `### Attached file: ${name} (pdf, extracted via OmniOCR${ex.__viaSandbox ? ' [sandbox]' : ''}, conf ${ex.confidence ?? '?'}%)\n${ex.text.trim()}`,
          };
        }
      } catch (_) { /* fall through to mode=ocr below */ }
    } else {
      // Legacy: OmniOCR first (local host → sandbox fallback).
      try {
        const ex = await ocrExtract(ctx, buffer, name, { mode: 'auto', pages: 30, tables: true });
        if (ex && ex.ok && ex.text && ex.text.trim()) {
          return {
            kind, name, sentToVision: false, engine: (ex.engine || 'omni_ocr') + (ex.__viaSandbox ? '_sandbox' : ''),
            contextBlock: `### Attached file: ${name} (pdf, extracted via OmniOCR${ex.__viaSandbox ? ' [sandbox]' : ''}, conf ${ex.confidence ?? '?'}%)\n${ex.text.trim()}`,
          };
        }
      } catch (_) { /* fall through */ }
    }
    // Fallback to JS extractor (pdf-parse).
    const fb = await fallbackExtract(name, buffer);

    if (fb.ok && fb.text) {
      return {
        kind, name, sentToVision: false, engine: fb.engine,
        contextBlock: `### Attached file: ${name} (${kind}, extracted via ${fb.engine})\n${fb.text}`,
      };
    }
    // Last resort for PDFs: OCR every page through OmniOCR with mode=ocr
    // (local host → sandbox fallback).
    if (kind === 'pdf') {
      try {
        const ex = await ocrExtract(ctx, buffer, name, { mode: 'ocr', pages: 20 });
        if (ex && ex.ok && ex.text && ex.text.trim()) {
          return {
            kind, name, sentToVision: false, engine: 'omni_ocr_ocr' + (ex.__viaSandbox ? '_sandbox' : ''),
            contextBlock: `### Attached file: ${name} (PDF, OCR'd via OmniOCR${ex.__viaSandbox ? ' [sandbox]' : ''})\n${ex.text.trim()}`,
          };
        }
      } catch (_) { /* fall through */ }
    }
    return {
      kind, name, sentToVision: false, engine: 'none',
      contextBlock: `### Attached file: ${name} (${kind})\n[unable to extract text — file may be empty, encrypted, or corrupt: ${fb.reason || 'unknown'}]`,
    };
  }

  // ── Images: classify text vs pure ───────────────────────────────────────
  if (kind === 'image') {
    // Emergency compatibility switch only. Deterministic sandbox OCR is the
    // default; vision models are used only when OCR finds no usable text or the
    // user needs semantic understanding of a non-text visual.
    const DIRECT_VISION = /^(1|true|on|yes)$/i.test(
      String(process.env.BRAIN_IMAGE_DIRECT_VISION != null ? process.env.BRAIN_IMAGE_DIRECT_VISION : '0'));
    if (DIRECT_VISION) {
      let v = '';
      try {
        v = await geminiVision(
          buffer, mime,
          (question ? `The user asks: ${question}\n\n` : '') +
          'You are an OCR + vision analyser. FIRST, transcribe EVERY piece of visible text in this image VERBATIM (exact spelling, casing, punctuation, numbers, line order). THEN describe what the image shows in detail. Put the transcription under a "TEXT:" heading and the description under a "DESCRIPTION:" heading. If there is no text, write "TEXT: (none)".'
        );
      } catch (e) { v = '[Gemini vision failed: ' + e.message + ']'; }
      return {
        kind, name, sentToVision: true, engine: 'gemini_vision',
        contextBlock: `### Attached image: ${name} (analysed by Gemini vision — text extracted + described)\n${v || '[no description returned]'}`,
      };
    }

    // Whole-OCR-attempt budget. On a cold free-tier host, tesseract first-run +
    // preprocessing can be slow; if OCR can't yield text within this budget we
    // bail to Gemini vision (fast) so we never trip the platform's ~50s HTTP
    // gateway timeout. Gemini also transcribes any visible text, so we lose
    // nothing for text-bearing images.
    const IMG_OCR_BUDGET_MS = parseInt(process.env.IMG_OCR_BUDGET_MS || '25000', 10);

    const ocrAttempt = (async () => {
      // One full extraction is both faster and safer than classifying and then
      // repeating the same multi-pass OCR. It also returns the complete text,
      // confidence and provider provenance in a single sandbox command.
      try {
        const ex = await ocrExtract(ctx, buffer, name, { mode: 'auto' });
        const text = (ex && ex.ok && ex.hasText !== false && ex.text) ? ex.text.trim() : '';
        if (text) {
          const viaSb = !!ex.__viaSandbox;
          return {
            kind, name, sentToVision: false, engine: 'deterministic_ocr' + (viaSb ? '_sandbox' : ''),
            contextBlock: `### Attached image: ${name} (text-bearing; deterministic OCR${viaSb ? ' [sandbox]' : ''}, conf ${ex.confidence ?? '?'}%)\n${text}`,
          };
        }
      } catch (_) { /* fall through to vision */ }
      return null; // no OCR text → caller falls back to vision
    })();

    const ocrResult = await Promise.race([
      ocrAttempt,
      new Promise((resolve) => setTimeout(() => resolve(null), IMG_OCR_BUDGET_MS)),
    ]);
    if (ocrResult) return ocrResult;

    // Pure image, OCR found no text, or OCR exceeded its budget → Gemini vision.
    // Vision answer becomes the context for DeepSeek to discuss further.
    let visionAnswer = '';
    try {
      visionAnswer = await geminiVision(
        buffer, mime,
        question
          ? `${question}\n\nPlease describe what you see in detail and, if there is any text, transcribe it verbatim.`
          : 'Describe what is in this image in detail. If there is any visible text, transcribe it verbatim.'
      );
    } catch (e) { visionAnswer = '[Gemini vision failed: ' + e.message + ']'; }

    return {
      kind, name, sentToVision: true, engine: 'gemini_vision',
      contextBlock: `### Attached image: ${name} (visual, described by Gemini vision)\n${visionAnswer || '[no description returned]'}`,
    };
  }

  // ── Other / unknown ─────────────────────────────────────────────────────
  return {
    kind: 'other', name, sentToVision: false, engine: 'none',
    contextBlock: `### Attached file: ${name} (unsupported type — skipped)`,
  };
}

// ── Brain chain (HotBot GPT-5 → Gemini → Cloudflare) ───────────────────────
//
// MAIN BRAIN: HotBot (GPT-5) — the frontier model that understands the task,
// reasons, and writes the answer. Gemini gateway is the second brain (and the
// dedicated vision/image engine), and the cheap Cloudflare text model is kept
// ONLY as a last-resort safety net. Files are ALWAYS converted to text first
// (see processFile) so the brain can read PDFs/DOCX/XLSX/images — only pure
// pictures go to Gemini vision, whose transcription + description is then
// handed back to HotBot as context. Override with AGENT_SOLO/HOTBOT_SOLO.
async function brainAnswer(systemPrompt, conversation) {
  const SOLO = String(process.env.AGENT_SOLO || process.env.HOTBOT_SOLO || '').toLowerCase();
  const TIMEOUT = parseInt(process.env.BRAIN_TIMEOUT_MS || '90000', 10);

  const flat = () => {
    const lines = [systemPrompt, ''];
    for (const m of conversation) {
      const who = (m.role === 'assistant' || m.role === 'model') ? 'ASSISTANT' : 'USER';
      lines.push(`${who}: ${m.text}`);
    }
    lines.push('ASSISTANT:');
    return lines.join('\n');
  };

  // OpenAI-style message array (used by Cloudflare + HotBot).
  const asMessages = () => {
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const m of conversation) {
      messages.push({ role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user', content: m.text });
    }
    return messages;
  };

  const _withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

  // ── MAIN BRAIN ── Kimi K2.7 on Cloudflare Workers AI (rotated)
  const cloudflareBrain = async () => {
    if (!(await cloudflare.brainEnabled())) throw new Error('Cloudflare brain has no API key configured');
    const reply = await cloudflare.brainChat(asMessages(), { max_tokens: 4096 });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty Cloudflare brain response');
  };
  // Legacy chat.deepseek.com web-token brain — kept only for AGENT_SOLO=deepseek.
  const deepseekBrain = async () => {
    if (!(await deepseek.isEnabled())) throw new Error('DeepSeek not configured');
    const reply = await deepseek.chat(flat());
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty DeepSeek response');
  };
  const hotbotBrain = async () => {
    const reply = await hotbot.chat(asMessages(), { _noJudge: true });
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty HotBot response');
  };
  // ── HEAD BRAIN ── Sakana (Namazu). Receives the full conversation as a
  // prompt; any attached files have already been extracted to TEXT and injected
  // as CONTEXT blocks by processFile(), so Sakana reads them as context exactly
  // like the other brains. (Native Sakana document upload is handled one level
  // up in answer(); this is the text/heavy-reasoning head for the brain chain.)
  const sakanaBrain = async () => {
    const reply = await sakana.chat(asMessages(), {});
    if (reply && String(reply).trim()) return String(reply);
    throw new Error('Empty Sakana response');
  };
  const geminiBrain = async () => {
    const reply = await gemini.ask(flat());
    const txt = gemini.extractText(reply);
    if (txt && txt.trim()) return txt;
    throw new Error('Empty Gemini response');
  };

  let chain;
  if (SOLO === 'cloudflare' || SOLO === 'cf') chain = [['Cloudflare', cloudflareBrain]];
  else if (SOLO === 'deepseek') chain = [['DeepSeek', deepseekBrain]];
  else if (SOLO === 'sakana') chain = [['Sakana', sakanaBrain]];
  else if (SOLO === 'hotbot') chain = [['HotBot', hotbotBrain]];
  else if (SOLO === 'gemini') chain = [['Gemini', geminiBrain]];
  // Default: Sakana (Namazu) is the HEAD BRAIN — it does the chat, analysis and
  // heavy reasoning first. HotBot (GPT-5) → Gemini → Cloudflare are the
  // resilient fallbacks if Sakana fails / times out / has no valid session.
  // Files are converted to text first (see processFile) and handed to whichever
  // brain answers as CONTEXT; pure pictures are described by Gemini vision and
  // that description is fed back as context.
  else {
    chain = [['HotBot', hotbotBrain], ['Gemini', geminiBrain], ['Cloudflare', cloudflareBrain]];
    if (sakana.isHeadEnabled()) chain.unshift(['Sakana', sakanaBrain]);
  }

  const errors = [];
  for (const [label, fn] of chain) {
    try {
      const r = await _withTimeout(fn(), TIMEOUT, label);
      return { reply: r, brain: label.toLowerCase() };
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      console.warn('[brain]', label, 'failed:', e.message);
    }
  }
  throw new Error('All brains failed (' + errors.join(' | ') + ')');
}

// ── Main public entry: answer a user task with optional attached files ─────
//
// opts: {
//   message:   string  (required)
//   files:     [{ name, buffer, mime? }]  (optional)
//   history:   [{ role:'user'|'assistant', text:string }]  (optional)
//   systemPrompt: string  (optional override)
// }
//
// Returns { reply, brain, used: [{name, kind, engine, sentToVision}], extractedChars, capyFiles? }
//
// Capy head (opt-in): when `opts.useCapy` is true (or the `capy_head` setting /
// CAPY_HEAD env is on AND opts.allowCapy !== false) the task is FIRST handed to
// the Capy.ai sandbox agent, which can work for a long time and return real
// files. On Capy failure/timeout/empty we transparently fall back to the normal
// Sakana → HotBot → Gemini → Cloudflare brain chain so nothing ever breaks.
// IMPORTANT: a full 15-min Capy poll must NOT run on the synchronous /api/brain
// path (Render's ~50s HTTP gateway). Callers that want the long poll use the
// async /api/capy job route; here `capyCeilingMs` defaults to a short, gateway-
// safe budget unless the caller explicitly raises it.
async function answer({ message, files = [], history = [], systemPrompt } = {}, opts = {}) {
  const msg = String(message || '').trim();
  const fileList = Array.isArray(files) ? files.filter(f => f && f.buffer && Buffer.isBuffer(f.buffer)) : [];

  if (!msg && !fileList.length) {
    throw new Error('message or files required');
  }

  // ── CAPY HEAD (LONG-RUNNING AGENT) ───────────────────────────────────────
  // Every task can first pass through Capy.ai, which runs in its own sandbox,
  // works for a long time, and can return ANY file type. Enabled when:
  //   • opts.useCapy === true, OR
  //   • Capy head is turned on (capy_head setting / CAPY_HEAD env) AND the
  //     caller has not opted out (opts.allowCapy !== false).
  // On ANY failure we fall through to the existing brain chain below.
  const SOLO = String(process.env.AGENT_SOLO || process.env.HOTBOT_SOLO || '').toLowerCase();
  let wantCapy = false;
  try {
    // 🔌 Master kill-switch: when an admin turns Capy AI off, NEVER use it —
    // not even when the caller forces it with opts.useCapy. Fall straight
    // through to the normal brain chain.
    const capyMasterOn = await capy.isEnabled();
    if (!capyMasterOn) wantCapy = false;
    else if (opts.useCapy === true) wantCapy = capy.isConfiguredSync() || !!(await capy.getKey());
    else if (opts.allowCapy !== false && SOLO === '') wantCapy = await capy.isHeadEnabled();
  } catch (_) { wantCapy = false; }

  if (wantCapy) {
    // Default to a SHORT budget so the synchronous /api/brain path never blows
    // Render's HTTP gateway. The async job route passes a long ceiling.
    const ceilingMs = parseInt(
      opts.capyCeilingMs != null ? opts.capyCeilingMs
        : (process.env.CAPY_SYNC_CEILING_MS || '40000'), 10);
    const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
    try {
      // Make user-attached files VISIBLE to Capy. Local upload buffers have no
      // public URL, so Capy (which fetches attachmentUrls over the internet)
      // cannot see them. Upload each buffer to a no-auth file host and pass the
      // resulting direct URLs as attachmentUrls. Best-effort: on any upload
      // failure we still proceed (Capy gets whatever uploaded + the prompt),
      // and the sandbox/brain fallbacks below still receive the raw buffers.
      let attachmentUrls = Array.isArray(opts.attachmentUrls) ? opts.attachmentUrls.slice() : [];
      let attachNote = '';
      if (fileList.length) {
        try {
          onStep(`Hosting ${fileList.length} attached file(s) so Capy can read them…`);
          const hosted = await capy.uploadBuffersToPublic(
            fileList.map(f => ({ name: f.name, buffer: f.buffer, mime: f.mime || sniffMime(f.buffer) })),
            { onStep, max: 8 }
          );
          for (const h of hosted) if (h && h.url) attachmentUrls.push(h.url);
          if (hosted.length) {
            attachNote =
              '\n\nThe user attached ' + hosted.length + ' file(s), provided as attachmentUrls ' +
              '(download and analyse them): ' +
              hosted.map(h => `${h.name} → ${h.url}`).join(' ; ') + '.';
          }
        } catch (e) {
          onStep(`Attachment hosting failed (${e.message.slice(0, 80)}) — continuing.`);
        }
      }
      const capyArgs = {
        message: (msg || 'Please complete the requested task and return any files.') + attachNote,
        attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
        repos: Array.isArray(opts.repos) ? opts.repos : undefined,
        projectId: opts.capyProjectId,
        model: opts.capyModel,
      };
      const out = await capy.run(capyArgs, { ceilingMs, intervalMs: opts.capyIntervalMs, onStep });
      if (out && ((out.reply && out.reply.trim()) || (out.files && out.files.length))) {
        return {
          reply: (out.reply || '').trim(),
          brain: 'capy',
          used: (out.files || []).map(f => ({ name: f.name, kind: 'capy_file', engine: 'capy', sentToVision: false })),
          extractedChars: 0,
          capyFiles: out.files || [],     // [{ name, buffer, mime, sourceUrl }]
          capyThreadId: out.threadId,
          capyRunState: out.runState,
          capyBlocked: !!out.blocked,
        };
      }
      // Capy finished but produced nothing usable → try the self-hosted sandbox.
      {
        const sb = await trySandboxFallback();
        if (sb) return sb;
      }
    } catch (e) {
      console.warn('[brain.answer] Capy head failed, trying self-hosted sandbox fallback:', e.message);
      // Capy errored / timed out → run the SAME task inside our OWN sandbox
      // (HopX → Runloop → Daytona), which ALSO polls until files come back, so
      // "render alone won't stop it". On failure here we still fall through to
      // the synchronous brain chain below.
      const sb = await trySandboxFallback();
      if (sb) return sb;
    }
  }

  // ── SELF-HOSTED SANDBOX FALLBACK (unified long-running agent) ─────────────
  // Defined as a closure so BOTH the "Capy empty" and "Capy errored" paths can
  // reuse it. Returns a brain-shaped result on success, or null/undefined to
  // fall through to the chat brain chain. NEVER throws.
  async function trySandboxFallback() {
    if (!sandboxBrain || typeof sandboxBrain.run !== 'function') return null;
    const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
    try {
      const sb = await sandboxBrain.run(
        {
          message: msg || 'Please complete the requested task and return any files.',
          attachments: fileList.map(f => ({ name: f.name, buffer: f.buffer, isImage: /^image\//i.test(f.mime || '') })),
          history,
          systemPrompt,
        },
        {
          sessionKey: opts.sandboxSessionKey || opts.sessionKey,
          onStep,
          onEvent: opts.onEvent,
        },
      );
      if (sb && ((sb.reply && sb.reply.trim()) || (sb.files && sb.files.length))) {
        return {
          reply: (sb.reply || '').trim(),
          brain: sb.brain || 'sandbox',
          used: (sb.files || []).map(f => ({ name: f.name, kind: 'sandbox_file', engine: sb.backend || 'sandbox', sentToVision: false })),
          extractedChars: 0,
          capyFiles: sb.files || [],      // reuse the same delivery channel as Capy files
          sandboxBackend: sb.backend,
          sandboxSteps: sb.steps,
        };
      }
    } catch (e) {
      console.warn('[brain.answer] self-hosted sandbox fallback failed, falling back to brain chain:', e.message);
    }
    return null;
  }

  // ── HEAD BRAIN FAST PATH: Sakana native document handling ────────────────
  // Sakana (Namazu) natively analyses PDF / DOCX / TXT / MD / JSON. When the
  // attachments are ALL Sakana-supported documents (no images / unsupported
  // types), hand them straight to Sakana with NATIVE upload — it reads the
  // files itself, so we skip the local extraction pipeline entirely. This makes
  // Sakana the head for file handling exactly as specced. On ANY failure we
  // fall through to the normal extract-to-text + brain-chain path below (which
  // ALSO tries Sakana first, then HotBot/Gemini/Cloudflare), so nothing breaks.
  const SAKANA_DOC_EXTS = /\.(pdf|docx|txt|md|markdown|json)$/i;
  function sakanaSupportsFile(f) {
    const mime = f.mime || sniffMime(f.buffer);
    return SAKANA_DOC_EXTS.test(String(f.name || '')) || sakana.SUPPORTED_MIMES.has(mime);
  }
  const allSakanaDocs = fileList.length > 0 && fileList.every(sakanaSupportsFile);
  // Native model file-reading is now an explicit compatibility fallback, not
  // the primary path. Deterministic extraction must run first by default.
  const SAKANA_NATIVE_FILES = /^(1|true|on|yes)$/i.test(String(process.env.SAKANA_NATIVE_FILES || '0'));
  if (SAKANA_NATIVE_FILES && sakana.isHeadEnabled() && allSakanaDocs && String(process.env.AGENT_SOLO || process.env.HOTBOT_SOLO || '').toLowerCase() === '') {
    try {
      const out = await sakana.answerWithFiles({ message: msg, files: fileList, history, systemPrompt });
      if (out && out.reply && out.reply.trim()) {
        return {
          reply: out.reply.trim(),
          brain: 'sakana',
          used: (out.usedFiles || fileList).map(f => ({
            name: f.name, kind: 'doc', engine: 'sakana_native', sentToVision: false,
          })),
          extractedChars: 0,
        };
      }
    } catch (e) {
      console.warn('[brain.answer] Sakana native doc path failed, falling back to extraction pipeline:', e.message);
    }
  }

  // Build a per-call fsx for OmniOCR. Cleaned up after the call.
  const ctx = { fsx: makeLocalFsx(), attachments: [], onStep: () => {} };
  const used = [];
  const contextBlocks = [];
  let totalChars = 0;

  // Per-file wall-clock budget. The whole HTTP request must finish before the
  // platform gateway (Render → 502 at ~50s) cuts us off, so no single file may
  // monopolise the clock. If extraction (incl. any sandbox provisioning + OCR)
  // exceeds this budget we abandon it and use the FAST last-resort path:
  //   • image → Gemini vision (also transcribes any visible text)
  //   • pdf/doc/sheet/text → pure-JS extractor (pdf-parse / mammoth / xlsx / utf8)
  // so the brain still gets usable context and the request returns in time.
  const FILE_BUDGET_MS = parseInt(process.env.BRAIN_FILE_BUDGET_MS || '38000', 10);

  async function fastFallbackBlock(f) {
    const kind = classifyFile(f.name, f.buffer);
    const mime = f.mime || sniffMime(f.buffer);
    if (kind === 'image') {
      let v = '';
      try {
        v = await geminiVision(f.buffer, mime,
          (msg ? msg + '\n\n' : '') + 'Describe what you see in detail and transcribe any visible text verbatim.');
      } catch (e) { v = '[Gemini vision failed: ' + e.message + ']'; }
      return {
        kind, name: f.name, sentToVision: true, engine: 'gemini_vision',
        contextBlock: `### Attached image: ${f.name} (visual, described by Gemini vision)\n${v || '[no description returned]'}`,
      };
    }
    const fb = await fallbackExtract(f.name, f.buffer);
    if (fb.ok && fb.text) {
      return {
        kind, name: f.name, sentToVision: false, engine: fb.engine,
        contextBlock: `### Attached file: ${f.name} (${kind}, extracted via ${fb.engine})\n${fb.text}`,
      };
    }
    return {
      kind, name: f.name, sentToVision: false, engine: 'none',
      contextBlock: `### Attached file: ${f.name} (${kind})\n[unable to extract text within the time budget: ${fb.reason || 'unknown'}]`,
    };
  }

  async function processFileBudgeted(f) {
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__BUDGET__'), FILE_BUDGET_MS);
      if (timer && timer.unref) timer.unref();
    });
    let r;
    try {
      r = await Promise.race([processFile(ctx, f, msg), budget]);
    } finally { if (timer) clearTimeout(timer); }
    if (r === '__BUDGET__') {
      console.warn(`[brain.answer] ${f.name}: extraction exceeded ${FILE_BUDGET_MS}ms — using fast fallback.`);
      return fastFallbackBlock(f);
    }
    return r;
  }

  try {
    // Process albums in a bounded pool while preserving input order. Nine-page
    // exam sets no longer pay nine sequential OCR round trips, and one failed
    // page cannot remove or reorder the others.
    const FILE_CONCURRENCY = Math.max(1, Math.min(5, parseInt(process.env.BRAIN_FILE_CONCURRENCY || '3', 10) || 3));
    const processed = new Array(fileList.length);
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= fileList.length) break;
        const f = fileList[i];
        try {
          processed[i] = await processFileBudgeted(f);
        } catch (e) {
          console.warn('[brain.answer] file failed:', f.name, e.message);
          processed[i] = {
            name: f.name, kind: 'error', engine: 'none', sentToVision: false,
            contextBlock: `### Attached file: ${f.name}\n[processing failed: ${e.message}]`,
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, fileList.length || 1) }, () => worker()));
    for (const r of processed) {
      used.push({ name: r.name, kind: r.kind, engine: r.engine, sentToVision: r.sentToVision });
      if (r.contextBlock) {
        contextBlocks.push(r.contextBlock);
        totalChars += r.contextBlock.length;
      }
    }

    const sys = systemPrompt || (
      'You are a helpful expert assistant. The user may attach files (PDF, DOCX, XLSX, images). ' +
      'When files are attached you will see EXTRACTED TEXT from them in CONTEXT blocks below. ' +
      'Use that extracted text as the source of truth. ' +
      'If a context block notes that an image was described by Gemini vision, treat that description as the ground truth for that image. ' +
      'Answer the user\'s question directly, faithfully and completely. Cite specific values, names, and figures from the extracted text when relevant. ' +
      'When several files or pages are supplied, maintain a completeness ledger: account for every named input and every numbered question in order; never silently skip an unreadable or unanswered item.'
    );

    const conversation = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-12)) {
        if (h && h.text) {
          conversation.push({
            role: (h.role === 'assistant' || h.role === 'model') ? 'assistant' : 'user',
            text: String(h.text).slice(0, 4000),
          });
        }
      }
    }
    if (contextBlocks.length) {
      // Pack fairly across inputs instead of slicing one concatenated string.
      // The old `.slice(0, 60000)` could include pages 1-4 and silently erase
      // pages 5-9. Every attachment now gets an ordered, explicit allocation;
      // oversized blocks retain both their beginning and ending with a visible
      // truncation marker rather than disappearing.
      const maxContext = Math.max(12000, parseInt(process.env.BRAIN_CONTEXT_MAX_CHARS || '180000', 10) || 180000);
      const separators = Math.max(0, contextBlocks.length - 1) * 2;
      const each = Math.max(1000, Math.floor((maxContext - separators) / contextBlocks.length));
      const packed = contextBlocks.map((block) => {
        if (block.length <= each) return block;
        const marker = `\n\n[EXTRACTION TRUNCATED: ${block.length - each} characters omitted; source remains accounted for]\n\n`;
        const room = Math.max(200, each - marker.length);
        const head = Math.ceil(room * 0.7);
        return block.slice(0, head) + marker + block.slice(-(room - head));
      });
      conversation.push({
        role: 'user',
        text: '=== CONTEXT (deterministically extracted from attached files; every block must be accounted for) ===\n\n' +
              packed.join('\n\n') + '\n\n=== END CONTEXT ===',
      });
    }
    conversation.push({ role: 'user', text: msg || (contextBlocks.length ? 'Summarise and explain the attached file(s).' : 'Hello.') });

    const result = await brainAnswer(sys, conversation);
    return { reply: result.reply, brain: result.brain, used, extractedChars: totalChars };
  } finally {
    try { await ctx.fsx.cleanup(); } catch (_) {}
    // Release the OCR-fallback sandbox if one was provisioned for this call.
    try { if (ctx.__sandbox && ctx.__sandbox.fsx && ctx.__sandbox.fsx.cleanup) await ctx.__sandbox.fsx.cleanup(); } catch (_) {}
  }
}

// ── Boot-time OCR warm-up ────────────────────────────────────────────────────
// Provision the OCR sandbox ONCE at server start and pre-install the OmniOCR
// toolchain inside it, so the FIRST user file is extracted instantly instead of
// paying the ~25s cold install (which can otherwise exceed the host HTTP
// gateway timeout and force a Gemini/local fallback). Uses a PERSISTENT session
// sandbox keyed `ocr-warm` so the same warmed box is reused across requests.
//
// Non-blocking, best-effort, never throws. Safe to call right after app.listen.
let _warmedOnce = false;
async function warmupOcrSandbox(opts = {}) {
  const onStep = opts.onStep || ((m) => console.log('[brain.warmup] ' + m));
  if (_warmedOnce) return { ok: true, skipped: 'already-warmed' };
  _warmedOnce = true;
  const started = Date.now();
  const ctx = { fsx: makeLocalFsx(), attachments: [], onStep };
  try {
    if (preferSandboxOcr()) {
      const sb = await ensureSandboxCtx(ctx);
      if (sb) {
        const r = await omniOcr.warmup(sb);
        onStep(r && r.ok ? '✅ deterministic sandbox OCR is warm.' : 'ℹ️ sandbox OCR warm-up deferred; it will retry on demand.');
        return { ...(r || { ok: false }), viaSandbox: true, ms: Date.now() - started };
      }
    }
    onStep('✅ native document extraction is ready; OCR will initialize on demand.');
    return { ok: true, engine: 'native_extractors', ms: Date.now() - started };
  } catch (e) {
    onStep('ℹ️ OCR warm-up deferred; normal fallbacks remain available.');
    return { ok: false, reason: e.message, ms: Date.now() - started };
  } finally {
    try { await ctx.fsx.cleanup(); } catch (_) {}
  }
}

module.exports = { answer, processFile, classifyFile, sniffMime, warmupOcrSandbox, _internals: { makeLocalFsx, brainAnswer, ocrExtract, ocrClassify, preferSandboxOcr, ensureSandboxCtx } };
