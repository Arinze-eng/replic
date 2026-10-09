# GitHub Actions Sandbox — Integration Notes

## What this adds

A new **sandbox backend** that gives the PowerX/WormGPT agent a real Linux
computer powered by **GitHub-hosted Actions runners** (`ubuntu-latest`). The
agent can run any shell command / script, install packages, build things and
produce files — and every produced file comes back as a **deliverable**.

Selectable by the admin like every other sandbox (CodeSandbox, Novita, HopX,
Runloop, Daytona, Tensorlake) — pin it, or leave `auto` and it joins the
fallback cascade.

## Why GitHub Actions

- **Real root Ubuntu**: passwordless `sudo`, `python3`, `node`, `git`, `docker`,
  `apt`, `pip`, `npm`, `gcc` all preinstalled.
- **Free CI minutes** on GitHub.
- **Durable disk**: the sandbox's work tree is committed to a runner repo (git),
  so a chat's files survive across turns (same "disk persists" model as the
  other backends).
- **Artifacts as deliverables**: files the task produces are uploaded as workflow
  artifacts AND persisted in the git work tree, so the agent always gets them
  back — even if the account's artifact storage quota is temporarily exhausted.

## How it works

1. A dispatcher workflow (`.github/workflows/powerx-sandbox.yml`) is installed
   once (idempotent) in the **runner repo**.
2. `exec(id, cmd)` commits nothing itself — it dispatches the workflow with the
   base64 command + a per-run token, polls the run to completion, then reads the
   run's `.stdout.log` / `.exit_code` (from the artifact, falling back to the
   git-persisted files, falling back to the raw job log).
3. `uploadFile` / `downloadFile` / `listFiles` operate on the sandbox work tree
   (`.sandbox/<id>/work/`) via the GitHub Git Data API.
4. `getLatestArtifacts(id)` returns every produced file (git work tree first,
   artifact zip as fallback).

## Configuration

Admin panel → **Integrations → 🐙 GitHub Actions Sandbox**:

- **GitHub PAT** (`ghp_…`) with **`repo` + `workflow`** scope.
- **Runner repo** (`owner/name`) — use a **dedicated repo** (e.g.
  `owner/app-sandbox`) so your app repo stays clean.
- **Branch** (default `main`).

Then **Admin → Active Sandbox** → pick `🐙 GitHub Actions (CI runner)` (or leave
`auto`).

Env-var equivalents (also supported, DB setting wins):

```
GITHUB_ACTIONS_TOKEN=ghp_...
GITHUB_ACTIONS_REPO=owner/name
GITHUB_ACTIONS_BRANCH=main
```

## Files touched

- `services/githubActions.js` — the backend (new).
- `services/agentEngine.js` — registered in `SANDBOX_BACKENDS` / `SANDBOX_ORDER` / labels.
- `services/sandboxPool.js` — registered in the MoE pool.
- `services/sandboxAgent.js` — registered in the owns-the-computer worker.
- `server.js` — admin: backend option, key GET/POST, test endpoint.
- `public/admin.html` — admin UI card + selector + save/test wiring.
- `scripts/test-githubactions-e2e.js` — end-to-end test.

## E2E verification

`node scripts/test-githubactions-e2e.js` (with `GHA_TOKEN` set) proves:
testKey → createSandbox → exec a real task on ubuntu-latest → downloadFile →
listFiles → getLatestArtifacts. Verified against `Arinze-eng/powerx-sandbox`.

`node scripts/test-gha-delivery-e2e.js` (with `GHA_TOKEN` set) proves the
HOST-LOOP delivery path end-to-end: pin GitHub Actions → provision a persistent
session sandbox → run a real multi-file task → list + download every deliverable
back to the host (exactly what the Telegram / WhatsApp bots then send). This is
the path used by every bot task when GitHub Actions is the selected sandbox.

`node scripts/test-gha-hostloop.js` (with `GHA_TOKEN` set) proves the routing
contract: when GitHub Actions is PINNED, `sandboxAgent.enabled()` is `false`
(host-loop, not the persistent in-sandbox worker) and the backend cascade
contains ONLY `githubactions` (no silent drift to another sandbox).

## Fixes (2026-07) — "pinned sandbox must be used" + reliable file delivery

Three bugs were fixed so the admin's sandbox choice is always honoured and
GitHub Actions delivers files correctly:

