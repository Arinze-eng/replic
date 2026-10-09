// ─────────────────────────────────────────────────────────────────────────────
// autoLiveScreen.js — make the LIVE sandbox screen turn ON AUTOMATICALLY.
//
// THE PROBLEM IT FIXES
//   Until now the real-time "watch the agent browse" screen only streamed when
//   the model explicitly called the `browse_live` tool. Every OTHER browsing
//   path — the plain `browse` (headless fetch), `browser_action` (remote
//   Browserless Puppeteer), `screenshot`, `solve_captcha`, `fetch_url` — did NOT
//   emit any `screen` frames. So when the agent browsed "normally" and the user
//   tapped the LIVE button (web or APK), they were stuck on "Connecting to the
//   live screen…" forever because no frames were ever sent.
//
// WHAT THIS DOES
//   It transparently ensures a liveScreen session is running INSIDE the sandbox
//   the FIRST time the agent touches ANY browsing/interaction tool, and keeps it
//   streaming `event: screen` frames over the SAME SSE channel the UI already
//   renders (web `agent-chat.html` + Flutter `agent_screen.dart`). It also
//   points the live browser at whatever URL the agent is visiting, so the user
//   literally watches the page the agent is working on — while the underlying
//   tool (headless/Browserless) still returns the page text the model reasons
//   about. The two run side-by-side; the live view is purely additive.
//
//   TWO ENTRY POINTS, because the engine has two runtimes:
//     • HOST-LOOP mode (runAgent): one persistent ctx per run → keyed off ctx.
//         use onBrowseTool(ctx, name, args) + stop(ctx).
//     • OWNS-THE-COMPUTER mode (runAgentInSandbox → runHostTool bridge): a FRESH
//         ctx per tool call, but a STABLE sandboxId → keyed off sandboxId.
//         use onBrowseToolBridge(fsx, name, args, onEvent, onStep) + stopSandbox(id).
//
// SAFETY / ADDITIVITY
//   • 100% best-effort: if the graphical stack can't boot (e.g. local host with
//     no X, or a backend that blocks it), it silently no-ops and the agent's
//     existing tools work EXACTLY as before. Nothing here can break a task.
//   • One session per run/sandbox. Booting is guarded so we only start it once;
//     subsequent browse calls just re-navigate the live browser.
//   • Auto-stops on run completion (stop / stopSandbox) and self-caps via
//     liveScreen's maxMs safety timer if a stop is ever missed.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const liveScreen = require('./liveScreen');
let cfBrowser = null;
try { cfBrowser = require('./cloudflareBrowserRun'); } catch (_) { cfBrowser = null; }
let browserless = null;
try { browserless = require('./browserless'); } catch (_) { browserless = null; }
let daytona = null;
try { daytona = require('./daytona'); } catch (_) { daytona = null; }
// agentEngine is required LAZILY inside boot() to avoid a circular import
// (agentEngine → autoLiveScreen → agentEngine).


// Per-ctx state lives on a hidden symbol so we never collide with engine fields
// and it is naturally garbage-collected with the ctx when the run ends.
const STATE = Symbol('autoLiveScreenState');

// Bridge-mode sessions are keyed by sandboxId (the ctx is recreated per call,
// so we can't hang state on it). Entries auto-expire so we never leak.
const sandboxSessions = new Map(); // sandboxId -> { session, booting, framesSent, lastUrl, failed, onEvent, expiresAt }
const SANDBOX_TTL_MS = 20 * 60 * 1000;

// Tools that mean "the agent is browsing / interacting with a page" and should
// therefore light up the live screen. `browse_live` is intentionally EXCLUDED
// because it manages its OWN dedicated session (and would double-stream).
const BROWSE_TOOLS = new Set([
  'browse', 'browser_action', 'screenshot', 'solve_captcha', 'captcha',
  'bypass_captcha', 'fetch_url',
]);

function isBrowseTool(name) {
  return BROWSE_TOOLS.has(String(name || '').toLowerCase());
}

// Pull a navigable URL out of whatever args the browse-class tool received.
function urlFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const u = args.url || args.link || args.href || args.target || '';
  return String(u || '').trim();
}

// Can this fsx host the in-sandbox desktop screen? Needs a sandbox-backed fsx
// with sh() (the virtual-display recipe runs shell + file download inside the
// box). This is the path used for the Daytona desktop.
function canSandboxScreen(fsx) {
  return !!(fsx && fsx.kind === 'sandbox' && typeof fsx.sh === 'function');
}

