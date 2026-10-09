// ─────────────────────────────────────────────────────────────────────────────
// wolfram.js — WolframAlpha integration for the EvilGPT / WormGPT super-engine.
//
// WolframAlpha is a computational knowledge engine: it gives REAL, verified
// answers for math, science, units/conversions, dates, statistics, chemistry,
// physics, geography, finance, definitions and live factual data — exactly the
// things an LLM tends to hallucinate. Wiring it into the agent + HotBot makes
// the whole engine far stronger and grounded in real computation.
//
// Two endpoints are used (both require a valid AppID — there is no demo key):
//   • LLM API     /api/v1/llm-api   → rich, multi-section answer optimised for
//                                     feeding back into a language model.
//   • Short Answers /v1/result      → single-line plain-text result (fallback).
//
// AppID resolution order (highest priority first):
//   1) Runtime setting `wolfram_appid` (editable live in the Admin panel)
//   2) Env var WOLFRAM_APPID
//   3) Built-in default
// Get a free AppID (2000 calls/month) at https://developer.wolframalpha.com .
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

// db is optional — when present we read the live, admin-editable AppID from the
// app_settings table so the key can be rotated WITHOUT a redeploy.
let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

const DEFAULT_APPID = process.env.WOLFRAM_APPID || 'JWQ6276UVG';
const LLM_API = 'https://www.wolframalpha.com/api/v1/llm-api';
const SHORT_API = 'https://api.wolframalpha.com/v1/result';
const SETTING_KEY = 'wolfram_appid';

// When true (default), WolframAlpha NEVER returns terse single-line answers:
// it always uses the rich, multi-section LLM API meant for chatbots, and the
// short-answers fallback is disabled. Set WOLFRAM_LONG_ANSWERS=0 to allow the
// old single-line fallback.
const LONG_ANSWERS = process.env.WOLFRAM_LONG_ANSWERS !== '0';

// Small cache so we don't hit the DB on every single Wolfram call.
const _cache = { appid: DEFAULT_APPID, ts: 0 };
const KEY_TTL = 30 * 1000; // 30s

/**
 * Resolve the active AppID: runtime setting → env → default.
 * Cached for KEY_TTL so admin edits propagate within ~30s, no redeploy needed.
 */
async function getAppId() {
  if (db && db.getSetting && Date.now() - _cache.ts >= KEY_TTL) {
    try {
      const v = await db.getSetting(SETTING_KEY);
      if (v && String(v).trim()) _cache.appid = String(v).trim();
      else _cache.appid = DEFAULT_APPID;
    } catch (_) { /* keep last known */ }
    _cache.ts = Date.now();
  }
  return _cache.appid || DEFAULT_APPID;
}

/** Persist a new AppID to the runtime store (admin action). */
async function setAppId(newId) {
  const id = String(newId || '').trim();
  if (!id) throw new Error('empty AppID');
  if (db && db.setSetting) await db.setSetting(SETTING_KEY, id);
  _cache.appid = id;
  _cache.ts = Date.now();
  return id;
}

function isConfigured() {
  return !!(_cache.appid || DEFAULT_APPID);
}

async function _get(url, timeoutMs = 25000) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (EvilGPT-Wolfram/1.0)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text().catch(() => '');
  return { status: resp.status, body: text };
}

/**
 * Validate an AppID by making a tiny real query. Used by the admin panel so a
 * mistyped key is caught before it's saved.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function validateAppId(appid) {
  const id = String(appid || '').trim();
  if (!id) return { ok: false, error: 'empty AppID' };
  try {
    const url = `${LLM_API}?appid=${encodeURIComponent(id)}&input=${encodeURIComponent('2+2')}&maxchars=200`;
    const { status, body } = await _get(url, 15000);
    if (status === 200 && body && !/Invalid appid/i.test(body)) return { ok: true };
    if (/Invalid appid/i.test(body) || status === 403) return { ok: false, error: 'Invalid AppID' };
    // Short-answers endpoint as a second opinion
    const r2 = await _get(`${SHORT_API}?appid=${encodeURIComponent(id)}&i=2%2B2`, 15000);
    if (r2.status === 200 && !/Invalid appid/i.test(r2.body)) return { ok: true };
    return { ok: false, error: `validation failed (HTTP ${status})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Ask WolframAlpha a natural-language / computational question.
 * Uses the rich LLM API (chatbot-friendly, long-form). In long-answers mode
 * (default) it NEVER falls back to terse single-line answers.
 * @param {string} question
 * @returns {Promise<{ok:boolean, source:string, answer:string, error?:string}>}
 */
