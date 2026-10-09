// aichatting.js — AIChatting.net (aga-api) text chat client.
//
// Endpoint : POST https://aga-api.aichatting.net/aigc/chat/v2/askai/stream  (SSE)
// Auth     : `vToken` header = a FingerprintJS-Pro visitor hash that the
//            website generates in-browser. The token DOES work from plain
//            server-side fetch (verified), but:
//              * each visitor token has only a small free quota, and
//              * generating a fresh token needs a real browser (Chromium).
//
// Capabilities (free tier): TEXT ONLY.  Vision/PDF are gated behind login,
// so we only ever wire the text path.
//
// Because a valid token can't be minted on a browserless Render box, this
// provider is OPT-IN: it only activates when an AICHATTING_VTOKEN env var (one
// or more comma-separated tokens) is supplied. If absent, isEnabled() is false
// and hotbot.js simply skips it — the rest of the brains keep working. This
// guarantees it can NEVER break or slow the system.
const fetch = require('node-fetch');

const ENDPOINT = 'https://aga-api.aichatting.net/aigc/chat/v2/askai/stream';
const MODEL = process.env.AICHATTING_MODEL || 'gpt-4.1-mini';

// Comma-separated list of vTokens (rotated round-robin to spread free quota).
function tokens() {
  return String(process.env.AICHATTING_VTOKEN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}
let _rr = 0;
function nextToken() {
  const t = tokens();
  if (!t.length) return null;
  const tok = t[_rr % t.length];
  _rr++;
  return tok;
}

function isEnabled() { return tokens().length > 0; }

const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept': 'text/event-stream,application/json',
  'source': 'web',
  'lang': 'en',
  'Origin': 'https://www.aichatting.net',
  'Referer': 'https://www.aichatting.net/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

/** Flatten OpenAI-style content to the array-of-parts shape the API requires. */
function toContentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    // Keep only text parts (free tier is text-only).
    const parts = content.filter(p => p && p.type === 'text').map(p => ({ type: 'text', text: p.text || '' }));
    return parts.length ? parts : [{ type: 'text', text: '' }];
  }
  return [{ type: 'text', text: String(content || '') }];
}

/** Build the messages array (text only). System messages are prepended as text. */
function buildMessages(messages) {
  const out = [];
  let sys = '';
  for (const m of messages) {
    if (m.role === 'system') {
      sys += (typeof m.content === 'string' ? m.content : toContentParts(m.content).map(p => p.text).join(' ')) + '\n';
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toContentParts(m.content) });
  }
  // Fold the system prompt into the first user message (API has no system role).
  if (sys && out.length) {
    const first = out.find(m => m.role === 'user');
    if (first) first.content.unshift({ type: 'text', text: `[Instructions]\n${sys.trim()}\n[End Instructions]` });
  }
  return out;
}

/** Parse the SSE `data:` stream into a clean text reply. */
function parseSSE(text) {
  if (text.trim().startsWith('{')) {
    // JSON error envelope.
    try {
      const j = JSON.parse(text);
      throw new Error(`AIChatting error: ${j.message || JSON.stringify(j)}`);
    } catch (e) { throw e instanceof Error ? e : new Error('AIChatting error'); }
  }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    let token = line.slice('data:'.length);
    if (token.includes('--@DONE@--')) continue;
    // The stream uses "-=- --" as a word-boundary marker; strip it.
    token = token.replace(/-=- --/g, '');
    out.push(token);
  }
  return out.join('').trim();
}

/**
 * Chat with AIChatting.net. Returns plain text. TEXT ONLY.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { timeout, model }
 */
async function chat(messages, opts = {}) {
  if (!isEnabled()) throw new Error('AIChatting disabled (no AICHATTING_VTOKEN)');
  const vToken = nextToken();
  const payload = {
    spaceHandle: true,
    roleId: 0,
    messages: buildMessages(messages),
    conversationId: '',
    model: opts.model || MODEL,
  };
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { ...HEADERS_BASE, vToken },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });
  const text = await resp.text();
  const reply = parseSSE(text);
  if (!reply) throw new Error('AIChatting: empty response');
  return reply;
}

function supportsVision() { return false; }
function supportsFiles() { return false; }

module.exports = { chat, isEnabled, supportsVision, supportsFiles, ENDPOINT };