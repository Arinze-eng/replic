// studentAI.js — StudentAI (AI Tutor) backend client.
//
// Backend     : Supabase Edge Function (OpenAI-backed, server-side key).
//   POST /functions/v1/openai-chat   (requires a logged-in user token)
// Auth        : creates a throwaway user via public signup (email confirmation
//               is disabled on this project, so signup returns an access_token).
//
// Capabilities: TEXT ONLY. No vision, no file upload on this endpoint.
//
// Public contract: chat(messages) -> string   (OpenAI-style messages in,
// plain text out) — so it can join the hotbot.js parallel race unchanged.
const fetch = require('node-fetch');

const BASE = process.env.STUDENTAI_BASE || 'https://xlhlttpjalhruxevxmtp.supabase.co';
const ANON_KEY = process.env.STUDENTAI_ANON_KEY || (
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsaGx0dHBqYWxocnV4ZXZ4bXRwIiwicm9sZSI6' +
  'ImFub24iLCJpYXQiOjE3NjYwNzM4NzIsImV4cCI6MjA4MTY0OTg3Mn0.' +
  '2E66IgwYQsW7fNBxaRdFdOskuN0vVQl8a7Ay7anXq3c'
);

// Cache the throwaway-user token for a while so we don't sign up on every call.
let _token = null;
let _tokenAt = 0;
const TOKEN_TTL_MS = parseInt(process.env.STUDENTAI_TOKEN_TTL_MS || '1800000', 10); // 30 min

async function getUserToken(force = false) {
  const now = Date.now();
  if (!force && _token && (now - _tokenAt) < TOKEN_TTL_MS) return _token;
  const email = `tester${now}${Math.floor(Math.random() * 1000)}@gmail.com`;
  const resp = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test12345!aB' }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await resp.json().catch(() => ({}));
  const token = data && data.access_token;
  if (!token) throw new Error(`StudentAI: no access_token (${JSON.stringify(data).slice(0, 150)})`);
  _token = token;
  _tokenAt = now;
  return token;
}

/** Flatten OpenAI-style content (string OR parts array) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  }
  return '';
}

/**
 * Split an OpenAI-style messages array into { systemPrompt, messages } where
 * messages contains only text (StudentAI is text-only — images are dropped).
 */
function prepare(messages) {
  let systemPrompt = 'You are a helpful, knowledgeable assistant. Answer fully and directly.';
  const out = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (m.role === 'system') { if (text) systemPrompt = text; continue; }
    if (!text) continue; // skip image-only messages (unsupported here)
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return { systemPrompt, messages: out };
}

/** True if these messages contain any non-text (image/file) part. */
function hasNonText(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && p.type && p.type !== 'text') return true;
      }
    }
  }
  return false;
}

/**
 * Chat with StudentAI. Returns plain text.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { maxTokens, temperature, timeout }
 */
async function chat(messages, opts = {}) {
  const { systemPrompt, messages: msgs } = prepare(messages);
  if (!msgs.length) throw new Error('StudentAI: no text content to send');

  const doCall = async (token) => {
    const resp = await fetch(`${BASE}/functions/v1/openai-chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'assistant',
        messages: msgs,
        systemPrompt,
        maxTokens: opts.maxTokens || 1024,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.5,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });
    const data = await resp.json().catch(() => ({}));
    if (data && data.error) throw new Error(`StudentAI error: ${JSON.stringify(data.error).slice(0, 150)}`);
    if (!data || !data.content) throw new Error('StudentAI: empty response');
    return String(data.content);
  };

  try {
    return await doCall(await getUserToken());
  } catch (e) {
    // Token may be stale/invalid — refresh once and retry.
    if (/Authentication|401|403|token/i.test(String(e.message))) {
      return await doCall(await getUserToken(true));
    }
    throw e;
  }
}

function supportsVision() { return false; }
function supportsFiles() { return false; }

module.exports = { chat, getUserToken, supportsVision, supportsFiles, hasNonText, BASE };