1. **Pinned backend was silently overridden.** `sandboxAgent.resolveBackendChain`
   appended EVERY other backend as a fallback even when the admin pinned a
   specific one, so a transient provisioning hiccup on the pinned backend drifted
   the task onto CodeSandbox/Novita/etc. Now a pinned backend is a HARD LOCK: the
   chain contains ONLY that backend. It is RETRIED in-place on transient errors
   (`AGENT_PINNED_RETRIES`, default 2), and only if it truly cannot provision does
   the run fall back to the HOST loop — never to a different sandbox. This mirrors
   `agentEngine.resolveBackendCascade`.

2. **GitHub Actions wrongly tried to run the persistent in-sandbox worker.** Each
   GHA `exec()` is a fresh, short-lived runner, so a long-lived `agent.py` worker
   loop cannot survive between commands. GitHub Actions is now flagged
   `perCommand: true`; `sandboxAgent.enabled()` returns `false` for it, forcing the
   correct HOST-LOOP execution model (the host brain drives; each `run_code`/shell
   tool = one workflow dispatch).

3. **`_workPath` mis-mapped absolute in-runner paths → "file not found in
   sandbox".** The host-loop fsx passes ABSOLUTE paths
   (`/home/runner/work/sandbox/work/foo`). `_workPath` stripped the leading slash
   BEFORE stripping the `WORKDIR` prefix, so the prefix never matched and produced
   a bogus repo path — breaking download/delivery of every produced file. Fixed to
   strip the `WORKDIR` prefix first. `readRepoFile` also gained retries + a Git
   Data blob/tree fallback for GitHub's `contents`-API eventual consistency and
   >1 MB files.

## Fixes (2026-07) — file uploads no longer error out or hang the AI forever

The Telegram / WhatsApp bots let a user upload a file (pdf, image, txt, docx,
apk, zip) with an instruction. On the GitHub Actions backend this used to
**error out or hang forever until an admin reset the sandbox**. Root cause and
fixes:

1. **Every file op was a full CI run.** The host-loop filesystem (`fsx`) routed
   `writeText` / `readText` / `exists` / `list` — and, worst of all, the CHUNKED
   base64 upload used for binary files — through `sb.exec()`. On GitHub Actions
   each `exec()` dispatches a WHOLE `workflow_dispatch` run (30 s – minutes). So
   staging a single binary attachment fired **dozens–hundreds** of workflow
   dispatches (one per 60 KB base64 chunk) → the bot appeared to hang forever.
   **Fix:** GitHub Actions is now flagged `nativeFs`. `githubActions.js` exposes
   native `existsFile` / `listFilesRecursive` / `uploadFiles` (batch commit) that
   hit the **Git Data API directly** (one or two REST calls, NO runner).
   `agentEngine`'s `fsx` uses these for all pure file I/O; only ACTUAL command
   execution (`run` / `sh`) still dispatches a workflow. Staging 8 mixed files
   (incl. a 1 MB apk + 500 KB pdf + an extracted zip) now takes ~6 s (one commit)
   instead of many minutes.

2. **ZIP extraction was a CI run.** `unzip` ran via `fsx.sh` (a workflow
   dispatch), and `apt-get install unzip` could stall. **Fix:** on `nativeFs`
   backends ZIPs are extracted IN-PROCESS with `adm-zip` and every entry is
   committed alongside the raw attachments in the SAME single commit.

3. **`make_zip` was a CI run.** **Fix:** on `nativeFs` backends the archive is
   built on the host (pull the work tree via the Git Data API → `adm-zip` →
   upload the single result), so producing a deliverable zip costs no runner.

4. **Concurrent bot tasks clashed on the shared runner repo.** `commitFiles`
   read HEAD, built a commit, then PATCHed the ref non-fast-forward; if another
   task moved HEAD it 422'd and the fallback CREATE failed with "Reference
   already exists". **Fix:** `commitFiles` now RETRIES with a rebase — re-read
   HEAD, rebuild the tree/commit on the fresh parent, PATCH again (jittered
   backoff, `GHA_COMMIT_RETRIES`, default 6). Blobs are content-addressed so
   they're reused across retries.

