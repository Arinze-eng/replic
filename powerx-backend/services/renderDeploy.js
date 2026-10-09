// ─────────────────────────────────────────────────────────────────────────────
// renderDeploy.js — Push edited files to the configured GitHub repo/branch and
// trigger a Render deploy.
//
// This is the "push my repo + deploy to Render" path for the WormGPT Agent. It
// is SEPARATE from githubDeploy.js (which is hard-locked to a different repo).
//
// Repo / branch are configurable via env (with safe defaults to the project's
// own repo). The push uses the GitHub Git Data API (blobs → tree → commit →
// update ref) so MANY files land in ONE atomic commit.
//
// Tokens come ONLY from env (never hardcoded):
//   • GITHUB_DEPLOY_TOKEN  — GitHub PAT with `repo`/`contents:write`.
//   • RENDER_API_KEY       — Render API key (rnd_…) to trigger a deploy.
//   • RENDER_SERVICE_ID    — Render service id (srv-…) to deploy. Optional; if
//                            absent we resolve it from the repo via the API.
//   • GITHUB_DEPLOY_REPO   — "owner/repo"  (default Arinze-eng/Netlify)
//   • GITHUB_DEPLOY_BRANCH — branch        (default evilgpt)
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const GH_API = 'https://api.github.com';
const RENDER_API = 'https://api.render.com/v1';

function repoSlug() { return (process.env.GITHUB_DEPLOY_REPO || 'Arinze-eng/Netlify').trim(); }
function branch() { return (process.env.GITHUB_DEPLOY_BRANCH || 'evilgpt').trim(); }
function ghToken() { return (process.env.GITHUB_DEPLOY_TOKEN || '').trim(); }
function renderKey() { return (process.env.RENDER_API_KEY || '').trim(); }
function renderServiceId() { return (process.env.RENDER_SERVICE_ID || '').trim(); }

function ownerRepo() {
  const [owner, repo] = repoSlug().split('/');
  return { owner: owner || '', repo: repo || '' };
}

function gitEnabled() { return !!ghToken(); }
function renderEnabled() { return !!renderKey(); }

async function gh(pathname, opts = {}) {
  const r = await fetch(`${GH_API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wormgpt-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

async function render(pathname, opts = {}) {
  const r = await fetch(`${RENDER_API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${renderKey()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

/**
 * Commit files to the configured repo@branch.
 * @param {object} opts
 *   - files:   array of { rel, buffer }  (rel = path inside the repo)
 *   - message: optional commit message
 *   - onStep:  optional progress callback
 * @returns { commitSha, commitUrl, htmlUrl, repo, branch, fileCount }
 */
async function pushFiles({ files, message, onStep }) {
  if (!ghToken()) throw new Error('GitHub push not configured (set GITHUB_DEPLOY_TOKEN).');
  if (!Array.isArray(files) || !files.length) throw new Error('no files to commit.');
  const { owner, repo } = ownerRepo();
  const BR = branch();
  if (!owner || !repo) throw new Error(`invalid GITHUB_DEPLOY_REPO "${repoSlug()}" (expected owner/repo).`);

  if (onStep) onStep(`🐙 committing ${files.length} file(s) to ${owner}/${repo}@${BR}…`);

  // 1) Resolve branch ref → latest commit → base tree.
  let baseTreeSha = null, parentCommitSha = null;
  const ref = await gh(`/repos/${owner}/${repo}/git/ref/heads/${BR}`, { method: 'GET' });
  if (ref.ok && ref.json && ref.json.object) {
    parentCommitSha = ref.json.object.sha;
    const commit = await gh(`/repos/${owner}/${repo}/git/commits/${parentCommitSha}`, { method: 'GET' });
    if (commit.ok) baseTreeSha = commit.json.tree.sha;
  } else if (ref.status === 404 || ref.status === 409) {
    parentCommitSha = null; baseTreeSha = null;
  } else {
    const msg = (ref.json && ref.json.message) || `HTTP ${ref.status}`;
    throw new Error(`could not read repo ref: ${msg} (check token has access to ${owner}/${repo}).`);
  }

  // 2) Blobs.
  const tree = [];
  for (const f of files) {
    const rel = String(f.rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) continue;
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: f.buffer.toString('base64'), encoding: 'base64' }),
    });
    if (!blob.ok) {
      const msg = (blob.json && blob.json.message) || `HTTP ${blob.status}`;
      throw new Error(`blob create failed for ${rel}: ${msg}`);
    }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
  }

  // 3) Tree.
  const treeBody = { tree };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;
  const newTree = await gh(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST', body: JSON.stringify(treeBody),
  });
  if (!newTree.ok) {
    const msg = (newTree.json && newTree.json.message) || `HTTP ${newTree.status}`;
    throw new Error(`tree create failed: ${msg}`);
  }

  // 4) Commit.
  const commitBody = {
    message: message || `Agent deploy — ${new Date().toISOString()}`,
    tree: newTree.json.sha,
  };
  if (parentCommitSha) commitBody.parents = [parentCommitSha];
  const newCommit = await gh(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST', body: JSON.stringify(commitBody),
  });
  if (!newCommit.ok) {
    const msg = (newCommit.json && newCommit.json.message) || `HTTP ${newCommit.status}`;
    throw new Error(`commit create failed: ${msg}`);
  }

  // 5) Update/create ref.
  let upd = await gh(`/repos/${owner}/${repo}/git/refs/heads/${BR}`, {
    method: 'PATCH', body: JSON.stringify({ sha: newCommit.json.sha, force: false }),
  });
  if (!upd.ok && (upd.status === 404 || upd.status === 422)) {
    upd = await gh(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BR}`, sha: newCommit.json.sha }),
    });
  }
  if (!upd.ok) {
    const msg = (upd.json && upd.json.message) || `HTTP ${upd.status}`;
    throw new Error(`ref update failed: ${msg}`);
  }

  return {
    commitSha: newCommit.json.sha,
    commitUrl: newCommit.json.html_url || `https://github.com/${owner}/${repo}/commit/${newCommit.json.sha}`,
    htmlUrl: `https://github.com/${owner}/${repo}/tree/${BR}`,
    repo: `${owner}/${repo}`,
    branch: BR,
    fileCount: tree.length,
  };
}

