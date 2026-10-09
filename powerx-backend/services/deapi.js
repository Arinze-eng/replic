'use strict';

// deAPI image-to-image integration (FLUX.2 Klein 4B BF16).
// Secrets are resolved server-side at runtime: admin DB setting first, then env.
// The provider is asynchronous: submit multipart image + prompt, poll the job,
// then download and validate the returned image bytes.
const fetch = require('node-fetch');
const FormData = require('form-data');

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

const BASE = (process.env.DEAPI_BASE_URL || 'https://api.deapi.ai').replace(/\/+$/, '');
const DEFAULT_EDIT_MODEL = (process.env.DEAPI_EDIT_MODEL || 'Flux_2_Klein_4B_BF16').trim();
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const KEY_TTL_MS = 15 * 1000;
let keyCache = { value: '', at: 0 };

async function getApiKey() {
  const now = Date.now();
  if (keyCache.value && now - keyCache.at < KEY_TTL_MS) return keyCache.value;
  let value = '';
  try {
    if (db && db.getSetting) value = String((await db.getSetting('deapi_api_key')) || '').trim();
  } catch (_) {}
  if (!value) value = String(process.env.DEAPI_API_KEY || '').trim();
  keyCache = { value, at: now };
  return value;
}

function invalidateKeyCache() { keyCache = { value: '', at: 0 }; }
async function enabled() { return !!(await getApiKey()); }
function auth(key) { return { Authorization: `Bearer ${key}`, Accept: 'application/json' }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
function isRetryableError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  const message = String(error.message || error);
  return /aborted|timeout|timed out|socket|network|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|HTTP (408|409|425|429|5\d\d)\b/i.test(message);
}

function retryDelay(attempt, retryAfter) {
  const headerMs = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
  if (headerMs) return Math.min(Math.max(headerMs, 1000), 20000);
  return Math.min(1200 * (2 ** Math.max(0, attempt - 1)), 10000);
}

async function withRetries(label, fn, options = {}) {
  const attempts = Math.min(Math.max(Number(options.attempts) || 3, 1), 5);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(attempt); } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      if (typeof options.onRetry === 'function') options.onRetry({ label, attempt, attempts, error });
      await sleep(retryDelay(attempt, error.retryAfter));
    }
  }
  throw lastError;
}

function responseError(message, response) {
  const error = new Error(message);
  error.status = response.status;
  error.retryable = RETRYABLE_STATUS.has(response.status);
  error.retryAfter = response.headers && response.headers.get && response.headers.get('retry-after');
  return error;
}

function sniffMime(buffer, fallback = 'image/png') {
  if (!buffer || buffer.length < 12) return fallback;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  if (buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fallback;
}

function extensionFor(mime) {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : mime === 'image/bmp' ? 'bmp' : 'png';
}

function errorMessage(json, text, fallback) {
  if (json) {
    if (typeof json.message === 'string' && json.message) return json.message;
    if (json.errors) return JSON.stringify(json.errors).slice(0, 500);
    if (json.data && typeof json.data.error === 'string') return json.data.error;
  }
  return String(text || fallback || 'Unknown deAPI error').slice(0, 500);
}

async function parseResponse(response) {
  const text = await response.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { text, json };
}

async function listModels(candidateKey) {
  const key = String(candidateKey || '').trim() || await getApiKey();
  if (!key) throw new Error('deAPI is not configured. Add its API key in Admin → Integrations.');
  const response = await fetch(`${BASE}/api/v2/models?per_page=100&page=1`, {
    headers: auth(key),
    signal: AbortSignal.timeout(20000),
  });
  const { text, json } = await parseResponse(response);
  if (!response.ok) throw new Error(`deAPI model lookup failed (HTTP ${response.status}): ${errorMessage(json, text)}`);
  return Array.isArray(json && json.data) ? json.data : [];
}

async function testKey(candidateKey) {
  const started = Date.now();
  try {
    const models = await listModels(candidateKey);
    const model = models.find(item => item && item.slug === DEFAULT_EDIT_MODEL);
    const types = model && model.inference_types;
    const supportsEdit = Array.isArray(types) ? types.includes('img2img') : !!(types && types.img2img);
    if (!model) return { ok: false, status: 200, message: `❌ Connected, but ${DEFAULT_EDIT_MODEL} is not available to this account.` };
    if (!supportsEdit) return { ok: false, status: 200, message: `❌ ${DEFAULT_EDIT_MODEL} is available but does not currently support image editing.` };
    return { ok: true, status: 200, ms: Date.now() - started, message: `✅ Connected — ${model.name || DEFAULT_EDIT_MODEL} supports image-to-image editing.` };
  } catch (error) {
    const message = String(error.message || error);
    const unauthorized = /HTTP 40[13]|unauthor|invalid.*key/i.test(message);
    return { ok: false, status: unauthorized ? 401 : 0, message: unauthorized ? '❌ Invalid or unauthorized deAPI key.' : `❌ Could not validate deAPI: ${message}` };
  }
}

async function pollJob(requestId, key, options = {}) {
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 180000, 30000), 300000);
  const deadline = Date.now() + timeoutMs;
  let delay = 1800;
  let transientFailures = 0;
  const maxTransientFailures = Math.min(Math.max(Number(options.pollRetries) || 5, 1), 10);
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(`${BASE}/api/v2/jobs/${encodeURIComponent(requestId)}`, {
        headers: auth(key),
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (!isRetryableError(error) || ++transientFailures > maxTransientFailures) throw error;
      if (typeof options.onRetry === 'function') options.onRetry({ stage: 'poll', attempt: transientFailures, error });
      await sleep(retryDelay(transientFailures));
      continue;
    }
    const { text, json } = await parseResponse(response);
    if (!response.ok) {
      const error = responseError(`deAPI job lookup failed (HTTP ${response.status}): ${errorMessage(json, text)}`, response);
      if (!error.retryable || ++transientFailures > maxTransientFailures) throw error;
      if (typeof options.onRetry === 'function') options.onRetry({ stage: 'poll', attempt: transientFailures, error });
      await sleep(retryDelay(transientFailures, error.retryAfter));
      continue;
    }
    transientFailures = 0;
    const data = (json && json.data) || {};
    const status = String(data.status || '').toLowerCase();
    if (status === 'done') {
      const url = data.result_url || (data.results_alt_formats && (data.results_alt_formats.webp || data.results_alt_formats.jpg));
      const secureResult = /^https:\/\//i.test(url || '');
      const localTestResult = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url || '') && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(BASE);
      if (!secureResult && !localTestResult) throw new Error('deAPI completed the edit without a secure result URL.');
      return { url, progress: data.progress };
    }
    if (status === 'error') throw new Error(`deAPI image edit failed: ${errorMessage(data, '', 'provider job error')}`);
    if (typeof options.onProgress === 'function') options.onProgress(Number(data.progress) || 0, status || 'pending');
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.25), 5000);
  }
  const error = new Error('deAPI image edit timed out.');
  error.retryable = true;
  throw error;
}

