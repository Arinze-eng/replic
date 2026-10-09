# WormGPT Agent — Upgrade Notes (E2E hardening, scheduling, time-box, stop/cancel)

## 🐉 Kali-slim security toolchain bootstrap (NEW — pip-first, one-time)

**Goal:** the agent must NEVER report a tool as "missing" during a cybersecurity /
vulnerability-testing task.

**Root cause found (verified LIVE on a real Novita sandbox — Debian 12 bookworm):**
the base sandbox only enables the apt `main` component, so classic pentest
packages (`sqlmap`, `nikto`, `hydra`, `john`, …) fail with
`E: Unable to locate package`. `pip` installs, however, work perfectly with
`--break-system-packages`.

**What was added:**
- `services/kaliBootstrap.js` — backend-agnostic, **sentinel-guarded** one-time
  bootstrap. It (1) enables Debian `contrib`/`non-free`/`non-free-firmware`,
  (2) adds the Kali `kali-rolling` repo **pinned to priority 50** (on-demand only,
  never auto-upgrades Debian), (3) installs a slim high-value apt arsenal, and
  (4) installs the pip-only tools with `pip --break-system-packages` (**pip is the
  PRIMARY installer**). Runs **detached/background** on the first turn so it never
  blocks the task; re-runs are an instant `test -f` no-op.
- `Dockerfile.kali-slim` — canonical buildable spec of the same arsenal (for
  baking a custom Novita/Daytona template, or local verification via
  `docker run --rm powerx/kali-slim kali-verify`).
- `services/sandboxAgent.js` — calls `kaliBootstrap.bootstrap()` right after the
  worker comes up (alongside the existing office/OCR prewarm), for every
  apt/Debian-based cloud backend (skipped only for LocalAlpine/apk). The existing
  office+cyber prewarm now also enables `contrib`/`non-free` so its apt packages
  resolve.
- `prompts/agent_system_prompt.md` — installation chain rewritten to **pip FIRST**,
  documents the pre-installed Kali-slim arsenal, and adds a hard "NEVER say a tool
  is missing — find a working path (pip → apt → release binary → source)" rule.

**Live test results (real Novita sandbox, active backend = `novita`):**
- All 12 core tools verified present: nmap, sqlmap, nikto, hydra, whois, nc, dig,
  dnsrecon, wafw00f, wapiti, gobuster, whatweb → **all OK**.
- Background launch returns instantly; sentinel makes re-runs a no-op.
- `nmap` scan runs; mid-task `pip3 install --break-system-packages` works.
- Applies to Novita **and** Daytona (same apt path; the script auto-detects the
  deb822 `debian.sources` vs legacy `sources.list`, covering Debian & Ubuntu).

---

This file also documents the earlier round of changes to the **WormGPT autonomous
agent** (Telegram + WhatsApp), all driven through the same in-sandbox worker
(`agent_worker/agent.py`) and host engine (`services/agentEngine.js` /
`agentGraph.js`).

## 1 & 2 — Resilient live browsing (works without Daytona / when a sandbox has no live browser)

- `toolBrowse` (`services/agentEngine.js`) now **auto-falls back** when Browserless
  is unavailable/blocked/empty: it makes a final explicit `power_scrape` pass
  (rotating-UA direct fetch → `r.jina.ai` reader → DuckDuckGo/Bing). Headless
  browsing therefore needs **no sandbox at all** and never returns a bare
  `[browse] error` when content is reachable by any strategy.
- Chain end-to-end: **Browserless → cheerio → power_scrape** (all inside
  `browserless.browseUrl`), plus the new outer `power_scrape` safety net.
- `browse_live` still prefers the real live view but transparently degrades to
  headless `browse` when a graphical sandbox isn't available.

## 3 — "Second task restarts / collides with the first" (FIXED)

Root cause: the in-sandbox worker spawned a **new daemon thread per inbox task**
with no coordination, and a new task's `clear_stop_flag()` + shared `_TERMINAL`
sink / single `.agent_stop` file **clobbered a still-running task**.

