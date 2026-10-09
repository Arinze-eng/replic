'use strict';

// Generic GitHub repository + Actions automation used by the coding agent.
// Secrets are resolved on the host and never copied into a sandbox or command.
// The sandbox agent reaches these operations through its authenticated host
// bridge, so Novita, Runloop, Upstash Box, and Daytona behave identically.

const fetchDefault = require('node-fetch');
const crypto = require('crypto');
let fetchImpl = fetchDefault;
let db = null;
try { db = require('../db'); } catch (_) {}

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function resolveToken() {
  const env = process.env.GITHUB_DEPLOY_TOKEN || process.env.GITHUB_ACTIONS_TOKEN || process.env.GITHUB_TOKEN || '';
  if (env.trim()) return env.trim();
  try {
    if (db && db.getSetting) {
      for (const key of ['github_deploy_token', 'github_actions_api_key', 'github_token']) {
        const value = await db.getSetting(key);
        if (value && String(value).trim()) return String(value).trim();
      }
    }
  } catch (_) {}
  return '';
}

function normalizeRepo(value) {
  let repo = String(value || '').trim();
  repo = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_.-]+$/.test(p))) {
    throw new Error('repository must be owner/name or a GitHub repository URL');
  }
  return parts.join('/');
}

async function request(pathname, options = {}, controls = {}) {
  const token = controls.token || await resolveToken();
  if (!token) throw new Error('GitHub token is not configured');
  const timeout = Math.max(1000, Number(controls.timeout || 60000));
  const response = await fetchImpl(pathname.startsWith('http') ? pathname : `${API}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: controls.accept || 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'powerx-coding-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (controls.raw) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${bytes.toString('utf8').slice(0, 300)}`);
    return bytes;
  }
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { _raw: text }; }
  return { ok: response.ok, status: response.status, body, headers: response.headers };
}

function apiError(label, response) {
  const message = response && response.body && (response.body.message || response.body._raw);
  return new Error(`${label}: ${message || `GitHub HTTP ${response ? response.status : 0}`}`);
}

async function repoInfo(repo) {
  repo = normalizeRepo(repo);
  const r = await request(`/repos/${repo}`);
  if (!r.ok) throw apiError(`cannot access ${repo}`, r);
  return r.body;
}

async function head(repo, branch) {
  const r = await request(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (r.ok && r.body.object) return r.body.object.sha;
  if (r.status === 404 || r.status === 409) return null;
  throw apiError(`cannot read ${repo}@${branch}`, r);
}

async function pushFiles({ repo, branch, files, message }) {
  repo = normalizeRepo(repo);
  const info = await repoInfo(repo);
  branch = String(branch || info.default_branch || 'main').trim();
  const clean = (files || []).map(file => ({
    path: String(file.rel || file.path || '').replace(/\\/g, '/').replace(/^\.?\/+/, ''),
    buffer: Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || file.content || ''),
  })).filter(file => file.path && !file.path.includes('..'));
  if (!clean.length) throw new Error('no files supplied for GitHub push');

  // Blobs are content-addressed and can be reused while retrying a concurrent
  // branch update. Upload them once, then rebuild the tree on the fresh head.
  const entries = [];
  for (const file of clean) {
    const r = await request(`/repos/${repo}/git/blobs`, {
      method: 'POST', body: JSON.stringify({ content: file.buffer.toString('base64'), encoding: 'base64' }),
    });
    if (!r.ok) throw apiError(`cannot upload ${file.path}`, r);
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: r.body.sha });
  }

  const attempts = Math.max(1, Number(process.env.GITHUB_PUSH_RETRIES || 6));
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const parent = await head(repo, branch);
    let baseTree = null;
    if (parent) {
      const c = await request(`/repos/${repo}/git/commits/${parent}`);
      if (!c.ok) throw apiError('cannot read parent commit', c);
      baseTree = c.body.tree.sha;
    }
    const tree = await request(`/repos/${repo}/git/trees`, {
      method: 'POST', body: JSON.stringify(baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries }),
    });
    if (!tree.ok) throw apiError('cannot create git tree', tree);
    const commitBody = { message: message || `PowerX coding agent update ${new Date().toISOString()}`, tree: tree.body.sha };
    if (parent) commitBody.parents = [parent];
    const commit = await request(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify(commitBody) });
    if (!commit.ok) throw apiError('cannot create commit', commit);
    const update = parent
      ? await request(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.body.sha, force: false }) })
      : await request(`/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.body.sha }) });
    if (update.ok) return { repo, branch, sha: commit.body.sha, files: entries.length, url: `https://github.com/${repo}/commit/${commit.body.sha}` };
    if (update.status !== 422) throw apiError('cannot update branch', update);
    last = update.body.message || 'branch moved concurrently';
    await sleep(250 * attempt);
  }
  throw new Error(`GitHub push conflicted after retries: ${last}`);
}

