// hotbotReal.js — Node client for the REAL HotBot.com AI backend.
//
// Ported from the verified Python reference client (hotbot.py, 2026-06-14).
// Pure node-fetch — no Python runtime needed on Render.
//
// Endpoints (no authentication required for chat/vision/pdf):
//   POST /api/chat            -> SSE stream of `data: {"content":"..."}` chunks, ends with `data: [DONE]`
//   POST /api/image           -> 202 { statusUrl, responseUrl }   (then poll status)
//   GET  /api/image/status    -> { status, url }
//   GET  /api/models          -> { models: [...] }
//
// Message content may be a string OR an array of parts:
//   text  : { type:'text',  text:'...' }
//   image : { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }
//   file  : { type:'input_file', filename:'x.pdf', file_data:'data:application/pdf;base64,...' }

const fetch = require('node-fetch');

const BASE_URL = 'https://www.hotbot.com';
const DEFAULT_CHAT_MODEL = process.env.HOTBOT_MODEL || 'gpt-5';
const DEFAULT_IMAGE_MODEL = process.env.HOTBOT_IMAGE_MODEL || 'bytedance-seedream-v5-lite';
const DEFAULT_IMAGE_SIZE = '1024x1024';

const HEADERS = {
  'Content-Type': 'application/json',
  'Origin': BASE_URL,
  'Referer': `${BASE_URL}/`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/event-stream',
};

class HotBotError extends Error {}

// Detect HotBot's error envelope (e.g. upgrade_required / quota).
function checkErrorEnvelope(obj) {
  if (obj && typeof obj === 'object' && typeof obj.type === 'string' &&
      obj.type.startsWith('urn:chat-ai:error')) {
    const title = obj.title || 'Error';
    const detail = obj.detail || '';
    throw new HotBotError(`${title}: ${detail} (code=${obj.code})`);
  }
}

/**
 * POST /api/chat and consume the SSE stream. Returns the full reply text.
 * @param {Array} messages OpenAI-style messages (string or parts-array content).
 * @param {Object} opts { model, mode ('web_search'|'deep_research'), timeout, onToken }
 */
async function streamChat(messages, opts = {}) {
  const model = opts.model || DEFAULT_CHAT_MODEL;
  const timeout = opts.timeout || 120000;
  const payload = { messages, model };
  if (opts.mode) payload.mode = opts.mode;

  const resp = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });

  if (resp.status !== 200) {
    const t = await resp.text().catch(() => '');
    throw new HotBotError(`HotBot /api/chat HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }

  // node-fetch v2 body is a Node stream; iterate raw chunks and parse SSE lines.
  const pieces = [];
  let buffer = '';

  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith(': ')) return;        // blank / keepalive
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch (_) { return; }
    checkErrorEnvelope(chunk);
    const token = chunk.content || '';
    if (token) {
      pieces.push(token);
      if (opts.onToken) { try { opts.onToken(token); } catch (_) {} }
    }
  };

  await new Promise((resolve, reject) => {
    resp.body.on('data', (buf) => {
      buffer += buf.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        try { handleLine(line); } catch (e) { reject(e); return; }
      }
    });
    resp.body.on('end', () => { try { if (buffer) handleLine(buffer); resolve(); } catch (e) { reject(e); } });
    resp.body.on('error', reject);
  });

  const out = pieces.join('');
  // GUEST-LIMIT / ERROR DETECTION: HotBot now sometimes returns HTTP 200 with a
  // single JSON ERROR ENVELOPE as the WHOLE body (not SSE `data:` lines), e.g.
  // {"type":"urn:chat-ai:error:rate_limit_guest", ...}. The per-line SSE parser
  // never sees it (no `data:` prefix), so we'd silently return ''. Detect that
  // here and THROW so callers can fall back to another backend.
  if (!out) {
    const raw = (buffer || '').trim();
    if (raw) {
      try { checkErrorEnvelope(JSON.parse(raw)); } catch (e) { if (e instanceof HotBotError) throw e; }
    }
    throw new HotBotError('HotBot returned an empty response (possible guest rate-limit / sign-in required).');
  }
  return out;
}

/**
 * Public chat: accepts OpenAI-style messages, returns the full text reply.
 * This is the same shape the existing hotbot.js `chat(messages)` expects.
 */
async function chat(messages, opts = {}) {
  return await streamChat(messages, opts);
}

/**
 * Generate an image and return its hosted URL (and optionally bytes).
 * Returns { url, model, blurred }. Throws HotBotError on quota/limit.
 */
async function generateImage(prompt, opts = {}) {
  const model = opts.model || DEFAULT_IMAGE_MODEL;
  const imageSize = opts.image_size || opts.size || DEFAULT_IMAGE_SIZE;
  const payload = { prompt, model, image_size: imageSize };
  if (opts.image_url) payload.image_url = opts.image_url; // img2img

  const initResp = await fetch(`${BASE_URL}/api/image`, {
    method: 'POST',
    headers: { ...HEADERS, Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const initText = await initResp.text();
  let init;
  try { init = JSON.parse(initText); } catch (_) {
    throw new HotBotError(`Image init non-JSON (HTTP ${initResp.status}): ${initText.slice(0, 200)}`);
  }
  checkErrorEnvelope(init);

  const statusUrl = init.statusUrl;
  const responseUrl = init.responseUrl;
  if (!statusUrl) throw new HotBotError(`No statusUrl returned: ${JSON.stringify(init).slice(0, 200)}`);

  const pollInterval = opts.poll_interval || 3000;
  const maxPolls = opts.max_polls || 60;
  let final = null;
  for (let i = 0; i < maxPolls; i++) {
    const q = new URLSearchParams({ statusUrl, responseUrl: responseUrl || '' }).toString();
    const r = await fetch(`${BASE_URL}/api/image/status?${q}`, {
      method: 'GET',
      headers: { ...HEADERS, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    const status = await r.json().catch(() => ({}));
    const st = status.status;
    if (st === 'completed' && status.url) { final = status; break; }
    if (st === 'failed') throw new HotBotError(`Generation failed: ${JSON.stringify(status).slice(0, 200)}`);
    await new Promise((res) => setTimeout(res, pollInterval));
  }
  if (!final) throw new HotBotError('Timed out waiting for image generation.');
  return { url: final.url, model, blurred: !!final.blurred };
}

/** Generate an image and return the raw bytes Buffer (downloads from the CDN URL). */
async function generateImageBuffer(prompt, opts = {}) {
  const res = await generateImage(prompt, opts);
  const img = await fetch(res.url, { headers: { ...HEADERS, Accept: '*/*' }, signal: AbortSignal.timeout(60000) });
  const arrayBuf = await img.arrayBuffer();
  return { ...res, buffer: Buffer.from(arrayBuf) };
}

/** GET /api/models -> array of { slug, name, provider, ... }. */
async function listModels() {
  const r = await fetch(`${BASE_URL}/api/models`, {
    method: 'GET',
    headers: { ...HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data.models) ? data.models : [];
}

module.exports = {
  BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGE_MODEL,
  HotBotError,
  chat,
  streamChat,
  generateImage,
  generateImageBuffer,
  listModels,
};