// Is the given fsx specifically a DAYTONA-backed sandbox? (browser-use prefers
// the Daytona computer first). We accept either the human label ("Daytona") or
// the backendMod identity matching the daytona module.
function isDaytonaFsx(fsx) {
  if (!canSandboxScreen(fsx)) return false;
  if (String(fsx.backend || '').toLowerCase() === 'daytona') return true;
  if (daytona && fsx.backendMod && fsx.backendMod === daytona) return true;
  return false;
}

// Is Daytona configured (env or admin DB key)? Cheap async probe, never throws.
async function daytonaEnabled() {
  if (!daytona) return false;
  try { if (daytona.enabledAsync) return !!(await daytona.enabledAsync()); } catch (_) {}
  try { return !!daytona.enabled(); } catch (_) { return false; }
}

// Acquire (or reuse) a DAYTONA-backed sandbox fsx on demand so the live screen
// can run on the Daytona computer even when the current run's fsx is the local
// host or a different backend. Best-effort: returns null on any failure.
//   • We pin the backend to Daytona ONLY for this acquisition by temporarily
//     using agentEngine.acquireSandboxFsx with a Daytona-first preference. To
//     keep it simple and avoid changing the admin's global selection, we call
//     daytona directly and wrap it in a minimal fsx via agentEngine's factory.
async function acquireDaytonaFsx(onStep, sessionKey) {
  if (!(await daytonaEnabled())) return null;
  let agentEngine = null;
  try { agentEngine = require('./agentEngine'); } catch (_) { agentEngine = null; }
  if (!agentEngine || typeof agentEngine.acquireSandboxFsxOn !== 'function') {
    // Fallback: use the generic acquireSandboxFsx (honours admin order). If the
    // admin already prefers Daytona this returns a Daytona fsx; otherwise we
    // accept whatever sandbox we get (still a real desktop) — but we only use
    // this when Daytona is enabled, so in practice it will be Daytona unless a
    // higher-priority backend is ALSO configured.
    if (agentEngine && typeof agentEngine.acquireSandboxFsx === 'function') {
      try {
        const fsx = await agentEngine.acquireSandboxFsx({ onStep, sessionKey });
        return fsx || null;
      } catch (_) { return null; }
    }
    return null;
  }
  try {
    return await agentEngine.acquireSandboxFsxOn('daytona', { onStep, sessionKey });
  } catch (_) { return null; }
}

function liveOpts(opts = {}) {
  return {
    fps: opts.fps || 3,
    quality: opts.quality || 60,
    width: opts.width || 1280,
    height: opts.height || 800,
    // Generous safety cap; a typical task is well under this and stop() is
    // called on completion anyway.
    maxMs: opts.maxMs || 12 * 60 * 1000,
  };
}

function emit(onEvent, payload) {
  try { if (typeof onEvent === 'function') onEvent('screen', payload); } catch (_) {}
}
function note(onStep, msg) {
  try { if (typeof onStep === 'function') onStep(msg); } catch (_) {}
}

