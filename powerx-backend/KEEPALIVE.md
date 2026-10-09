# Keep-Alive / Uptime Hardening

This app runs on a **Render free web service** (`hackerx-v7`, branch `evilgpt`).
Free dynos are **suspended after ~15 min with no inbound HTTP traffic**, which
freezes the whole Node process — every `setInterval` stops, the WhatsApp tracker
socket dies, and the URL uptime scheduler pauses. A self-ping *alone* can't fix
this because the self-ping loop is frozen too.

The fix is a **multi-layer defense**, with the strongest layer running OUTSIDE Render.

## Layer 1 — External pingers (PRIMARY, the real fix)

External requests are the only thing that can **wake a sleeping dyno**.

### a) GitHub Actions (already in this repo)
`.github/workflows/keepalive.yml` runs every 10 min on GitHub's infra and, within
each run, pings `/health` `/ping` `/healthz` `/` every ~50s for ~9 minutes →
effectively continuous coverage. No setup needed; it activates once pushed.

- Manual run: GitHub repo -> **Actions -> Keep Render Awake -> Run workflow**.
- Custom URL: repo **Settings -> Secrets and variables -> Actions -> Variables** ->
  add `KEEPALIVE_URL = https://your-app.onrender.com`.

### b) Free third-party uptime monitors (recommended — add at least one)
Belt-and-suspenders, in case GitHub Actions is delayed/disabled. Point each at:
`https://hackerx-v7.onrender.com/health` (interval 5 min).

- **UptimeRobot** — https://uptimerobot.com (50 monitors free, 5-min interval)
- **cron-job.org** — https://cron-job.org (free, down to 1-min interval)
- **BetterStack / Better Uptime** — https://betterstack.com (free tier)
- **Cronitor**, **Freshping**, **Hetrix Tools** — all have free tiers

## Layer 2 — Hardened internal self-ping (`server.js`)
- Pings the **public** `SELF_URL` (real inbound traffic) every ~5 min ± jitter.
- Falls back to localhost `/healthz` if the public ping fails.
- Stats exposed at `/health -> selfPing`.
- Requires env var **`SELF_URL=https://hackerx-v7.onrender.com`** (already set on Render).

## Layer 3 — Resilient schedulers (`server.js`)
- `runPingScheduler` (URL monitor): overlap guard + concurrency cap (12) +
  instant **catch-up** of all monitors that came due while the dyno slept.
- `pingUrl`: HEAD->GET fallback, follows redirects, one retry on transient
  failure (no false "down"), treats 2xx/3xx as up.
- WhatsApp tracker watchdog every 2 min (unchanged) revives dead sockets.

## Health endpoints
| Path | Purpose |
|------|---------|
| `GET /health` | JSON: `ok`, `uptime`, `ts`, `selfPing` stats |
| `GET /healthz` | `{ok:true}` — cheapest JSON |
| `GET /ping` / `HEAD /ping` | `pong` / 200 — cheapest for external cron |

## Honest limits
No code makes a Render **free** dyno truly 24/7: there is a monthly compute cap
and occasional forced cold starts. External pinging realistically yields ~99%
effective availability. For a hard guarantee, upgrade to a **paid Render plan**
(no idle suspension) — the cleanest single fix.
