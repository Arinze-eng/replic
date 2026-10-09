// ─────────────────────────────────────────────────────────────────────────────
// services/toapis.js — ToAPIs (toapis.com) OpenAI-compatible image gateway.
//
// This is the PAID cross-provider FALLBACK for image generation and image
// EDITING (text-prompt img2img) when the free Cloudflare Workers AI path is
// unavailable (e.g. every CF account hit its daily neuron cap, or the CF model
// errored). ToAPIs exposes GPT-Image-2, nano-banana (Gemini Flash Image),
// Seedream, FLUX-Kontext etc. behind one OpenAI-style endpoint.
//
// KEY (admin-updatable, survives redeploys):
//   runtime DB setting `toapis_api_key`  →  env `TOAPIS_API_KEY`
// Admin sets it in the panel → Integrations; it is read fresh (short cache) on
// every call so a top-up / rotation takes effect with no restart.
//
// API SHAPE (verified live against https://toapis.com/v1):
//   • Base URL:  https://toapis.com/v1   (override with TOAPIS_API_URL)
//   • Image gen/edit is ASYNC + task-based:
//       POST /v1/images/generations  { model, prompt, size?, n:1, image_urls? }
//         → { id, object:"generation.task", status:"queued|pending", ... }
//       GET  /v1/images/generations/{id}
//         → status queued|in_progress|completed|failed
//           on completed: { result: { data: [ { url } ] } }  (also top-level url)
//   • Image EDITING = same endpoint + `image_urls:[<public url>]`. Base64 is NOT
//     accepted — the source image must be a PUBLIC url (we host it on Cloudinary
//     first, exactly like the rest of the media pipeline).
//
// This module NEVER throws to satisfy the "always returns a result" contract of
// the callers; resolveEdit()/resolveGenerate() throw only on a genuine failure
// so the orchestrator can fall through to the next engine.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

const BASE = (process.env.TOAPIS_API_URL || 'https://toapis.com/v1').replace(/\/+$/, '');

// ── Default image models, in preference order. The first that has quota /
//    succeeds wins. nano-banana (Gemini Flash Image) is the best all-round
//    editor+generator; Seedream/FLUX-Kontext/GPT-Image-2 are strong fallbacks.
//    Overridable via env (comma-separated) so ops can retune with no code change.
const GEN_MODELS = (process.env.TOAPIS_IMAGE_MODELS ||
  'gemini-2.5-flash-image-preview,nano_banana,doubao-seedream-4-0,flux-kontext-pro,gpt-image-2')
  .split(',').map(s => s.trim()).filter(Boolean);

// Models that are especially good at INSTRUCTION-BASED editing (keep layout/
// faces/text, change only what's asked). Tried first for edits.
const EDIT_MODELS = (process.env.TOAPIS_EDIT_MODELS ||
  'gemini-2.5-flash-image-preview,nano_banana,flux-kontext-pro,flux-kontext-max,doubao-seedream-4-0,gpt-image-2')
  .split(',').map(s => s.trim()).filter(Boolean);

// ── Key resolution (runtime DB first, env fallback) with a tiny cache ────────
let _keyCache = { value: '', at: 0 };
const KEY_TTL_MS = 30 * 1000;

async function getApiKey() {
  const now = Date.now();
  if (_keyCache.value && (now - _keyCache.at) < KEY_TTL_MS) return _keyCache.value;
  let v = '';
  try {
    if (db && db.getSetting) {
      const raw = await db.getSetting('toapis_api_key');
      if (raw && String(raw).trim()) v = String(raw).trim();
    }
  } catch (_) { /* ignore */ }
  if (!v) v = (process.env.TOAPIS_API_KEY || '').trim();
  _keyCache = { value: v, at: now };
  return v;
}

/** Force the next getApiKey() to re-read (call after an admin saves the key). */
function invalidateKeyCache() { _keyCache = { value: '', at: 0 }; }

/** Is ToAPIs usable right now (a key is configured)? */
async function enabled() {
  try { return !!(await getApiKey()); } catch (_) { return false; }
}