Fixes in `agent_worker/agent.py`:
- **Strict per-session serialization**: a single `_task_worker` thread drains a
  queue in arrival order. A task that arrives while another runs **waits its
  turn** — it never starts on top of / restarts the running one.
- **Per-task stop flags** (`<taskId>.stop`) split from the legacy **global**
  `.agent_stop` ("stop everything"), so a new task can't wipe another task's
  stop request, and `/stop` targets only the current task.
- `_TERMINAL` now carries `task_id`; `stop_requested()` checks both the
  per-task and global flags (used by `run_shell` mid-command and the step loop).

## 4 — Time-boxed thinking + scheduled-time tasks (NEW — the most important)

**Think for a duration** ("use 5 minutes to do X"):
- `services/agentScheduler.js` → `parseDuration()` extracts a working duration
  (clamped to 30s–30min, rejects false positives like "5 minutes of exercise").
- The bot passes `minDurationMs` / `thinkUntilMs` through
  `runTask → agentEngine.runAgent → sandboxAgent.runAgentInSandbox` (payload
  `think_until_ms`) and to the host-loop `agentGraph`.
- In `agent.py` (and `agentGraph.js`), while the deadline is in the future the
  agent **won't finish early** — every `finish` attempt is bounced with a
  directive to take a **genuinely different, improving** next action (new angle,
  verify/stress-test, more research, edge cases, depth). The existing
  loop-detector guarantees "keep thinking" is **never an idle spin**, and a
  bounded bounce count guarantees eventual completion.

**Schedule for a specific time** ("at 6pm", "in 30 minutes", "tomorrow 9am"):
- `parseSchedule()` extracts an absolute fire time; matching messages are stored
  (persisted in Supabase `app_settings`, so they survive redeploys) and fired by
  a single interval ticker. When fired, a scheduled task runs through the
  **exact same** task path (engine, credits, files, live terminal).
- A scheduled task may **also** be time-boxed ("at 6pm, use 5 minutes to …").

## 5 — `/stop` + cancel-all schedules

- `/stop` and `/halt` → stop the **current running task** (schedules untouched).
- `/cancelall` (alias `/cancel`) → **cancel every scheduled task** for the chat
  **and** stop the running one.
- `/schedules` → list pending scheduled tasks with their fire times.

## 6 — Extra improvements

- WhatsApp bot reached **parity** with Telegram (time-box + schedule + `/cancelall`
  + `/schedules`), sharing the same scheduler via a **multi-runner dispatcher**
  that routes by chat-id shape (numeric = Telegram, `@` = WhatsApp) and fires a
  due task **exactly once** to its owning runner.
- Clearer "still working — will NOT be restarted; send /stop to cancel" message
  when a task arrives mid-run.
- `/help` updated to document time-box + scheduling.

## Tests

- `npm run test:scheduler` → offline E2E (19 checks): duration parsing/clamping,
  schedule-time parsing, per-chat CRUD isolation, and multi-runner dispatch
  (fires once, to the owning runner, then removed — no double-fire).
- `agent.py` stop-flag isolation / global-stop / serialization helpers verified.

## Env knobs (all optional, sensible defaults)

- `AGENT_KEEP_THINKING_MAX` (default 60) — max "keep exploring" bounces per run.
- `AGENT_SCHEDULER_TICK_MS` (default 20000) — scheduler poll interval.
- `AGENT_SCHEDULER_MAX_PER_CHAT` (default 25) — max pending schedules per chat.

> **Note on live-site E2E:** logging into the deployed site and driving the bot
> through a real Daytona/Cloudflare sandbox requires the production API keys
> (Supabase/Daytona/Cloudflare/Browserless) that live in Render's env, not in the
> repo. The offline suites above validate all new logic; the deployed instance
> exercises the live sandbox path with those keys.