// ── Core boot routine shared by both modes. `st` is the mutable state bag;
//    `getOnEvent` returns the CURRENT live SSE emitter (so frames always reach
//    whatever request is streaming right now). Returns the session or null.
//
//    PROVIDER ORDER (per product requirement):
//      1) 🖥️ DAYTONA DESKTOP  — a REAL Linux desktop (Xvfb + Chromium + noVNC)
//         running INSIDE the user's Daytona sandbox. This is the agent's own
//         "computer". If the current run's fsx is already Daytona-backed we use
//         it directly; otherwise, when Daytona is configured, we acquire a
//         Daytona sandbox on demand so browser-use ALWAYS prefers the Daytona
//         computer first. Exposes a click-free noVNC preview URL for the APK.
//      2) ☁️ CLOUDFLARE LIVE  — cloud headless Chrome → a WebView-ready
//         live.browser.run url. Used when Daytona can't come up.
//      3) 🖼️ BROWSERLESS      — server-rendered screenshot frames over SSE.
//         Final fallback so the user still SEES the browsing even with no
//         desktop and no Cloudflare.
async function boot(fsx, st, getOnEvent, onStep, opts) {
  if (st.failed) return null;
  if (st.session) return st.session;
  if (st.booting) { try { return await st.booting; } catch (_) { return null; } }

  st.booting = (async () => {
    try {
      // ── 1) 🖥️ DAYTONA DESKTOP (preferred — the agent's own computer) ─────
      // Prefer the Daytona-backed sandbox desktop. We accept the current fsx if
      // it is already Daytona; otherwise we try to acquire a Daytona sandbox on
      // demand (only when Daytona is configured). Any failure falls through to
      // Cloudflare → Browserless, so a task is NEVER blocked.
      let daytonaFsx = null;
      if (isDaytonaFsx(fsx)) {
        daytonaFsx = fsx;
      } else if (await daytonaEnabled()) {
        note(onStep, '🖥️ bringing up the Daytona computer for live browsing…');
        try {
          daytonaFsx = await acquireDaytonaFsx((n) => note(onStep, n), opts && opts.sessionKey);
          if (daytonaFsx) st.acquiredFsx = daytonaFsx; // remember so we can clean it up
        } catch (_) { daytonaFsx = null; }
      }

      if (daytonaFsx && canSandboxScreen(daytonaFsx)) {
        try {
          const session = await startSandboxScreen(daytonaFsx, st, getOnEvent, onStep, opts, 'daytona');
          if (session) return session;
        } catch (e) {
          note(onStep, 'ℹ️ Daytona desktop unavailable (' + String((e && e.message) || e).slice(0, 90) + ') — trying Cloudflare Live…');
        }
      }

      // ── 2) ☁️ CLOUDFLARE LIVE (fallback) ────────────────────────────────
      // No sandbox needed: the browser runs in Cloudflare's cloud and the app
      // loads the hosted live url in a WebView.
      let cfEnabled = false;
      try { cfEnabled = cfBrowser && (await cfBrowser.isEnabled()); } catch (_) { cfEnabled = false; }
      if (cfEnabled) {
        try {
          emit(getOnEvent(), { event: 'start', ts: Date.now(), backend: 'CloudflareBrowserRun', provider: 'cloudflare', auto: true });
          const session = await cfBrowser.start({
            onStep: (n) => note(onStep, n),
            keepAliveMs: (opts && opts.maxMs) || 600000,
          });
          st.session = session;
          st.provider = 'cloudflare';
          // Push the WebView-ready live url to the UI immediately.
          try {
            const url = await session.directUrl();
            if (url) {
              st.liveUrl = url;
              emit(getOnEvent(), { event: 'liveurl', liveUrl: url, provider: 'cloudflare', ts: Date.now(), auto: true });
              note(onStep, '🔗 Cloudflare Live ready — open the “Cloudflare Live” button to watch.');
            }
          } catch (_) {}
          return session;
        } catch (e) {
          // Cloudflare failed (token/permission/etc.) → fall through to Browserless.
          note(onStep, 'ℹ️ Cloudflare Live unavailable (' + String((e && e.message) || e).slice(0, 90) + ') — trying Browserless live view…');
        }
      }

      // ── 2b) Legacy in-sandbox screen on a NON-Daytona sandbox ────────────
      // If we never got a Daytona desktop but the CURRENT fsx is some other
      // sandbox (HopX/Runloop/local-sandbox), still use its desktop before
      // dropping to Browserless — it's a richer live view than screenshots.
      if (!isDaytonaFsx(fsx) && canSandboxScreen(fsx)) {
        try {
          const session = await startSandboxScreen(fsx, st, getOnEvent, onStep, opts, 'sandbox');
          if (session) return session;
        } catch (_) { /* fall through to Browserless */ }
      }

      // ── 3) 🖼️ BROWSERLESS LIVE (final fallback) ─────────────────────────
      // Server-rendered screenshots streamed as frames. Needs no sandbox and no
      // Cloudflare — guarantees the user still sees the agent browsing.
      let blAvailable = false;
      try { blAvailable = browserless && (await browserless.isAvailable()); } catch (_) { blAvailable = false; }
      if (blAvailable && typeof browserless.startLiveScreen === 'function') {
        try {
          emit(getOnEvent(), { event: 'start', ts: Date.now(), backend: 'Browserless', provider: 'browserless', auto: true });
          const o = liveOpts(opts);
          const session = await browserless.startLiveScreen({
            fps: 2, quality: o.quality, width: o.width, height: o.height, maxMs: o.maxMs,
            startUrl: opts && opts.startUrl,
            onStep: (n) => note(onStep, n),
            onFrame: (b64, meta) => {
              st.framesSent++;
              emit(getOnEvent(), { frame: b64, w: meta.w, h: meta.h, ts: meta.ts, n: meta.n });
            },
          });
          st.session = session;
          st.provider = 'browserless';
          note(onStep, '🖼️ Browserless live view streaming the agent\'s browsing.');
          return session;
        } catch (e) {
          note(onStep, 'ℹ️ Browserless live unavailable (' + String((e && e.message) || e).slice(0, 90) + ').');
        }
      }

      // Nothing could host a live view — degrade silently.
      st.failed = true;
      emit(getOnEvent(), { event: 'end', ts: Date.now(), error: 'no live provider available', auto: true });
      return null;
    } catch (e) {
      // No live provider could boot — degrade silently; the agent keeps using
      // its normal (headless/Browserless) browsing untouched.
      st.failed = true;
      emit(getOnEvent(), { event: 'end', ts: Date.now(), error: String((e && e.message) || e), auto: true });
      note(onStep, 'ℹ️ live screen unavailable here — continuing without the live view.');
      return null;
    } finally {
      st.booting = null;
    }
  })();

  try { return await st.booting; } catch (_) { return null; }
}