function authHeaders(key) {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// ── Submit one async image task. Returns the task id, or throws with a tagged
//    reason so the caller can decide whether to try the next model/engine. ────
async function submitTask(model, body, key) {
  const res = await fetch(`${BASE}/images/generations`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(Object.assign({ model, n: 1 }, body)),
    signal: (() => { try { return AbortSignal.timeout(45000); } catch (_) { return undefined; } })(),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  if (res.status === 401 || res.status === 403) {
    const e = new Error('ToAPIs auth failed (check toapis_api_key)'); e.fatal = true; e.status = res.status; throw e;
  }
  // Quota / balance exhausted → not fatal for auth, but no point retrying other
  // models on the SAME key with the same empty balance → mark quota-exhausted.
  const msg = (json && (json.message || (json.error && json.error.message))) || text || '';
  if (json && (json.code === 'quota_not_enough' || /quota|insufficient|balance/i.test(msg))) {
    const e = new Error(`ToAPIs quota exhausted: ${msg.slice(0, 120)}`); e.quota = true; throw e;
  }
  if (!res.ok || !json) {
    const e = new Error(`ToAPIs submit error (HTTP ${res.status}): ${msg.slice(0, 140)}`); throw e;
  }
  const id = json.id || json.task_id || (json.data && json.data.id);
  if (!id) {
    const e = new Error(`ToAPIs submit: no task id in response: ${JSON.stringify(json).slice(0, 140)}`); throw e;
  }
  return id;
}

// ── Poll an image task until completed/failed/timeout. Returns the image URL. ─
async function pollTask(taskId, key, { maxWaitMs = 120000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  // small initial wait — most tasks aren't ready instantly
  await new Promise(r => setTimeout(r, 2000));
  while (Date.now() - start < maxWaitMs) {
    let res;
    try {
      res = await fetch(`${BASE}/images/generations/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: (() => { try { return AbortSignal.timeout(20000); } catch (_) { return undefined; } })(),
      });
    } catch (_) { await new Promise(r => setTimeout(r, intervalMs)); continue; }
    const text = await res.text().catch(() => '');
    let d = null; try { d = text ? JSON.parse(text) : null; } catch (_) {}
    if (d) {
      const status = String(d.status || '').toLowerCase();
      if (status === 'completed' || status === 'success' || status === 'succeeded') {
        const url =
          (d.result && Array.isArray(d.result.data) && d.result.data[0] && d.result.data[0].url) ||
          d.url ||
          (Array.isArray(d.data) && d.data[0] && d.data[0].url) || '';
        if (url) return url;
        throw new Error('ToAPIs task completed but no image url returned');
      }
      if (status === 'failed' || status === 'error') {
        const em = (d.error && d.error.message) || 'task failed';
        throw new Error(`ToAPIs task failed: ${String(em).slice(0, 140)}`);
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('ToAPIs task timed out');
}

/** Download the finished image URL into a Buffer. */
async function fetchImage(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' },
    signal: (() => { try { return AbortSignal.timeout(60000); } catch (_) { return undefined; } })(),
  });
  if (!r.ok) throw new Error(`ToAPIs image download failed (HTTP ${r.status})`);
  const buf = await r.buffer();
  if (!buf || buf.length < 500) throw new Error('ToAPIs image download was empty');
  const ct = r.headers.get('content-type') || 'image/png';
  return { buffer: buf, mime: ct.split(';')[0] || 'image/png' };
}

// Map a requested width/height (px) to the closest ToAPIs `size` ratio string.
function sizeRatio(width, height) {
  if (!width || !height) return '1:1';
  if (width === height) return '1:1';
  const r = width / height;
  if (r >= 1.7) return '16:9';
  if (r >= 1.4) return '3:2';
  if (r >= 1.2) return '4:3';
  if (r <= 0.58) return '9:16';
  if (r <= 0.71) return '2:3';
  if (r <= 0.83) return '3:4';
  return '1:1';
}

/**
 * resolveGenerate — TEXT→IMAGE. Tries each GEN model until one succeeds.
 * @param {string} prompt
 * @param {object} [opts] { size?, width?, height?, models?, model? }
 * @returns {Promise<{buffer:Buffer, mime:string, model:string, url:string}>}
 */
async function resolveGenerate(prompt, opts = {}) {
  const key = await getApiKey();
  if (!key) { const e = new Error('ToAPIs not configured (no toapis_api_key)'); e.notConfigured = true; throw e; }
  const p = String(prompt || '').trim();
  if (!p) throw new Error('No prompt provided');
  const size = opts.size || sizeRatio(opts.width, opts.height);
  const models = opts.model ? [opts.model] : (opts.models || GEN_MODELS);
  const errors = [];
  let quotaHit = false;
  for (const model of models) {
    try {
      const id = await submitTask(model, { prompt: p.slice(0, 1000), size }, key);
      const url = await pollTask(id, key, { maxWaitMs: opts.maxWaitMs || 120000 });
      const img = await fetchImage(url);
      return { buffer: img.buffer, mime: img.mime, model, url };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      if (e.fatal) throw e;              // bad key → stop immediately
      if (e.quota) { quotaHit = true; break; } // no balance → other models won't help
    }
  }
  const err = new Error('ToAPIs generate failed (' + errors.join(' | ') + ')');
  err.quota = quotaHit;
  throw err;
}

/**
 * resolveEdit — TEXT-PROMPT IMAGE EDIT (img2img). The source image MUST be a
 * public URL (ToAPIs no longer accepts base64). Callers host the source on
 * Cloudinary first and pass its URL here.
 * @param {string} imageUrl  public URL of the source image to edit
 * @param {string} prompt    the edit instruction
 * @param {object} [opts] { size?, width?, height?, refUrls?:string[], models?, model? }
 * @returns {Promise<{buffer:Buffer, mime:string, model:string, url:string}>}
 */
async function resolveEdit(imageUrl, prompt, opts = {}) {
  const key = await getApiKey();
  if (!key) { const e = new Error('ToAPIs not configured (no toapis_api_key)'); e.notConfigured = true; throw e; }
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
    throw new Error('ToAPIs edit needs a public source image URL');
  }
  const p = String(prompt || '').trim();
  if (!p) throw new Error('No edit instruction provided');
  const size = opts.size || sizeRatio(opts.width, opts.height);
  const image_urls = [{ url: imageUrl }];
  if (Array.isArray(opts.refUrls)) {
    for (const u of opts.refUrls.slice(0, 13)) if (u) image_urls.push({ url: u });
  }
  const models = opts.model ? [opts.model] : (opts.models || EDIT_MODELS);
  const errors = [];
  let quotaHit = false;
  for (const model of models) {
    try {
      const id = await submitTask(model, { prompt: p.slice(0, 1000), size, image_urls }, key);
      const url = await pollTask(id, key, { maxWaitMs: opts.maxWaitMs || 150000 });
      const img = await fetchImage(url);
      return { buffer: img.buffer, mime: img.mime, model, url };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      if (e.fatal) throw e;
      if (e.quota) { quotaHit = true; break; }
    }
  }
  const err = new Error('ToAPIs edit failed (' + errors.join(' | ') + ')');
  err.quota = quotaHit;
  throw err;
}

/** Lightweight connectivity/key test for the admin panel. Never throws. */
async function testKey(candidate) {
  const key = (candidate && String(candidate).trim()) || (await getApiKey());
  if (!key) return { ok: false, message: 'No ToAPIs API key set.' };
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: (() => { try { return AbortSignal.timeout(15000); } catch (_) { return undefined; } })(),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, message: '❌ Invalid ToAPIs API key.' };
    if (!r.ok) return { ok: false, message: `❌ ToAPIs API error (HTTP ${r.status}).` };
    const d = await r.json().catch(() => null);
    const n = (d && Array.isArray(d.data)) ? d.data.length : 0;
    return { ok: true, message: `✅ Connected — ${n} model(s) available.` };
  } catch (e) {
    return { ok: false, message: `❌ Could not reach ToAPIs: ${e.message}` };
  }
}

module.exports = {
  BASE,
  GEN_MODELS,
  EDIT_MODELS,
  getApiKey,
  invalidateKeyCache,
  enabled,
  resolveGenerate,
  resolveEdit,
  testKey,
};