function defaultFlutterWorkflow({ projectDir = '.', artifactName = 'app-release-apk' } = {}) {
  const dir = String(projectDir || '.').replace(/^\.?\/+|\/+$/g, '') || '.';
  return `name: Build Android APK\nrun-name: APK build \${{ github.sha }}\non:\n  workflow_dispatch:\n  push:\n    branches: [main]\npermissions:\n  contents: read\njobs:\n  build-apk:\n    runs-on: ubuntu-latest\n    timeout-minutes: 45\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: '17'\n      - uses: subosito/flutter-action@v2\n        with:\n          channel: stable\n          cache: true\n      - name: Resolve dependencies\n        working-directory: ${dir}\n        run: flutter pub get\n      - name: Analyze\n        working-directory: ${dir}\n        run: flutter analyze --no-fatal-infos --no-fatal-warnings\n      - name: Test\n        working-directory: ${dir}\n        run: flutter test\n      - name: Build release APK\n        working-directory: ${dir}\n        run: flutter build apk --release\n      - name: Validate APK\n        run: |\n          APK=$(find ${dir}/build/app/outputs/flutter-apk -name '*release*.apk' -type f | head -1)\n          test -n "$APK" && test -s "$APK"\n          echo "apk=$APK" >> "$GITHUB_ENV"\n          sha256sum "$APK"\n      - uses: actions/upload-artifact@v4\n        with:\n          name: ${artifactName}\n          path: \${{ env.apk }}\n          if-no-files-found: error\n          retention-days: 14\n`;
}

async function ensureFlutterWorkflow({ repo, branch, workflow = 'build-apk.yml', projectDir = '.', artifactName }) {
  const rel = `.github/workflows/${String(workflow).replace(/^.*\//, '').replace(/[^A-Za-z0-9_.-]/g, '-')}`;
  const content = defaultFlutterWorkflow({ projectDir, artifactName });
  return pushFiles({ repo, branch, files: [{ rel, buffer: Buffer.from(content) }], message: 'ci: configure verified Flutter APK build' });
}

async function listWorkflows(repo) {
  repo = normalizeRepo(repo);
  const r = await request(`/repos/${repo}/actions/workflows?per_page=100`);
  if (!r.ok) throw apiError('cannot list workflows', r);
  return r.body.workflows || [];
}

async function resolveWorkflow(repo, workflow) {
  if (workflow) return workflow;
  const workflows = await listWorkflows(repo);
  const found = workflows.find(w => /apk|flutter|android/i.test(`${w.name} ${w.path}`)) || workflows.find(w => /build/i.test(w.name));
  if (!found) throw new Error('no APK/Flutter build workflow found');
  return found.id;
}

