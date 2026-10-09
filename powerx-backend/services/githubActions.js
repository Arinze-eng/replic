// ─────────────────────────────────────────────────────────────────────────────
// githubActions.js — GitHub Actions as a REAL Linux sandbox backend.
//
// WHY: GitHub-hosted runners (`ubuntu-latest`) are full Ubuntu boxes with root
// (passwordless sudo), python3, node, git, curl, docker, apt, pip, npm, gcc …
// This backend lets the WormGPT/PowerX agent "own the computer" using GitHub's
// free CI minutes: it commits the agent's command + working files into a
// dedicated path of a repo, dispatches a workflow that runs the command on a
// runner, streams the runner's stdout back, and downloads any files the command
// produced as REAL workflow ARTIFACTS (the deliverables).
//
// It implements the SAME backend-agnostic interface as daytona/hopx/runloop so
// it drops straight into agentEngine's SANDBOX_BACKENDS cascade, the MoE
// sandboxPool, and sandboxAgent's owns-the-computer worker:
//
//   enabled(), enabledAsync(), testKey()
//   createSandbox(), deleteSandbox(), getSandboxState(), startSandbox()
//   getOrCreateSessionSandbox(), endSession(), getSessionSandboxId()
//   exec(id, command, {cwd, timeout}) -> { exitCode, output }
//   uploadFile(id, dest, buffer), downloadFile(id, src), listFiles(id, dir)
//   dockerSetup(id), dockerRun(id, args)   (docker IS preinstalled on runners)
//   WORKDIR
//
// AUTH (runtime DB → env, admin-settable, no restart needed):
//   github_actions_api_key / GITHUB_ACTIONS_TOKEN  (a `ghp_...` PAT, `repo`+`workflow` scope)
//   github_actions_repo    / GITHUB_ACTIONS_REPO   ("owner/name", the runner repo)
//   github_actions_branch  / GITHUB_ACTIONS_BRANCH (default "main")
//
// The repo is the "machine": each sandbox is a namespaced folder `.sandbox/<id>/`
// whose `work/` subtree PERSISTS across turns (files survive in git), giving the
// same "disk survives between sessions" semantics as the other backends.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const crypto = require('crypto');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

const GH_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
// Where the agent works inside the runner (mirrors the repo's .sandbox/<id>/work).
const WORKDIR = '/home/runner/work/sandbox/work';
// The workflow file we install once in the runner repo.
const WORKFLOW_PATH = '.github/workflows/powerx-sandbox.yml';
const WORKFLOW_FILE = 'powerx-sandbox.yml';
const SANDBOX_ROOT = '.sandbox';

// ── Runtime config resolution (DB setting → env), short cache ────────────────
const CFG_TTL = 15000;
let _keyCache = { value: undefined, ts: 0 };
let _repoCache = { value: undefined, ts: 0 };
let _branchCache = { value: undefined, ts: 0 };

function envKey() {
  return (process.env.GITHUB_ACTIONS_TOKEN || process.env.GITHUB_ACTIONS_API_KEY || '').trim();
}
function envRepo() { return (process.env.GITHUB_ACTIONS_REPO || '').trim(); }
function envBranch() { return (process.env.GITHUB_ACTIONS_BRANCH || 'main').trim(); }

function getApiKeySync() {
  if (_keyCache.value !== undefined && Date.now() - _keyCache.ts < CFG_TTL) {
    return _keyCache.value || envKey();
  }
  return envKey();
}

async function getApiKey() {
  const now = Date.now();
  if (_keyCache.value !== undefined && now - _keyCache.ts < CFG_TTL) {
    return _keyCache.value || envKey();
  }
  let runtime = '';
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting('github_actions_api_key');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _keyCache = { value: runtime, ts: now };
  return runtime || envKey();
}

async function getRepo() {
  const now = Date.now();
  if (_repoCache.value !== undefined && now - _repoCache.ts < CFG_TTL) {
    return _repoCache.value || envRepo();
  }
  let runtime = '';
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting('github_actions_repo');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _repoCache = { value: runtime, ts: now };
  return runtime || envRepo();
}

async function getBranch() {
  const now = Date.now();
  if (_branchCache.value !== undefined && now - _branchCache.ts < CFG_TTL) {
    return _branchCache.value || envBranch();
  }
  let runtime = '';
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting('github_actions_branch');
      if (v && v.trim()) runtime = v.trim();
    }
  } catch (_) {}
  _branchCache = { value: runtime, ts: now };
  return runtime || envBranch();
}

function invalidateKeyCache() {
  _keyCache = { value: undefined, ts: 0 };
  _repoCache = { value: undefined, ts: 0 };
  _branchCache = { value: undefined, ts: 0 };
}

// Enabled when BOTH a token AND a target repo are configured (env or runtime).
function enabled() {
  if (db && db.getSetting && Date.now() - _keyCache.ts >= CFG_TTL) {
    getApiKey().catch(() => {});
    getRepo().catch(() => {});
  }
  const key = getApiKeySync() || _keyCache.value;
  const repo = (_repoCache.value !== undefined ? _repoCache.value : '') || envRepo();
  return !!(key && repo);
}

async function enabledAsync() {
  const key = await getApiKey();
  const repo = await getRepo();
  return !!(key && repo);
}

