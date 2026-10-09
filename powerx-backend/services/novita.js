// novita.js — Novita AI client (OpenAI-compatible), used as EXTRA fusion brains.
//
// Novita (https://novita.ai) exposes an OpenAI-compatible Chat Completions
// endpoint at  POST https://api.novita.ai/v3/openai/chat/completions  with a
// simple Bearer key. The project already stores that key in Supabase
// app_settings under `novita_api_key` (the same key the WhatsApp/HotBot flows
// use), so both brains below reuse it — no new secret to configure.
//
// Two brains are surfaced so the hotbot FUSION panel gets STRONGER on both axes
// the user asked for:
//
//   1. VISION  — `chatVision(messages)` → Gemini 3.1 Flash Image (via Novita).
//                A true multimodal model that reads BOTH https image URLs AND
//                base64 data: URIs (verified: Google logo → "Google", two
//                golden-retriever puppies photo → correct caption). This joins
//                the race on IMAGE (multimodal) requests, right beside the
//                Gemini gateway + Unitool, so the Gemini/vision fallback path is
//                markedly stronger.
//
//   2. DEEPSEEK — `chatDeepseek(messages)` → deepseek/deepseek-v4-pro (via
//                Novita). A strong reasoning/coding model that joins the race on
//                pure-TEXT requests, adding another top-tier proposer to the
//                fusion panel (independent of the keyless chat.deepseek.com web
//                token in services/deepseek.js — this one is key-backed and
//                does not need a PoW/token refresh).
//
// Public contract mirrors the other brains so hotbot.js can call it unchanged:
//   chatVision(messages, opts)   -> string   (multimodal: text + images)
//   chatDeepseek(messages, opts) -> string   (text)
//   isVisionEnabled()            -> bool      (key present AND not disabled)
//   isDeepseekEnabled()          -> bool      (key present AND not disabled)

const fetch = require('node-fetch');

let _db = null;
try { _db = require('../db'); } catch (_) {}

const BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai/v3/openai';
const CHAT_ENDPOINT = BASE_URL + '/chat/completions';

// Model slugs (overridable via env for easy ops rotation).
const VISION_MODEL = process.env.NOVITA_VISION_MODEL || 'gemini-3.1-flash-image';
const DEEPSEEK_MODEL = process.env.NOVITA_DEEPSEEK_MODEL || 'deepseek/deepseek-v4-pro';

// Per-request timeout. Kept under Render's ~50s free-tier gateway; the fusion
// proposer/budget windows in hotbot.js bound the overall latency anyway.
// NOTE: we use our OWN env var (NOVITA_CHAT_TIMEOUT_MS) — NOT NOVITA_TIMEOUT_MS
// — because NOVITA_TIMEOUT_MS is already used by the sandbox SDK (set to
// 3600000 = 1h in render.yaml), which would be far too long for a chat call.
const TIMEOUT_MS = parseInt(process.env.NOVITA_CHAT_TIMEOUT_MS || '45000', 10);

// ── enable gates ─────────────────────────────────────────────────────────
// Each brain is ON by default when a key is available. Ops can disable either
// one without a code change:
//   NOVITA_VISION_DISABLED=1     → drop the Gemini-image vision brain
//   NOVITA_DEEPSEEK_DISABLED=1   → drop the Novita-DeepSeek text brain
function _envDisabled(name) {
  const v = String(process.env[name] || '').toLowerCase();
  return v === '1' || v === 'true';
}

let _keyCache = { value: null, at: 0 };
const _KEY_TTL_MS = 60 * 1000; // cache the DB key for a minute

