// DeepSeek Free — Free text chat via chat.deepseek.com web token
//
// Uses the chat.deepseek.com web API (no API key required). Provides text
// chat that runs in the hotbot brain race alongside Gemini, HotBot, etc.
//
// The admin sets the token in the admin panel under "DeepSeek Token" (stored
// in app_settings as `deepseek_token`). Falls back to env DEEPSEEK_TOKEN.
//
// The WASM/ PoW solver files are deployed under services/deepseek_wasm/ and
// are loaded via __dirname at runtime.

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── PoW Solver (DeepSeekHashV1 via WASM) ────────────────────────────────
// DeepSeek requires a valid "DeepSeekHashV1" Proof-of-Work before every
// completion request. The algorithm is implemented in the shipped WebAssembly
// module (services/deepseek_wasm/sha3_wasm_bg.*.wasm) — the SAME one the real
// web client uses. We call its `wasm_solve` export via services/deepseekPow.js.
//
// IMPORTANT: a naive SHA-256 nonce loop is NOT the right algorithm. DeepSeek
// silently ACCEPTS a malformed answer (HTTP 200) but returns an EMPTY reply,
// which used to make the judge transparently fall back to the backup brain and
// never actually use DeepSeek. The WASM solver below produces an answer the
// server accepts, so DeepSeek replies for real.

const deepseekPow = require('./deepseekPow');

function _solvePow(challenge) {
  return deepseekPow.solvePow(challenge);
}

// ── Token management ────────────────────────────────────────────────────
let _db = null;
try { _db = require('../db'); } catch (_) {}

async function getToken() {
  // Admin-set token (DB) takes priority, then env var
  if (_db && _db.getSetting) {
    try {
      const fromDb = await _db.getSetting('deepseek_token');
      if (fromDb && fromDb.trim()) return fromDb.trim();
    } catch (_) {}
  }
  return process.env.DEEPSEEK_TOKEN || '';
}

// ── HTTP helpers ────────────────────────────────────────────────────────
const BASE = 'https://chat.deepseek.com/api/v0';

function _headers(token) {
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'origin': 'https://chat.deepseek.com',
    'referer': 'https://chat.deepseek.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    'x-app-version': '20241129.1',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0-always',
  };
}

async function _getPow(token, targetPath = '/api/v0/chat/completion') {
  const resp = await fetch(`${BASE}/chat/create_pow_challenge`, {
    method: 'POST',
    headers: _headers(token),
    body: JSON.stringify({ target_path: targetPath }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) throw new Error('DEEPSEEK_TOKEN expired — update it in the admin panel');
  if (!resp.ok) throw new Error(`PoW challenge: ${resp.status}`);
  const data = await resp.json();
  const challenge = data?.data?.biz_data?.challenge;
  if (!challenge) throw new Error('No PoW challenge in response');
  return _solvePow(challenge);
}

async function _createSession(token) {
  const resp = await fetch(`${BASE}/chat_session/create`, {
    method: 'POST',
    headers: _headers(token),
    body: JSON.stringify({ character_id: null }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 401) throw new Error('DEEPSEEK_TOKEN expired — update it in the admin panel');
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Session create: ${resp.status} ${txt.slice(0, 120)}`);
  }
  const data = await resp.json();
  return data?.data?.biz_data?.id;
}

function _parseChunks(body) {
  // DeepSeek SSE format. Text deltas look like one of:
  //   data: {"v":"text"}                                        (bare delta)
  //   data: {"p":"response/content","o":"APPEND","v":"text"}    (content delta)
  // But there are ALSO non-content events that carry a string `v`, e.g.:
  //   data: {"p":"response/status","v":"FINISHED"}              (status marker)
  //   data: {"p":"response/title", ...}                         (metadata)
  // The old parser grabbed every string `v`, which leaked "FINISHED" (and other
  // markers) into the reply and corrupted the judge's JSON verdict parsing.
  // We now ONLY accept content deltas: either no `p` (bare delta) or
  // `p === "response/content"`.
  const parts = [];
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const d = JSON.parse(payload);
      if (!d || typeof d.v !== 'string') continue;
      // Only real content deltas. Skip status/metadata paths.
      if (d.p == null || d.p === 'response/content') {
        parts.push(d.v);
      }
    } catch (_) {}
  }
  return parts.join('');
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Send a text message to DeepSeek and get the reply.
 * @param {string} prompt - The message.
 * @param {object} [opts] - Optional: { thinking, search, token, onToken }.
 *   - token: override the saved/env token (used by the admin "Test" button to
 *            validate a freshly-typed token BEFORE it is saved).
 * @returns {string} The reply text.
 */
async function chat(prompt, opts = {}) {
  const token = (opts.token && String(opts.token).trim()) || await getToken();
  if (!token) throw new Error('DEEPSEEK_TOKEN not configured — add it in the admin panel');

  const sessionId = await _createSession(token);
  const pow = await _getPow(token);

  const headers = _headers(token);
  headers['x-ds-pow-response'] = pow;

  const body = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt: String(prompt),
    ref_file_ids: [],
    thinking_enabled: opts.thinking === true,
    search_enabled: opts.search === true,
  };

  const resp = await fetch(`${BASE}/chat/completion`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });

  if (resp.status === 401) throw new Error('DEEPSEEK_TOKEN expired — update it in the admin panel');
  if (resp.status === 422) {
    // UUID/session issue — return empty so the caller doesn't crash
    const txt = await resp.text().catch(() => '');
    throw new Error(`DeepSeek 422: ${txt.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`DeepSeek ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const rawText = await resp.text();
  const reply = _parseChunks(rawText);
  return reply || '';
}

/**
 * Check whether DeepSeek is configured (has a token).
 * Used by the hotbot brain race to decide whether to include DeepSeek.
 */
async function isEnabled() {
  const token = await getToken();
  return !!(token && token.trim());
}

module.exports = { chat, isEnabled, getToken };