// ── HTTP helper against the GitHub REST API ──────────────────────────────────
async function gh(pathname, opts = {}, { apiKey, timeout = 60000, raw = false } = {}) {
  const token = (apiKey && apiKey.trim()) || (await getApiKey());
  if (!token) throw new Error('GITHUB_ACTIONS_TOKEN not set');
  const url = pathname.startsWith('http') ? pathname : `${GH_API}${pathname}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'powerx-agent',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(timeout),
    redirect: raw ? 'follow' : 'follow',
  });
  if (raw) {
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`GitHub ${opts.method || 'GET'} ${pathname} → ${r.status}: ${t.slice(0, 200)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { _raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

function repoParts(repo) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) throw new Error(`Invalid github_actions_repo "${repo}" (expected "owner/name")`);
  return { owner, name };
}

// ── Explicit connectivity test for the admin "Test" button (never throws). ───
async function testKey(overrideKey, overrideRepo) {
  const key = (overrideKey && overrideKey.trim()) || (await getApiKey());
  if (!key) return { ok: false, status: 0, message: 'No GitHub Actions token configured.' };
  const repo = (overrideRepo && overrideRepo.trim()) || (await getRepo());
  const started = Date.now();
  try {
    // 1) Validate the token identity.
    const who = await gh('/user', { method: 'GET' }, { apiKey: key, timeout: 20000 });
    if (!who.ok) {
      const ms = Date.now() - started;
      if (who.status === 401) return { ok: false, status: 401, ms, message: '❌ Invalid or unauthorized GitHub token (401).' };
      return { ok: false, status: who.status, ms, message: `❌ GitHub returned HTTP ${who.status}.` };
    }
    const login = who.json && who.json.login ? who.json.login : 'unknown';
    if (!repo) {
      const ms = Date.now() - started;
      return { ok: true, status: 200, ms, message: `✅ Token valid (user @${login}) in ${ms}ms — but NO runner repo set. Add "owner/name" in the Repo field so the agent has a machine to run on.` };
    }
    // 2) Validate repo access + Actions availability.
    const { owner, name } = repoParts(repo);
    const rp = await gh(`/repos/${owner}/${name}`, { method: 'GET' }, { apiKey: key, timeout: 20000 });
    const ms = Date.now() - started;
    if (!rp.ok) {
      if (rp.status === 404) return { ok: false, status: 404, ms, message: `❌ Repo "${repo}" not found or token has no access to it.` };
      return { ok: false, status: rp.status, ms, message: `❌ Cannot read repo "${repo}" (HTTP ${rp.status}).` };
    }
    const perms = (rp.json && rp.json.permissions) || {};
    if (!perms.push && !perms.admin) {
      return { ok: false, status: 403, ms, message: `❌ Token can read "${repo}" but has NO write access — GitHub Actions sandbox needs push+workflow scope.` };
    }
    return { ok: true, status: 200, ms, message: `✅ Working — GitHub Actions ready on ${repo} as @${login} (write access confirmed) in ${ms}ms.` };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Could not reach GitHub: ${e.message}` };
  }
}

// ── Git Data helpers: read/commit files in the runner repo ───────────────────

async function getRefSha(owner, name, branch) {
  const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`, { method: 'GET' });
  if (ref.ok && ref.json && ref.json.object) return ref.json.object.sha;
  return null;
}

// Commit a set of {rel, buffer} files to `branch` in ONE atomic commit.
//
// Robust against CONCURRENT writers (multiple bot tasks share the same runner
// repo): if the ref moved between reading HEAD and updating it, GitHub rejects
// the non-fast-forward PATCH with 422. The old code then tried to CREATE the
// ref and failed with "Reference already exists". We now RETRY: re-read HEAD,
// rebuild the tree/commit on the fresh parent, and PATCH again. Blobs are
// uploaded once (content-addressed, so they're safe to reuse across retries).
async function commitFiles(owner, name, branch, files, message) {
  // 1) Upload every blob once (SHA is content-addressed, retry-safe).
  const blobs = [];
  for (const f of files) {
    const rel = String(f.rel).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel) continue;
    const blob = await gh(`/repos/${owner}/${name}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: Buffer.from(f.buffer).toString('base64'), encoding: 'base64' }),
    });
    if (!blob.ok) throw new Error(`blob create failed for ${rel}: ${(blob.json && blob.json.message) || blob.status}`);
    blobs.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
  }

  const MAX_TRIES = parseInt(process.env.GHA_COMMIT_RETRIES || '6', 10);
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    // 2) Read the CURRENT HEAD (fresh each attempt so we rebase onto any
    //    concurrent commit instead of clobbering / conflicting with it).
    const parentCommitSha = await getRefSha(owner, name, branch);
    let baseTreeSha = null;
    if (parentCommitSha) {
      const commit = await gh(`/repos/${owner}/${name}/git/commits/${parentCommitSha}`, { method: 'GET' });
      if (commit.ok) baseTreeSha = commit.json.tree.sha;
    }

    // 3) Build the tree on top of the current base.
    const treeBody = { tree: blobs };
    if (baseTreeSha) treeBody.base_tree = baseTreeSha;
    const newTree = await gh(`/repos/${owner}/${name}/git/trees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(treeBody),
    });
    if (!newTree.ok) throw new Error(`tree create failed: ${(newTree.json && newTree.json.message) || newTree.status}`);

    // 4) Create the commit pointing at the current parent.
    const commitBody = { message: message || `sandbox commit ${new Date().toISOString()}`, tree: newTree.json.sha };
    if (parentCommitSha) commitBody.parents = [parentCommitSha];
    const newCommit = await gh(`/repos/${owner}/${name}/git/commits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(commitBody),
    });
    if (!newCommit.ok) throw new Error(`commit create failed: ${(newCommit.json && newCommit.json.message) || newCommit.status}`);

    // 5) Move the ref. Create it if it doesn't exist yet; on a fast-forward
    //    conflict (422 — another writer moved HEAD) retry the whole rebase.
    if (!parentCommitSha) {
      const create = await gh(`/repos/${owner}/${name}/git/refs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.json.sha }),
      });
      if (create.ok) return newCommit.json.sha;
      // Someone created it first → fall through to a PATCH-based retry.
      if (create.status !== 422) throw new Error(`ref create failed: ${(create.json && create.json.message) || create.status}`);
      lastErr = (create.json && create.json.message) || `HTTP ${create.status}`;
    } else {
      const upd = await gh(`/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.json.sha, force: false }),
      });
      if (upd.ok) return newCommit.json.sha;
      if (upd.status !== 422) throw new Error(`ref update failed: ${(upd.json && upd.json.message) || upd.status}`);
      lastErr = (upd.json && upd.json.message) || `HTTP ${upd.status}`;
    }

    // Conflict → brief jittered backoff, then rebuild on the new HEAD.
    await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
  }
  throw new Error(`ref update failed after ${MAX_TRIES} attempts (concurrent commits): ${lastErr}`);
}

// Read a single file's raw bytes from the repo (null if missing).
//
// Robust against two GitHub quirks that caused "file not found in sandbox"
// even when the file WAS committed by the workflow:
//   1) The `contents` API is served from a CDN and can be briefly STALE right
//      after the workflow's git push (eventual consistency) — we retry a few
//      times with a short backoff.
//   2) The `contents` API does NOT inline `content` for files >1 MB (it returns
//      the metadata only). For those we fall back to the Git Data blob API via
//      the file's blob SHA, which returns the full bytes and is immediately
//      consistent against the branch HEAD tree.
async function readRepoFile(owner, name, branch, relPath) {
  const encPath = relPath.split('/').map(encodeURIComponent).join('/');
  const RETRIES = parseInt(process.env.GHA_READ_RETRIES || '4', 10);
  const BACKOFF = parseInt(process.env.GHA_READ_BACKOFF_MS || '1500', 10);

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    // Cache-buster query param so the CDN doesn't hand us a stale 404/older blob.
    const bust = `&_ts=${Date.now()}`;
    const r = await gh(`/repos/${owner}/${name}/contents/${encPath}?ref=${encodeURIComponent(branch)}${bust}`, {
      method: 'GET', headers: { 'Cache-Control': 'no-cache' },
    });
    if (r.ok && r.json) {
      // Small file → content is inlined.
      if (r.json.content && r.json.encoding === 'base64') {
        return Buffer.from(r.json.content, 'base64');
      }
      // Large file (>1MB) → contents API omits content; use the blob SHA.
      if (r.json.sha) {
        try {
          const blob = await gh(`/repos/${owner}/${name}/git/blobs/${r.json.sha}`, { method: 'GET' }, { timeout: 120000 });
          if (blob.ok && blob.json && blob.json.content) {
            return Buffer.from(blob.json.content, blob.json.encoding || 'base64');
          }
        } catch (_) { /* fall through to tree lookup below */ }
      }
    }

    // Not found yet (or stale) → try resolving via the branch HEAD tree, which
    // is immediately consistent once the push lands.
    try {
      const headSha = await getRefSha(owner, name, branch);
      if (headSha) {
        const tree = await gh(`/repos/${owner}/${name}/git/trees/${headSha}?recursive=1&_ts=${Date.now()}`, { method: 'GET' });
        if (tree.ok && tree.json && Array.isArray(tree.json.tree)) {
          const want = relPath.replace(/^\.?\/+/, '');
          const node = tree.json.tree.find(t => t.type === 'blob' && t.path === want);
          if (node && node.sha) {
            const blob = await gh(`/repos/${owner}/${name}/git/blobs/${node.sha}`, { method: 'GET' }, { timeout: 120000 });
            if (blob.ok && blob.json && blob.json.content) {
              return Buffer.from(blob.json.content, blob.json.encoding || 'base64');
            }
          }
        }
      }
    } catch (_) { /* retry */ }

    // Wait for eventual consistency, then retry (skip the wait after the last).
    if (attempt < RETRIES) await new Promise(res => setTimeout(res, BACKOFF));
  }
  return null;
}

async function listRepoDir(owner, name, branch, relDir) {
  const r = await gh(`/repos/${owner}/${name}/contents/${relDir.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, { method: 'GET' });
  if (!r.ok || !Array.isArray(r.json)) return [];
  return r.json.map(e => ({ name: e.name, size: e.size || 0, isDir: e.type === 'dir', path: e.path }));
}

// ── The dispatcher workflow — installed ONCE per runner repo ─────────────────
// It reads a base64 command + a sandbox id from workflow_dispatch inputs,
// restores that sandbox's persisted work tree, runs the command as root, then
// commits the mutated work tree back and uploads it (plus a stdout log) as an
// artifact named `sbx-<id>-<run>` so the host can fetch the exit code, stdout,
// and any produced files.
function dispatcherWorkflowYaml() {
  return `# AUTO-GENERATED by PowerX — GitHub Actions sandbox dispatcher. Do not edit by hand.
name: PowerX Sandbox
run-name: PowerX Sandbox \${{ github.event.inputs.sandbox_id }} \${{ github.event.inputs.run_token }}
on:
  workflow_dispatch:
    inputs:
      sandbox_id:
        description: Sandbox id
        required: true
      cmd_b64:
        description: Base64 shell command
        required: true
      run_token:
        description: Correlation token
        required: true
      timeout_s:
        description: Command timeout (seconds)
        required: false
        default: "600"
permissions:
  contents: write
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Checkout runner repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
      - name: Prepare sandbox workspace
        id: prep
        run: |
          set -e
          SID="\${{ github.event.inputs.sandbox_id }}"
          echo "sid=$SID" >> "$GITHUB_OUTPUT"
          mkdir -p ".sandbox/$SID/work"
          echo "\${{ github.event.inputs.run_token }}" > ".sandbox/$SID/.run_token"
      - name: Execute agent command
        id: exec
        continue-on-error: true
        run: |
          SID="\${{ github.event.inputs.sandbox_id }}"
          TIMEOUT="\${{ github.event.inputs.timeout_s }}"
          cd ".sandbox/$SID/work"
          echo "\${{ github.event.inputs.cmd_b64 }}" | base64 -d > /tmp/_cmd.sh
          set +e
          timeout "\${TIMEOUT:-600}" sudo -E bash /tmp/_cmd.sh > /tmp/_stdout.log 2>&1
          CODE=$?
          set -e
          echo "exit_code=$CODE" >> "$GITHUB_OUTPUT"
          cp /tmp/_stdout.log "$GITHUB_WORKSPACE/.sandbox/$SID/.stdout.log" || true
          echo "$CODE" > "$GITHUB_WORKSPACE/.sandbox/$SID/.exit_code"
      - name: Persist sandbox work tree
        run: |
          SID="\${{ github.event.inputs.sandbox_id }}"
          git config user.name "powerx-sandbox[bot]"
          git config user.email "powerx-sandbox@users.noreply.github.com"
          git add -A ".sandbox/$SID" || true
          git commit -m "sandbox $SID run \${{ github.event.inputs.run_token }}" || echo "nothing to commit"
          for i in 1 2 3 4 5; do
            git pull --rebase --autostash origin "\${{ github.ref_name }}" || true
            if git push origin "HEAD:\${{ github.ref_name }}"; then break; fi
            sleep 3
          done
      - name: Upload sandbox artifact
        uses: actions/upload-artifact@v4
        continue-on-error: true
        with:
          name: sbx-\${{ github.event.inputs.sandbox_id }}-\${{ github.event.inputs.run_token }}
          path: |
            .sandbox/\${{ github.event.inputs.sandbox_id }}/.stdout.log
            .sandbox/\${{ github.event.inputs.sandbox_id }}/.exit_code
            .sandbox/\${{ github.event.inputs.sandbox_id }}/work
          if-no-files-found: warn
          retention-days: 7
`;
}

// Ensure the dispatcher workflow exists in the runner repo (idempotent).
async function ensureWorkflow(owner, name, branch) {
  const existing = await readRepoFile(owner, name, branch, WORKFLOW_PATH);
  const desired = dispatcherWorkflowYaml();
  if (existing && existing.toString('utf-8').trim() === desired.trim()) return;
  await commitFiles(owner, name, branch, [{ rel: WORKFLOW_PATH, buffer: Buffer.from(desired, 'utf-8') }], 'PowerX: install sandbox dispatcher workflow');
  // Give GitHub a moment to register the new workflow before we dispatch it.
  await new Promise(r => setTimeout(r, 4000));
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
// A "sandbox" is a namespaced folder in the runner repo. Creating it installs
// the workflow (once) and seeds an empty work tree. The disk (work tree) is git,
// so it persists across turns exactly like the other backends' preserved disks.
async function createSandbox({ labels = {} } = {}) {
  const repo = await getRepo();
  if (!repo) throw new Error('github_actions_repo not set');
  if (!(await getApiKey())) throw new Error('GITHUB_ACTIONS_TOKEN not set');
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  await ensureWorkflow(owner, name, branch);
  const id = (labels.session ? 's-' + crypto.createHash('sha1').update(String(labels.session)).digest('hex').slice(0, 12)
                             : 'sb-' + crypto.randomBytes(6).toString('hex'));
  // Seed the work tree with a keep file so the folder exists in git.
  await commitFiles(owner, name, branch, [
    { rel: `${SANDBOX_ROOT}/${id}/work/.keep`, buffer: Buffer.from('', 'utf-8') },
    { rel: `${SANDBOX_ROOT}/${id}/.created`, buffer: Buffer.from(new Date().toISOString(), 'utf-8') },
  ], `PowerX: create sandbox ${id}`);
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  try {
    const repo = await getRepo(); if (!repo) return;
    const { owner, name } = repoParts(repo);
    const branch = await getBranch();
    // Mark it destroyed (we don't hard-delete git history; a tombstone is enough).
    await commitFiles(owner, name, branch, [
      { rel: `${SANDBOX_ROOT}/${id}/.destroyed`, buffer: Buffer.from(new Date().toISOString(), 'utf-8') },
    ], `PowerX: destroy sandbox ${id}`);
  } catch (_) { /* best-effort */ }
}

async function getSandboxState(id) {
  if (!id) return null;
  try {
    const repo = await getRepo(); if (!repo) return null;
    const { owner, name } = repoParts(repo);
    const branch = await getBranch();
    const gone = await readRepoFile(owner, name, branch, `${SANDBOX_ROOT}/${id}/.destroyed`);
    if (gone) return 'destroyed';
    const created = await readRepoFile(owner, name, branch, `${SANDBOX_ROOT}/${id}/.created`);
    return created ? 'started' : null;
  } catch (_) { return null; }
}

// GitHub runners are always "on demand" — nothing to start; existence == started.
async function startSandbox(id) {
  const s = await getSandboxState(id);
  return s === 'started';
}

// ── Persistent session → sandbox mapping (survives restarts via settings). ───
const SESSION_PREFIX = 'gha_sbx_session:';
function _sessionSettingKey(k) { return SESSION_PREFIX + String(k); }
async function _readSessionId(k) {
  if (!db || !db.getSetting) return null;
  try { const v = await db.getSetting(_sessionSettingKey(k)); return (v && v.trim()) || null; } catch (_) { return null; }
}
async function _writeSessionId(k, id) {
  if (!db || !db.setSetting) return;
  try { await db.setSetting(_sessionSettingKey(k), id || ''); } catch (_) {}
}
async function getSessionSandboxId(sessionKey) { return _readSessionId(sessionKey); }

async function getOrCreateSessionSandbox(sessionKey, { labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ labels });
    return { id, reused: false };
  }
  const existing = await _readSessionId(sessionKey);
  if (existing) {
    const state = await getSandboxState(existing);
    if (state === 'started') return { id: existing, reused: true };
    await _writeSessionId(sessionKey, '');
  }
  const id = await createSandbox({ labels: { session: String(sessionKey), ...labels } });
  await _writeSessionId(sessionKey, id);
  return { id, reused: false };
}

