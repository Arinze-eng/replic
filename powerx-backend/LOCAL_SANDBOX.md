# 🖥️ LOCAL Alpine Linux Sandbox (Windows .exe / Linux .deb)

This document describes the **local Alpine Linux sandbox** feature added so the
WormGPT **desktop app** runs heavy coding / bug-fixing / analysis tasks in a
sandbox on the **user's own machine** — NOT in a cloud sandbox (Daytona, Novita,
CodeSandbox, Runloop, HopX). The AI **fusion brain** (hotbot/Gemini/racers) and
all host-only tools are unchanged: they still run on the server and are metered.
Only *where the shell/computer runs* changes: locally, not in the cloud.

## Architecture

The whole thing is a **drop-in sandbox backend** so nothing else in the agent
had to change.

```
Desktop app (Electron)                         Server (Render)
┌───────────────────────────────┐             ┌──────────────────────────────┐
│ renderer  (UI + Local toggle)  │             │ /api/desktop/brain  (JWT)    │
│      │ IPC                     │             │   → agentEngine.brainComplete│
│ main.js → localHost.js         │  HTTPS/JWT  │   → FUSION brain + credits   │
│      │                         │────────────▶│ /api/desktop/tool   (JWT)    │
│ localSandbox.js                │             │   → agentEngine.runHostTool  │
│  docker│podman│wsl│proot│chroot│             │ /api/desktop/task-log (JWT)  │
│      ▼                         │             │   → admin telemetry          │
│  ┌───────────────────────┐     │             └──────────────────────────────┘
│  │ LOCAL Alpine box       │     │
│  │  agent.py worker       │     │  The worker's brain()/host_tool() calls are
│  │  full root + toolchain │     │  serviced LOCALLY by localHost, which forwards
│  └───────────────────────┘     │  them to the server endpoints above.
└───────────────────────────────┘
```

### Key files

| File | Role |
|------|------|
| `services/localSandbox.js` | New sandbox backend. Same interface as the cloud backends (`getOrCreateSessionSandbox`, `exec`, `uploadFile`, `downloadFile`, `listFiles`, `dockerSetup`, `dockerRun`, …). Provisions a local Alpine box. |
| `services/sandboxAgent.js` | Registers `localsandbox` in `BACKENDS`/`ORDER` (first, so it wins when enabled). OFF by default on Render. |
| `server.js` | `/api/desktop/brain`, `/api/desktop/tool`, `/api/desktop/task-log`, `/api/admin/desktop-users`; `platform=desktop` detection. |
| `db.js` | `getDesktopUsers()`. |
| `desktop_agent/src/localSandbox.js` | Bundled copy of the backend (runs in Electron main). |
| `desktop_agent/src/localHost.js` | Desktop runner: provisions the local box, runs `agent.py`, services the bridge → server. |
| `desktop_agent/src/agent_worker/agent.py` | Bundled copy of the ReAct worker. |
| `desktop_agent/src/main.js` | Routes `agent:run` to `localHost` when Local mode is on; sets `LOCAL_SANDBOX=1` + data dir. |
| `public/admin.html` | 🖥️ Desktop Users tab (count + task-type breakdown + recent tasks). |

## Isolation strategies (auto-selected, most-isolated first)

1. **docker / podman** — a persistent `alpine` container (real isolation, full root inside, `apk`).
2. **WSL Alpine** (Windows) — `wsl -d alpine`.
3. **proot + Alpine mini-rootfs** — unprivileged user-space chroot with fake-root.
4. **chroot** (root only) — real chroot into the Alpine rootfs.
5. **bare** — last-resort: runs on the host shell scoped to a per-box work dir (still local).

Override with `LOCAL_SANDBOX_STRATEGY=docker|podman|wsl|proot|chroot|bare`.

## Preinstalled coding toolchain

Every local Alpine box gets (via `apk`, cached after first run):
`bash, coreutils, grep, sed, gawk, findutils, diffutils, curl, wget, jq, git,
openssh, sqlite, python3+pip, nodejs+npm, build-base/gcc/g++/make/cmake, go,
rust/cargo, sudo, nmap, netcat, vim, nano, tree`, and more. Missing tools
auto-install on demand inside the worker.

## Enabling / disabling

- **Desktop app**: local mode is **ON by default** (toggle in the top bar). It
  sets `LOCAL_SANDBOX=1`.
- **Server (Render)**: local sandbox is **OFF by default** — the web keeps using
  the cloud sandboxes exactly as before. Admins on a self-hosted box can flip the
  `local_sandbox_enabled` app-setting or set `LOCAL_SANDBOX=1`.

## Anti-loot (credit-system protection)

Desktop signup already sends a stable per-machine `device_id` (the Electron
`clientId`). The existing device anti-loot in `routes/auth.js` enforces **one
account per device** — so a desktop user cannot re-sign-up to farm free credits.
Every desktop request carries `X-Client-Platform: desktop`, so the server stamps
`platform=desktop` and the admin **Desktop Users** tab shows who is using it.

Each fusion **brain call** from a local run is metered server-side
(`/api/desktop/brain` charges one step), so local compute is free but the shared
brain still bills fairly.

## Admin visibility

Admin dashboard → **🖥️ Desktop Users** tab:
- number of desktop users, active (24h/1h) counts,
- a breakdown of the **kind of tasks** they run (bug-fix / analysis / coding / security / data / other),
- a recent-task feed.

## Testing

`desktop_agent/e2e-local-test.js` runs the full desktop pipeline end-to-end in
`bare` strategy with a stub brain server — provisioning, worker start, file
bridge, tool loop and deliverable download. Run:

```bash
cd desktop_agent && LOCAL_SANDBOX_STRATEGY=bare node e2e-local-test.js
```
