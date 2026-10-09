'use strict';

// Image-editing orchestrator. Natural-language image-to-image requests always
// use deAPI first and never get silently converted into sandbox operations.
// The sandbox editor is reserved for callers that explicitly provide an
// `operations` array/object for exact mechanical transformations.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'python', 'precise_image_edit.py'));
const IMAGE_RE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

function safeName(name, fallback = 'image') {
  return (String(name || fallback).replace(/[^\w.\-]/g, '_') || fallback).slice(0, 180);
}

function numberNear(text, regex) {
  const m = String(text).match(regex); return m ? Number(m[1]) : null;
}

function parsePrompt(prompt, args = {}) {
  const p = String(prompt || '').trim();
  const low = p.toLowerCase();
  const ops = [];
  let m;
  if (/remove (the )?background|transparent background|cut ?out/.test(low)) ops.push({ type: 'remove_background' });
  if ((m = low.match(/(?:resize|scale|dimensions?).{0,30}?(\d{1,5})\s*[x×]\s*(\d{1,5})/))) {
    ops.push({ type: 'resize', width: +m[1], height: +m[2], keep_aspect: /keep|preserve|maintain/.test(low), fit: /fit|within|contain/.test(low) ? 'contain' : undefined });
  } else if ((m = low.match(/(?:resize|width).{0,20}?(\d{1,5})\s*(?:px|pixels?)?/))) {
    ops.push({ type: 'resize', width: +m[1], keep_aspect: true });
  } else if ((m = low.match(/(?:height).{0,20}?(\d{1,5})\s*(?:px|pixels?)?/))) {
    ops.push({ type: 'resize', height: +m[1], keep_aspect: true });
  }
  if ((m = low.match(/crop.{0,30}?(\d{1,5})\s*[x×]\s*(\d{1,5})(?:.{0,15}?(?:at|from)\s*(\d{1,5})\s*[,x ]\s*(\d{1,5}))?/))) {
    ops.push({ type: 'crop', width: +m[1], height: +m[2], x: +(m[3] || 0), y: +(m[4] || 0) });
  }
  if ((m = low.match(/rotate.{0,15}?(-?\d+(?:\.\d+)?)\s*(?:degrees?|°)/))) ops.push({ type: 'rotate', degrees: +m[1], expand: true });
  if (/flip (?:it )?(?:horizontally|horizontal)|mirror/.test(low)) ops.push({ type: 'flip_horizontal' });
  if (/flip (?:it )?(?:vertically|vertical)/.test(low)) ops.push({ type: 'flip_vertical' });
  if (/grayscale|greyscale|black and white|b&w/.test(low)) ops.push({ type: 'grayscale' });
  if (/sharpen/.test(low)) ops.push({ type: 'sharpen', radius: numberNear(low, /sharpen.{0,12}?(\d+(?:\.\d+)?)/) || 2 });
  if (/\bblur\b/.test(low)) ops.push({ type: 'blur', radius: numberNear(low, /blur.{0,12}?(\d+(?:\.\d+)?)/) || 4 });
  if (/strip (?:exif|metadata)|remove (?:exif|metadata)/.test(low)) ops.push({ type: 'strip_metadata' });
  // Text edits must become replace_text, not a new annotation layered over the
  // old pixels. Accept quoted and natural phrasing such as:
  // "edit the Grant notification access to Grant county acess 😃😪".
  const replace = p.match(/(?:replace|change|edit)\s+(?:the\s+)?(?:text\s+)?["“']?(.+?)["”']?\s+(?:to|with)\s+["“']?(.+?)["”']?\s*$/i);
  if (replace) {
    ops.push({
      type: 'replace_text', old_text: replace[1].trim(), new_text: replace[2].trim(),
      box: args.box, font_size: args.font_size, font: args.font, color: args.color,
      background: args.background, padding: args.padding, max_width: args.max_width,
    });
  } else if (args.text || (m = p.match(/(?:add|write|put)\s+(?:the\s+)?text\s+["“']([^"”']+)["”']/i))) {
    ops.push({ type: 'add_text', text: args.text || m[1], x: args.x, y: args.y, position: args.position, font_size: args.font_size, color: args.color, background: args.background });
  }
  return ops.map(op => Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)));
}

function normalizeOperations(args) {
  // Security/reliability boundary: only a structured operation supplied by the
  // caller may invoke the sandbox editor. Natural-language prompts are not
  // parsed into sandbox work because doing so bypasses the configured primary
  // image-to-image provider for requests such as background or text changes.
  if (Array.isArray(args.operations) && args.operations.length) return args.operations;
  if (args.operation && typeof args.operation === 'object') return [args.operation];
  return [];
}