// Boot the in-sandbox desktop screen (Xvfb + Chromium + noVNC) on a sandbox-
// backed fsx and wire its frames + noVNC preview URL into the SSE stream.
// `providerTag` is the provider label emitted to the UI ('daytona' or 'sandbox').
// Returns the session, or throws if the graphical stack can't boot.
async function startSandboxScreen(fsx, st, getOnEvent, onStep, opts, providerTag) {
  emit(getOnEvent(), { event: 'start', ts: Date.now(), backend: fsx.backend, provider: providerTag, auto: true });

  const o = liveOpts(opts);
  const session = await liveScreen.start(fsx, {
    fps: o.fps, quality: o.quality, width: o.width, height: o.height, maxMs: o.maxMs,
    onStep: (n) => note(onStep, n),
    onFrame: (b64, meta) => {
      st.framesSent++;
      emit(getOnEvent(), { frame: b64, w: meta.w, h: meta.h, ts: meta.ts, n: meta.n });
    },
  });
  st.session = session;
  st.provider = providerTag;

  // Resolve the sandbox web-VNC preview URL (Daytona proxy → noVNC) as the
  // reliable live url; frames still flow as a fallback.
  (async () => {
    try {
      if (st.liveUrl || typeof session.directUrl !== 'function') return;
      const url = await session.directUrl();
      if (url) {
        st.liveUrl = url;
        emit(getOnEvent(), { event: 'liveurl', liveUrl: url, provider: providerTag, ts: Date.now(), auto: true });
        note(onStep, '🔗 ' + (providerTag === 'daytona' ? 'Daytona desktop' : 'live screen') + ' ready — streaming the agent\'s real-time computer.');
      }
    } catch (_) {}
  })();

  return session;
}

// True when SOME live provider can run for this run (Daytona/sandbox desktop,
// Cloudflare, or Browserless).
async function liveAvailable(fsx) {
  if (canSandboxScreen(fsx)) return true;
  try { if (await daytonaEnabled()) return true; } catch (_) {}
  try { if (cfBrowser && (await cfBrowser.isEnabled())) return true; } catch (_) {}
  try { if (browserless && (await browserless.isAvailable())) return true; } catch (_) {}
  return false;
}


// ═════════════════════════════════════════════════════════════════════════════
// HOST-LOOP mode (runAgent): state hangs off the ctx.
// ═════════════════════════════════════════════════════════════════════════════

async function ensure(ctx, opts = {}) {
  if (!ctx) return null;
  if (!(await liveAvailable(ctx.fsx))) return null;
  let st = ctx[STATE];
  if (!st) st = ctx[STATE] = { session: null, booting: null, framesSent: 0, lastUrl: '', failed: false };
  return boot(ctx.fsx, st, () => ctx.onEvent, ctx.onStep, opts);
}