5. **A stuck/queued run could hang the task indefinitely.** `exec` polled until
   `timeout + 180 s` and, under concurrency, could grab ANOTHER chat's run
   (the loose "most recent run" fallback). **Fix:** the dispatcher workflow now
   sets a `run-name` containing the unique `run_token`, so `exec` matches its
   run EXACTLY (never another task's). A HARD wall-clock cap (`GHA_HARD_CAP_MS`,
   default 20 min) bounds the wait, and a run that overruns is cancelled so it
   doesn't block the queue — the task then continues on the host engine instead
   of hanging.

E2E: `node scripts/test-gha-fileupload-e2e.js` (with `GHA_TOKEN` set) uploads a
file of every requested type + a real zip, asserts staging is fast (proving no
CI runs fire), verifies native exists/list/download, runs ONE real command that
reads the uploads and produces a deliverable, and confirms the deliverable comes
back. Verified live against `Arinze-eng/powerx-sandbox`.

## Fixes (2026-07) — permanent per-task file isolation + /clearfiles + browsing

Three product asks were addressed, all verified live against
`Arinze-eng/powerx-sandbox`:

### 1. Previous-task files no longer come back (PERMANENT FIX)

The GitHub Actions work tree PERSISTS in git across turns (so follow-ups like
"now convert that file" keep working). The bug was that a NEW task's deliverable
scan (and whole-dir tools like `make_zip .`) could sweep up leftovers from
earlier tasks. Fixed with a **two-layer, per-session-scoped** guard in
`agentEngine.runAgent`:

- **(a) Up-front wipe for a NEW task.** On the GitHub Actions backend
  (`nativeFs + perCommand`), when the turn is NOT a follow-up (no prior chat
  history) — or when `freshWorkspace` is forced — the runtime calls the new
  `githubActions.clearWorkTree(id)` to empty *only this sandbox id's*
  `.sandbox/<id>/work/` subtree in ONE atomic git commit (re-seeding `.keep`).
  Because it is scoped to one deterministic sandbox id (= one chat), it can
  NEVER touch another user's files even though everyone shares the runner repo.
- **(b) Task-start baseline diff at delivery.** The runtime snapshots the work
  tree at task start and, at delivery, drops any candidate that existed
  UNCHANGED since task start — so a pre-existing file can never leak into the
  results even if a whole-dir tool would include it. Host-generated buffers
  (docx/pdf produced this turn) are always kept.

`clearWorkTree` retries on concurrent-writer 422s (rebase-and-retry), exactly
like `commitFiles`.

E2E: `node scripts/test-gha-perisolation-e2e.js` — stage fileA → `clearWorkTree`
→ confirm gone → stage fileB → confirm fileA NEVER reappears. PASSED live.

### 2. `/clearfiles` command (Telegram + WhatsApp)

New backend-agnostic `agentEngine.clearSessionFiles(sessionKey)` wipes ONLY the
working-directory files of a chat's sandbox (GitHub Actions → `clearWorkTree`;
every other backend → `rm -rf` the work dir), keeping chat memory, the auth link
and the warm sandbox. Wired into both bots as `/clearfiles` (aliases
`/clearfile`, `/wipefiles`, `/emptyfiles`). Unlike `/reset` (which also wipes
memory and tears the sandbox down), `/clearfiles` is "empty my workspace, keep
everything else". Scoped per chat → never affects other users.

E2E: `node scripts/test-clearsessionfiles-e2e.js` — stage 2 files → clear →
confirm the tree is empty. PASSED live.

### 3. Real-time browsing on the GitHub Actions runner

`sandboxBrowser` used a two-step install→drive flow (sentinel in `/tmp`) that
cannot work on GitHub Actions, where each `exec()` is a fresh, short-lived runner
(nothing in `/tmp`/process survives between execs). Added a `perCommand` branch:
on GitHub Actions the whole browse — install Python+Playwright+Chromium (root
apt deps) AND launch→navigate→captcha-loop→screenshot — runs in ONE
self-contained workflow dispatch. The screenshot is copied into the work dir
(`browser_screenshot.jpg`, persisted in git) so it can be delivered, and
`toolSandboxBrowse` registers it as a deliverable. Always-on backends keep the
fast sentinel-cached two-step path.

E2E: `node scripts/test-gha-browse-e2e.js` — browses example.com via the CI
runner, extracts the title/text, clears the captcha loop, captures a screenshot.
PASSED live (~57s including first-run Chromium install).


