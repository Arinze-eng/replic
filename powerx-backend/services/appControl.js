// ─────────────────────────────────────────────────────────────────────────────
// appControl.js — Central "Remote App Control" brain.
// FIXED: APK download URL now ALWAYS resolves via GitHub API for reliable
// direct-download links (no more "Download failed HTTP 404" from "+" in tags)

const fetch = require('node-fetch');
const db = require('../db');

const GH_API = 'https://api.github.com';

const SCHEMA = {
  apk_latest_version:      { def: '1.5.0',  type: 'string' },
  apk_latest_build:        { def: '68',      type: 'int'    },
  apk_min_supported_build: { def: '0',      type: 'int'    },
  apk_force_update:        { def: '0',      type: 'bool'   },
  apk_download_url:        { def: '',       type: 'string' },
  apk_update_title:        { def: 'Update available', type: 'string' },
  apk_update_message:      { def: 'A new version of the app is available. Please update to continue.', type: 'string' },
  apk_update_changelog:    { def: '',       type: 'string' },
  app_name:                { def: 'WormGPT Agent', type: 'string' },
  app_tagline:             { def: 'All-in-one AI', type: 'string' },
  app_primary_color:       { def: '#7c3aed', type: 'string' },
  app_announcement:        { def: '',       type: 'string' },
  app_announcement_active: { def: '0',      type: 'bool'   },
  app_maintenance:         { def: '0',      type: 'bool'   },
  app_maintenance_message: { def: 'We are doing scheduled maintenance. Please check back shortly.', type: 'string' },
  feature_chat:            { def: '1',      type: 'bool'   },
  feature_wormgpt:         { def: '1',      type: 'bool'   },
  feature_agent:          { def: '1',      type: 'bool'   },
  feature_lemon:           { def: '1',      type: 'bool'   },
  feature_tools:           { def: '1',      type: 'bool'   },
  feature_payments:        { def: '1',      type: 'bool'   },
  feature_signup:          { def: '1',      type: 'bool'   },
  feature_image_gen:       { def: '1',      type: 'bool'   },
  feature_file_upload:     { def: '1',      type: 'bool'   },
  free_daily_limit:        { def: '20',     type: 'int'    },
  max_upload_mb:           { def: '25',     type: 'int'    },
};

function parseVal(type, raw, def) {
  if (raw == null || raw === '') raw = def;
  switch (type) {
    case 'bool': return String(raw) === '1' || String(raw).toLowerCase() === 'true';
    case 'int':  { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : parseInt(def, 10) || 0; }
    default:     return String(raw);
  }
}

async function getAll() {
  const out = {};
  await Promise.all(Object.entries(SCHEMA).map(async ([key, meta]) => {
    let raw = null;
    try { raw = await db.getSetting(key); } catch (_) { raw = null; }
    out[key] = parseVal(meta.type, raw, meta.def);
  }));
  return out;
}

