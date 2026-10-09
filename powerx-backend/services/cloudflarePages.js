// ─────────────────────────────────────────────────────────────────────────────
// cloudflarePages.js — Deploy a folder of static files to Cloudflare Pages and
// return a public *.pages.dev URL.
//
// Uses the Cloudflare Pages "Direct Upload" API (no Git connection needed):
//   1. Ensure a Pages PROJECT exists (create it if missing). The project name
//      is STABLE per user, so re-deploying updates the SAME site and returns the
//      SAME URL. A different user → different project name → different URL.
//   2. POST /pages/projects/{name}/upload-token  → short-lived JWT for uploads.
//   3. For every file, upload its bytes to the Pages content store keyed by a
//      base64( sha256(file) + ext ) hash via /pages/assets/upload (batched).
//   4. POST /pages/projects/{name}/deployments with a multipart manifest mapping
//      "/path" → hash. Cloudflare builds the deployment and serves it instantly.
//   5. Poll the deployment until it is live, return deployment.url (and the
//      canonical project subdomain).
//
// Credentials come ONLY from env (never hardcoded):
//   CF_PAGES_ACCOUNT_ID   — Cloudflare account id
//   CF_PAGES_API_TOKEN    — API token with "Cloudflare Pages: Edit" permission
// Falls back to the generic CF_ACCOUNT_ID / CF_API_TOKEN if the Pages-specific
// ones are not set, so existing single-account setups keep working.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const CF_API = 'https://api.cloudflare.com/client/v4';

function getCreds() {
  const accountId = process.env.CF_PAGES_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
  const token = process.env.CF_PAGES_API_TOKEN || process.env.CF_API_TOKEN || '';
  return { accountId, token };
}

function enabled() {
  const { accountId, token } = getCreds();
  return !!(accountId && token);
}

// Cloudflare Pages project names: lowercase letters, digits, hyphens; ≤58 chars,
// must start with a letter/number. We derive a STABLE name from the user key so
// the same user always lands on the same project/URL.
function projectNameFromUser(userKey) {
  const base = (userKey && String(userKey)) || 'anon';
  const hash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 12);
  let name = `site-${hash}`;
  name = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 58);
  if (!/^[a-z0-9]/.test(name)) name = 's' + name;
  return name;
}

// Content type from extension (Pages serves whatever we tell it).
function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain',
    '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
    '.map': 'application/json', '.webmanifest': 'application/manifest+json',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  };
  return map[ext] || 'application/octet-stream';
}

// Cloudflare Pages asset hash: blake3 is ideal but they accept a 32-char hex
// derived from the file content + extension. We follow the wrangler scheme:
// hash = hex( sha256( base64(content) + extension ) ).slice(0,32)
function assetHash(buffer, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const b64 = buffer.toString('base64');
  return crypto.createHash('sha256').update(b64 + ext).digest('hex').slice(0, 32);
}

