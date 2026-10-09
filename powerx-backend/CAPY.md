# CAPY — long-running autonomous agent (poll up to 15 min, returns files)

This doc describes `services/capy.js` and the async `/api/capy` HTTP job API.

[Capy.ai](https://capy.ai) is a full autonomous coding/agent platform. Every
task runs inside Capy's **own cloud sandbox**, so — unlike the synchronous chat
brains (Sakana / HotBot / Gemini / Cloudflare) — a Capy task can plan, run shell
commands, browse, write code, and **produce files** over minutes.

The integration is built around the exact spec the project asked for:

> Any task first passes through Capy, is polled for a long period (15 min max)
> until the AI fully responds or returns a file, can return **all file types**
> (images → PDF → DOCX → Excel → …), and **falls back** to the other brains if
> nothing usable comes back. It works after deploy to Render. No APK build.

## Flow

```
POST /api/capy ──▶ capy.submit()  POST /v1/threads {projectId, prompt}
                        │                       └▶ { id (threadId), runState }
                        ▼
                 background long-poll (up to CAPY_POLL_CEILING_MS = 15 min)
                   GET /v1/threads/{id}  → runState running→ready (done)
                        │
                        ▼
                 GET /v1/threads/{id}/messages → final assistant answer (text)
                        │
                        ▼
                 harvest file URLs from the answer → download bytes
                        │
                        ▼
   GET /api/capy/:jobId            → { status, reply, files:[{idx,name,mime,bytes,url}] }
   GET /api/capy/:jobId/file/:idx  → the file bytes (image/pdf/docx/xlsx/…)
```

Because a 15-minute poll cannot be held open under Render's ~50s HTTP gateway,
`/api/capy` is an **async job API**: submit returns a `jobId` immediately and the
poll runs in the background.

## Returning files of any type

Capy's message `content` is **text only**, and its sandbox files are not exposed
as public binaries for repo-less projects. So the prompt appends an **output
contract** instructing Capy to upload every deliverable to a no-auth file host
(`0x0.st`, `transfer.sh`, `catbox.moe`, `tmpfiles.org`, …) and list the direct
URLs under a `DELIVERABLES:` section. The integration then:

1. Extracts every URL from the assistant text (plain + markdown links).
2. Keeps only file-looking / known-file-host URLs (skips the capy.ai dashboard,
   GitHub, search results, etc.).
3. Resolves indirect share links (e.g. gofile.io) to a direct link.
4. Downloads each (rejecting HTML landing pages), inferring the filename + MIME.

This works for **any** file type — images, PDF, DOCX, XLSX, CSV, ZIP, audio,
video, code archives, etc. — and for repo projects the task **diff** is a
secondary text-file source.

## HTTP

### POST /api/capy — submit

```bash
curl -X POST https://hackerx-v7.onrender.com/api/capy \
  -H 'Content-Type: application/json' \
  -d '{ "message": "Make a 1-page PDF invoice for ₦50,000 and give me the file." }'
# → { "ok": true, "jobId": "…", "threadId": "…", "status": "running",
#     "poll": "/api/capy/…" }
```

Optional body fields: `attachmentUrls` (public input URLs), `model`
(Capy model slug), `projectId` (override), `repos` (`[{repoFullName,branch}]`).

### GET /api/capy/:jobId — poll

```jsonc
{
  "ok": true,
  "jobId": "…",
  "status": "done",            // running | done | error | blocked
  "threadId": "…",
  "runState": "ready",
  "elapsedMs": 83000,
  "reply": "Here's your invoice… DELIVERABLES: https://…/invoice.pdf",
  "files": [ { "idx": 0, "name": "invoice.pdf", "mime": "application/pdf",
               "bytes": 24180, "url": "https://…/invoice.pdf" } ]
}
```

### GET /api/capy/:jobId/file/:idx — download

Streams the produced file with the right `Content-Type` and
`Content-Disposition`.

### GET /api/capy — health/docs

Reports whether Capy is configured, whether the head is enabled, and the poll
ceiling.

## Brain-pipeline integration (optional head)

`services/brain.js → answer({…}, opts)` can run Capy **first**:

* `opts.useCapy === true` forces it, OR
* `capy_head` (admin panel) / `CAPY_HEAD=1` (env) turns it on globally.

On Capy failure / timeout / empty it **falls back** to the existing chain
(Sakana → HotBot → Gemini → Cloudflare), so nothing ever breaks. On the
synchronous `/api/brain` path the Capy budget defaults to a gateway-safe
`CAPY_SYNC_CEILING_MS` (40s); the full 15-min poll only runs via `/api/capy`.

## Config (runtime DB → env)

All settings are runtime-settable in the **admin panel** (saved to Supabase
`app_settings`, survives redeploys, overrides env) and fall back to env:

| Setting / env            | Purpose                                         | Default |
|--------------------------|-------------------------------------------------|---------|
| `capy_api_key` / `CAPY_API_KEY`         | Capy token (`capy_…`)            | —       |
| `capy_project_id` / `CAPY_PROJECT_ID`   | project tasks run in            | Scratchpad |
| `capy_model` / `CAPY_MODEL`             | model slug (validated)          | claude-sonnet-4-6 |
| `capy_head` / `CAPY_HEAD`               | use Capy as the head/long agent | 0 (off) |
| `CAPY_POLL_CEILING_MS`                  | long-poll ceiling               | 900000 (15 min) |
| `CAPY_POLL_INTERVAL_MS`                 | poll interval                   | 6000    |
| `CAPY_SYNC_CEILING_MS`                  | sync `/api/brain` budget        | 40000   |

Admin **Test** button: `POST` the test endpoint with `provider: "capy"` (and an
optional `key` / `capy_project_id`) to validate the key and list projects.

## Self-hosted sandbox fallback (Daytona / HopX / Runloop)

Capy runs each task in **Capy's own cloud sandbox**. To make the long-running,
file-returning capability resilient even when Capy (or the Render gateway in
front of it) hiccups, the integration now adds a **self-hosted sandbox
fallback** layer (`services/sandboxBrain.js`):

```
        ┌──────────── task ────────────┐
        ▼                              │
   Capy.ai sandbox (head, 15-min poll) │   ← services/capy.js
        │  fail / timeout / empty      │
        ▼                              │
   SELF-HOSTED sandbox agent ──────────┘   ← services/sandboxBrain.js → sandboxAgent.js
   (HopX → Runloop → Daytona, polls until files come back)
        │  no sandbox configured / all failed
        ▼
   synchronous brain chain (Sakana → HotBot → Gemini → Cloudflare)
```

The self-hosted layer reuses the existing "owns-the-computer" runtime
(`agent_worker/agent.py` running inside HopX/Runloop/Daytona via `sandboxAgent`),
which **also** long-polls (minutes → hours) and returns files of any type. So
*"render alone won't stop it"*: if Capy is unavailable, the very same task is
completed inside the project's own sandbox cascade and the file is still
delivered.

Wired in three places:

* `services/brain.js` — after the Capy head fails/empties, it tries
  `sandboxBrain.run()` before falling through to the chat brain chain.
* `server.js → _startCapyJob` — the async `/api/capy` background poll runs the
  sandbox fallback on Capy submit-failure, block, empty, or ceiling timeout, so
  the async job still returns `reply` + `files` (with `brain: "sandbox:<backend>"`).
* `POST /api/capy` — accepts the job when EITHER Capy is configured OR a
  self-hosted sandbox is available.

### Config

| Setting / env                                   | Purpose                                   | Default |
|-------------------------------------------------|-------------------------------------------|---------|
| `capy_sandbox_fallback` / `CAPY_SANDBOX_FALLBACK` | turn the self-hosted fallback on/off     | 1 (ON)  |
| `sandbox_backend` / `SANDBOX_BACKEND`           | which providers to use (`auto`/hopx/runloop/daytona) | auto |
| `agent_in_sandbox` / `AGENT_IN_SANDBOX`         | owns-the-computer master switch           | ON      |

The toggle is runtime-settable in the **admin panel** (Capy card → "🛟 Sandbox
fallback") and saved to Supabase `app_settings`, so it survives redeploys and
takes effect immediately. The admin Capy key field already lets an admin change
the Capy API key at runtime (no redeploy).

## 🧠 Capy-only mode (admin toggle — disable the other-brain fallback)

The admin panel now has a **🧠 Capy-only mode** toggle on the Capy/Lemon card
(and in the Telegram bot flow it's honoured automatically). When ON:

* the Telegram bot / web / app run each task through Capy exactly as before, but
* if Capy fails / times out / returns nothing, the caller does **NOT** fall back
  to the other brains (Sakana / HotBot / Gemini / Cloudflare) or the self-hosted
  sandbox — **only Capy is allowed to answer**. The user gets a clear
  "Capy couldn't finish, try again" message (brain tag `capy-only`) instead of a
  silent switch to a weaker brain.

Config: DB setting `capy_only` → env `CAPY_ONLY` → **default OFF** (so existing
fall-back behaviour is unchanged unless an admin turns it on). Saved to Supabase
`app_settings`, survives redeploys, active on the next task with no redeploy.
Implemented in `services/capy.js → isCapyOnly()` and honoured in
`services/agentCapyFirst.js → runAgentCapyFirst()`.

## 🧠 Memory / carry-over (remembers ≥ 6 tasks, fast, answers immediately)

Capy runs with **fast per-task migration** (`CAPY_ALWAYS_MIGRATE=1`, default): a
BRAND-NEW Capy thread is spun for every task and **seeded with the recent
conversation** so it still remembers, while never hanging on a stuck thread.

* **Carry-over depth raised 3 → 6.** `CAPY_HISTORY_TURNS` (db `capy_hist:*`) now
  defaults to **6**, so the last 6 exchanges (each = user Q + assistant A) are
  re-stated to the fresh thread. Capy therefore "remembers at least 6 tasks".
* **Run-start watchdog (fixes "only remembers when you push the task again").**
  Capy occasionally creates a fresh thread but DROPS the initial run, so the poll
  used to report done-with-nothing and the task only worked after a MANUAL
  re-push. `_pollUntilDone` now detects a fresh-thread done-but-empty state and
  **auto-re-pushes the task once/twice** (`CAPY_FRESH_RENUDGE_MAX`, default 2),
  so the very first message is answered immediately with no manual re-push.

Verified live (see `scripts/test-capy-memory-e2e.js` and
`scripts/test-capy-memory-deep-e2e.js`): 6 sequential fresh-thread tasks each
answered in ~11–20s, carry-over held ≥ 6 turns, and Capy recalled a fact from
turn 2 after 6 turns — proving deep memory + immediate response.

---

## Verification

```bash
node scripts/test-capy-integration.js        # connection + URL-harvest unit tests
CAPY_LIVE=1 CAPY_API_KEY=capy_… node scripts/test-capy-integration.js   # full live e2e
npm run test:capy
```

Verified live: a task that creates an `.xlsx` / `.png` / `.pdf` is polled to
`runState=ready` in ~80–110s, the deliverable URL is harvested, and the real
file bytes are returned with the correct MIME (validated by magic bytes).