/**
 * Set (create or update) an environment variable on the configured Render
 * service, then trigger a redeploy so the new value takes effect.
 *
 * Used by the Truecaller setup wizard to PERSIST the freshly-obtained
 * installation id (so it survives every restart/redeploy without anyone
 * touching the Render dashboard).
 *
 * @returns { ok, serviceId, key, deployId? }
 */
async function setEnvVar(key, value, { redeploy = true } = {}) {
  if (!renderKey()) throw new Error('Render not configured (set RENDER_API_KEY).');
  if (!key) throw new Error('env var key required.');
  const sid = await resolveServiceId();
  if (!sid) throw new Error('could not resolve Render service id (set RENDER_SERVICE_ID).');
  // Render: PUT /services/{id}/env-vars/{key}  → upserts a single env var.
  const r = await render(`/services/${sid}/env-vars/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value: String(value == null ? '' : value) }),
  });
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json._raw)) || `HTTP ${r.status}`;
    throw new Error(`Render env var update failed: ${msg}`);
  }
  let deployId = '';
  if (redeploy) {
    try {
      const d = await triggerRenderDeploy({});
      deployId = d.deployId || '';
    } catch (_) { /* env var is saved; a manual redeploy can still apply it */ }
  }
  return { ok: true, serviceId: sid, key, deployId };
}

// Resolve a Render service id from the configured repo (best-effort).
async function resolveServiceId() {
  if (renderServiceId()) return renderServiceId();
  const { owner, repo } = ownerRepo();
  const wantRepo = `https://github.com/${owner}/${repo}`.toLowerCase();
  const r = await render(`/services?limit=100`, { method: 'GET' });
  if (!r.ok || !Array.isArray(r.json)) return '';
  for (const item of r.json) {
    const svc = item.service || item;
    const repoUrl = ((svc.repo || (svc.serviceDetails && svc.serviceDetails.repo)) || '').toLowerCase();
    if (repoUrl && repoUrl.includes(`${owner}/${repo}`.toLowerCase())) return svc.id;
    if (repoUrl === wantRepo) return svc.id;
  }
  return '';
}

/**
 * Trigger a Render deploy for the configured service.
 * @returns { deployId, serviceId, dashboardUrl }
 */
async function triggerRenderDeploy({ onStep, clearCache } = {}) {
  if (!renderKey()) throw new Error('Render deploy not configured (set RENDER_API_KEY).');
  const sid = await resolveServiceId();
  if (!sid) throw new Error('could not resolve Render service id (set RENDER_SERVICE_ID).');
  if (onStep) onStep(`🚀 triggering Render deploy for ${sid}…`);
  const body = clearCache ? { clearCache: 'clear' } : {};
  const r = await render(`/services/${sid}/deploys`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json._raw)) || `HTTP ${r.status}`;
    throw new Error(`Render deploy trigger failed: ${msg}`);
  }
  return {
    deployId: r.json.id || (r.json.deploy && r.json.deploy.id) || '',
    serviceId: sid,
    dashboardUrl: `https://dashboard.render.com/web/${sid}`,
  };
}

module.exports = {
  gitEnabled, renderEnabled,
  pushFiles, triggerRenderDeploy, resolveServiceId, setEnvVar,
  repoSlug, branch, ownerRepo,
};
