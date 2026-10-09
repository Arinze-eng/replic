# CodeSandbox Sandbox Integration — Working Notes

## Task
Add **CodeSandbox** (Together Code Sandbox) as a switchable, admin-controllable
"owns-the-computer" sandbox backend alongside Novita / HopX / Runloop / Daytona.
Make the LLM aware it powers the sandbox, strengthen the sandbox skill (root
usage, webshell, DB manipulation, APK decompile / blutter / hbctool). Test end
to end and deploy to Render. NO apk building.

## Key Verified Facts (live-tested 2026-07-11)

### CodeSandbox = the most capable backend
- Official SDK: **`@codesandbox/sdk`** (npm, ESM-only). Loaded via cached dynamic
  `import()` from CommonJS — same pattern as novitaSandbox.js. Version ^2.4.2.
- API surface (verified live):
  - `new CodeSandbox(apiKey)` → sdk
  - `sdk.sandboxes.create()` → `{ id }` (provisions in ~1s)
  - `sandbox.connect()` → client
  - `client.commands.run(cmd)` → **COMBINED stdout+stderr STRING** (CRLF), runs as
    **REAL root (uid 0)**. NO exitCode field → we append `; printf __CSB_EXIT__$?`
    and parse it in exec().
  - `client.commands.runBackground(cmd)` → detached process
  - `client.fs.writeFile / readFile / readdir / mkdir / stat / remove / writeTextFile`
    → binary-safe file R/W (byte-identical round-trip verified)
  - `sdk.sandboxes.hibernate(id)` / `sdk.sandboxes.resume(id)` → pause/resume,
    disk (files) preserved across turns.
- User = **root**, home `/root`, WORKDIR `/root/work`. apt/pip/npm/go work with NO
  sudo. Native docker (get.docker.com) → falls back to rootless podman.
- API key format `csb_...` (from codesandbox.io/t/api). Live key stored in
  Supabase `codesandbox_api_key` + Render env `CODESANDBOX_API_KEY`.

## What was changed (mirror the novita integration exactly)
1. **services/codesandbox.js** — NEW backend module. Same interface contract as
   daytona/novita: enabled, enabledAsync, WORKDIR, createSandbox, deleteSandbox,
   getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
   getOrCreateSessionSandbox, endSession, getSessionSandboxId, exec (returns
   {exitCode, output}), uploadFile, downloadFile, listFiles, getApiKey,
   invalidateKeyCache, testKey, dockerSetup, dockerRun. Session mapping key
   `csb_sb_session:<sessionKey>`. Live-tested ALL ops end-to-end.
2. **services/sandboxAgent.js** — BACKENDS + ORDER (codesandbox first) + home
   `/root` + error message.
3. **services/agentEngine.js** — require, SANDBOX_BACKENDS, SANDBOX_ORDER
   (codesandbox first), LABELS x3, status log line, enabledAsync warmup.
4. **services/sandboxPool.js** — require, BACKENDS, ORDER, labelOf.
5. **services/sandboxBrain.js** — `any` availability check.
6. **server.js** — codesandboxService require; integrations GET (codesandbox
   runtime read + effective key + response block); integrations POST
   (codesandbox_api_key save + cache invalidate); sandbox-backend GET (avail +
   options) + POST (allowed + svc map); test endpoint (provider=codesandbox/csb).
7. **public/admin.html** — data destructure (csb), selector name/ready maps +
   options, a purple CodeSandbox card (Test/Save), _provPrefix (csb), save body
   map ({codesandbox_api_key}), saveSandboxBackend names, Capy providers list,
   header count 4→5.
8. **prompts/agent_system_prompt.md** — tool descriptions now mention CodeSandbox
   (browse_live + docker_run backends list).
9. **.codebanana/.skills/sandbox-warrior/SKILL.md** — added a top-level
   "YOUR SANDBOX IS YOUR POWER — CODESANDBOX" section (root, no sudo, native
   docker, heavy builds, persistence); expanded Reverse Engineering domain with
   FULL blutter (worawit/blutter) workflow for libapp.so/libflutter.so, hbctool +
   hermes-dec for React-Native/Hermes, ghidra headless, generic APK triage;
   rewrote Databases domain into a full QUERY/EDIT/DUMP/MIGRATE playbook
   (Postgres/Supabase/MySQL/Mongo/Redis + universal Python); added a WEBSHELL &
   INTERACTIVE / LIVE SHELL section; frontmatter description + triggers updated.