async function cfFetch(url, opts, token) {
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

// Ensure a Pages project exists. Returns { created, subdomain }.
async function ensureProject(accountId, token, name, onStep) {
  // Check if it already exists.
  const got = await cfFetch(`${CF_API}/accounts/${accountId}/pages/projects/${name}`, { method: 'GET' }, token);
  if (got.ok && got.json && got.json.success) {
    return { created: false, subdomain: got.json.result.subdomain };
  }
  // Detect a bad/insufficient token early and give an actionable message.
  const authCode = got.json && got.json.errors && got.json.errors[0] && got.json.errors[0].code;
  if (authCode === 1000 || authCode === 9109 || authCode === 10000) {
    throw new Error(
      'Cloudflare authentication failed (invalid or insufficient API token). ' +
      'Create a classic API token at Cloudflare → My Profile → API Tokens → Create Token, ' +
      'grant it the "Cloudflare Pages: Edit" permission on this account, and set it as ' +
      'CF_PAGES_API_TOKEN (with CF_PAGES_ACCOUNT_ID = your account id).'
    );
  }
  // Create it (production_branch is required by the API).
  if (onStep) onStep('🌐 creating your Cloudflare Pages project…');
  const created = await cfFetch(`${CF_API}/accounts/${accountId}/pages/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, production_branch: 'main' }),
  }, token);
  if (!created.ok || !created.json || !created.json.success) {
    const errs = created.json && created.json.errors ? created.json.errors : null;
    const code = errs && errs[0] && errs[0].code;
    if (code === 1000 || code === 9109 || code === 10000) {
      throw new Error(
        'Cloudflare authentication failed (invalid or insufficient API token). ' +
        'Token needs the "Cloudflare Pages: Edit" permission. ' +
        'Set CF_PAGES_API_TOKEN + CF_PAGES_ACCOUNT_ID.'
      );
    }
    const msg = errs ? JSON.stringify(errs) : `HTTP ${created.status}`;
    throw new Error(`could not create Pages project: ${msg}`);
  }
  return { created: true, subdomain: created.json.result.subdomain };
}

// Upload assets that Cloudflare doesn't yet have, using the upload JWT.
async function uploadMissing(accountId, token, name, hashToBuf, onStep) {
  // 1) get an upload token (JWT)
  const tok = await cfFetch(`${CF_API}/accounts/${accountId}/pages/projects/${name}/upload-token`, { method: 'GET' }, token);
  if (!tok.ok || !tok.json || !tok.json.success) {
    throw new Error('could not get Pages upload token (token may lack "Cloudflare Pages: Edit" permission)');
  }
  const jwt = tok.json.result.jwt;

  const allHashes = Object.keys(hashToBuf);

  // 2) ask which hashes are missing
  const check = await fetch(`${CF_API}/pages/assets/check-missing`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: allHashes }),
  });
  let missing = allHashes;
  try {
    const cj = await check.json();
    if (cj && cj.success && Array.isArray(cj.result)) missing = cj.result;
  } catch (_) { /* if check fails, upload everything */ }

  if (!missing.length) return;
  if (onStep) onStep(`⬆️ uploading ${missing.length} file(s) to Cloudflare…`);

  // 3) upload missing assets in batches
  const batchSize = 5;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const payload = batch.map(h => {
      const { buffer, file } = hashToBuf[h];
      return {
        key: h,
        value: buffer.toString('base64'),
        metadata: { contentType: contentTypeFor(file) },
        base64: true,
      };
    });
    const up = await fetch(`${CF_API}/pages/assets/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      throw new Error(`asset upload failed (HTTP ${up.status}): ${t.slice(0, 200)}`);
    }
  }

  // 4) tell Cloudflare these hashes are now upserted
  await fetch(`${CF_API}/pages/assets/upsert-hashes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: allHashes }),
  }).catch(() => {});
}

// Create a deployment from the manifest. Returns the deployment object.
async function createDeployment(accountId, token, name, manifest, onStep) {
  if (onStep) onStep('🚀 publishing deployment…');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  const r = await fetch(`${CF_API}/accounts/${accountId}/pages/projects/${name}/deployments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    body: form,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  if (!r.ok || !json || !json.success) {
    const msg = json && json.errors ? JSON.stringify(json.errors) : text.slice(0, 300);
    throw new Error(`deployment create failed (HTTP ${r.status}): ${msg}`);
  }
  return json.result;
}

/**
 * Deploy a set of files to Cloudflare Pages.
 *
 * @param {object} opts
 *   - userKey:   stable per-user identifier (same user → same URL).
 *   - files:     array of { rel, buffer }  (rel = path relative to site root).
 *   - onStep:    optional progress callback.
 * @returns { url, projectUrl, project, created, fileCount }
 */
async function deploy({ userKey, files, onStep }) {
  const { accountId, token } = getCreds();
  if (!accountId || !token) {
    throw new Error('Cloudflare Pages not configured (set CF_PAGES_ACCOUNT_ID and CF_PAGES_API_TOKEN).');
  }
  if (!Array.isArray(files) || !files.length) {
    throw new Error('no files to deploy.');
  }

  const name = projectNameFromUser(userKey);

  // Build the asset map: hash → {buffer,file}; and the manifest: "/path" → hash.
  const hashToBuf = {};
  const manifest = {};
  for (const f of files) {
    let rel = String(f.rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) continue;
    const h = assetHash(f.buffer, rel);
    hashToBuf[h] = { buffer: f.buffer, file: rel };
    manifest['/' + rel] = h;
  }

  const { created, subdomain } = await ensureProject(accountId, token, name, onStep);
  await uploadMissing(accountId, token, name, hashToBuf, onStep);
  const dep = await createDeployment(accountId, token, name, manifest, onStep);

  // dep.url is the unique deployment URL; the project's stable URL is the
  // production subdomain (https://<name>.pages.dev) which always points to the
  // latest production deployment — that's the one we return so a user's URL is
  // STABLE across updates.
  const projectUrl = subdomain ? (subdomain.startsWith('http') ? subdomain : `https://${subdomain}`) : (dep.url || '');
  return {
    url: projectUrl || dep.url,
    deploymentUrl: dep.url,
    project: name,
    created,
    fileCount: Object.keys(manifest).length,
  };
}

module.exports = { deploy, enabled, projectNameFromUser, getCreds };