async function dispatchWorkflow({ repo, branch, workflow, inputs = {} }) {
  repo = normalizeRepo(repo);
  const info = await repoInfo(repo);
  branch = branch || info.default_branch || 'main';
  workflow = await resolveWorkflow(repo, workflow);
  const before = Date.now();
  const correlation = crypto.randomBytes(6).toString('hex');
  const r = await request(`/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST', body: JSON.stringify({ ref: branch, ...(Object.keys(inputs || {}).length ? { inputs } : {}) }),
  });
  if (!r.ok) throw apiError('workflow dispatch failed', r);
  return { repo, branch, workflow, dispatchedAt: before, correlation };
}

async function findDispatchedRun(dispatch, { timeoutSeconds = 120, pollSeconds = 4 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const r = await request(`/repos/${dispatch.repo}/actions/workflows/${encodeURIComponent(dispatch.workflow)}/runs?event=workflow_dispatch&branch=${encodeURIComponent(dispatch.branch)}&per_page=20`);
    if (r.ok) {
      const candidates = (r.body.workflow_runs || []).filter(run => new Date(run.created_at).getTime() >= dispatch.dispatchedAt - 15000);
      if (candidates.length) return candidates[0];
    }
    await sleep(pollSeconds * 1000);
  }
  throw new Error('could not locate the dispatched workflow run');
}

async function runStatus(repo, runId) {
  repo = normalizeRepo(repo);
  const r = await request(`/repos/${repo}/actions/runs/${runId}`);
  if (!r.ok) throw apiError(`cannot read run ${runId}`, r);
  return r.body;
}

async function failureDiagnostics(repo, runId) {
  repo = normalizeRepo(repo);
  const jobsR = await request(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  if (!jobsR.ok) throw apiError('cannot read workflow jobs', jobsR);
  const failed = (jobsR.body.jobs || []).filter(j => j.conclusion === 'failure');
  const diagnostics = [];
  for (const job of failed) {
    const step = (job.steps || []).find(s => s.conclusion === 'failure');
    let log = '';
    try {
      const raw = await request(`/repos/${repo}/actions/jobs/${job.id}/logs`, {}, { raw: true, timeout: 120000 });
      log = raw.toString('utf8').split('\n').slice(-120).join('\n');
    } catch (e) { log = `log unavailable: ${e.message}`; }
    diagnostics.push({ job: job.name, step: step ? step.name : 'unknown', log: log.slice(-16000), url: job.html_url });
  }
  return diagnostics;
}

async function artifacts(repo, runId, { download = false } = {}) {
  repo = normalizeRepo(repo);
  const r = await request(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!r.ok) throw apiError('cannot list artifacts', r);
  const out = [];
  for (const item of (r.body.artifacts || [])) {
    const record = { id: item.id, name: item.name, size: item.size_in_bytes, expired: item.expired, url: item.archive_download_url };
    if (download && !item.expired) record.buffer = await request(`/repos/${repo}/actions/artifacts/${item.id}/zip`, {}, { raw: true, timeout: 180000 });
    out.push(record);
  }
  return out;
}

function zipContainsApk(buffer) {
  const data = Buffer.from(buffer || []);
  // GitHub uses ZIP data descriptors, ZIP64, or ordinary local headers
  // depending on artifact size. Use the installed archive reader first so
  // validation works for every encoding, then retain a no-dependency fallback.
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(data);
    return zip.getEntries().some(entry => !entry.isDirectory && /\.apk$/i.test(entry.entryName) && entry.header.size > 0);
  } catch (_) {}
  let offset = 0;
  while (offset + 30 <= data.length) {
    if (data.readUInt32LE(offset) !== 0x04034b50) { offset++; continue; }
    const compressedSize = data.readUInt32LE(offset + 18);
    const uncompressedSize = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = data.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (/\.apk$/i.test(name) && (compressedSize > 0 || uncompressedSize > 0)) return true;
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return false;
}

async function watchRun({ repo, runId, maxWaitSeconds = 2700, pollSeconds = 15, onPoll }) {
  const deadline = Date.now() + Math.max(30, Math.min(Number(maxWaitSeconds) || 2700, 6 * 60 * 60)) * 1000;
  const interval = Math.max(2, Math.min(Number(pollSeconds) || 15, 60));
  const maxPollErrors = Math.max(1, Number(process.env.GITHUB_MONITOR_MAX_POLL_ERRORS || 8));
  let run = null;
  let consecutiveErrors = 0;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      run = await runStatus(repo, runId);
      consecutiveErrors = 0;
      lastError = null;
      if (onPoll) await onPoll(run);
      if (run.status === 'completed') break;
    } catch (error) {
      lastError = error;
      consecutiveErrors++;
      // GitHub and Render occasionally reset a polling request. Treat those as
      // temporary monitor noise, not as an APK build failure. Only stop after a
      // sustained outage; callers still receive the existing run state.
      if (onPoll) await onPoll({ id: runId, status: (run && run.status) || 'unknown', pollError: error.message, retry: consecutiveErrors });
      if (consecutiveErrors >= maxPollErrors) {
        return { ok: false, monitorFailed: true, run, error: `workflow monitor failed after ${consecutiveErrors} consecutive polling errors: ${error.message}` };
      }
    }
    await sleep(Math.min(interval * (1 + consecutiveErrors * 0.5), 60) * 1000);
  }
  if (!run || run.status !== 'completed') return { ok: false, timedOut: true, run, error: lastError && lastError.message };
  if (run.conclusion === 'success') {
    const built = await artifacts(repo, runId, { download: true });
    const apkEvidence = built.filter(a => a.buffer && zipContainsApk(a.buffer));
    return { ok: apkEvidence.length > 0, run, artifacts: built, apkArtifacts: apkEvidence,
      error: apkEvidence.length ? null : 'workflow succeeded but no downloaded artifact contained a non-empty .apk file' };
  }
  return { ok: false, run, diagnostics: await failureDiagnostics(repo, runId) };
}

async function dispatchAndWatch(args) {
  const dispatch = await dispatchWorkflow(args);
  const run = await findDispatchedRun(dispatch, args);
  return watchRun({ ...args, repo: dispatch.repo, runId: run.id });
}

function __setFetchForTests(fn) { fetchImpl = fn || fetchDefault; }

module.exports = {
  normalizeRepo, resolveToken, request, repoInfo, pushFiles,
  defaultFlutterWorkflow, ensureFlutterWorkflow,
  listWorkflows, dispatchWorkflow, findDispatchedRun, runStatus,
  failureDiagnostics, artifacts, watchRun, dispatchAndWatch,
  __setFetchForTests,
};
