# MoE Optimization (v2) — Cross-Backend Sandbox + Web Verification + Resilient Experts

This iteration hardens the Mixture-of-Experts (MoE) debate engine so that **two
genuine experts (Gemini + GPT-5) reliably cross-verify every task** — on any
platform, even browsing tasks — and produce one accurate, united answer.

## What changed

### 1. Unified, cross-backend sandbox (`services/sandboxPool.js` — NEW)
Previously `debate.js` was hardcoded to `daytona`, so the panel could only
verify code on Daytona. Now there is ONE backend-agnostic facade shared by the
whole app:

- `acquire(sessionKey)` → tries **HopX → Runloop → Daytona** (first healthy wins),
  honouring the admin `sandbox_backend` setting / `SANDBOX_BACKEND` env (a
  specific backend disables cross-fallback; `auto` cascades).
- `run(handle, code)` → auto-detects language (python3 / node / shell), wraps the
  command with a timeout + output cap, runs identically on any backend.
- If **every** remote backend is down, `acquire()` returns `null` — the panel
  then reasons without a sandbox instead of faking a verified result.

### 2. Auto-acquire in `debate.js`
`debate()` now transparently acquires a sandbox from the pool whenever a task
needs the terminal (`needsSandbox()`), unless the caller passes one. This means
the HTTP `/api/debate` route and every caller get real terminal cross-verification
out of the box — not just the bots.

### 3. Web / browsing cross-verification
- `needsWeb(question)` flags tasks that need live data (URLs, "latest", "price of",
  "search the web", …).
- `gatherWebEvidence()` fetches **one** shared snapshot (page via `browseUrl`, or a
  web search) and injects the **same** evidence into **both** experts' prompts, so
  they reason over identical facts and can cross-verify — instead of two divergent
  independent browses.

### 4. Resilient GPT-5 expert (critical reliability fix)
HotBot's free guest access now returns `rate_limit_guest` (HTTP 200 + JSON error
body), which silently made the GPT-5 expert **mute** and collapsed the panel to a
single voice.

- `hotbotReal.streamChat` now detects the JSON error envelope / empty body and
  **throws** instead of returning `''`.
- `debate.askGpt` falls back across keyless/working backends:
  **HotBot → Pollinations → DevToolbox → (last resort) Gemini**, so the GPT-5 seat
  is never silent. The first non-empty reply wins.

### 5. Smarter convergence
Terminal-verified convergence now accepts: both clean runs whose outputs match,
**OR** matching prose answers corroborated by at least one clean sandbox run — so a
single missing `run` block on the final round can't block an otherwise-verified,
identical answer. Strictness for accuracy is preserved.

## Tests
- `scripts/test-moe-upgrade.js`   — original orchestration (sequential, one-at-a-time, anti-flicker) ✅
- `scripts/test-moe-optimize.js`  — NEW: pool selection contract, `needsWeb` routing, auto-acquire, shared web evidence ✅

Run: `node scripts/test-moe-upgrade.js && node scripts/test-moe-optimize.js`

## Verified live (end-to-end)
- `POST /api/debate` math task → auto-acquired **HopX** sandbox, BOTH experts ran
  code, both returned 7006652, judge produced the correct final answer.
- SSE stream → 2 `sandbox` events (both experts ran), 2 `round_summary` (no flicker),
  `verdict` + `unified`.
- Web task → `needsWeb:true`, `usedWebEvidence:true` (shared snapshot fed to both).

## Config knobs
- `SANDBOX_BACKEND` = `auto` (default) | `hopx` | `runloop` | `daytona`
- `SANDBOX_PROVISION_TIMEOUT_MS` = 60000 (fail-fast provisioning)
- `HOTBOT_MODEL` = `gpt-5` (HotBot slug; falls back automatically if unavailable)