async function saveAll(patch = {}) {
  const writes = [];
  for (const [key, meta] of Object.entries(SCHEMA)) {
    if (!(key in patch)) continue;
    let v = patch[key];
    if (meta.type === 'bool') v = (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true') ? '1' : '0';
    else if (meta.type === 'int') v = String(parseInt(v, 10) || 0);
    else v = String(v == null ? '' : v).slice(0, 4000);
    writes.push(db.setSetting(key, v));
  }
  await Promise.all(writes);
  return getAll();
}

async function getClientConfig(clientBuild, baseUrl) {
  const c = await getAll();
  const cb = parseInt(clientBuild, 10) || 0;
  const latest = c.apk_latest_build;
  const minSup = c.apk_min_supported_build;

  // FIX: Always resolve the download URL via GitHub API to avoid the "+" tag 404
  const downloadUrl = await resolveApkDownloadUrl(c.apk_download_url, baseUrl);
  const hasDownload = !!downloadUrl;

  const available = latest > cb && hasDownload;
  const forced = (c.apk_force_update || (cb > 0 && cb < minSup)) && hasDownload;
  const required = available && (forced || cb < minSup);

  return {
    ok: true,
    server_time: new Date().toISOString(),
    branding: {
      app_name: c.app_name,
      tagline: c.app_tagline,
      primary_color: c.app_primary_color,
    },
    announcement: {
      active: c.app_announcement_active && !!String(c.app_announcement).trim(),
      message: c.app_announcement_active ? c.app_announcement : '',
    },
    maintenance: {
      active: c.app_maintenance,
      message: c.app_maintenance_message,
    },
    features: {
      chat: c.feature_chat,
      wormgpt: c.feature_wormgpt,
      agent: c.feature_agent,
      lemon: c.feature_lemon,
      tools: c.feature_tools,
      payments: c.feature_payments,
      signup: c.feature_signup,
      image_gen: c.feature_image_gen,
      file_upload: c.feature_file_upload,
    },
    limits: {
      free_daily_limit: c.free_daily_limit,
      max_upload_mb: c.max_upload_mb,
    },
    update: {
      latest_version: c.apk_latest_version,
      latest_build: latest,
      client_build: cb,
      available,
      required,
      forced,
      // FIX: This is now ALWAYS a working direct-download URL resolved via GitHub API
      download_url: downloadUrl,
      title: c.apk_update_title,
      message: c.apk_update_message,
      changelog: c.apk_update_changelog,
    },
  };
}

function apkRepo()     { return (process.env.APK_REPO || process.env.GITHUB_DEPLOY_REPO || 'Arinze-eng/powerx').trim(); }
// FIX: default the build branch to `main`. The fresh Arinze-eng/powerx repo is
// pushed to `main`, and a GitHub `workflow_dispatch` requires the workflow file
// to exist on the ref it is dispatched against. Defaulting to the stale
// `wormgpt-apk` branch (which does not exist on the fresh repo) made every
// admin "release + build" fail with "No ref found for: wormgpt-apk". Override
// with APK_BRANCH if you keep the APK source on a dedicated branch.
function apkBranch()   { return (process.env.APK_BRANCH || 'main').trim(); }
function apkWorkflow() { return (process.env.APK_WORKFLOW || 'build-apk.yml').trim(); }
function ghToken()     { return (process.env.GITHUB_DEPLOY_TOKEN || '').trim(); }
function ghEnabled() { return !!ghToken(); }
function apkAssetName() { return (process.env.APK_ASSET_NAME || 'wormgpt-agent-arm64-v8a.apk').trim(); }

async function gh(pathname, opts = {}) {
  const r = await fetch(`${GH_API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wormgpt-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

// FIXED: Resolve APK download URL using GitHub API.
// This is the fix for "Download failed HTTP 404" caused by "+" in release tags.
// Returns a working signed CDN URL or falls back to the static GitHub release URL.
async function resolveApkDownloadUrl(adminUrl, baseUrl) {
  // If admin provided a direct .apk URL, use it
  if (adminUrl && isDirectApkUrl(adminUrl)) return adminUrl.trim();
  
  // Try GitHub API first
  try {
    const repo = apkRepo();
    const wantName = apkAssetName().toLowerCase();
    
    const rel = await gh(`/repos/${repo}/releases/latest`, { method: 'GET' });
    if (rel.ok && rel.json && Array.isArray(rel.json.assets)) {
      const asset = rel.json.assets.find(a => String(a.name || '').toLowerCase() === wantName)
        || rel.json.assets.find(a => String(a.name || '').toLowerCase().endsWith('.apk'));
      
      if (asset) {
        // Use browser_download_url which is a direct GitHub CDN link
        // This works even with "+" in tags
        if (asset.browser_download_url) return asset.browser_download_url;
        
        // Fallback: resolve via API redirect
        const r = await fetch(`${GH_API}/repos/${repo}/releases/assets/${asset.id}`, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': 'wormgpt-agent',
            ...(ghToken() ? { Authorization: `Bearer ${ghToken()}` } : {}),
          },
        });
        const location = r.headers.get('location');
        if (location) return location;
      }
    }
  } catch (e) {
    console.error('[appControl] GitHub API resolve failed:', e.message);
  }
  
  // Fallback to static GitHub release URL
  return `https://github.com/${apkRepo()}/releases/latest/download/${apkAssetName()}`;
}

function isDirectApkUrl(u) {
  if (!u) return false;
  const s = String(u).trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) return false;
  if (/\/actions\/runs\//.test(s) || /\/suites\//.test(s)) return false;
  return /\/(releases\/download\/|releases\/latest\/download\/)/.test(s) || /\.apk(\?|#|$)/.test(s);
}

async function triggerApkBuild(params = {}) {
  if (!ghToken()) throw new Error('APK build not configured (set GITHUB_DEPLOY_TOKEN).');
  const repo = apkRepo();
  const wf = apkWorkflow();
  const branch = apkBranch();

  const inputs = {};
  if (params.version != null && String(params.version).trim() !== '') inputs.version = String(params.version).trim();
  if (params.build != null && String(params.build).trim() !== '') inputs.build = String(parseInt(params.build, 10) || '').trim();

  const body = { ref: branch };
  if (Object.keys(inputs).length) body.inputs = inputs;

  const r = await gh(`/repos/${repo}/actions/workflows/${wf}/dispatches`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json._raw)) || `HTTP ${r.status}`;
    throw new Error(`workflow_dispatch failed: ${msg}`);
  }
  return {
    ok: true,
    repo, branch, workflow: wf,
    inputs,
    runsUrl: `https://github.com/${repo}/actions/workflows/${wf}`,
  };
}

async function releaseApkVersion({ version, build } = {}) {
  const v = String(version || '').trim();
  const b = parseInt(build, 10);
  if (!v) throw new Error('version is required (e.g. "1.4.2").');
  if (!Number.isFinite(b) || b <= 0) throw new Error('build must be a positive integer (e.g. 10).');

  const cur = await getAll();
  if (b <= cur.apk_latest_build) {
    throw new Error(`build (${b}) must be greater than the current latest build (${cur.apk_latest_build}).`);
  }

  const config = await saveAll({ apk_latest_version: v, apk_latest_build: b });

  let buildResult = null;
  try {
    buildResult = await triggerApkBuild({ version: v, build: b });
  } catch (e) {
    throw new Error(`settings saved, but build dispatch failed: ${e.message}`);
  }

  return { ok: true, config, build: buildResult };
}

async function getApkBuildStatus() {
  if (!ghToken()) return { ok: false, error: 'GITHUB_DEPLOY_TOKEN not set', runs: [] };
  const repo = apkRepo();
  const wf = apkWorkflow();
  const r = await gh(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=5`, { method: 'GET' });
  if (!r.ok) return { ok: false, error: (r.json && r.json.message) || `HTTP ${r.status}`, runs: [] };
  const runs = (r.json.workflow_runs || []).map((w) => ({
    id: w.id,
    status: w.status,
    conclusion: w.conclusion,
    branch: w.head_branch,
    created_at: w.created_at,
    updated_at: w.updated_at,
    html_url: w.html_url,
    artifacts_url: w.artifacts_url,
  }));
  return { ok: true, repo, workflow: wf, runs };
}

module.exports = {
  SCHEMA,
  getAll, saveAll, getClientConfig,
  triggerApkBuild, releaseApkVersion, getApkBuildStatus, ghEnabled,
  apkRepo, apkBranch, apkWorkflow,
  isDirectApkUrl, resolveApkDownloadUrl, apkAssetName,
};