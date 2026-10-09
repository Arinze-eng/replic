// ─────────────────────────────────────────────────────────────────────────────
// services/sakana.js — Sakana Chat (Namazu) HEAD brain.
//
// Sakana is the PRIMARY brain for chat, analysis, file handling and heavy
// tasks. It supports BOTH plain text-to-text chat AND document analysis
// (PDF / DOCX / TXT / Markdown / JSON). If Sakana fails / times out / has no
// valid session, callers fall back to the existing HotBot(+other brains)+Gemini
// chain — this module NEVER throws for "soft" failures it can recover from; it
// throws a normal Error only when it genuinely cannot produce a reply, so the
// caller's try/catch falls through to the next brain.
//
// ── Request flow (reverse-engineered from the SvelteKit frontend + verified live)
//
// 1) POST /conversation                       (JSON)
//      { inputs, enableThinking, toneMode, webSearchEnabled, agentId }
//      -> { conversationId, systemMessageId }
//
// 2) POST /conversation/<conversationId>       (multipart/form-data)
//      For each attached file, append a part:
//          field name : "files"
//          filename   : "base64;<original_name>"   (literally  type ";" name)
//          content    : the BASE64 STRING of the file bytes (NOT raw bytes)
//          Content-Type: the file's real mime type
//      Then append:
//          field name : "data"
//          value      : JSON { inputs, id:<systemMessageId>, is_retry:false,
//                              is_continue:false, enableThinking, toneMode,
//                              webSearchEnabled, userMessageId:<uuid> }
//      The reply streams back as NDJSON lines:
//          {"type":"stream","token":"..."}      <- tokens are NUL-padded; strip \u0000
//          {"type":"finalAnswer","text":"<plan>...</plan><answer>...</answer>"}
//      The model wraps its reasoning in <plan>..</plan> and the user-facing
//      reply in <answer>..</answer>; we return only the <answer> body.
//
// ── Auth
// A single session cookie  sakana-chat=<uuid>  (anonymous sessions work).
// Resolved at RUNTIME, in priority order:
//   1. db.getSetting('sakana_session')   ← admin panel, survives redeploys
//   2. process.env.SAKANA_SESSION        ← Render env var
//   3. DEFAULT_SESSION                   ← bundled fallback (captured anon uuid)
// The admin panel writes (1) so the session can be refreshed without a redeploy
// whenever the anonymous cookie rotates/expires.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const crypto = require('crypto');

// Lazily required to avoid any require-cycle at module-load time.
let _db = null;
function db() {
  if (_db === null) {
    try { _db = require('../db'); } catch (_) { _db = false; }
  }
  return _db || null;
}

const BASE = (process.env.SAKANA_BASE || 'https://chat.sakana.ai').replace(/\/+$/, '');
const AGENT_ID = process.env.SAKANA_AGENT_ID || 'namazu';
const USER_AGENT =
  process.env.SAKANA_UA ||
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/149.0.0.0 Mobile Safari/537.36';

// Bundled fallback anonymous session (captured + verified live). The admin
// panel / env can override it at runtime via the `sakana_session` setting.
const DEFAULT_SESSION = process.env.SAKANA_SESSION_DEFAULT || '71cc2345-e7c8-4504-a351-e10c43779b4a';

// Master on/off — when '0'/'off' the head brain is bypassed entirely and the
// caller goes straight to its existing fallback chain.
const HEAD_ENABLED = (() => {
  const v = String(process.env.SAKANA_HEAD != null ? process.env.SAKANA_HEAD : '1').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
})();

// Per-request budgets. Kept under Render's ~50s free-tier HTTP gateway so a slow
// Sakana never trips a 502 — on timeout we throw and the caller falls back.
const CREATE_TIMEOUT_MS = parseInt(process.env.SAKANA_CREATE_TIMEOUT_MS || '20000', 10);
const STREAM_TIMEOUT_MS = parseInt(process.env.SAKANA_STREAM_TIMEOUT_MS || '40000', 10);

// MIME types the Sakana frontend's file input accepts.
const SUPPORTED_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ── Session resolution (runtime DB → env → default), short-TTL cached ────────
let _sessionCache = { value: null, at: 0 };
const SESSION_TTL_MS = 30 * 1000;

async function getSession() {
  const now = Date.now();
  if (_sessionCache.value && now - _sessionCache.at < SESSION_TTL_MS) {
    return _sessionCache.value;
  }
  let val = '';
  const d = db();
  if (d && typeof d.getSetting === 'function') {
    try {
      const v = await d.getSetting('sakana_session');
      if (v && String(v).trim()) val = String(v).trim();
    } catch (_) { /* ignore — fall through to env/default */ }
  }
  if (!val) val = (process.env.SAKANA_SESSION || '').trim();
  if (!val) val = DEFAULT_SESSION;
  _sessionCache = { value: val, at: now };
  return val;
}

