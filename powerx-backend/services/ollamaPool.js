// ollamaPool.js — Public Ollama community-pool text chat client.
//
// Endpoint : POST http://<ip>:11434/api/generate   (Ollama native API)
// Auth     : NONE. Public community Ollama nodes, no API key, no signup.
// Backend  : llama3.2 / smollm2 / llava etc. served by volunteer nodes.
//            (Discovered via the OllamaFreeAPI community pool; verified live.)
//
// Capabilities: TEXT ONLY (we only ever send the text prompt).
//
// Resilience: a comma-separated list of "ip:port|model" entries is tried in
// order; the first node that returns a non-empty reply wins. Default list is
// the nodes verified alive at wiring time; override with OLLAMAPOOL_NODES.
// Disable entirely via OLLAMAPOOL_DISABLED=1.
//
// Public contract: chat(messages) -> string  (OpenAI-style messages in,
// plain text out) — joins the hotbot.js parallel race unchanged.
const fetch = require('node-fetch');

// Verified-alive nodes at wiring time. Format: "ip:port|model".
const DEFAULT_NODES = [
  '108.181.196.208:11434|llama3.2:latest',
  '91.99.61.122:11434|llama3.2:latest',
  '108.181.196.208:11434|llama3:latest',
  '91.99.61.122:11434|llama3.2:1b',
  '108.181.196.208:11434|smollm2:135m',
];

function nodes() {
  const raw = String(process.env.OLLAMAPOOL_NODES || '').trim();
  const list = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_NODES;
  return list.map(entry => {
    const [hostPort, model] = entry.split('|').map(s => s.trim());
    return { url: `http://${hostPort}/api/generate`, model: model || 'llama3.2:latest' };
  });
}

function isEnabled() {
  const v = String(process.env.OLLAMAPOOL_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true' && nodes().length > 0;
}

/** Flatten OpenAI-style content (string OR parts array) to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
  }
  return String(content || '');
}

/** Collapse OpenAI-style messages into a single Ollama prompt string. */
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

/** Try a single Ollama node; returns text or throws. */
async function callNode(node, prompt, timeout) {
  const resp = await fetch(node.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: node.model, prompt, stream: false }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OllamaPool ${node.url} (${resp.status}): ${errText.slice(0, 120)}`);
  }
  const data = await resp.json().catch(() => ({}));
  const reply = data && data.response;
  if (!reply || !String(reply).trim()) throw new Error(`OllamaPool ${node.url}: empty response`);
  return String(reply).trim();
}

/**
 * Chat via the public Ollama pool. Returns plain text. TEXT ONLY.
 * Tries each node in turn; first success wins.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { timeout }
 */
async function chat(messages, opts = {}) {
  if (!isEnabled()) throw new Error('OllamaPool disabled (OLLAMAPOOL_DISABLED)');
  const prompt = messagesToPrompt(messages);
  // Per-node timeout: split the brain budget across nodes but cap each at 20s.
  const perNode = Math.min(20000, opts.timeout || 20000);
  let lastErr = null;
  for (const node of nodes()) {
    try {
      return await callNode(node, prompt, perNode);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('OllamaPool: all nodes failed');
}

function supportsVision() { return false; }
function supportsFiles() { return false; }

module.exports = { chat, isEnabled, supportsVision, supportsFiles, nodes };
