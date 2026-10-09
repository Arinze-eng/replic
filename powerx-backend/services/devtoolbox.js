// devtoolbox.js — DevToolBox AI (Cloudflare Workers AI) text chat client.
//
// Endpoint : POST https://devtoolbox-api.devtoolbox-api.workers.dev/ai/generate
// Auth     : NONE. Completely free, no API key, no signup. (verified)
// Backend  : Cloudflare Workers AI running llama-3.2-3b-instruct.
//
// Capabilities (free tier): TEXT ONLY. No vision, no files.
//
// Public contract: chat(messages) -> string  (OpenAI-style messages in,
// plain text out) — so it can join the hotbot.js parallel race unchanged.
// Disable via DEVTOOLBOX_DISABLED=1.
const fetch = require('node-fetch');

const ENDPOINT = process.env.DEVTOOLBOX_ENDPOINT ||
  'https://devtoolbox-api.devtoolbox-api.workers.dev/ai/generate';

function isEnabled() {
  const v = String(process.env.DEVTOOLBOX_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}

/** Flatten OpenAI-style content (string OR parts array) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  }
  return String(content || '');
}

/**
 * Collapse an OpenAI-style messages array into a single prompt string.
 * System messages are wrapped as instructions; roles are labelled so the
 * model keeps conversational context. TEXT ONLY (images are dropped).
 */
function messagesToPrompt(messages) {
  const lines = [];
  let sys = '';
  for (const m of messages) {
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === 'system') { sys += text + '\n'; continue; }
    if (m.role === 'assistant') { lines.push(`Assistant: ${text}`); }
    else { lines.push(`User: ${text}`); }
  }
  let prompt = '';
  if (sys.trim()) prompt += `[Instructions]\n${sys.trim()}\n[End Instructions]\n\n`;
  prompt += lines.join('\n');
  prompt += '\nAssistant:';
  return prompt;
}

/**
 * Chat with DevToolBox AI. Returns plain text. TEXT ONLY.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { timeout }
 */
async function chat(messages, opts = {}) {
  if (!isEnabled()) throw new Error('DevToolBox disabled (DEVTOOLBOX_DISABLED)');
  const prompt = messagesToPrompt(messages);
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`DevToolBox error (${resp.status}): ${errText.slice(0, 160)}`);
  }
  const data = await resp.json().catch(() => ({}));
  const reply = data && data.response;
  if (!reply || !String(reply).trim()) throw new Error('DevToolBox: empty response');
  return String(reply).trim();
}

function supportsVision() { return false; }
function supportsFiles() { return false; }

module.exports = { chat, isEnabled, supportsVision, supportsFiles, ENDPOINT };
