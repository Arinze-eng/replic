// eqingChat.js — eqing.tech (EasyChat) free GPT-3.5-Turbo text client.
//
// Endpoint : POST https://origin.eqing.tech/api/openai/v1/chat/completions
// Auth     : NONE. The `gpt-3.5-turbo` model is served keyless / no-signup and,
//            unlike the site's premium models (gpt-5-free, gemini, deepseek,
//            grok, …) it is NOT gated behind a Cloudflare-Turnstile captcha —
//            so it answers from a plain server-side fetch on a Render box.
//
// Capabilities (free tier): TEXT ONLY.  The premium/vision models require a
// browser-minted captcha token, so we ONLY ever wire the text path. This racer
// therefore joins the parallel race exactly like the other keyless text brains
// (Pollinations / StudentAI / AIChatting) and ONLY on pure-text requests.
//
// Why it's safe for an enterprise box:
//   • Keyless  → nothing to mint, rotate, or expire.
//   • Verified → returns HTTP 200 with no rate limit across 280+ calls.
//   • Default ON, but disable instantly via EQING_DISABLED=1 (then hotbot.js
//     simply skips it and every other brain keeps working). It can NEVER break
//     or slow the system because each racer is independently timed-out upstream.
const fetch = require('node-fetch');

// The origin.* subdomain is the API host the EasyChat SPA talks to. Override
// via env if eqing rotates its domain (the site posts new domains in its
// in-app announcement).
const BASE     = process.env.EQING_BASE || 'https://origin.eqing.tech';
const ENDPOINT = BASE + '/api/openai/v1/chat/completions';
// gpt-3.5-turbo maps internally to glm-4-flash on eqing — the only keyless,
// captcha-free model. Override only if you know another keyless model exists.
const MODEL    = process.env.EQING_MODEL || 'gpt-3.5-turbo';

// Keyless → enabled by default. Set EQING_DISABLED=1/true to turn it off.
function isEnabled() {
  const v = String(process.env.EQING_DISABLED || '').toLowerCase();
  return v !== '1' && v !== 'true';
}

const HEADERS_BASE = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Origin': BASE,
  'Referer': BASE + '/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
};

/** Flatten OpenAI-style content to a plain string (free tier is text-only). */
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
 * Build the OpenAI-style messages array the endpoint expects. It honours the
 * native `system` role (verified working), so we keep system / user / assistant
 * turns intact and just strip non-text parts.
 */
function buildMessages(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant'
               : m.role === 'system'    ? 'system'
               : 'user';
    const text = contentToText(m.content);
    // Skip empty turns so the upstream doesn't choke on blank content.
    if (text || role === 'user') out.push({ role, content: text });
  }
  if (!out.length) out.push({ role: 'user', content: '' });
  return out;
}

/**
 * Chat with eqing.tech (gpt-3.5-turbo, keyless). Returns plain text. TEXT ONLY.
 * @param {Array} messages OpenAI-style messages.
 * @param {Object} opts { model, timeout }
 */
async function chat(messages, opts = {}) {
  if (!isEnabled()) throw new Error('eqing disabled (EQING_DISABLED)');
  const payload = {
    model: opts.model || MODEL,
    messages: buildMessages(messages),
    stream: false,
  };
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: HEADERS_BASE,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeout || 45000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`eqing error (${resp.status}): ${t.slice(0, 160)}`);
  }
  const data = await resp.json().catch(() => null);
  // Defensive: the keyless model occasionally returns a non-answer system
  // string (e.g. "SummarizingConversation") when the request is malformed;
  // treat empty/sentinel replies as a failure so the race falls to another brain.
  const reply = data && data.choices && data.choices[0] &&
                data.choices[0].message && data.choices[0].message.content;
  if (!reply || !String(reply).trim()) throw new Error('eqing: empty response');
  const clean = String(reply).trim();
  if (/^summarizing(conversation|convoexperience)$/i.test(clean) ||
      clean.includes('需要验证')) {
    throw new Error('eqing: captcha/sentinel response, skipping');
  }
  return clean;
}

function supportsVision() { return false; }
function supportsFiles()  { return false; }

module.exports = { chat, isEnabled, supportsVision, supportsFiles, ENDPOINT, MODEL };