async function pickImage(ctx, requested) {
  const want = requested && safeName(requested);
  const attachments = (ctx.attachments || []).filter(a => a && (a.isImage || IMAGE_RE.test(a.name || '')));
  let att = attachments.find(a => safeName(a.name) === want) || (attachments.length === 1 ? attachments[0] : null);
  if (att) {
    const rel = safeName(att.name, 'input.png');
    if (!(await ctx.fsx.exists(rel)) && att.buffer) await ctx.fsx.uploadBuffer(rel, att.buffer);
    return rel;
  }
  const files = await ctx.fsx.list();
  const images = files.filter(f => IMAGE_RE.test(f.rel) && !/^edited[-_.]|^result[-_.]/i.test(path.posix.basename(f.rel)));
  if (want) {
    const exact = images.find(f => safeName(path.posix.basename(f.rel)) === want || f.rel === requested);
    if (exact) return exact.rel;
  }
  if (images.length === 1) return images[0].rel;
  if (images.length) return images.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0].rel;
  return null;
}

function outputName(source, args, operations) {
  if (args.output || args.filename) return safeName(args.output || args.filename);
  const needsPng = operations.some(op => /remove_background/.test(op.type || op.op || ''));
  const requestedFormat = String(args.prompt || '').match(/(?:convert|format|save|export).{0,20}?\b(png|jpe?g|webp|bmp|tiff?)\b/i);
  const ext = needsPng ? '.png' : (requestedFormat ? `.${requestedFormat[1].toLowerCase().replace('jpeg', 'jpg')}` : (path.extname(source) || '.png').toLowerCase());
  return `edited-${path.basename(source, path.extname(source))}${ext}`;
}

async function toolGenerativeEdit(source, args, ctx) {
  const prompt = String(args.prompt || args.instruction || args.edit || '').trim();
  if (!prompt) return '[edit_image] Describe the change to make to the attached image.';
  let sourceBuffer = null;
  const wanted = safeName(path.posix.basename(source));
  const attachment = (ctx.attachments || []).find(a => a && a.buffer && safeName(a.name) === wanted);
  if (attachment) sourceBuffer = attachment.buffer;
  if (!sourceBuffer) sourceBuffer = await ctx.fsx.downloadBuffer(source);
  if (!sourceBuffer || !sourceBuffer.length) return '[edit_image] The source image could not be read.';

  const preservePrompt = args.raw === true ? prompt :
    `${prompt}. Apply only the requested change. Preserve the original subject identity, faces, pose, composition, ` +
    'lighting, colors, textures, background, text and all untouched details. Do not crop or alter anything else. ' +
    'Return a sharp, natural, high-quality edited image.';
  const output = safeName(args.output || args.filename || `edited-${path.basename(source, path.extname(source))}.png`);
  if (output === path.posix.basename(source)) return '[edit_image] Output must use a new filename so the original remains intact.';
  try {
    const deapi = require('./deapi');
    if (ctx.onStep) ctx.onStep('🎨 editing the image from your text instruction…');
    const result = await deapi.editImage(sourceBuffer, preservePrompt, {
      mime: attachment && attachment.mime,
      width: Number.isInteger(args.width) ? args.width : undefined,
      height: Number.isInteger(args.height) ? args.height : undefined,
      seed: Number.isInteger(args.seed) ? args.seed : undefined,
      model: args.model,
      attempts: Number.isInteger(args.attempts) ? args.attempts : 3,
      pollRetries: Number.isInteger(args.poll_retries) ? args.poll_retries : 5,
      onProgress: (progress, status) => {
        if (ctx.onStep && progress > 0) ctx.onStep(`🎨 image edit ${status} (${Math.round(progress)}%)…`);
      },
      onRetry: ({ label, stage, attempt, attempts }) => {
        if (ctx.onStep) ctx.onStep(`🎨 image edit provider retry ${attempt}${attempts ? `/${attempts}` : ''} (${stage || label || 'transient failure'})…`);
      },
    });
    await ctx.fsx.uploadBuffer(output, result.buffer);
    if (!(await ctx.fsx.exists(output))) throw new Error('edited file was not persisted');
    ctx.addFile(output, output);
    return `[edit_image] ✅ Generative image edit complete via ${result.model}; ${result.buffer.length} bytes. Queued ${output} for delivery.`;
  } catch (error) {
    // Only after the API's bounded retry budget is exhausted, allow a narrow
    // deterministic fallback for edits the local engine can faithfully express.
    // Creative/object/style edits must fail clearly rather than fabricate output.
    const fallbackOperations = parsePrompt(prompt, args);
    if (fallbackOperations.length && args.disable_sandbox_fallback !== true) {
      if (ctx.onStep) ctx.onStep('🖼️ the primary image editor stayed unavailable after retries; applying the deterministic fallback…');
      return toolEditImage({ ...args, prompt: undefined, instruction: undefined, edit: undefined, operations: fallbackOperations }, ctx);
    }
    return `[edit_image] generative editor failed after retries: ${String(error.message || error).slice(0, 1200)}`;
  }
}

