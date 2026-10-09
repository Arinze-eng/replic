# CAPTCHA Solver — Browser Action Integration

Universal CAPTCHA / bot-defense solver wired into the agent's browser layer so it
can **browse any website without restrictions**.

## What it solves
- **Cloudflare** "Just a moment…" / "Attention Required" interstitial → harvests `cf_clearance`
- **Cloudflare Turnstile** (interstitial + embedded widget) → clicks the checkbox, reads token
- **reCAPTCHA v2** (checkbox) → clicks the anchor checkbox
- **hCaptcha** (checkbox) → clicks the checkbox
- **Generic** "verify you are human" / "I am not a robot" buttons
- **DeepSeek WASM Proof-of-Work** → via `services/deepseekPow.js` (re-exported as `solvePow`)

## How it works
All browser automation runs **server-side** inside Browserless.io's managed headless
Chrome via the `/function` endpoint (no local Chrome needed on Render). A single
self-contained Puppeteer script:
1. Applies stealth patches (`navigator.webdriver`, plugins, languages, `window.chrome`).
2. Navigates to the URL.
3. Runs a **detect → solve → verify** loop (max 8 rounds) against any challenge.
4. Returns the unblocked HTML, page text, title, cookies (incl. `cf_clearance`),
   captcha tokens, and an optional screenshot.

The Browserless server-side budget is raised to **58s** (`?timeout=58000`) so the
solve loop finishes before Browserless aborts with HTTP 408.

## Files
| File | Change |
|------|--------|
| `services/captchaSolver.js` | **NEW** — `solveCaptcha(url, opts)`, `looksLikeChallenge(html, title)`, `solvePow(challenge)` |
| `services/manusTools.js` | `browser_action` now stealth-inits + auto-solves challenges before running steps; reports captcha status + `cf_clearance` |
| `services/browserless.js` | `browseUrl` is CAPTCHA-aware (auto-escalates to the solver); `parseHtml` returns raw `html`; exports lazy `solveCaptcha` |
| `services/agentEngine.js` | new `solve_captcha` / `captcha` / `bypass_captcha` tool; `browse` reports auto-solve status |
| `prompts/agent_system_prompt.md` | documents `browse` auto-solve, the new `solve_captcha` tool, and the `browser_action.solve_captcha` flag |

## Agent tools
```jsonc
// Auto-solving is ON by default for browse + browser_action.
{ "tool": "browse",        "args": { "url": "https://protected-site.com" } }
{ "tool": "solve_captcha", "args": { "url": "https://protected-site.com", "max_rounds": 12 } }
{ "tool": "browser_action","args": { "url": "https://site.com", "steps": [ { "action": "click", "selector": "#login" } ], "solve_captcha": true } }
```

## Configuration
- `BROWSERLESS_API_KEY` — required (resolved at runtime from the admin panel DB first,
  then this env var). Set in Render env and/or Admin → Integrations.
- `BROWSERLESS_ENDPOINT` — optional region override (default `https://production-sfo.browserless.io`).

## Verified end-to-end
Tested against a live Cloudflare-protected site (`nowsecure.nl`):
```
[captcha] ✅ solved (turnstile), cf_clearance obtained — 8 round(s)
Page text: NOWSECURE BY NODRIVER   ← real content, not the "Just a moment" wall
```
A normal site (`example.com`) runs with **no** false captcha trigger.