async function ask(question) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, source: 'none', answer: '', error: 'empty query' };

  const APPID = await getAppId();
  if (!APPID) return { ok: false, source: 'none', answer: '', error: 'WOLFRAM_APPID not configured' };

  // 1) LLM API — rich, multi-section answer (the chatbot-friendly endpoint).
  // This is what makes WolframAlpha "talk" like an AI: it returns the full
  // breakdown (input interpretation, result, steps, plots, related info).
  try {
    const url = `${LLM_API}?appid=${encodeURIComponent(APPID)}&input=${encodeURIComponent(q)}&maxchars=6800`;
    const { status, body } = await _get(url);
    if (status === 200 && body && body.trim() && !/Invalid appid/i.test(body)) {
      return { ok: true, source: 'llm-api', answer: body.trim() };
    }
    if (/Invalid appid/i.test(body)) {
      return { ok: false, source: 'llm-api', answer: '', error: 'Invalid AppID' };
    }
  } catch (e) {
    // fall through to short answers (unless long-answers mode forbids it)
  }

  // In long-answers mode we never degrade to the terse single-line endpoint —
  // a chatbot should always get the rich result or nothing.
  if (LONG_ANSWERS) {
    return { ok: false, source: 'llm-api', answer: '', error: 'no rich result' };
  }

  // 2) Short Answers API — single line (legacy fallback, disabled by default)
  try {
    const url = `${SHORT_API}?appid=${encodeURIComponent(APPID)}&i=${encodeURIComponent(q)}`;
    const { status, body } = await _get(url);
    if (status === 200 && body && body.trim() && !/Invalid appid/i.test(body)) {
      return { ok: true, source: 'short-answers', answer: body.trim() };
    }
    if (/Invalid appid/i.test(body)) {
      return { ok: false, source: 'short-answers', answer: '', error: 'Invalid AppID' };
    }
    // WolframAlpha returns HTTP 501 "Wolfram|Alpha did not understand your input"
    if (status === 501) {
      return { ok: false, source: 'short-answers', answer: '', error: 'no result (not understood)' };
    }
    return { ok: false, source: 'short-answers', answer: '', error: `HTTP ${status}` };
  } catch (e) {
    return { ok: false, source: 'none', answer: '', error: e.message };
  }
}

/**
 * Heuristic: does this user message look like something WolframAlpha can answer
 * better than a chat model? (math, science, units, dates, conversions, live
 * facts, definitions, statistics…). Used to auto-augment HotBot chat.
 */
function looksComputational(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t || t.length > 600) return false;

  // Obvious math expressions: digits + operators, equations, functions
  if (/[0-9]\s*[\+\-\*\/\^=]\s*[0-9(]/.test(t)) return true;
  if (/\b(integrate|integral|derivative|differentiate|solve|factor|simplify|expand|limit|sum|series|product|matrix|determinant|eigen|probability|permutation|combination)\b/.test(t)) return true;
  if (/\b(square root|cube root|squared|cubed|factorial|logarithm|exponent|percent(age)? of|prime|gcd|lcm|modulo|remainder|standard deviation|mean|median|variance)\b/.test(t)) return true;
  if (/[√∫∑π∂]|sqrt\(|sin\(|cos\(|tan\(|log\(|ln\(/.test(t)) return true;

  // Conversions / units
  if (/\bconvert\b|\bhow many\b.*\b(in|to|per)\b|\b(km|miles|kg|lbs|celsius|fahrenheit|liters|gallons|bytes|bits)\b/.test(t)) return true;

  // Science / facts / data WolframAlpha is authoritative on
  if (/\b(distance|mass|density|atomic|molar|molecular weight|speed of light|gravity|planck|boltzmann)\b/.test(t)) return true;
  if (/\b(population of|gdp of|capital of|currency of|time in|timezone|sunrise|sunset|moon phase|stock|exchange rate|usd|eur|gbp)\b/.test(t)) return true;
  if (/\b(what is the value of|calculate|compute|evaluate|how far|how old|how tall|how much is)\b/.test(t)) return true;

  return false;
}

module.exports = {
  ask, isConfigured, looksComputational, validateAppId,
  getAppId, setAppId, LLM_API, SHORT_API, LONG_ANSWERS, SETTING_KEY,
};