/** Force the next getSession() to re-read from the DB (call after admin saves). */
function invalidateSessionCache() { _sessionCache = { value: null, at: 0 }; }

function headers(cookieVal, extra = {}) {
  return {
    'User-Agent': USER_AGENT,
    'Referer': BASE + '/',
    'Origin': BASE,
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `sakana-chat=${cookieVal}`,
    ...extra,
  };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || 'sakana') + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

// ── Helpers to flatten OpenAI-style messages into Sakana's single `inputs` ───
// Sakana takes ONE prompt string per turn (plus optional files). We fold the
// system prompt + prior conversation into a single well-structured prompt so
// context is preserved. Multimodal image parts are NOT supported by Sakana
// (it is a text+document model), so any image parts are dropped here and the
// caller's vision path (Gemini) handles pictures instead.
function partsToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && (p.type === 'text' || typeof p === 'string'))
      .map(p => (typeof p === 'string' ? p : p.text || ''))
      .join('\n')
      .trim();
  }
  return content == null ? '' : String(content);
}

function messagesHaveImage(messages) {
  return messages.some(m => Array.isArray(m.content) &&
    m.content.some(p => p && p.type && p.type !== 'text'));
}

function buildPrompt(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (!m) continue;
    const text = partsToText(m.content);
    if (!text) continue;
    if (m.role === 'system') { system.push(text); continue; }
    const who = (m.role === 'assistant' || m.role === 'model') ? 'Assistant' : 'User';
    turns.push(`${who}: ${text}`);
  }
  // If there's only a single user turn and no system prompt, send it raw — the
  // cleanest path for ordinary chat (matches how the UI calls it).
  if (!system.length && turns.length === 1 && turns[0].startsWith('User: ')) {
    return turns[0].slice('User: '.length);
  }
  const parts = [];
  if (system.length) parts.push('[System instructions]\n' + system.join('\n\n'));
  if (turns.length) parts.push(turns.join('\n\n'));
  parts.push('Assistant:');
  return parts.join('\n\n');
}

function stripNul(s) { return String(s || '').replace(/\u0000/g, ''); }

function extractAnswer(finalText) {
  const t = String(finalText || '');
  const i = t.indexOf('<answer>');
  const j = t.indexOf('</answer>');
  if (i !== -1 && j !== -1 && j > i) {
    return t.slice(i + '<answer>'.length, j).trim();
  }
  // No wrapper — strip any leftover <plan>..</plan> block, return the rest.
  return t.replace(/<plan>[\s\S]*?<\/plan>/gi, '').replace(/<\/?answer>/gi, '').trim();
}

function guessMime(name, fallback) {
  const n = String(name || '').toLowerCase();
  const dot = n.lastIndexOf('.');
  const ext = dot >= 0 ? n.slice(dot) : '';
  if (EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  return fallback || 'application/octet-stream';
}

// ── Core: create conversation, optionally upload files, stream the reply ─────
async function rawSend(prompt, files, opts = {}) {
  const cookieVal = await getSession();
  if (!cookieVal) throw new Error('No Sakana session configured');

  const webSearch = !!opts.webSearch;
  const thinking = !!opts.thinking;
  const tone = opts.tone || 'default';

  // STEP 1 — create conversation.
  const r1 = await withTimeout(fetch(`${BASE}/conversation`, {
    method: 'POST',
    headers: headers(cookieVal, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      inputs: prompt,
      enableThinking: thinking,
      toneMode: tone,
      webSearchEnabled: webSearch,
      agentId: AGENT_ID,
    }),
  }), CREATE_TIMEOUT_MS, 'sakana-create');
  if (!r1.ok) {
    const t = await r1.text().catch(() => '');
    throw new Error(`Sakana create failed (HTTP ${r1.status}): ${t.slice(0, 160)}`);
  }
  const meta = await r1.json();
  const conversationId = meta.conversationId;
  const systemMessageId = meta.systemMessageId;
  if (!conversationId) throw new Error('Sakana create returned no conversationId');

  // STEP 2 — multipart message (files first, then `data`).
  const FormData = require('form-data');
  const form = new FormData();
  const usedFiles = [];
  for (const f of (files || [])) {
    if (!f || !f.buffer || !Buffer.isBuffer(f.buffer)) continue;
    const mime = guessMime(f.name, f.mime);
    if (!SUPPORTED_MIMES.has(mime)) continue; // skip unsupported (caller handles those)
    const b64 = f.buffer.toString('base64');
    const multipartFilename = `base64;${f.name || 'file'}`; // type ";" name
    form.append('files', b64, { filename: multipartFilename, contentType: mime });
    usedFiles.push({ name: f.name, mime });
  }
  const dataPayload = JSON.stringify({
    inputs: prompt,
    id: systemMessageId,
    is_retry: false,
    is_continue: false,
    enableThinking: thinking,
    toneMode: tone,
    webSearchEnabled: webSearch,
    userMessageId: crypto.randomUUID(),
  });
  form.append('data', dataPayload);

  const r2 = await withTimeout(fetch(`${BASE}/conversation/${conversationId}`, {
    method: 'POST',
    headers: headers(cookieVal, form.getHeaders()),
    body: form,
  }), STREAM_TIMEOUT_MS, 'sakana-stream');
  if (!r2.ok) {
    const t = await r2.text().catch(() => '');
    throw new Error(`Sakana send failed (HTTP ${r2.status}): ${t.slice(0, 160)}`);
  }

  // Parse the NDJSON body. node-fetch returns a Node stream for `.body`.
  const bodyText = await withTimeout(r2.text(), STREAM_TIMEOUT_MS, 'sakana-read');
  let streamed = '';
  let finalAnswer = null;
  for (const line of bodyText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch (_) { continue; }
    const ty = obj.type;
    if (ty === 'stream') streamed += stripNul(obj.token);
    else if (ty === 'finalAnswer') finalAnswer = obj.text;
    else if (ty === 'error') throw new Error('Sakana stream error: ' + (obj.message || JSON.stringify(obj)));
  }

  const source = finalAnswer != null ? finalAnswer : streamed;
  const answer = extractAnswer(source);
  if (!answer || !answer.trim()) throw new Error('Empty Sakana response');
  return { reply: answer.trim(), usedFiles };
}