async function editImage(buffer, prompt, options = {}) {
  const key = await getApiKey();
  if (!key) throw new Error('deAPI is not configured. Add its API key in Admin → Integrations.');
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) throw new Error('No valid source image was provided.');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('Source image exceeds deAPI’s 10 MB limit.');
  const instruction = String(prompt || '').trim();
  if (!instruction) throw new Error('No image-edit instruction was provided.');

  const mime = sniffMime(buffer, options.mime);
  const attempts = Math.min(Math.max(Number(options.attempts) || 3, 1), 5);
  return withRetries('image edit', async attempt => {
    // FormData streams are single-use, so rebuild the multipart body for every
    // submission attempt instead of replaying a consumed stream.
    const attemptForm = new FormData();
    attemptForm.append('prompt', instruction.slice(0, 4000));
    attemptForm.append('model', String(options.model || DEFAULT_EDIT_MODEL));
    attemptForm.append('steps', String(4));
    attemptForm.append('seed', String(Number.isInteger(options.seed) ? options.seed : -1));
    if (Number.isInteger(options.width)) attemptForm.append('width', String(options.width));
    if (Number.isInteger(options.height)) attemptForm.append('height', String(options.height));
    attemptForm.append('image', buffer, { filename: `source.${extensionFor(mime)}`, contentType: mime, knownLength: buffer.length });

    const response = await fetch(`${BASE}/api/v2/images/edits`, {
      method: 'POST',
      headers: { ...auth(key), ...attemptForm.getHeaders() },
      body: attemptForm,
      signal: AbortSignal.timeout(45000),
    });
    const { text, json } = await parseResponse(response);
    if (!response.ok) throw responseError(`deAPI edit submission failed (HTTP ${response.status}): ${errorMessage(json, text)}`, response);
    const requestId = json && json.data && json.data.request_id;
    if (!requestId) {
      const error = new Error('deAPI did not return an edit request ID.');
      error.retryable = true;
      throw error;
    }

    const completed = await pollJob(requestId, key, options);
    const downloaded = await withRetries('result download', async () => {
      const imageResponse = await fetch(completed.url, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(60000) });
      if (!imageResponse.ok) throw responseError(`deAPI result download failed (HTTP ${imageResponse.status}).`, imageResponse);
      const output = await imageResponse.buffer();
      const outputMime = String(imageResponse.headers.get('content-type') || sniffMime(output)).split(';')[0];
      if (!outputMime.startsWith('image/') || output.length < 500) {
        const error = new Error('deAPI returned an invalid or empty image.');
        error.retryable = true;
        throw error;
      }
      return { output, outputMime };
    }, { attempts, onRetry: options.onRetry });
    return { buffer: downloaded.output, mime: downloaded.outputMime, model: String(options.model || DEFAULT_EDIT_MODEL), requestId, url: completed.url, attempt };
  }, { attempts, onRetry: options.onRetry });
}

module.exports = { BASE, DEFAULT_EDIT_MODEL, getApiKey, invalidateKeyCache, enabled, listModels, testKey, editImage, pollJob, sniffMime, isRetryableError, withRetries };
