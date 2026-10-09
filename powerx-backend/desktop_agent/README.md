# WormGPT Coding Agent — Desktop (Windows & Linux)

A native desktop coding agent for **Windows** (`.exe`) and **Linux** (`.deb`).
It is a thin, reliable client to the WormGPT backend — the same brain and
sandbox that power the website and the Android app.

## What it does

- **Sign in with your website account.** Use the exact email/password you signed
  up with on the WormGPT website (Gmail addresses).
- **Heavy, long-running coding tasks** run in a real cloud **Alpine Linux
  sandbox** ("owns-the-computer" mode) with preinstalled tools — `bash`,
  `sqlite`, `grep`, `python`, editors, `requests`, `curl`, `git`, and more —
  installing extra packages on demand during a task.
- **The HotBot · Gemini · racers FUSION brain** drives every task (uncensored
  fusion mode), exactly like the WormGPT web agent.
- **File understanding:** read **PDF / DOCX / XLSX / TXT**, **OCR** images, and
  **transcribe audio** — just attach files to your task.
- **Task history** — every task is saved locally and re-openable from the
  sidebar (durable server jobs are re-fetched for the freshest result).
- **Metered credits** — the credit balance **drains as the AI works**. When you
  run out, the app shows an upgrade / buy-credits prompt (Free → Basic → Pro).
- **Produced files** (scripts, reports, zips, images) are shown inline and can
  be saved to disk with one click.

## Architecture

All heavy lifting (Alpine sandbox, tools, OCR, file reading, audio transcription,
long heavy coding, the fusion brain, credit draining, and the paywall) is done
**server-side** by the already-deployed backend. The desktop app is a native
client that:

1. authenticates via `POST /api/auth/login` (or `/signup`),
2. streams a task to `POST /api/agent/run` in **fusion** mode (SSE:
   `start` / `step` / `screen` / `done` / `error`),
3. surfaces live steps, the live sandbox screen, produced files, and the
   draining credit balance,
4. reads task history from `GET /api/agent/job/:id`.

Built with **Electron** + **electron-builder** — no browser sandbox limits, full
Node networking, so SSE, large uploads/downloads, and long tasks all work
reliably on Windows and Linux.

## Build

```bash
cd desktop_agent
npm install

# Linux .deb (works on a Linux host):
npm run dist:linux

# Windows .exe installer (NSIS) — needs Wine on Linux, or run on a Windows host / CI:
npm run dist:win

# Both:
npm run dist
```

Outputs land in `desktop_agent/dist/`:
- `WormGPT-Coding-Agent-<version>-linux-amd64.deb`
- `WormGPT Coding Agent Setup <version>.exe` (NSIS installer)
- `WormGPT-Coding-Agent-<version>-win-x64.zip` (portable Windows build)

> On a Linux host without Wine, the NSIS installer can't be produced, but the
> fully-runnable Windows app is still built into `dist/win-unpacked/` and can be
> zipped for distribution. GitHub Actions (`.github/workflows/build-desktop.yml`)
> builds the signed `.exe` on a Windows runner and the `.deb` on a Linux runner.

## Run in dev

```bash
cd desktop_agent
npm start
```

## Configuration

- Default backend: `https://hackerx-v7-d5s4.onrender.com` (override in the app's
  **Advanced → backend URL**, or with the `WORMGPT_API_BASE` env var).
- Session (JWT + user) is stored securely via `electron-store`.

## End-to-end test

```bash
cd desktop_agent
node e2e-test.js
```

Creates a throwaway account, runs a real coding task through the fusion brain +
sandbox, and asserts the SSE stream, the answer, and credit draining.
