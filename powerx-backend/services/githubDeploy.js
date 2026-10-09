// ─────────────────────────────────────────────────────────────────────────────
// githubDeploy.js — Commit a set of files to a SINGLE, HARD-LOCKED GitHub repo.
//
// SECURITY: This module can ONLY ever push to Arinze-eng/urlpower on the `main`
// branch. The owner/repo/branch are constants and are NOT taken from the
// caller, so the agent can never be tricked into pushing to any other repo.
//
// It uses the GitHub Git Data API (blobs → tree → commit → update ref) so it
// can commit MANY files in ONE atomic commit, creating or updating them.
//
// The token comes ONLY from env: GITHUB_DEPLOY_TOKEN (never hardcoded).
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

// ── HARD LOCK — do not parameterise these. ──
const OWNER = 'Arinze-eng';
const REPO = 'urlpower';
const BRANCH = 'main';

const GH_API = 'https://api.github.com';

function getToken() {
  return process.env.GITHUB_DEPLOY_TOKEN || '';
}

function enabled() {
  return !!getToken();
}

async function gh(pathname, opts = {}, token) {
  const r = await fetch(`${GH_API}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'urlpower-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

/**
 * Commit files to Arinze-eng/urlpower @ main.
 *
 * @param {object} opts
 *   - files:    array of { rel, buffer }  (rel = path inside the repo).
 *   - message:  optional commit message.
 *   - onStep:   optional progress callback.
 * @returns { commitUrl, htmlUrl, pagesUrl, repo, branch, fileCount }
 */
async function deploy({ files, message, onStep }) {
  const token = getToken();
  if (!token) throw new Error('GitHub deploy not configured (set GITHUB_DEPLOY_TOKEN).');
  if (!Array.isArray(files) || !files.length) throw new Error('no files to commit.');

  if (onStep) onStep(`🐙 committing ${files.length} file(s) to ${OWNER}/${REPO}@${BRANCH}…`);

  // 1) Resolve the branch ref → latest commit sha → base tree sha.
  let baseTreeSha = null;
  let parentCommitSha = null;
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`, { method: 'GET' }, token);
  if (ref.ok && ref.json && ref.json.object) {
    parentCommitSha = ref.json.object.sha;
    const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${parentCommitSha}`, { method: 'GET' }, token);
    if (commit.ok) baseTreeSha = commit.json.tree.sha;
  } else if (ref.status === 404 || ref.status === 409) {
    // Empty repo / branch doesn't exist yet → we'll create the first commit
    // with no parent and no base tree.
    parentCommitSha = null;
    baseTreeSha = null;
  } else {
    const msg = ref.json && ref.json.message ? ref.json.message : `HTTP ${ref.status}`;
    throw new Error(`could not read repo ref: ${msg} (check token has 'repo'/'contents:write' access to ${OWNER}/${REPO})`);
  }

  // 2) Create a blob for each file.
  const tree = [];
  for (const f of files) {
    const rel = String(f.rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) continue;
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.buffer.toString('base64'), encoding: 'base64' }),
    }, token);
    if (!blob.ok) {
      const msg = blob.json && blob.json.message ? blob.json.message : `HTTP ${blob.status}`;
      throw new Error(`blob create failed for ${rel}: ${msg}`);
    }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
  }

  // 3) Create a tree (based on the existing one so untouched files survive).
  const treeBody = { tree };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;
  const newTree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(treeBody),
  }, token);
  if (!newTree.ok) {
    const msg = newTree.json && newTree.json.message ? newTree.json.message : `HTTP ${newTree.status}`;
    throw new Error(`tree create failed: ${msg}`);
  }

  // 4) Create the commit.
  const commitBody = {
    message: message || `Deploy from agent — ${new Date().toISOString()}`,
    tree: newTree.json.sha,
  };
  if (parentCommitSha) commitBody.parents = [parentCommitSha];
  const newCommit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commitBody),
  }, token);
  if (!newCommit.ok) {
    const msg = newCommit.json && newCommit.json.message ? newCommit.json.message : `HTTP ${newCommit.status}`;
    throw new Error(`commit create failed: ${msg}`);
  }

  // 5) Update (or create) the branch ref to point at the new commit.
  let upd = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.json.sha, force: false }),
  }, token);
  if (!upd.ok && (upd.status === 404 || upd.status === 422)) {
    // Branch ref didn't exist → create it.
    upd = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: newCommit.json.sha }),
    }, token);
  }
  if (!upd.ok) {
    const msg = upd.json && upd.json.message ? upd.json.message : `HTTP ${upd.status}`;
    throw new Error(`ref update failed: ${msg}`);
  }

  return {
    commitSha: newCommit.json.sha,
    commitUrl: newCommit.json.html_url || `https://github.com/${OWNER}/${REPO}/commit/${newCommit.json.sha}`,
    htmlUrl: `https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`,
    pagesUrl: `https://${OWNER.toLowerCase()}.github.io/${REPO}/`,
    repo: `${OWNER}/${REPO}`,
    branch: BRANCH,
    fileCount: tree.length,
  };
}

module.exports = { deploy, enabled, OWNER, REPO, BRANCH };
