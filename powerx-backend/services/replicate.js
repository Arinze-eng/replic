// ─────────────────────────────────────────────────────────────────────────────
// replicate.js — Replicate AI image-EDITING integration for the WormGPT Agent.
//
// Powers the `edit_image` tool: the user sends a photo on WhatsApp/Telegram and
// asks to change it ("remove the background", "add a party hat", "make it look
// like a painting", "remove the person on the left", …). We feed the image +
// the instruction to an instruction-based image-editing model on Replicate
// (default: black-forest-labs/flux-kontext-pro) and hand the edited image back.
//
// Design notes (mirrors services/browserless.js conventions):
//   • The API key is resolved at RUNTIME — DB setting `replicate_api_key` first
//     (admin panel → Integrations, so it can be rotated live with NO redeploy),
//     then the REPLICATE_API_TOKEN env var as a fallback.
//   • Pure node-fetch against the Replicate REST API — no extra SDK dependency,
//     so it works out of the box on Render with nothing else to install.
//   • Synchronous prediction via the `Prefer: wait` header (Replicate holds the
//     connection open until the prediction finishes), with a polling fallback
//     for long-running edits so it never hangs forever.
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require('node-fetch');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional (unit tests) */ }

const REPLICATE_BASE = (process.env.REPLICATE_BASE || 'https://api.replicate.com/v1').replace(/\/+$/, '');

// Default instruction-based image-editing model. Overridable via env.
// flux-kontext-max is the highest-fidelity FLUX-Kontext editing model: it makes
// precise, localized edits while keeping every untouched region pixel-identical
// (no blurring, no hallucinated changes). We default to it for high-quality
// editing; set REPLICATE_EDIT_MODEL to override (e.g. flux-kontext-pro).
const DEFAULT_EDIT_MODEL = (process.env.REPLICATE_EDIT_MODEL || 'black-forest-labs/flux-kontext-max').trim();

// Runtime key cache (short TTL) — avoids a DB hit on every call but still picks
// up admin key changes within a few seconds.
let _keyCache = { value: null, ts: 0 };
const KEY_TTL = 15000;

async function getKey() {
  const now = Date.now();
  if (_keyCache.value && now - _keyCache.ts < KEY_TTL) return _keyCache.value;
  let key = '';
  try {
    if (db && db.getSetting) {
      const runtime = await db.getSetting('replicate_api_key');
      if (runtime && runtime.trim()) key = runtime.trim();
    }
  } catch (_) {}
  if (!key) key = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '').trim();
  _keyCache = { value: key, ts: now };
  return key;
}

// Allow the admin route to flush the cache the instant a new key is saved.
function invalidateKeyCache() { _keyCache = { value: null, ts: 0 }; }

// Is Replicate configured (a key is present somewhere)?
function enabled() {
  try {
    // Cheap synchronous check on env; DB-backed key is checked lazily in getKey.
    if (_keyCache.value && _keyCache.value.trim()) return true;
    if ((process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '').trim()) return true;
  } catch (_) {}
  // Fall back to "maybe" — getKey() resolves the DB value when actually used.
  return false;
}

function authHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// Detect MIME from buffer magic bytes so PNG/WEBP/GIF aren't mislabelled.
function sniffMime(buf, fallback = 'image/png') {
  if (!buf || buf.length < 4) return fallback;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fallback;
}