async function endSession(sessionKey) {
  if (!sessionKey) return;
  const existing = await _readSessionId(sessionKey);
  if (existing) await deleteSandbox(existing);
  await _writeSessionId(sessionKey, '');
}

// ── Process execution: dispatch a workflow run and stream the result back ────

async function _findWorkflowId(owner, name) {
  const wf = await gh(`/repos/${owner}/${name}/actions/workflows`, { method: 'GET' });
  if (wf.ok && wf.json && Array.isArray(wf.json.workflows)) {
    const found = wf.json.workflows.find(w => (w.path || '').endsWith(WORKFLOW_FILE) || w.name === 'PowerX Sandbox');
    if (found) return found.id;
  }
  return WORKFLOW_FILE; // dispatch by filename also works
}

// Run a shell command inside a GitHub-hosted runner. Returns { exitCode, output }.
async function exec(id, command, { cwd, timeout = 600 } = {}) {
  if (!id) throw new Error('exec requires a sandbox id');
  const repo = await getRepo();
  if (!repo) throw new Error('github_actions_repo not set');
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  await ensureWorkflow(owner, name, branch);

  const full = cwd ? `cd '${String(cwd).replace(/'/g, `'\\''`)}' 2>/dev/null || true\n${command}` : command;
  const cmdB64 = Buffer.from(full, 'utf-8').toString('base64');
  const runToken = crypto.randomBytes(8).toString('hex');
  const workflowId = await _findWorkflowId(owner, name);
  const dispatchedAt = Date.now();

  const disp = await gh(`/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: branch, inputs: { sandbox_id: id, cmd_b64: cmdB64, run_token: runToken, timeout_s: String(timeout) } }),
  });
  if (!disp.ok) {
    throw new Error(`workflow dispatch failed: ${(disp.json && disp.json.message) || disp.status}`);
  }

  // HARD wall-clock ceiling so a queued/stuck run can NEVER hang the bot forever
  // (the old failure mode where "the AI hangs until an admin releases the
  // sandbox"). The job itself is bounded by `timeout` inside the runner; here we
  // add generous slack for GitHub's queue/startup, capped by GHA_HARD_CAP_MS.
  // GitHub-hosted jobs may run for up to six hours. Do not impose the previous
  // 20-minute host-side ceiling: monitoring, market analysis, dependency
  // installs, and large builds must be allowed to use the command's real
  // timeout budget. Operators can still lower GHA_HARD_CAP_MS explicitly.
  const HARD_CAP_MS = parseInt(process.env.GHA_HARD_CAP_MS || String(6 * 60 * 60 * 1000), 10);
  const deadline = Date.now() + Math.min((timeout + 300) * 1000, HARD_CAP_MS);

  // Locate the run created by THIS dispatch. Matching is STRICT on the unique
  // run_token (now embedded in the run-name / display_title) so a CONCURRENT
  // task's run is never mistaken for ours — the old loose "most recent run"
  // fallback could hand back another chat's output under load.
  let runId = null;
  while (Date.now() < deadline && !runId) {
    await new Promise(r => setTimeout(r, 4000));
    const runs = await gh(`/repos/${owner}/${name}/actions/runs?event=workflow_dispatch&per_page=30`, { method: 'GET' });
    if (runs.ok && runs.json && Array.isArray(runs.json.workflow_runs)) {
      const recent = runs.json.workflow_runs.filter(r => new Date(r.created_at).getTime() >= dispatchedAt - 20000);
      const exact = recent.find(r =>
        (r.display_title || '').includes(runToken) ||
        (r.name || '').includes(runToken) ||
        (r.run_name || '').includes(runToken));
      if (exact) { runId = exact.id; break; }
      // Only accept a time-based candidate when it is UNAMBIGUOUS: exactly one
      // dispatch run appeared in our window. Otherwise keep polling for the
      // token match instead of risking picking someone else's run.
      if (recent.length === 1) runId = recent[0].id;
    }
  }
  if (!runId) return { exitCode: 124, output: '(github-actions: could not locate dispatched run within the time budget — check the token has "workflow" scope, Actions is enabled on the repo, and the runner repo is not out of CI minutes)' };

  // Wait for the run to complete (bounded by the same hard deadline).
  let status = 'queued', conclusion = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const run = await gh(`/repos/${owner}/${name}/actions/runs/${runId}`, { method: 'GET' });
    if (run.ok && run.json) {
      status = run.json.status; conclusion = run.json.conclusion;
      if (status === 'completed') break;
    }
  }
  if (status !== 'completed') {
    // Best-effort cancel so a wedged run doesn't keep occupying the queue and
    // block the NEXT task (the "admin must release the sandbox" symptom).
    try { await gh(`/repos/${owner}/${name}/actions/runs/${runId}/cancel`, { method: 'POST' }, { timeout: 15000 }); } catch (_) {}
    return { exitCode: 124, output: `(github-actions: run ${runId} did not finish in the time budget and was cancelled — the task will continue on the host engine)` };
  }

  // Fetch the artifact holding stdout + exit code.
  const result = await _readRunResult(owner, name, runId, id, runToken);
  if (result) return result;

  // Fallback: read the persisted files straight from the repo (the workflow
  // commits .stdout.log/.exit_code back), then fall back to the raw job log.
  const stdout = await readRepoFile(owner, name, branch, `${SANDBOX_ROOT}/${id}/.stdout.log`);
  const codeBuf = await readRepoFile(owner, name, branch, `${SANDBOX_ROOT}/${id}/.exit_code`);
  if (stdout || codeBuf) {
    const code = codeBuf ? parseInt(codeBuf.toString('utf-8').trim(), 10) : (conclusion === 'success' ? 0 : 1);
    return { exitCode: Number.isFinite(code) ? code : 0, output: (stdout ? stdout.toString('utf-8') : '') };
  }
  const log = await _readJobLog(owner, name, runId);
  return { exitCode: conclusion === 'success' ? 0 : 1, output: log || '(no output captured)' };
}

