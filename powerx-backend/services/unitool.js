// unitool.js — Unitool.ai client (TEXT + VISION, keyless, free).
//
// Unitool.ai exposes a public support-widget AI endpoint that needs NO API key
// and NO signup. It is backed by an OpenRouter → Azure OpenAI vision GPT model,
// so it answers BOTH plain text AND multimodal (image) queries.
//
// Why it's wired here:
//   The HotBot "Gemini section" is the FALLBACK / VISION brain. To make that
//   backup strong even when the Gemini gateway is weak or down, Unitool joins
//   the race as an ADDITIONAL vision-capable brain. On image (multimodal)
//   requests it races alongside Gemini so there is always a second strong eye
//   on the picture; on pure-text requests it can race too (cheap, keyless).
//
// Endpoint (verified live):
//   POST https://unitool.ai/api/widget/stream
//   Body : { "messages": [ {role, content}, ... ] }   (OpenAI-style)
//   Auth : none
//   Reply: Server-Sent Events stream of  `data: {"content":"..."}`  chunks,
//          terminated by  `data: [DONE]`.
//
// Verified capabilities:
//   • TEXT   : works (streaming).
//   • VISION : works via OpenAI "image_url" parts. Accepts BOTH public https
//              image URLs AND base64 data: URIs. (Tested: coyote photo → "Coyote.")
//   • model field : IGNORED (backend uses one fixed model) — so we never send it.
//   • PDF/DOCX : NOT supported (image/text only).
//
// Public contract mirrors the other brains so it can join hotbot.js unchanged:
//   chat(messages, opts) -> string
const fetch = require('node-fetch');

const ENDPOINT = process.env.UNITOOL_ENDPOINT || 'https://unitool.ai/api/widget/stream';

// Enable flag (default ON because it's keyless). Set UNITOOL_DISABLED=1 to turn off.
function textEnabled() {
  const v = String(process.env.UNITOOL_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}
// hotbot.js race gate. Keyless → ON by default.
function isEnabled() { return textEnabled(); }
function supportsVision() { return true; }

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'text/event-stream',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://unitool.ai',
  'Referer': 'https://unitool.ai/en/chatgpt',
};

/**
 * Normalize OpenAI-style content (string OR multimodal parts) into the exact
 * shape Unitool's endpoint accepts. It speaks the OpenAI content schema
 * directly, so text + image_url parts pass through mostly untouched.
 */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
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

/** Parse the full SSE body into a single text string. */
function parseSSE(body) {
  const out = [];
  for (const rawLine of String(body).split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const obj = JSON.parse(data);
      if (obj && typeof obj.content === 'string') out.push(obj.content);
    } catch (_) { /* ignore non-JSON / error frames */ }
  }
  return out.join('');
}

/**
 * Chat via Unitool. Returns plain text. Supports text and vision (images).
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { timeout, onToken }
 */
async function chat(messages, opts = {}) {
  if (!textEnabled()) throw new Error('Unitool disabled (UNITOOL_DISABLED)');

  const payload = { messages: buildMessages(messages) };

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Unitool error (${resp.status}): ${t.slice(0, 160)}`);
  }

  // The endpoint streams SSE. node-fetch v2 gives us the body as text via
  // resp.text(); that contains the full `data: {...}` frame sequence.
  const body = await resp.text();
  const reply = parseSSE(body);
  if (!reply || !String(reply).trim()) {
    // 200 + empty stream usually means the input was rejected upstream
    // (e.g. an unsupported file). Surface it so the racer falls through.
    throw new Error('Unitool: empty response (input may be unsupported, e.g. PDF/DOCX)');
  }
  return String(reply).trim();
}

module.exports = {
  chat,
  isEnabled,
  textEnabled,
  supportsVision,
  ENDPOINT,
};
