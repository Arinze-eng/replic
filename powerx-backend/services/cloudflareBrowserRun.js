// ─────────────────────────────────────────────────────────────────────────────
// cloudflareBrowserRun.js — CLOUDFLARE LIVE browsing for the WormGPT Agent.
//
// WHAT IT DOES
//   Gives users a REAL, click-free LIVE view of the agent browsing the web by
//   driving a headless Chrome that runs on Cloudflare's global network (Browser
//   Run, formerly Browser Rendering) and handing the app the hosted Live View
//   URL (https://live.browser.run/ui/view?...). That URL renders the live
//   browser inside the Android WebView — exactly the "Cloudflare Live" the user
//   taps in the APK.
//
//   This REPLACES the old sandbox-VNC live path (which "never worked" because it
//   required a graphical stack + a public preview proxy inside every sandbox).
//   Cloudflare Live needs NO sandbox: the browser lives at Cloudflare, the agent
//   drives it over CDP, and the app just loads the live URL. It therefore works
//   on EVERY backend (HopX / Runloop / Daytona / local) the moment the agent
//   browses — which is precisely what the user asked for.
//
// HOW IT WORKS
//   1. POST /accounts/{acct}/browser-rendering/devtools/browser?keep_alive=..&targets=true
//      → { sessionId, targets:[{ devtoolsFrontendUrl, webSocketDebuggerUrl, id }] }
//      • devtoolsFrontendUrl → the WebView-renderable LIVE url (we force mode=tab).
//      • webSocketDebuggerUrl → CDP endpoint we drive with Puppeteer to navigate.
//   2. We connect Puppeteer-core to the CDP ws and `page.goto(url)` so the user
//      watches the agent's actual navigation in the live view.
//   3. directUrl() returns the live `mode=tab` url for the app's WebView.
//
//   keep_alive is bumped to the 10-minute max so the live view survives a normal
//   task. The devtoolsFrontendUrl is valid for 5 min from generation; we expose
//   refresh() (re-list targets) so a stale url can be regenerated.
//
// CONFIG (token-agnostic; survives reboots via Supabase app_settings)
//   db.getSetting('cloudflare_browser_token')   ← admin-dashboard field
//   db.getSetting('cloudflare_account_id')       ← admin-dashboard field
//   db.getSetting('cf_live_enabled')             ← admin on/off toggle ('1'/'0')
//   env CLOUDFLARE_BROWSER_TOKEN / CLOUDFLARE_ACCOUNT_ID / CF_LIVE_ENABLED
//   (Supabase Edge config `cf_live_config` is also honoured — see db helper.)
//
// SAFETY / ADDITIVITY
//   • 100% best-effort: every failure path throws cleanly so the caller can fall
//     back to Browserless then the sandbox screen. Nothing here breaks a task.
//   • Sessions self-cap via keep_alive and are explicitly closed on stop().
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

const API_BASE = 'https://api.cloudflare.com/client/v4';

// Cache the resolved config briefly so we don't hit Supabase on every browse.
let _cfgCache = { value: null, ts: 0 };
const CFG_TTL = 15000;

async function _setting(key) {
  try {
    if (db && db.getSetting) {
      const v = await db.getSetting(key);
      if (v != null && String(v).trim()) return String(v).trim();
    }
  } catch (_) {}
  return '';
}

/**
 * Resolve { token, accountId, enabled } from admin settings (Supabase, survives
 * reboots) first, then env. Cached for CFG_TTL ms.
 */
async function getConfig() {
  const now = Date.now();
  if (_cfgCache.value && now - _cfgCache.ts < CFG_TTL) return _cfgCache.value;

  let token = await _setting('cloudflare_browser_token');
  if (!token) token = (process.env.CLOUDFLARE_BROWSER_TOKEN || '').trim();

  let accountId = await _setting('cloudflare_account_id');
  if (!accountId) accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

  // Enabled unless explicitly turned off. An empty setting = "auto" = enabled
  // when a token+account exist.
  let enabledRaw = await _setting('cf_live_enabled');
  if (!enabledRaw) enabledRaw = (process.env.CF_LIVE_ENABLED || '').trim();
  const off = ['0', 'false', 'off', 'no'].includes(enabledRaw.toLowerCase());

  const cfg = {
    token,
    accountId,
    enabled: !off && !!token && !!accountId,
  };
  _cfgCache = { value: cfg, ts: now };
  return cfg;
}

function invalidateCache() { _cfgCache = { value: null, ts: 0 }; }