/** Resolve the Novita API key: admin-set (DB) first, then env. Cached ~60s. */
async function getKey() {
  const now = Date.now();
  if (_keyCache.value && (now - _keyCache.at) < _KEY_TTL_MS) return _keyCache.value;
  let key = '';
  if (_db && _db.getSetting) {
    try {
      const fromDb = await _db.getSetting('novita_api_key');
      if (fromDb && String(fromDb).trim()) key = String(fromDb).trim();
    } catch (_) {}
  }
  if (!key) key = process.env.NOVITA_API_KEY || '';
  if (key) _keyCache = { value: key, at: now };
  return key;
}

/**
 * Convert OpenAI-style content (string OR multimodal parts) into the exact
 * OpenAI content schema Novita accepts. Novita speaks the OpenAI schema
 * natively, so text + image_url parts pass through with light normalisation.
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

/** True if any message carries a non-text (image) part. */
function isMultimodal(messages) {
  return messages.some(m => Array.isArray(m.content) &&
    m.content.some(p => p && p.type && p.type !== 'text'));
}

/**
 * Low-level call to Novita's OpenAI-compatible chat endpoint. Non-streaming
 * (we read the full JSON) so it slots into the fusion "collect candidate"
 * model exactly like the other brains. Returns the assistant text.
 */
async function _complete(model, messages, opts = {}) {
  const key = await getKey();
  if (!key) throw new Error('Novita API key not configured (set novita_api_key in admin, or NOVITA_API_KEY env)');

  const payload = {
    model,
    messages: buildMessages(messages),
    max_tokens: opts.maxTokens || parseInt(process.env.NOVITA_MAX_TOKENS || '4096', 10),
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    stream: false,
  };

  const resp = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT_MS),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Novita auth failed (' + resp.status + ') — check novita_api_key');
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Novita error (' + resp.status + '): ' + t.slice(0, 200));
  }

  const data = await resp.json().catch(() => null);
  if (!data) throw new Error('Novita: non-JSON response');
  // Some Novita models return a non-OpenAI error envelope with a 200.
  if (data.code && data.message && !data.choices) {
    throw new Error('Novita model error: ' + String(data.message).slice(0, 160));
  }
  const choice = data.choices && data.choices[0];
  const msg = choice && choice.message;
  // Prefer visible content; DeepSeek-family models sometimes only fill
  // reasoning_content when max_tokens is tight — fall back to it so a valid
  // (if terse) reply is never dropped.
  let reply = (msg && typeof msg.content === 'string') ? msg.content : '';
  if (!reply && msg && typeof msg.reasoning_content === 'string') reply = msg.reasoning_content;
  reply = String(reply || '').trim();
  if (!reply) throw new Error('Novita: empty response from ' + model);
  return reply;
}

// ── public brains ──────────────────────────────────────────────────────────

/**
 * VISION brain — Gemini 3.1 Flash Image via Novita. Reads text + images.
 * Joins the Gemini-section race on multimodal (image) requests.
 */
async function chatVision(messages, opts = {}) {
  return await _complete(VISION_MODEL, messages, opts);
}

/**
 * DEEPSEEK brain — deepseek/deepseek-v4-pro via Novita. Text reasoning/coding.
 * Joins the FUSION panel on pure-text requests.
 */
async function chatDeepseek(messages, opts = {}) {
  return await _complete(DEEPSEEK_MODEL, messages, opts);
}

/** Enable gate for the Novita vision brain (key present AND not disabled). */
async function isVisionEnabled() {
  if (_envDisabled('NOVITA_VISION_DISABLED')) return false;
  const key = await getKey();
  return !!(key && key.trim());
}

/** Enable gate for the Novita DeepSeek brain (key present AND not disabled). */
async function isDeepseekEnabled() {
  if (_envDisabled('NOVITA_DEEPSEEK_DISABLED')) return false;
  const key = await getKey();
  return !!(key && key.trim());
}

function supportsVision() { return true; }

module.exports = {
  chatVision,
  chatDeepseek,
  isVisionEnabled,
  isDeepseekEnabled,
  supportsVision,
  getKey,
  isMultimodal,
  VISION_MODEL,
  DEEPSEEK_MODEL,
};