// Download + parse the run's artifact zip → { exitCode, output }.
async function _readRunResult(owner, name, runId, sandboxId, runToken) {
  try {
    const arts = await gh(`/repos/${owner}/${name}/actions/runs/${runId}/artifacts`, { method: 'GET' });
    if (!arts.ok || !arts.json || !Array.isArray(arts.json.artifacts)) return null;
    const wanted = `sbx-${sandboxId}-${runToken}`;
    const art = arts.json.artifacts.find(a => a.name === wanted) || arts.json.artifacts[0];
    if (!art) return null;
    const zipBuf = await gh(`/repos/${owner}/${name}/actions/artifacts/${art.id}/zip`, { method: 'GET' }, { raw: true, timeout: 120000 });
    const files = _unzip(zipBuf);
    const stdout = files['.stdout.log'] || _findBySuffix(files, '.stdout.log');
    const codeRaw = files['.exit_code'] || _findBySuffix(files, '.exit_code');
    const code = codeRaw ? parseInt(codeRaw.toString('utf-8').trim(), 10) : 0;
    return { exitCode: Number.isFinite(code) ? code : 0, output: stdout ? stdout.toString('utf-8') : '' };
  } catch (_) { return null; }
}

// Read the raw job log text (fallback when no artifact).
async function _readJobLog(owner, name, runId) {
  try {
    const buf = await gh(`/repos/${owner}/${name}/actions/runs/${runId}/logs`, { method: 'GET' }, { raw: true, timeout: 120000 });
    const files = _unzip(buf);
    // Concatenate the "Execute agent command" step logs when present.
    let out = '';
    for (const [fn, content] of Object.entries(files)) {
      if (/exec|command|run/i.test(fn)) out += content.toString('utf-8') + '\n';
    }
    return (out || Object.values(files).map(b => b.toString('utf-8')).join('\n')).slice(-8000);
  } catch (_) { return ''; }
}

