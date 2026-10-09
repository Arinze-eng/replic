// ─────────────────────────────────────────────────────────────────────────────
// cloudinary.js — Cloudinary media hosting + transformation for the WormGPT Agent.
//
// WHAT IT DOES
//   Cloudinary gives every image/video the agent creates or edits a PERMANENT,
//   CDN-hosted, shareable URL (https://res.cloudinary.com/…). This "combines
//   power" with Replicate: Replicate EDITS the bytes, Cloudinary HOSTS the
//   result (and can transform it — resize, crop, format-convert, watermark, …).
//   It also hosts the images/videos that `generate_image` produces, so the bot
//   can hand the user a clean link in addition to the file itself.
//
//   If Cloudinary is NOT configured, every helper degrades GRACEFULLY: callers
//   that ask for a hosted URL simply get `null` and keep working with the raw
//   bytes exactly as before. So Replicate and Cloudinary can be used TOGETHER
//   (edit → host) or SEPARATELY (edit only, or host only) with no breakage.
//
// DESIGN NOTES (mirrors services/replicate.js conventions EXACTLY)
//   • Credentials resolved at RUNTIME — DB settings first (admin panel →
//     Integrations, so they can be rotated live with NO redeploy), then env
//     vars (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET,
//     or a single CLOUDINARY_URL=cloudinary://key:secret@cloud) as a fallback.
//   • Pure node-fetch + node `crypto` for signing — NO extra SDK dependency, so
//     it works out of the box on Render with nothing else to install.
//   • A short-TTL runtime cache avoids a DB hit on every call but still picks up
//     admin credential changes within a few seconds.
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
const crypto = require('crypto');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional (unit tests) */ }

const CLOUDINARY_BASE = (process.env.CLOUDINARY_BASE || 'https://api.cloudinary.com/v1_1').replace(/\/+$/, '');

// Runtime credential cache (short TTL).
let _credCache = { value: null, ts: 0 };
const CRED_TTL = 15000;

// Parse a CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud> string.
function parseCloudinaryUrl(url) {
  try {
    const m = String(url || '').match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/i);
    if (!m) return null;
    return { apiKey: m[1].trim(), apiSecret: m[2].trim(), cloudName: m[3].trim() };
  } catch (_) { return null; }
}

// ── Resolve {cloudName, apiKey, apiSecret} — DB first, then env. ──────────────
async function getCreds() {
  const now = Date.now();
  if (_credCache.value && now - _credCache.ts < CRED_TTL) return _credCache.value;

  let cloudName = '', apiKey = '', apiSecret = '';
  try {
    if (db && db.getSetting) {
      const c = await db.getSetting('cloudinary_cloud_name');
      const k = await db.getSetting('cloudinary_api_key');
      const s = await db.getSetting('cloudinary_api_secret');
      if (c && c.trim()) cloudName = c.trim();
      if (k && k.trim()) apiKey = k.trim();
      if (s && s.trim()) apiSecret = s.trim();
    }
  } catch (_) {}

  // Env fallback — only fills the pieces still missing, so an admin can override
  // just one field at runtime without wiping the others.
  if (!cloudName || !apiKey || !apiSecret) {
    const fromUrl = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
    if (!cloudName) cloudName = (process.env.CLOUDINARY_CLOUD_NAME || (fromUrl && fromUrl.cloudName) || '').trim();
    if (!apiKey) apiKey = (process.env.CLOUDINARY_API_KEY || (fromUrl && fromUrl.apiKey) || '').trim();
    if (!apiSecret) apiSecret = (process.env.CLOUDINARY_API_SECRET || (fromUrl && fromUrl.apiSecret) || '').trim();
  }

  const creds = { cloudName, apiKey, apiSecret };
  _credCache = { value: creds, ts: now };
  return creds;
}

// Allow the admin route to flush the cache the instant new creds are saved.
function invalidateKeyCache() { _credCache = { value: null, ts: 0 }; }

// Is Cloudinary configured (all three pieces present somewhere)?
function enabled() {
  try {
    if (_credCache.value) {
      const c = _credCache.value;
      if (c.cloudName && c.apiKey && c.apiSecret) return true;
    }
    const fromUrl = parseCloudinaryUrl(process.env.CLOUDINARY_URL);
    const cn = process.env.CLOUDINARY_CLOUD_NAME || (fromUrl && fromUrl.cloudName);
    const ak = process.env.CLOUDINARY_API_KEY || (fromUrl && fromUrl.apiKey);
    const as = process.env.CLOUDINARY_API_SECRET || (fromUrl && fromUrl.apiSecret);
    if (cn && ak && as) return true;
  } catch (_) {}
  // Fall back to "maybe" — getCreds() resolves the DB values when actually used.
  return false;
}