// Called BEFORE a browse-class tool runs: make sure the live screen is up and
// (best-effort) navigate it to the URL the agent is about to visit. Fire-and-
// forget — never delays/blocks the real tool.
function onBrowseTool(ctx, name, args) {
  if (!isBrowseTool(name)) return;
  if (!ctx) return;
  // Note: do NOT hard-gate on a sandbox here — Cloudflare Live needs none.
  // ensure()/boot() re-check provider availability and return null if neither
  // Cloudflare nor a sandbox screen can run.
  const url = urlFromArgs(args);
  ensure(ctx).then((session) => {
    if (!session) return;
    const st = ctx[STATE];
    if (url && st && url !== st.lastUrl) {
      st.lastUrl = url;
      try { session.openUrl(url); } catch (_) {}
    }
  }).catch(() => {});
}

// Stop the host-loop live session (called from the engine's finally).
async function stop(ctx) {
  const st = ctx && ctx[STATE];
  if (!st) return;
  const session = st.session;
  st.session = null;
  if (session) { try { await session.stop(); } catch (_) {} }
  // If we acquired an EPHEMERAL Daytona sandbox just for the live screen (i.e.
  // the run's own fsx was not Daytona), tear it down so we don't leak it. A
  // PERSISTENT session sandbox is left alone (cleanup is a no-op there).
  if (st.acquiredFsx && st.acquiredFsx !== (ctx && ctx.fsx)) {
    try { if (typeof st.acquiredFsx.cleanup === 'function') await st.acquiredFsx.cleanup(); } catch (_) {}
    st.acquiredFsx = null;
  }
  emit(ctx.onEvent, { event: 'end', ts: Date.now(), frames: st.framesSent, auto: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// OWNS-THE-COMPUTER (bridge) mode (runHostTool): state keyed by sandboxId.
// ═════════════════════════════════════════════════════════════════════════════

function pruneSandboxSessions() {
  const now = Date.now();
  for (const [id, st] of sandboxSessions) {
    if (st.expiresAt && st.expiresAt < now && !st.session && !st.booting) sandboxSessions.delete(id);
  }
}

// Called BEFORE a browse-class HOST tool runs in bridge mode. `fsx` is bound to
// the persistent sandbox, `onEvent` streams to the CURRENT live SSE request.
function onBrowseToolBridge(fsx, name, args, onEvent, onStep) {
  if (!isBrowseTool(name)) return;
  // Cloudflare Live needs no sandbox; only skip if we have NEITHER a sandbox nor
  // (potentially) Cloudflare. We resolve availability inside boot(), so here we
  // just require an fsx object to key the session.
  if (!fsx) return;
  const id = fsx.sandboxId || fsx.id || 'default';
  let st = sandboxSessions.get(id);
  if (!st) {
    st = { session: null, booting: null, framesSent: 0, lastUrl: '', failed: false, onEvent, expiresAt: Date.now() + SANDBOX_TTL_MS };
    sandboxSessions.set(id, st);
  }
  // Always point frames at the most recent live stream.
  st.onEvent = onEvent;
  st.expiresAt = Date.now() + SANDBOX_TTL_MS;
  if (st.failed) return;

  const url = urlFromArgs(args);
  boot(fsx, st, () => st.onEvent, onStep, {}).then((session) => {
    if (!session) return;
    if (url && url !== st.lastUrl) {
      st.lastUrl = url;
      try { session.openUrl(url); } catch (_) {}
    }
  }).catch(() => {});
  pruneSandboxSessions();
}

// Stop the bridge live session for a sandbox (called when the worker task ends).
async function stopSandbox(sandboxId) {
  const id = sandboxId || 'default';
  const st = sandboxSessions.get(id);
  if (!st) return;
  const session = st.session;
  st.session = null;
  if (session) { try { await session.stop(); } catch (_) {} }
  // Tear down any ephemeral Daytona sandbox we acquired solely for the live
  // screen. The persistent task sandbox (keyed by `id`) is NEVER touched here.
  if (st.acquiredFsx && (st.acquiredFsx.sandboxId !== id)) {
    try { if (typeof st.acquiredFsx.cleanup === 'function') await st.acquiredFsx.cleanup(); } catch (_) {}
    st.acquiredFsx = null;
  }
  emit(st.onEvent, { event: 'end', ts: Date.now(), frames: st.framesSent, auto: true });
  sandboxSessions.delete(id);
}

module.exports = {
  isBrowseTool,
  liveAvailable,
  // host-loop mode
  ensure, onBrowseTool, stop,
  // bridge mode
  onBrowseToolBridge, stopSandbox,
};