// ── Public API ───────────────────────────────────────────────────────────────

function isHeadEnabled() { return HEAD_ENABLED; }

/**
 * Text chat. Takes OpenAI-style messages (string or text-parts content).
 * Returns the reply string. THROWS on failure so callers fall back.
 * Image/multimodal requests are REJECTED (Sakana is text+document only) so the
 * caller routes pictures to its vision brain instead.
 */
async function chat(messages, opts = {}) {
  if (!HEAD_ENABLED) throw new Error('Sakana head disabled');
  if (messagesHaveImage(messages)) throw new Error('Sakana does not support image input');
  const prompt = buildPrompt(messages);
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt for Sakana');
  const { reply } = await rawSend(prompt, [], opts);
  return reply;
}

/**
 * Document/heavy path. message + extracted/attached files + optional history.
 * `files` = [{ name, buffer, mime? }] (only PDF/DOCX/TXT/MD/JSON are uploaded
 * natively; others are ignored here and should be pre-extracted by the caller).
 * Returns { reply, usedFiles }. THROWS on failure so callers fall back.
 */
async function answerWithFiles({ message, files = [], history = [], systemPrompt } = {}, opts = {}) {
  if (!HEAD_ENABLED) throw new Error('Sakana head disabled');
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  if (Array.isArray(history)) {
    for (const h of history.slice(-12)) {
      if (h && h.text) msgs.push({ role: (h.role === 'assistant' || h.role === 'model') ? 'assistant' : 'user', text: String(h.text).slice(0, 4000) });
    }
  }
  // history entries use {role,text}; normalise to {role,content}
  const normalised = msgs.map(m => m.content != null ? m : { role: m.role, content: m.text });
  normalised.push({ role: 'user', content: String(message || 'Please read and analyse the attached file(s).') });
  const prompt = buildPrompt(normalised);
  const nativeFiles = (files || []).filter(f => f && f.buffer && Buffer.isBuffer(f.buffer));
  return await rawSend(prompt, nativeFiles, opts);
}

/**
 * Lightweight health/credential check used by the admin "Test" button.
 * Returns { ok, agents?, error? }. Never throws.
 * If `sessionOverride` is provided, tests THAT cookie (so the admin can verify
 * a new session before saving it).
 */
async function testSession(sessionOverride) {
  try {
    const cookieVal = (sessionOverride && String(sessionOverride).trim()) || (await getSession());
    if (!cookieVal) return { ok: false, error: 'No session configured' };
    const r = await withTimeout(fetch(`${BASE}/api/agents`, {
      method: 'GET',
      headers: headers(cookieVal),
    }), CREATE_TIMEOUT_MS, 'sakana-test');
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const txt = await r.text();
    let agents = [];
    try { agents = JSON.parse(txt); } catch (_) {}
    if (Array.isArray(agents) && agents.length) {
      return { ok: true, agents: agents.map(a => a.displayName || a.id) };
    }
    return { ok: false, error: 'Unexpected response (session may be invalid)' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  chat,
  answerWithFiles,
  testSession,
  getSession,
  invalidateSessionCache,
  isHeadEnabled,
  SUPPORTED_MIMES,
  BASE,
  AGENT_ID,
};