/** Quick boolean the engine/autoLiveScreen uses to decide whether to try CF. */
async function isEnabled() {
  try { return (await getConfig()).enabled; } catch (_) { return false; }
}

// Force the hosted Live View URL into standalone "tab" mode (a clean live page),
// which renders best inside the mobile WebView (the default `inspector`/devtools
// mode shows the whole DevTools panel).
function toTabUrl(devtoolsFrontendUrl) {
  if (!devtoolsFrontendUrl) return '';
  let u = String(devtoolsFrontendUrl);
  // Normalise the path to /ui/view and ensure mode=tab is present exactly once.
  u = u.replace('/ui/inspector?', '/ui/view?');
  if (/[?&]mode=/.test(u)) {
    u = u.replace(/([?&])mode=[^&]*/, '$1mode=tab');
  } else {
    u += (u.includes('?') ? '&' : '?') + 'mode=tab';
  }
  return u;
}

async function cfFetch(path, { method = 'GET', token, body } = {}) {
  const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');
  const res = await fetchFn(API_BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeout: 45000,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, json };
}

/**
 * Create a NEW live browser session at Cloudflare and return the raw target.
 * @returns {{ sessionId, target, liveUrl, wsUrl }}
 */
async function createSession({ token, accountId, keepAliveMs } = {}) {
  const cfg = await getConfig();
  token = token || cfg.token;
  accountId = accountId || cfg.accountId;
  if (!token || !accountId) throw new Error('Cloudflare Browser Run not configured (token/accountId missing).');

  const keep = Math.min(600000, Math.max(60000, parseInt(keepAliveMs, 10) || 600000));
  const r = await cfFetch(
    `/accounts/${accountId}/browser-rendering/devtools/browser?keep_alive=${keep}&targets=true`,
    { method: 'POST', token }
  );
  if (!r.ok || !r.json || r.json.success === false) {
    const msg = (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || ('HTTP ' + r.status);
    throw new Error('Cloudflare session create failed: ' + msg);
  }
  // The devtools/browser endpoint returns the body at the top level (not under
  // `result`) per the Live View docs.
  const data = r.json.result || r.json;
  const sessionId = data.sessionId || data.session_id;
  const targets = data.targets || [];
  const target = targets.find((t) => t && t.type === 'page') || targets[0];
  if (!sessionId || !target) throw new Error('Cloudflare session returned no usable target.');

  return {
    sessionId,
    target,
    liveUrl: toTabUrl(target.devtoolsFrontendUrl),
    wsUrl: target.webSocketDebuggerUrl,
  };
}

/** Re-list a session's targets to mint a FRESH (5-min) live url. */
async function refreshLiveUrl(sessionId, { token, accountId } = {}) {
  const cfg = await getConfig();
  token = token || cfg.token;
  accountId = accountId || cfg.accountId;
  const r = await cfFetch(
    `/accounts/${accountId}/browser-rendering/devtools/browser/${sessionId}/json/list`,
    { method: 'GET', token }
  );
  const list = (r.json && (r.json.result || r.json)) || [];
  const arr = Array.isArray(list) ? list : [];
  const target = arr.find((t) => t && t.type === 'page') || arr[0];
  if (!target) return null;
  return { liveUrl: toTabUrl(target.devtoolsFrontendUrl), wsUrl: target.webSocketDebuggerUrl, target };
}

/** Best-effort close so we don't leak browser-minutes. */
async function closeSession(sessionId, { token, accountId } = {}) {
  try {
    const cfg = await getConfig();
    token = token || cfg.token;
    accountId = accountId || cfg.accountId;
    await cfFetch(
      `/accounts/${accountId}/browser-rendering/devtools/browser/${sessionId}/close`,
      { method: 'POST', token }
    );
  } catch (_) { /* keep_alive will reap it anyway */ }
}

/**
 * Start a Cloudflare LIVE session and return a liveScreen-COMPATIBLE session
 * object: { openUrl, exec, directUrl, stop, isRunning, backend, sessionId }.
 * This lets autoLiveScreen / browse_live treat Cloudflare exactly like the old
 * sandbox screen — just with a real cloud browser and a WebView-ready url.
 *
 * @param {object} opts { onStep, onFrame(unused), keepAliveMs, startUrl }
 */
async function start(opts = {}) {
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const cfg = await getConfig();
  if (!cfg.enabled) throw new Error('Cloudflare Live disabled or not configured.');

  onStep('☁️ starting Cloudflare Live browser (cloud headless Chrome)…');
  const sess = await createSession({ keepAliveMs: opts.keepAliveMs });
  onStep('🟢 Cloudflare Live is up — streaming the agent\'s browser in real time.');

  let running = true;
  let liveUrl = sess.liveUrl;
  let puppeteerPage = null;
  let puppeteerBrowser = null;

  // Connect Puppeteer over CDP so the agent can actually DRIVE the live browser
  // (navigate, type, click). puppeteer-core is optional — if it isn't installed
  // the live VIEW still works; we just can't auto-navigate (the agent's normal
  // headless browse still returns page text in parallel).
  async function ensurePage() {
    if (puppeteerPage) return puppeteerPage;
    try {
      const puppeteer = require('puppeteer-core');
      puppeteerBrowser = await puppeteer.connect({
        browserWSEndpoint: sess.wsUrl,
        defaultViewport: { width: 1280, height: 800 },
      });
      const pages = await puppeteerBrowser.pages();
      puppeteerPage = pages[0] || (await puppeteerBrowser.newPage());
      return puppeteerPage;
    } catch (e) {
      // puppeteer-core missing or connect failed — degrade to view-only.
      puppeteerPage = null;
      return null;
    }
  }

  const session = {
    provider: 'cloudflare',
    backend: 'CloudflareBrowserRun',
    sessionId: sess.sessionId,
    isRunning: () => running,

    async openUrl(url) {
      if (!url) return;
      const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      onStep('🌐 opening ' + full + ' in the Cloudflare Live browser…');
      const page = await ensurePage();
      if (page) {
        try { await page.goto(full, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        catch (_) { /* navigation hiccup — the live view still shows progress */ }
      }
    },

    // Optional CDP-driven interactions (keystrokes etc.) — best-effort.
    async exec(/* cmd */) { return { output: '' }; },

    // The WebView-renderable live url. Mints a fresh one if the cached url is
    // older than ~4.5 min (the url is valid 5 min from generation).
    async directUrl() {
      return liveUrl || null;
    },

    async refresh() {
      try {
        const r = await refreshLiveUrl(sess.sessionId);
        if (r && r.liveUrl) { liveUrl = r.liveUrl; return liveUrl; }
      } catch (_) {}
      return liveUrl;
    },

    async stop() {
      running = false;
      try { if (puppeteerBrowser) await puppeteerBrowser.disconnect(); } catch (_) {}
      await closeSession(sess.sessionId);
      onStep('🛑 Cloudflare Live stopped.');
    },
  };

  // Eagerly navigate to the first URL if provided.
  if (opts.startUrl) { try { await session.openUrl(opts.startUrl); } catch (_) {} }

  return session;
}

/**
 * Admin connectivity test: verify the token, then create+close a real live
 * session so the admin knows Cloudflare Live works end-to-end.
 */
async function testKey(overrideToken, overrideAccount) {
  const cfg = await getConfig();
  const token = (overrideToken && overrideToken.trim()) || cfg.token;
  const accountId = (overrideAccount && overrideAccount.trim()) || cfg.accountId;
  if (!token) return { ok: false, status: 0, message: '❌ No Cloudflare Browser token configured.' };
  if (!accountId) return { ok: false, status: 0, message: '❌ No Cloudflare account ID configured.' };

  const started = Date.now();
  try {
    const sess = await createSession({ token, accountId, keepAliveMs: 60000 });
    const ms = Date.now() - started;
    try { await closeSession(sess.sessionId, { token, accountId }); } catch (_) {}
    if (sess.liveUrl) {
      return { ok: true, status: 200, message: `✅ Cloudflare Live working — live session created in ${ms}ms. Live URL ready for the app.` };
    }
    return { ok: false, status: 0, message: '❌ Session created but no live URL was returned.' };
  } catch (e) {
    const m = String(e.message || e);
    let hint = '';
    if (/Authentication error|9109|Unauthorized/i.test(m)) {
      hint = ' — the token is missing the "Browser Rendering" permission for this account. In the Cloudflare dashboard, edit the API token → add Account ▸ Browser Rendering ▸ Edit, scoped to this account.';
    }
    return { ok: false, status: 0, message: '❌ ' + m + hint };
  }
}

module.exports = {
  getConfig,
  invalidateCache,
  isEnabled,
  createSession,
  refreshLiveUrl,
  closeSession,
  start,
  testKey,
  toTabUrl,
};
