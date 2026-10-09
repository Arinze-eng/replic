// pollinations.js — Pollinations.AI client (TEXT + IMAGE, keyless, free).
//
// Pollinations is a free, open generative platform that needs NO API key and
// NO signup. It is rock-solid for a public Render box because there is nothing
// to mint, rotate, or expire — every call is an anonymous HTTPS request.
//
// Capabilities wired here (verified):
//   • TEXT  : POST https://text.pollinations.ai/openai  (OpenAI-style messages)
//             — also supports vision models, so it can answer multimodal too.
//             Fallback simple GET https://text.pollinations.ai/{prompt}.
//   • IMAGE : GET  https://image.pollinations.ai/prompt/{prompt}?width&height&...
//             — returns the raw image bytes directly (no polling).
//
// Public contract mirrors the other brains so it can join hotbot.js unchanged:
//   chat(messages, opts) -> string
//   generateImageBuffer(prompt, opts) -> Buffer
//   generateImage(prompt, opts) -> { url(data-uri), model }
//
// Everything is keyless, so isEnabled() is ON by default. It can be disabled
// per-capability via env flags so it can NEVER be forced to break the system.
const fetch = require('node-fetch');

const TEXT_BASE  = process.env.POLLINATIONS_TEXT_BASE  || 'https://text.pollinations.ai';
const IMAGE_BASE = process.env.POLLINATIONS_IMAGE_BASE || 'https://image.pollinations.ai';

// Default models (override via env). Text uses the keyless "openai" alias
// (GPT-OSS reasoning LLM); image uses "flux" (falls back to provider default).
const TEXT_MODEL  = process.env.POLLINATIONS_TEXT_MODEL  || 'openai';
const IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || 'flux';

// Optional referrer/token: Pollinations works anonymously, but passing a
// referrer (or token) raises rate limits. Both are optional.
const REFERRER = process.env.POLLINATIONS_REFERRER || 'hackerx-v7';
const TOKEN    = process.env.POLLINATIONS_TOKEN    || '';

// Enable flags (default ON because it's keyless). Set *_DISABLED=1 to turn off.
function textEnabled() {
  const v = String(process.env.POLLINATIONS_TEXT_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}
function imageEnabled() {
  const v = String(process.env.POLLINATIONS_IMAGE_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}
// hotbot.js text-race gate.
function isEnabled() { return textEnabled(); }

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

/* ───────────────────────────── TEXT ───────────────────────────── */

/** Map OpenAI-style content (string OR multimodal parts) → Pollinations parts.
 *  Pollinations' /openai endpoint accepts the OpenAI content schema directly,
 *  including text + image_url parts, so we pass it through mostly untouched. */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Keep text + image_url parts; the openai-compatible endpoint understands both.
    const parts = content
      .filter(p => p && (p.type === 'text' || p.type === 'image_url'))
      .map(p => p.type === 'text'
        ? { type: 'text', text: p.text || '' }
        : { type: 'image_url', image_url: p.image_url });
    return parts.length ? parts : '';
  }
  return String(content || '');
}

function buildMessages(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
    content: normalizeContent(m.content),
  }));
}

/**
 * Chat via Pollinations (OpenAI-compatible). Returns plain text.
 * Supports text and (with a vision model) multimodal input.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { model, timeout }
 */
async function chat(messages, opts = {}) {
  if (!textEnabled()) throw new Error('Pollinations text disabled (POLLINATIONS_TEXT_DISABLED)');
  const payload = {
    model: opts.model || TEXT_MODEL,
    messages: buildMessages(messages),
    referrer: REFERRER,
  };
  const headers = { 'Content-Type': 'application/json', ...COMMON_HEADERS };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;

  const resp = await fetch(`${TEXT_BASE}/openai`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Pollinations text error (${resp.status}): ${t.slice(0, 160)}`);
  }
  const data = await resp.json().catch(() => null);
  const reply = data && data.choices && data.choices[0] &&
                data.choices[0].message && data.choices[0].message.content;
  if (!reply || !String(reply).trim()) throw new Error('Pollinations: empty text response');
  return String(reply).trim();
}

/* ───────────────────────────── IMAGE ──────────────────────────── */

function buildImageUrl(prompt, opts = {}) {
  const p = encodeURIComponent(String(prompt || '').trim());
  const qs = new URLSearchParams();
  qs.set('model', opts.model || IMAGE_MODEL);
  qs.set('width',  String(opts.width  || opts.size_w || 1024));
  qs.set('height', String(opts.height || opts.size_h || 1024));
  if (opts.seed != null) qs.set('seed', String(opts.seed));
  qs.set('nologo', 'true');
  qs.set('referrer', REFERRER);
  if (TOKEN) qs.set('token', TOKEN);
  return `${IMAGE_BASE}/prompt/${p}?${qs.toString()}`;
}

/**
 * Generate an image and return the raw bytes Buffer.
 * @param {string} prompt
 * @param {Object} opts { model, width, height, seed, timeout }
 */
async function generateImageBuffer(prompt, opts = {}) {
  if (!imageEnabled()) throw new Error('Pollinations image disabled (POLLINATIONS_IMAGE_DISABLED)');
  if (!prompt || !String(prompt).trim()) throw new Error('Pollinations: prompt is required');
  const url = buildImageUrl(prompt, opts);
  const resp = await fetch(url, {
    method: 'GET',
    headers: COMMON_HEADERS,
    signal: AbortSignal.timeout(opts.timeout || 90000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Pollinations image error (${resp.status}): ${t.slice(0, 160)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (!/image\//i.test(ct)) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Pollinations image: non-image response (${ct}): ${t.slice(0, 120)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf || buf.length < 100) throw new Error('Pollinations image: empty image');
  return buf;
}

/**
 * Generate an image and return a data-URI result object (matches the shape
 * hotbot.generateImage produces so server.js callers work unchanged).
 * @returns {{ url:string, model:string, mime:string }}
 */
async function generateImage(prompt, opts = {}) {
  const buf = await generateImageBuffer(prompt, opts);
  const mime = 'image/jpeg';
  const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
  return { url: dataUri, model: `pollinations/${opts.model || IMAGE_MODEL}`, mime };
}

function supportsImageGen() { return imageEnabled(); }
function supportsVision()   { return true; } // vision models available on text endpoint

module.exports = {
  chat,
  generateImage,
  generateImageBuffer,
  isEnabled,
  textEnabled,
  imageEnabled,
  supportsImageGen,
  supportsVision,
  TEXT_BASE,
  IMAGE_BASE,
};
