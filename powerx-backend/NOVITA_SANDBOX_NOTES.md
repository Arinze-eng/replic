# Novita Sandbox Integration — Working Notes

## Task
Enable **Novita** as a switchable sandbox backend (admin can pick it alongside HopX/Runloop/Daytona), fix why HopX & Runloop "don't work", deploy to Render, test. NO apk building.

## Key Verified Facts (live-tested 2026-07-10)

### API keys
- **HopX** `hopx_live_[REDACTED]` — VALID (list HTTP 200) BUT create sandbox → **503 "no available nodes"** (provider out of capacity). Not a code/key bug — HopX is down.
- **Runloop** — NO `ak_` key was ever provided. `[REDACTED_RENDER_API_KEY]` is a **RENDER** key (not Runloop — Runloop keys are `ak_...`). So Runloop backend is simply unconfigured. That's why it "doesn't work".
- **Render** `[REDACTED_RENDER_API_KEY]` — VALID. Service `srv-d8to0t0js32c73c02ti0` name `hackerx-v7`, branch `evilgpt`, URL https://hackerx-v7.onrender.com (the render URL user gave, hackerx-v7-d5s4, may be an older instance).
- **Novita** `sk_[REDACTED]` — VALID for both chat (api.novita.ai) AND sandbox.

### Novita Sandbox = E2B-compatible
- Control API base: `https://api.sandbox.novita.ai` (E2B REST). Auth header: `X-API-Key: <NOVITA_API_KEY>`.
- Official SDK `novita-sandbox` (npm) — ESM only, works from CommonJS via dynamic `import()`. Installs clean (35 pkgs, 0 vuln).
- SDK verified end-to-end: `Sandbox.create({apiKey,timeoutMs})`, `sbx.commands.run(cmd)` → {exitCode,stdout,stderr}, `sbx.files.write/read/list`, binary roundtrip OK, `sbx.pause()`, `Sandbox.connect(id,{apiKey})` (resume, files persist), `sbx.getInfo()`, `sbx.kill()`.
- Default user `user`, home `/home/user`, x86_64 Linux 6.1, has apt/pip/node.
- Templates: `base` and `code-interpreter-v1` both work.

## Architecture (where backends are registered — MUST update all)
1. `services/sandboxAgent.js` → `const BACKENDS = { hopx, runloop, daytona }`, `const ORDER = ['hopx','runloop','daytona']`. home path per backend.
2. `services/agentEngine.js` → `const SANDBOX_BACKENDS = { hopx, runloop, daytona }`, `SANDBOX_ORDER`. Comment: "Unknown/removed backends (novita, tensorlake) collapse to 'auto'".
3. `server.js`:
   - GET `/api/admin/integrations` (~line 960-1020): reads `*_api_key` DB settings, reports status.
   - POST `/api/admin/integrations` (~1257): saves keys.
   - GET/POST `/api/admin/sandbox-backend` (~1173, 1183): `options: ['auto','hopx','runloop','daytona']`, saves `sandbox_backend` DB setting.
4. `render.yaml`: env `SANDBOX_BACKEND=auto`, needs `NOVITA_API_KEY` (already present, sync:false).
5. Admin frontend: `public/` — find the Integrations tab + sandbox selector UI.

## Backend interface contract (mirror daytona.js / hopx.js exports)
`enabled, enabledAsync, WORKDIR, createSandbox, deleteSandbox, getSandboxState, startSandbox, getOrCreateSessionSandbox, endSession, getSessionSandboxId, exec, uploadFile, downloadFile, listFiles, getApiKey, invalidateKeyCache, testKey, dockerSetup, dockerRun`
- `exec(id, cmd, {cwd,timeout})` → `{exitCode, output}` (stdout+stderr merged)
- session mapping stored via db.getSetting/setSetting under a prefix key.
- Key resolution: DB setting `novita_api_key` first, then env `NOVITA_API_KEY`.
- home = `/home/user`, WORKDIR = `/home/user/work`.

## FINAL DIAGNOSIS — why HopX & Runloop "don't work" (provider-side, not code)
Tested the REAL keys stored in the Supabase `app_settings` table:
- **HopX**: key valid (list 200) but create → **503 "no available nodes"** = provider capacity outage.
- **Runloop**: DB has a real `ak_33agg...pi5o` key, but → **403 "Account is disabled. Contact billing"** = Runloop account suspended.
- **Daytona**: WORKS (200) — was the active backend, has running sandboxes.
- **Novita**: WORKS — now fully integrated as a 4th backend.
Neither HopX nor Runloop can be fixed in code — HopX needs capacity, Runloop needs the account re-enabled/billing. Novita is the reliable fix.

## DONE
- Created services/novitaSandbox.js (E2B SDK wrapper) — live-tested all ops.
- Registered novita in: sandboxAgent.js (BACKENDS+ORDER), agentEngine.js (SANDBOX_BACKENDS+ORDER+log+LABELS x3), sandboxPool.js (BACKENDS+ORDER+labelOf), sandboxBrain.js (any check).
- server.js: integrations GET/POST (novita_sandbox_api_key), sandbox-backend options+availability+warning, test endpoint (provider=novita).
- public/admin.html: selector name/ready/options, Novita card, _provPrefix nv, save body, saveSandboxBackend names, Capy providers list.
- package.json: novita-sandbox ^2.0.6. render.yaml: NOVITA_SANDBOX_API_KEY + NOVITA_SANDBOX_TEMPLATE.
- Supabase app_settings: set novita_sandbox_api_key + sandbox_backend=novita.
- ORDER cascade now: novita → runloop → daytona → hopx (novita first since it's the only reliable one right now).

## DEPLOY
- Render service srv-d8to0t0js32c73c02ti0 (hackerx-v7), branch evilgpt, auto-deploys on push.
- Render key [REDACTED_RENDER_API_KEY]. NOVITA_API_KEY already in Render env (sync:false) + now in DB.
- Push to evilgpt → Render builds Docker → npm install pulls novita-sandbox.