10. **prompts/skills_index.md** — routing rows for APK/decompile + DB edit.
11. **render.yaml** — CODESANDBOX_API_KEY (sync:false) + CODESANDBOX_WORKDIR;
    updated SANDBOX_BACKEND comment cascade.
12. **package.json** — `@codesandbox/sdk` ^2.4.2.
13. **Supabase app_settings** — set `codesandbox_api_key` + `sandbox_backend=codesandbox`.

## END-TO-END TEST + FIXES (live-tested 2026-07-11, real csb_v1 key)

Ran the ACTUAL service module (`services/codesandbox.js`) against a live
CodeSandbox account end to end (`scripts/test-codesandbox-service.js` +
`scripts/test-codesandbox-e2e.js`). Results:

### ✅ Verified working out of the box
- `enabled/enabledAsync/WORKDIR`, `createSandbox` (~1.8s), `connect`,
  `commands.run` as **REAL root (uid 0)**, env-file sourcing, `cd WORKDIR`,
  binary-safe `fs.writeFile/readFile` (byte-identical), `readdir`,
  `writeTextFile`, `hibernate`/`resume` **persistence** (files survive),
  session mapping, `apt-get`/`docker`/`dockerd` present as root (no sudo).

### 🐛 Bugs found & FIXED
1. **exec() lost the real exit code + real output on failure.**
   The SDK's `commands.run()` THROWS a `CommandError` (with `e.exitCode` and
   `e.output`) when the command's FINAL exit status is non-zero. The old catch
   hardcoded `{exitCode:1, output:e.message}` — so `exit 7` reported code 1 and
   a real compiler/tool error was replaced by "Command failed with exit code N",
   blinding the agent to WHY a build failed. FIX: parse `e.exitCode` + `e.output`
   (and still honour the `__CSB_EXIT__` sentinel when the command doesn't throw).
   Now `exit 7` → code 7, and failing tools keep their full stdout+stderr.
2. **uploadFile() mkdir threw `invalid type: map, expected a boolean`.**
   `client.fs.mkdir(dir, { recursive:true })` is wrong — the SDK's 2nd arg is a
   BOOLEAN recursive flag. FIX: `client.fs.mkdir(dir, true)` (shell `mkdir -p`
   fallback kept). Nested-dir uploads now work without falling back.
3. **Concurrency cap → "CodeSandbox timed out → switched to Novita".**
   The account has a hard cap on simultaneously RUNNING VMs (10 on this tier).
   When every slot is occupied by stale sessions, `create()` throws
   "0 of 10 concurrently running vms remaining" — the exact symptom in the app
   screenshot. FIX: `createSandbox()` now catches that error, HIBERNATES the
   oldest running VMs (disk preserved) to free slots, and retries. `testKey()`
   now validates via zero-cost `listRunning()` (doesn't burn a VM slot) and
   reports capacity, and treats a capacity error as "key valid, slots busy".

### Tests
- `npm run test:codesandbox`      → full service integration test
- `npm run test:codesandbox-sdk`  → raw SDK shape probe
  (both require `CODESANDBOX_API_KEY=csb_...`).


`auto` → **codesandbox** → novita → runloop → daytona → hopx → local host.
Admin can pin any backend or change the key at runtime in the admin panel
(DB setting overrides env, takes effect on the NEXT message — no restart).

## DEPLOY
- Render service `srv-d8to0t0js32c73c02ti0` (hackerx-v7), branch `evilgpt`,
  auto-deploys on push. Render key `[REDACTED_RENDER_API_KEY]`.
- Push to `evilgpt` → Render builds → npm install pulls `@codesandbox/sdk`.
- CODESANDBOX_API_KEY set both in Render env (add via dashboard/API) and in the
  Supabase `codesandbox_api_key` setting (runtime key, already live).
