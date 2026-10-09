'use strict';

// Guaranteed inbound attachment → text pre-ingestion.
// This runs before any agent/sandbox/model planning so the LLM receives file
// contents even if it never chooses read_document/analyze_image. The underlying
// OCR process has its own hard deadline; this wrapper adds a per-file wall-clock
// budget and preserves source order across multi-file batches.

const ocr = require('./simpleOcr');

const DEFAULT_FILE_MS = 25000;
const DEFAULT_MAX_CHARS = 180000;

function bounded(promise, ms) {
  let timer;
  const timeout = new Promise(resolve => {
    // Keep this timer referenced: it is the guarantee that a hung extractor
    // resolves. Unref'ing it can let short-lived workers exit before cleanup.
    timer = setTimeout(() => resolve({ ok: false, reason: `pre-ingestion-timeout-${ms}ms` }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function packBlocks(blocks, maxChars) {
  if (!blocks.length) return '';
  const each = Math.max(1000, Math.floor(maxChars / blocks.length));
  return blocks.map(block => {
    if (block.length <= each) return block;
    const marker = `\n\n[TEXT TRUNCATED: ${block.length - each} characters omitted]\n\n`;
    const room = Math.max(200, each - marker.length);
    const head = Math.ceil(room * 0.75);
    return block.slice(0, head) + marker + block.slice(-(room - head));
  }).join('\n\n');
}

async function extractAttachments(files, options = {}) {
  const list = (Array.isArray(files) ? files : []).filter(f =>
    f && Buffer.isBuffer(f.buffer) && f.buffer.length && (ocr.isImageName(f.name) || ocr.isDocName(f.name)));
  if (!list.length) return { context: '', results: [], extractedCount: 0 };

  const perFileMs = Math.max(10000, Math.min(90000,
    Number(options.perFileMs) || Number(process.env.ATTACHMENT_PREINGEST_FILE_MS) || DEFAULT_FILE_MS));
  const maxChars = Math.max(12000,
    Number(options.maxChars) || Number(process.env.ATTACHMENT_PREINGEST_MAX_CHARS) || DEFAULT_MAX_CHARS);
  const concurrency = Math.max(1, Math.min(4,
    Number(options.concurrency) || Number(process.env.ATTACHMENT_PREINGEST_CONCURRENCY) || 2));
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const f = list[i];
      try {
        // No fsx: use the deterministic host engine baked into the production
        // image. This deliberately avoids sandbox provisioning/command queues.
        results[i] = await bounded(ocr.extract({}, f.buffer, f.name, {
          mode: 'auto', pages: 30, tables: true,
        }), perFileMs);
      } catch (e) {
        results[i] = { ok: false, reason: e && e.message ? e.message : String(e) };
      }
      results[i] = { name: f.name, ...(results[i] || { ok: false, reason: 'no-result' }) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));

  const blocks = [];
  for (const r of results) {
    if (r && r.ok && typeof r.text === 'string' && r.text.trim()) {
      blocks.push(`### PRE-EXTRACTED ATTACHMENT TEXT: ${r.name}\n${r.text.trim()}`);
    }
  }
  const context = packBlocks(blocks, maxChars);
  if (context && typeof options.onStep === 'function') {
    try { options.onStep(`📄 Extracted readable text from ${blocks.length}/${list.length} attached file(s) for the AI.`); } catch (_) {}
  }
  return { context, results, extractedCount: blocks.length };
}

module.exports = { extractAttachments, _internals: { bounded, packBlocks } };