// ── File operations (via Git Data API on the runner repo work tree) ──────────
// Map ANY path the agent/host uses — an in-runner ABSOLUTE path
// (/home/runner/work/sandbox/work/foo.txt), a WORKDIR-relative path, or a bare
// filename — to the corresponding repo path .sandbox/<id>/work/<rel>.
//
// ⚠️ ORDER MATTERS: the in-runner absolute path starts with a leading "/", and
// WORKDIR also starts with "/". We MUST strip the WORKDIR prefix FIRST (while
// the leading slash is still present) — otherwise removing the leading slash
// first turns "/home/runner/.../work/foo" into "home/runner/.../work/foo",
// which no longer matches the "^/home/..." WORKDIR regex, so the prefix is left
// in place and the repo path becomes .sandbox/<id>/work/home/runner/.../foo —
// a path that does not exist → "file not found in sandbox". (Root cause of the
// data.csv delivery bug.)
function _workPath(id, dest) {
  let p = String(dest || '').replace(/\\/g, '/');
  // 1) Strip the in-runner WORKDIR prefix if present (before touching slashes).
  const wdEsc = WORKDIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  p = p.replace(new RegExp(`^${wdEsc}/?`), '');
  // 2) Also strip an already-mapped repo prefix, if the caller passed one.
  p = p.replace(new RegExp(`^\\.?/?${SANDBOX_ROOT}/${id}/work/?`), '');
  // 3) Now normalise: drop any leading "./" or "/".
  p = p.replace(/^\.?\/+/, '');
  // 4) A leading "work/" (some callers pass a WORKDIR-relative "work/foo") is
  //    redundant with the repo work root — collapse it.
  p = p.replace(/^work\//, '');
  return `${SANDBOX_ROOT}/${id}/work/${p}`.replace(/\/+/g, '/');
}

async function uploadFile(id, destPath, buffer) {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const rel = _workPath(id, destPath);
  await commitFiles(owner, name, branch, [{ rel, buffer: Buffer.from(buffer) }], `PowerX: upload ${rel}`);
  return destPath;
}

// Batch-upload MANY files in ONE atomic git commit. Staging N attachments (or
// extracting a ZIP into N files) used to be N sequential commits — each with a
// rebase/ref-race retry — which was slow and could clash. One commit is fast,
// atomic, and race-free. `files` = [{ dest, buffer }].
async function uploadFiles(id, files) {
  const list = (files || []).filter(f => f && f.dest != null && f.buffer != null);
  if (!list.length) return [];
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const commitSet = list.map(f => ({ rel: _workPath(id, f.dest), buffer: Buffer.from(f.buffer) }));
  await commitFiles(owner, name, branch, commitSet, `PowerX: upload ${commitSet.length} file(s)`);
  return list.map(f => f.dest);
}

async function downloadFile(id, srcPath) {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const rel = _workPath(id, srcPath);
  const buf = await readRepoFile(owner, name, branch, rel);
  if (!buf) throw new Error(`file not found in sandbox: ${srcPath}`);
  return buf;
}

async function listFiles(id, dir = 'work') {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  // Normalise `dir` to a path relative to the sandbox work root.
  let sub = String(dir || '').replace(/\\/g, '/');
  if (sub === WORKDIR || sub === 'work' || sub === '' || sub === '.') sub = '';
  else sub = sub.replace(new RegExp(`^${WORKDIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '').replace(/^work\/?/, '').replace(/^\/+/, '');
  const rel = (`${SANDBOX_ROOT}/${id}/work` + (sub ? `/${sub}` : '')).replace(/\/+$/, '');
  return listRepoDir(owner, name, branch, rel);
}

// ── Clear the sandbox work tree (PER-TASK ISOLATION + /clearfiles) ────────────
// PERMANENT FIX for "GitHub Actions returns previous task files": because the
// work tree PERSISTS in git across turns, a NEW task's deliverable scan would
// otherwise pick up every file left behind by earlier tasks. This wipes ONLY
// this sandbox id's `.sandbox/<id>/work/` subtree (re-seeding an empty `.keep`)
// in a SINGLE atomic commit built on the CURRENT HEAD tree — so:
//   • It is SCOPED to one sandbox id (= one chat/session). Other users' sandbox
//     folders live under different ids and are never touched → zero cross-user
//     impact even though everyone shares the same runner repo.
//   • It never deletes the workflow file, the `.created` marker, or any sibling
//     sandbox — only the work files of THIS id.
// Returns the number of files removed (0 if the tree was already empty).
async function clearWorkTree(id) {
  if (!id) return 0;
  const repo = await getRepo();
  if (!repo) return 0;
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const workPrefix = `${SANDBOX_ROOT}/${id}/work/`;

  const MAX_TRIES = parseInt(process.env.GHA_COMMIT_RETRIES || '6', 10);
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const parentCommitSha = await getRefSha(owner, name, branch);
    if (!parentCommitSha) return 0; // nothing committed yet → nothing to clear
    // Read the full tree so we can enumerate this sandbox's work files.
    const tree = await gh(`/repos/${owner}/${name}/git/trees/${parentCommitSha}?recursive=1&_ts=${Date.now()}`, { method: 'GET' });
    if (!tree.ok || !tree.json || !Array.isArray(tree.json.tree)) {
      lastErr = 'could not read tree';
      await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 400)));
      continue;
    }
    const doomed = tree.json.tree.filter(t => t.type === 'blob' && t.path.startsWith(workPrefix) && t.path !== `${workPrefix}.keep`);
    if (!doomed.length) return 0; // already clean

    // Rebuild the tree deleting each work blob (sha:null) and re-seed .keep so
    // the folder keeps existing in git.
    const keepBlob = await gh(`/repos/${owner}/${name}/git/blobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '', encoding: 'utf-8' }),
    });
    const treeEntries = doomed.map(t => ({ path: t.path, mode: '100644', type: 'blob', sha: null }));
    if (keepBlob.ok && keepBlob.json && keepBlob.json.sha) {
      treeEntries.push({ path: `${workPrefix}.keep`, mode: '100644', type: 'blob', sha: keepBlob.json.sha });
    }
    const baseCommit = await gh(`/repos/${owner}/${name}/git/commits/${parentCommitSha}`, { method: 'GET' });
    const baseTreeSha = baseCommit.ok ? baseCommit.json.tree.sha : null;
    const newTree = await gh(`/repos/${owner}/${name}/git/trees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseTreeSha ? { base_tree: baseTreeSha, tree: treeEntries } : { tree: treeEntries }),
    });
    if (!newTree.ok) { lastErr = (newTree.json && newTree.json.message) || `HTTP ${newTree.status}`; continue; }
    const newCommit = await gh(`/repos/${owner}/${name}/git/commits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `PowerX: clear work tree for sandbox ${id} (${doomed.length} file(s))`, tree: newTree.json.sha, parents: [parentCommitSha] }),
    });
    if (!newCommit.ok) { lastErr = (newCommit.json && newCommit.json.message) || `HTTP ${newCommit.status}`; continue; }
    const upd = await gh(`/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.json.sha, force: false }),
    });
    if (upd.ok) return doomed.length;
    if (upd.status !== 422) { lastErr = (upd.json && upd.json.message) || `HTTP ${upd.status}`; }
    // Concurrent writer moved HEAD → rebase and retry.
    await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random() * 600)));
  }
  throw new Error(`clearWorkTree failed after ${MAX_TRIES} attempts: ${lastErr}`);
}

// ── Docker (preinstalled on ubuntu-latest runners) ───────────────────────────
async function dockerSetup(id, { onStep } = {}) {
  if (onStep) onStep('🐳 Docker is preinstalled on GitHub runners — verifying…');
  const r = await exec(id, 'docker --version && echo DOCKER_OK', { timeout: 120 });
  const ok = /DOCKER_OK/.test(r.output || '');
  const vm = (r.output || '').match(/Docker version [^\n]+/i);
  return { ok, version: vm ? vm[0] : '', log: (r.output || '').slice(-2000) };
}

async function dockerRun(id, dockerArgs, { timeout = 600 } = {}) {
  return exec(id, `sudo docker ${dockerArgs}`, { timeout });
}

// ── Minimal ZIP reader (stored + deflate) — no external deps ─────────────────
const zlib = require('zlib');
function _unzip(buf) {
  const files = {};
  let i = 0;
  const data = Buffer.from(buf);
  while (i + 4 <= data.length) {
    const sig = data.readUInt32LE(i);
    if (sig !== 0x04034b50) break; // local file header
    const method = data.readUInt16LE(i + 8);
    let compSize = data.readUInt32LE(i + 18);
    let uncompSize = data.readUInt32LE(i + 22);
    const nameLen = data.readUInt16LE(i + 26);
    const extraLen = data.readUInt16LE(i + 28);
    const flags = data.readUInt16LE(i + 6);
    const nameStart = i + 30;
    const name = data.slice(nameStart, nameStart + nameLen).toString('utf-8');
    let dataStart = nameStart + nameLen + extraLen;
    if (flags & 0x08) {
      // Sizes are in a data descriptor AFTER the data — scan for next header/central dir.
      let j = dataStart;
      while (j + 4 <= data.length) {
        const s = data.readUInt32LE(j);
        if (s === 0x08074b50 || s === 0x04034b50 || s === 0x02014b50) break;
        j++;
      }
      compSize = j - dataStart;
      if (data.readUInt32LE(j) === 0x08074b50) { uncompSize = data.readUInt32LE(j + 8); }
    }
    const comp = data.slice(dataStart, dataStart + compSize);
    let content;
    try { content = method === 8 ? zlib.inflateRawSync(comp) : comp; }
    catch (_) { content = comp; }
    if (!name.endsWith('/')) files[name] = content;
    i = dataStart + compSize;
    if (flags & 0x08) i += 16; // skip data descriptor
    if (compSize === 0 && method === 0 && uncompSize === 0) i += 0;
  }
  return files;
}
function _findBySuffix(files, suffix) {
  const k = Object.keys(files).find(k => k.endsWith(suffix));
  return k ? files[k] : null;
}

// Return ALL files the sandbox produced (the deliverables) as {name, buffer}.
// PRIMARY path: the git-persisted work tree (durable, always available, and
// unaffected by GitHub's artifact storage quota). FALLBACK: the most recent run
// artifact zip. This guarantees deliverables come back even when the account's
// artifact quota is exhausted.
async function getLatestArtifacts(id) {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();

  // 1) Read the persisted work tree recursively via the git trees API.
  try {
    const headSha = await getRefSha(owner, name, branch);
    if (headSha) {
      const tree = await gh(`/repos/${owner}/${name}/git/trees/${headSha}?recursive=1`, { method: 'GET' });
      if (tree.ok && tree.json && Array.isArray(tree.json.tree)) {
        const prefix = `${SANDBOX_ROOT}/${id}/work/`;
        const blobs = tree.json.tree.filter(t => t.type === 'blob' && t.path.startsWith(prefix) && !t.path.endsWith('/.keep'));
        const out = [];
        for (const b of blobs) {
          const blob = await gh(`/repos/${owner}/${name}/git/blobs/${b.sha}`, { method: 'GET' });
          if (blob.ok && blob.json && blob.json.content) {
            out.push({ name: b.path.slice(prefix.length), buffer: Buffer.from(blob.json.content, blob.json.encoding || 'base64') });
          }
        }
        if (out.length) return out;
      }
    }
  } catch (_) { /* fall through to artifacts */ }

  // 2) Fallback: pull the most recent run's artifact zip (when quota permits).
  const runs = await gh(`/repos/${owner}/${name}/actions/runs?event=workflow_dispatch&per_page=30`, { method: 'GET' });
  if (!runs.ok || !runs.json || !Array.isArray(runs.json.workflow_runs)) return [];
  for (const run of runs.json.workflow_runs) {
    const arts = await gh(`/repos/${owner}/${name}/actions/runs/${run.id}/artifacts`, { method: 'GET' });
    if (arts.ok && arts.json && Array.isArray(arts.json.artifacts)) {
      const art = arts.json.artifacts.find(a => a.name.startsWith(`sbx-${id}-`));
      if (art) {
        const zipBuf = await gh(`/repos/${owner}/${name}/actions/artifacts/${art.id}/zip`, { method: 'GET' }, { raw: true, timeout: 120000 });
        const files = _unzip(zipBuf);
        return Object.entries(files)
          .filter(([fn]) => fn.includes('/work/') && !fn.endsWith('/.keep'))
          .map(([fn, buffer]) => ({ name: fn.split('/work/').pop(), buffer }));
      }
    }
  }
  return [];
}

// ── Native (no-CI) filesystem ops via the Git Data API ───────────────────────
// CRITICAL: on GitHub Actions every `exec()` dispatches a WHOLE workflow run
// (30 s – several minutes each). The host loop's fsx used to route writeText /
// readText / exists / list AND every base64 upload chunk through exec(), so
// staging a single binary attachment (image / pdf / docx / apk / zip) fired
// dozens–hundreds of workflow dispatches → the bot "hung forever". These native
// helpers do the SAME file operations directly against the runner repo's git
// tree (one or two REST calls, no runner), so agentEngine can bypass exec() for
// pure file I/O and only spend a CI run on ACTUAL command execution.

// Does the work-tree file exist? (single git-tree lookup, no CI run)
async function existsFile(id, srcPath) {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const rel = _workPath(id, srcPath);
  try {
    const headSha = await getRefSha(owner, name, branch);
    if (!headSha) return false;
    const tree = await gh(`/repos/${owner}/${name}/git/trees/${headSha}?recursive=1&_ts=${Date.now()}`, { method: 'GET' });
    if (tree.ok && tree.json && Array.isArray(tree.json.tree)) {
      const want = rel.replace(/^\.?\/+/, '');
      return tree.json.tree.some(t => t.path === want);
    }
  } catch (_) {}
  return false;
}

// Recursive listing of the sandbox work tree → [{ rel, size, mtime }].
// `rel` is relative to the work root (mirrors the local/shell fsx.list()).
async function listFilesRecursive(id) {
  const repo = await getRepo();
  const { owner, name } = repoParts(repo);
  const branch = await getBranch();
  const prefix = `${SANDBOX_ROOT}/${id}/work/`;
  const out = [];
  try {
    const headSha = await getRefSha(owner, name, branch);
    if (!headSha) return out;
    const tree = await gh(`/repos/${owner}/${name}/git/trees/${headSha}?recursive=1&_ts=${Date.now()}`, { method: 'GET' });
    if (tree.ok && tree.json && Array.isArray(tree.json.tree)) {
      const now = Date.now() / 1000;
      for (const t of tree.json.tree) {
        if (t.type !== 'blob') continue;
        if (!t.path.startsWith(prefix)) continue;
        const rel = t.path.slice(prefix.length);
        if (!rel || rel === '.keep' || /(^|\/)\.keep$/.test(rel)) continue;
        if (/(^|\/)_step_[^/]*$/.test(rel)) continue;   // hide scratch scripts
        if (/(^|\/)\.git\//.test(rel)) continue;
        out.push({ rel, size: t.size || 0, mtime: now });
      }
    }
  } catch (_) {}
  return out;
}

module.exports = {
  enabled, enabledAsync, WORKDIR,
  // Each exec() is a fresh short-lived runner → per-command, no persistent worker.
  perCommand: true,
  // Signals to agentEngine that pure file I/O should use the native Git Data
  // API helpers below instead of the (very expensive) exec()-based shell fsx.
  nativeFs: true,
  createSandbox, deleteSandbox, getSandboxState, startSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, uploadFiles, downloadFile, listFiles,
  existsFile, listFilesRecursive, clearWorkTree,
  getApiKey, getRepo, getBranch, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
  getLatestArtifacts,
};
