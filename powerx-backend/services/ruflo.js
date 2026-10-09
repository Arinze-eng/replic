// ruflo.js — RuFlo (flo.ruv.io) keyless TEXT brain client.
//
// Endpoint : https://flo.ruv.io  (SvelteKit / HuggingFace chat-ui fork on Cloud Run)
// Model    : Gemini 2.5 Flash / Pro, served through RuFlo's anonymous gateway.
// Auth     : NONE. An anonymous `hf-chat` session cookie is auto-issued on the
//            first request — nothing to mint, rotate, or expire. Exactly the
//            same "keyless / no-signup" contract as the other extra brains
//            (eqing / StudentAI / Pollinations), so it is safe to wire into the
//            HotBot/Gemini FUSION race without adding any secret to Render env.
//
// Capabilities (as wired here): TEXT ONLY.
//   RuFlo *can* accept file uploads, but the anonymous multimodal (vision) path
//   goes through its MCP bridge and is NOT reliable for keyless sessions, so we
//   deliberately wire ONLY the text path. Vision / image reading is already
//   handled robustly by the existing Gemini + Unitool + HotBot vision brains —
//   RuFlo simply joins the pure-TEXT race like the other keyless text brains.
//
// Protocol (reverse-engineered — see flo-ruv-client/README.md):
//   1. POST /conversation                 → { conversationId }   (+ session cookie)
//   2. GET  /api/v2/conversations/{id}     → json.rootMessageId
//   3. POST /conversation/{id}  (FormData) → JSONL stream:
//        { type:"stream",      token }
//        { type:"finalAnswer", text }
//        { type:"status",      status:"started|keepAlive|finished|error" }
//
// Why it can NEVER break the enterprise box:
//   • Keyless & default-ON, but instantly disabled via RUFLO_DISABLED=1 (then
//     hotbot.js just skips it and every other brain keeps working).
//   • Each racer is independently timed-out upstream (HOTBOT_BRAIN_TIMEOUT_MS),
//     so a slow/hung RuFlo can never stall the whole request.
//   • Any error/empty reply throws, so the race falls straight to the next brain.
const fetch = require('node-fetch');

const BASE = process.env.RUFLO_BASE || 'https://flo.ruv.io';
// RuFlo exposes gemini-2.5-flash (fast) and gemini-2.5-pro. Flash is the right
// default for a race brain (low latency); override via RUFLO_MODEL.
const MODEL = process.env.RUFLO_MODEL || 'models/gemini-2.5-flash';

// Keyless → enabled by default. Set RUFLO_DISABLED=1/true to turn it off.
function isEnabled() {
  const v = String(process.env.RUFLO_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

// Base headers. Origin/Referer are required by the SvelteKit CSRF guard for the
// non-JSON (multipart) message POST.
const HEADERS_JSON = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Origin': BASE,
  'Referer': BASE + '/',
  'User-Agent': UA,
};

/** Flatten OpenAI-style content to a plain string (text-only brain). */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text')
      .map(p => p.text || '')
      .join(' ')
      .trim();
  }
  return String(content || '');
}

/**
 * RuFlo has no multi-message API — each conversation turn appends to a tree.
 * We flatten the OpenAI-style messages into a single well-labelled prompt so
 * the system + prior turns are preserved as context, then send it as one input.
 */
function flattenPrompt(messages) {
  const parts = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === 'system') parts.push(text);
    else if (m.role === 'assistant') parts.push('Assistant: ' + text);
    else parts.push('User: ' + text);
  }
  let prompt = parts.join('\n\n').trim();
  if (!prompt) prompt = 'Hello';
  return prompt;
}

/** Extract the hf-chat session cookie from a Set-Cookie header value. */
function parseSessionCookie(setCookie) {
  if (!setCookie) return null;
  const m = /hf-chat=([^;]+)/.exec(String(setCookie));
  return m ? 'hf-chat=' + m[1] : null;
}

/**
 * Chat with RuFlo (Gemini 2.5 via flo.ruv.io, keyless). Returns plain text.
 * TEXT ONLY — multimodal parts are flattened to their text.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { model, timeout }
 */
async function chat(messages, opts = {}) {
  if (!isEnabled()) throw new Error('ruflo disabled (RUFLO_DISABLED)');
  const timeout = opts.timeout || 45000;
  const model = opts.model && /gemini/i.test(opts.model) ? opts.model : MODEL;

  // ── 1) Create a fresh conversation (also mints the anonymous session). ────
  const createResp = await fetch(BASE + '/conversation', {
    method: 'POST',
    headers: HEADERS_JSON,
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!createResp.ok) {
    const t = await createResp.text().catch(() => '');
    throw new Error(`ruflo create error (${createResp.status}): ${t.slice(0, 160)}`);
  }
  const cookie = parseSessionCookie(createResp.headers.get('set-cookie'));
  if (!cookie) throw new Error('ruflo: no session cookie issued');
  const createData = await createResp.json().catch(() => null);
  const convId = createData && createData.conversationId;
  if (!convId) throw new Error('ruflo: no conversationId returned');

  // ── 2) Fetch the rootMessageId (the parent to append our message to). ─────
  const metaResp = await fetch(`${BASE}/api/v2/conversations/${convId}`, {
    headers: { 'Cookie': cookie, 'Accept': 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(timeout),
  });
  if (!metaResp.ok) throw new Error(`ruflo meta error (${metaResp.status})`);
  const metaData = await metaResp.json().catch(() => null);
  const rootId = metaData && (metaData.json ? metaData.json.rootMessageId : metaData.rootMessageId);
  if (!rootId) throw new Error('ruflo: no rootMessageId');

  // ── 3) Send the message (multipart FormData "data" field) → JSONL stream. ─
  const FormData = require('form-data');
  const form = new FormData();
  form.append('data', JSON.stringify({ inputs: flattenPrompt(messages), id: rootId }));

  const sendResp = await fetch(`${BASE}/conversation/${convId}`, {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      'Cookie': cookie,
      'Origin': BASE,
      'Referer': BASE + '/',
      'User-Agent': UA,
    },
    body: form,
    signal: AbortSignal.timeout(timeout),
  });
  if (!sendResp.ok) {
    const t = await sendResp.text().catch(() => '');
    throw new Error(`ruflo send error (${sendResp.status}): ${t.slice(0, 160)}`);
  }

  // Parse the JSONL stream into the final answer text.
  const raw = await sendResp.text();
  let finalText = '';
  let streamed = '';
  let sawError = false;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    const type = evt.type;
    if (type === 'finalAnswer') {
      finalText = String(evt.text || '').replace(/\x00/g, '');
    } else if (type === 'stream') {
      streamed += String(evt.token || '').replace(/\x00/g, '');
    } else if (type === 'status' && evt.status === 'error') {
      sawError = true;
    }
  }
  const reply = (finalText || streamed).trim();
  if (!reply) {
    throw new Error(sawError ? 'ruflo: stream error, empty reply' : 'ruflo: empty response');
  }
  return reply;
}

// Text-only brain — matches the eqing/StudentAI contract.
function supportsVision() { return false; }
function supportsFiles()  { return false; }

module.exports = { chat, isEnabled, supportsVision, supportsFiles, BASE, MODEL };