function bufferToDataUri(buf, mime) {
  return `data:${mime || sniffMime(buf)};base64,${buf.toString('base64')}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Test the key by listing the authenticated account ────────────────────────
// Returns { ok, status, ms, message } — never throws.
async function testKey(overrideKey) {
  const token = (overrideKey && overrideKey.trim()) || (await getKey());
  if (!token) return { ok: false, status: 0, message: 'No Replicate API key configured.' };
  const started = Date.now();
  try {
    const r = await fetchWithTimeout(REPLICATE_BASE + '/account', { headers: authHeaders(token) }, 20000);
    const ms = Date.now() - started;
    if (r.ok) {
      let who = '';
      try { const d = await r.json(); who = d && (d.username || d.name) ? ' — ' + (d.username || d.name) : ''; } catch (_) {}
      return { ok: true, status: r.status, ms, message: '✅ Working — Replicate API reachable in ' + ms + 'ms' + who + '.' };
    }
    let msg = '❌ Replicate returned HTTP ' + r.status + '.';
    if (r.status === 401 || r.status === 403) msg = '❌ Invalid or unauthorized Replicate API key (401/403).';
    return { ok: false, status: r.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: '❌ Could not reach Replicate: ' + e.message };
  }
}

// ── Normalise the prediction output into a single image URL ──────────────────
function pickOutputUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    for (const o of output) { const u = pickOutputUrl(o); if (u) return u; }
    return null;
  }
  // Some models return { url } or FileOutput-like objects.
  if (typeof output === 'object') {
    if (typeof output.url === 'string') return output.url;
    if (output.output) return pickOutputUrl(output.output);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// editImage — edit an input image per a text instruction.
//   buffer : Buffer of the source image (the photo the user sent).
//   prompt : the edit instruction (e.g. "remove the background").
//   opts   : { model?, mime?, onStep?, outputFormat? }
// returns  : { buffer, mime, model, url } — the edited image as a Buffer.
// throws   : on hard failure (no key, model error, timeout).
// ─────────────────────────────────────────────────────────────────────────────
async function editImage(buffer, prompt, opts = {}) {
  const token = await getKey();
  if (!token) throw new Error('Replicate is not configured (no API key). Add it in Admin → Integrations.');
  if (!buffer || !buffer.length) throw new Error('No source image provided.');
  const instruction = String(prompt || '').trim();
  if (!instruction) throw new Error('No edit instruction provided.');

  const model = (opts.model || DEFAULT_EDIT_MODEL).trim();
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const mime = opts.mime || sniffMime(buffer);
  const dataUri = bufferToDataUri(buffer, mime);
  // Default to PNG so the edited result is lossless (no JPEG compression
  // artifacts / blurring). Callers can still override via opts.outputFormat.
  const outputFormat = (opts.outputFormat || 'png').replace(/[^\w]/g, '') || 'png';

  // ── Precision wrapper ──────────────────────────────────────────────────────
  // FLUX-Kontext edits exactly what the prompt describes, but explicitly telling
  // it to PRESERVE everything else dramatically reduces unwanted changes,
  // blurring of the background, and accidental removal of objects the user did
  // not ask about. We append clear preservation directives unless the caller
  // opted out (opts.raw === true) so we get high-precision, high-fidelity edits.
  let finalPrompt = instruction;
  if (!opts.raw) {
    finalPrompt =
      instruction +
      '. Apply ONLY this change and nothing else. Keep every other part of the image exactly the same — ' +
      'preserve the original subject, faces, identities, pose, composition, colors, lighting, textures and background. ' +
      'Do not remove, add, distort, crop, recolor or alter anything that was not requested. ' +
      'Maintain photorealistic, sharp, high-resolution detail with no blur, no smudging and no compression artifacts. ' +
      'Result must look natural and seamlessly integrated.';
  }

  // FLUX-Kontext uses `input_image`; some editing models use `image`. We send
  // BOTH common keys so the same call works across the popular editing models.
  // The extra quality knobs (output_quality, prompt_upsampling, aspect_ratio:
  // match_input_image) maximise fidelity and keep the output dimensions /
  // framing identical to the source so nothing the user didn't ask for changes.
  const input = {
    prompt: finalPrompt,
    input_image: dataUri,
    image: dataUri,
    output_format: outputFormat,
    output_quality: 100,
    prompt_upsampling: true,
    aspect_ratio: 'match_input_image',
    safety_tolerance: 6,
  };

  onStep('🖌️ editing image via Replicate (' + model + ')…');

  // Call the official-model endpoint with `Prefer: wait` for a synchronous run.
  const url = `${REPLICATE_BASE}/models/${model}/predictions`;

  // Helper: POST a given input body to the model.
  async function postInput(body) {
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...authHeaders(token), Prefer: 'wait' },
      body: JSON.stringify({ input: body }),
    }, 180000);
  }

  let r;
  try {
    r = await postInput(input);
  } catch (e) {
    throw new Error('Replicate request failed: ' + e.message);
  }

  let pred;
  try { pred = await r.json(); } catch (_) { pred = null; }

  // If the model rejected one of our quality knobs (some editing models don't
  // accept output_quality / prompt_upsampling / aspect_ratio), retry once with
  // a minimal, universally-supported input so the edit still goes through.
  if (!r.ok && (r.status === 422 || r.status === 400)) {
    const minimal = {
      prompt: finalPrompt,
      input_image: dataUri,
      image: dataUri,
      output_format: outputFormat,
      safety_tolerance: 6,
    };
    try {
      const r2 = await postInput(minimal);
      const pred2 = await r2.json().catch(() => null);
      if (r2.ok) { r = r2; pred = pred2; }
    } catch (_) { /* keep original error below */ }
  }

  if (!r.ok) {
    const detail = pred && (pred.detail || pred.title || JSON.stringify(pred));
    throw new Error('Replicate HTTP ' + r.status + ': ' + (detail || 'unknown error').slice(0, 300));
  }

  // If `Prefer: wait` returned before completion, poll until done.
  let status = pred && pred.status;
  let getUrl = pred && pred.urls && pred.urls.get;
  const deadline = Date.now() + 170000;
  while (status && status !== 'succeeded' && status !== 'failed' && status !== 'canceled') {
    if (Date.now() > deadline) throw new Error('Replicate edit timed out.');
    await new Promise((res) => setTimeout(res, 1500));
    if (!getUrl) break;
    try {
      const pr = await fetchWithTimeout(getUrl, { headers: authHeaders(token) }, 20000);
      pred = await pr.json();
      status = pred.status;
    } catch (_) { /* keep polling */ }
  }

  if (status === 'failed' || status === 'canceled') {
    throw new Error('Replicate edit ' + status + ': ' + ((pred && pred.error) || 'no detail'));
  }

  const outUrl = pickOutputUrl(pred && pred.output);
  if (!outUrl) throw new Error('Replicate returned no image output.');

  // Download the edited image bytes.
  onStep('⬇️ downloading edited image…');
  const imgResp = await fetchWithTimeout(outUrl, {}, 60000);
  if (!imgResp.ok) throw new Error('Could not download edited image (HTTP ' + imgResp.status + ').');
  const outBuf = Buffer.from(await imgResp.arrayBuffer());
  if (!outBuf.length) throw new Error('Edited image was empty.');

  return {
    buffer: outBuf,
    mime: sniffMime(outBuf, 'image/jpeg'),
    model,
    url: outUrl,
  };
}

module.exports = {
  REPLICATE_BASE,
  DEFAULT_EDIT_MODEL,
  getKey,
  invalidateKeyCache,
  enabled,
  testKey,
  editImage,
  sniffMime,
};