function sniffMime(buf, fallback = 'image/png') {
  if (!buf || buf.length < 4) return fallback;
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // Crude video sniff (mp4/webm) so resource_type can be auto-detected.
  if (buf.length > 11 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
  return fallback;
}

function isVideoMime(mime) { return /^video\//i.test(String(mime || '')); }

function bufferToDataUri(buf, mime) {
  return `data:${mime || sniffMime(buf)};base64,${buf.toString('base64')}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Cloudinary signed-request signature ──────────────────────────────────────
// Sign the params (alphabetical, joined as k=v&k=v) + api_secret, SHA-1 hex.
// `signature` and `api_key`/`file`/`resource_type` are NOT part of the string.
function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

// ── Test the credentials by hitting the Admin "ping" endpoint ─────────────────
// Returns { ok, status, ms, message } — never throws.
async function testKey(override) {
  let creds;
  if (override && typeof override === 'object' && (override.cloudName || override.cloud_name)) {
    creds = {
      cloudName: (override.cloudName || override.cloud_name || '').trim(),
      apiKey: (override.apiKey || override.api_key || '').trim(),
      apiSecret: (override.apiSecret || override.api_secret || '').trim(),
    };
  } else {
    creds = await getCreds();
  }
  const { cloudName, apiKey, apiSecret } = creds;
  if (!cloudName || !apiKey || !apiSecret) {
    return { ok: false, status: 0, message: '❌ Cloudinary is not fully configured (need cloud name, API key and API secret).' };
  }
  const started = Date.now();
  try {
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const r = await fetchWithTimeout(
      `${CLOUDINARY_BASE}/${encodeURIComponent(cloudName)}/ping`,
      { headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } },
      20000
    );
    const ms = Date.now() - started;
    if (r.ok) {
      return { ok: true, status: r.status, ms, message: `✅ Working — Cloudinary "${cloudName}" reachable in ${ms}ms.` };
    }
    let msg = '❌ Cloudinary returned HTTP ' + r.status + '.';
    if (r.status === 401 || r.status === 403) msg = '❌ Invalid Cloudinary credentials (401/403) — check cloud name / API key / API secret.';
    return { ok: false, status: r.status, ms, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: '❌ Could not reach Cloudinary: ' + e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// uploadBuffer — upload image OR video bytes to Cloudinary and return its
// permanent secure URL. Auto-detects image vs video from the MIME / sniff.
//   buffer : Buffer of the media.
//   opts   : { mime?, folder?, publicId?, resourceType? ('image'|'video'|'auto'),
//              tags?, transformation? (eager URL transform string) }
//   returns: { url, publicId, resourceType, width?, height?, format?, bytes? }
//            or null on ANY failure (so callers degrade gracefully).
// ─────────────────────────────────────────────────────────────────────────────
async function uploadBuffer(buffer, opts = {}) {
  if (!buffer || !buffer.length) return null;
  let creds;
  try { creds = await getCreds(); } catch (_) { return null; }
  const { cloudName, apiKey, apiSecret } = creds || {};
  if (!cloudName || !apiKey || !apiSecret) return null; // not configured → skip silently

  const mime = opts.mime || sniffMime(buffer);
  let resourceType = (opts.resourceType || '').trim();
  if (!resourceType) resourceType = isVideoMime(mime) ? 'video' : 'image';
  const folder = (opts.folder || process.env.CLOUDINARY_FOLDER || 'wormgpt').trim();

  const timestamp = Math.floor(Date.now() / 1000);
  // Params that participate in the signature (everything except file/api_key/
  // resource_type/signature). Keep this list lean & deterministic.
  const signed = { timestamp };
  if (folder) signed.folder = folder;
  if (opts.publicId) signed.public_id = String(opts.publicId);
  if (opts.tags) signed.tags = Array.isArray(opts.tags) ? opts.tags.join(',') : String(opts.tags);
  if (opts.eager) signed.eager = String(opts.eager);

  const signature = signParams(signed, apiSecret);

  const form = new URLSearchParams();
  form.set('file', bufferToDataUri(buffer, mime));
  form.set('api_key', apiKey);
  form.set('signature', signature);
  for (const [k, v] of Object.entries(signed)) form.set(k, String(v));

  try {
    const r = await fetchWithTimeout(
      `${CLOUDINARY_BASE}/${encodeURIComponent(cloudName)}/${resourceType}/upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      // Videos can be large — give them a generous timeout.
      resourceType === 'video' ? 180000 : 90000
    );
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok || !data || (!data.secure_url && !data.url)) {
      return null; // graceful: caller keeps using the raw bytes
    }
    return {
      url: data.secure_url || data.url,
      publicId: data.public_id,
      resourceType: data.resource_type || resourceType,
      format: data.format,
      width: data.width,
      height: data.height,
      bytes: data.bytes,
      duration: data.duration,
    };
  } catch (_) {
    return null; // network/timeout → graceful skip
  }
}

// Convenience wrappers for clarity at the call sites.
async function uploadImage(buffer, opts = {}) {
  return uploadBuffer(buffer, { ...opts, resourceType: 'image' });
}
async function uploadVideo(buffer, opts = {}) {
  return uploadBuffer(buffer, { ...opts, resourceType: 'video' });
}

// Build a transformed delivery URL from a public_id (e.g. resize/crop/format).
// transformation e.g. "w_800,h_600,c_fill,f_auto,q_auto".
async function buildUrl(publicId, transformation = 'f_auto,q_auto', resourceType = 'image') {
  if (!publicId) return null;
  const { cloudName } = await getCreds();
  if (!cloudName) return null;
  const t = transformation ? transformation.replace(/^\/+|\/+$/g, '') + '/' : '';
  return `https://res.cloudinary.com/${cloudName}/${resourceType}/upload/${t}${publicId}`;
}

module.exports = {
  CLOUDINARY_BASE,
  getCreds,
  invalidateKeyCache,
  enabled,
  testKey,
  uploadBuffer,
  uploadImage,
  uploadVideo,
  buildUrl,
  sniffMime,
  isVideoMime,
  parseCloudinaryUrl,
};