async function toolEditImage(args, ctx) {
  args = args || {};
  const source = await pickImage(ctx, args.name || args.source);
  if (!source) return '[edit_image] No source image is available. Attach an image or pass its exact filename.';
  const operations = normalizeOperations(args);
  // Every prompt-only image edit goes directly to deAPI. Exact sandbox editing
  // remains available only when the caller deliberately supplies operations.
  if (!operations.length) return toolGenerativeEdit(source, args, ctx);
  const output = outputName(source, args, operations);
  if (output === path.posix.basename(source)) return '[edit_image] Output must use a new filename so the original remains intact.';
  const id = crypto.randomBytes(6).toString('hex');
  const engine = `.precise_image_edit_${id}.py`;
  const jobName = `.precise_image_job_${id}.json`;
  const job = { source, output, operations, quality: args.quality, compress_level: args.compress_level };
  try {
    await ctx.fsx.uploadBuffer(engine, ENGINE_SOURCE);
    await ctx.fsx.writeText(jobName, JSON.stringify(job));
    if (ctx.onStep) ctx.onStep(`🖼️ applying ${operations.length} precise image edit${operations.length === 1 ? '' : 's'} in the sandbox…`);
    const needsOcr = operations.some(op => /^(replace_text|edit_text)$/.test(String(op.type || op.op || '').toLowerCase()) && !op.box);
    const command = [
      'set -e',
      // Providers differ: some have pip, some only apt, and some require sudo.
      // Install Pillow through a verified ladder rather than assuming pip exists.
      'if ! python3 -c "import PIL" 2>/dev/null; then SU=""; [ "$(id -u)" = 0 ] || SU=sudo; (($SU apt-get update -qq && $SU apt-get install -y -qq python3-pil python3-pip) || true); fi',
      'python3 -c "import PIL" 2>/dev/null || (python3 -m pip install -q --break-system-packages Pillow 2>/dev/null || python3 -m pip install -q Pillow)',
      needsOcr ? 'if ! command -v tesseract >/dev/null 2>&1; then SU=""; [ "$(id -u)" = 0 ] || SU=sudo; $SU apt-get update -qq && $SU apt-get install -y -qq tesseract-ocr; fi' : 'true',
      needsOcr ? 'python3 -c "import pytesseract" 2>/dev/null || (python3 -m pip install -q --break-system-packages pytesseract 2>/dev/null || python3 -m pip install -q pytesseract)' : 'true',
      // rembg/OpenCV are optional: the engine has a deterministic border-mask
      // fallback and Pillow implementations for its core operation set.
      `python3 ${JSON.stringify(engine)} ${JSON.stringify(jobName)} --workdir .`,
    ].join(' && ');
    const run = await ctx.fsx.sh(command);
    if (run.exitCode !== 0) return `[edit_image] deterministic editor failed: ${(run.output || '').slice(-2000)}`;
    let report;
    try {
      const reportLine = (run.output || '').trim().split('\n').reverse().find(line => line.trim().startsWith('{') && line.includes('"ok"'));
      report = reportLine ? JSON.parse(reportLine) : null;
    } catch (_) { report = null; }
    if (!report || !report.ok || !(await ctx.fsx.exists(output))) return `[edit_image] verification failed: ${(run.output || '').slice(-1600)}`;
    const bytes = await ctx.fsx.downloadBuffer(output);
    if (!bytes || bytes.length < 32) return '[edit_image] verification failed: output file is empty.';
    ctx.addFile(output, output);
    return `[edit_image] VERIFIED deterministic edit complete (no generative AI): ${report.before.size.join('×')} → ${report.after.size.join('×')}, ${report.after.mode}, ${report.after.bytes} bytes; operations=${report.operations.map(x => x.type).join(', ')}. Queued ${output} for delivery.`;
  } catch (e) {
    return `[edit_image] deterministic editor error: ${e.message}`;
  } finally {
    try { await ctx.fsx.sh(`rm -f ${JSON.stringify(engine)} ${JSON.stringify(jobName)}`); } catch (_) {}
  }
}

module.exports = { toolEditImage, toolGenerativeEdit, parsePrompt, normalizeOperations };
