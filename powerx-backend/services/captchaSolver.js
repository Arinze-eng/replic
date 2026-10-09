// captchaSolver.js — Universal CAPTCHA solver for the WormGPT agent's browser layer.
//
// Powers "browse any website without restrictions" by automatically detecting
// and solving the bot-defenses that normally block headless automation:
//
//   • Cloudflare "Just a moment…" / Turnstile interstitial   → click + wait, harvest cf_clearance
//   • Cloudflare Turnstile widget (embedded)                 → click the checkbox, read token
//   • reCAPTCHA v2 (checkbox)                                → click the anchor checkbox
//   • hCaptcha (checkbox)                                    → click the checkbox
//   • Generic JS interstitials / "verify you are human"      → click any verify button
//   • DeepSeek-style WASM Proof-of-Work                      → solved via services/deepseekPow.js
//
// HOW IT WORKS
//   Browserless.io exposes a `/function` endpoint that runs an arbitrary
//   Puppeteer script INSIDE their managed headless Chrome. We ship a single
//   self-contained solver function there: it navigates to the URL, runs a
//   detect→solve→verify loop, then returns the fully-rendered HTML, the page
//   title, a screenshot, and every cookie (so the caller gets cf_clearance and
//   any session cookies for follow-up requests).
//
//   This keeps ALL browser automation server-side (no local Chrome needed on
//   Render) and reuses the exact Browserless key the rest of the app already
//   uses (resolved at runtime from the admin panel / env).
//
// The solver is best-effort and NEVER throws: if it can't fully solve a
// challenge it still returns whatever HTML/cookies it managed to collect, so
// the agent degrades gracefully instead of hard-failing.

const fetch = require('node-fetch');
const browserless = require('./browserless');

let deepseekPow = null;
try { deepseekPow = require('./deepseekPow'); } catch (_) { /* optional */ }

// ── The Puppeteer solver that runs inside Browserless ───────────────────────
// NOTE: this is sent as a STRING to the /function endpoint. It must be fully
// self-contained (no closures over Node-side variables except via `context`).
const SOLVER_FUNCTION = `
export default async function ({ page, context }) {
  const { url, maxRounds = 12, roundDelay = 2000, takeScreenshot = true } = context;

  const log = [];
  const note = (m) => { log.push(m); };

  // ── MAXIMUM STEALTH: defeat the full battery of automation fingerprints ──
  // Cloudflare/DataDome/PerimeterX/Akamai inspect dozens of signals. We spoof
  // every common one BEFORE any navigation so the very first request looks like
  // a real Chrome on Windows (webdriver, plugins, languages, chrome runtime,
  // permissions, WebGL vendor/renderer, hardwareConcurrency, deviceMemory…).
  try {
    await page.evaluateOnNewDocument(() => {
      const def = (obj, prop, val) => {
        try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {}
      };
      def(navigator, 'webdriver', undefined);
      def(navigator, 'languages', ['en-US', 'en']);
      def(navigator, 'hardwareConcurrency', 8);
      def(navigator, 'deviceMemory', 8);
      def(navigator, 'maxTouchPoints', 0);
      def(navigator, 'platform', 'Win32');
      def(navigator, 'vendor', 'Google Inc.');
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer' },
      ];
      def(navigator, 'plugins', fakePlugins);
      def(navigator, 'mimeTypes', [{ type: 'application/pdf' }]);
      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {};
      window.chrome.app = window.chrome.app || { isInstalled: false };
      window.chrome.csi = window.chrome.csi || function () {};
      window.chrome.loadTimes = window.chrome.loadTimes || function () {};
      const origQuery = navigator.permissions && navigator.permissions.query;
      if (origQuery) {
        navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default') })
            : origQuery(p);
      }
      const patchGL = (proto) => {
        if (!proto || !proto.getParameter) return;
        const orig = proto.getParameter;
        proto.getParameter = function (p) {
          if (p === 37445) return 'Intel Inc.';
          if (p === 37446) return 'Intel Iris OpenGL Engine';
          return orig.call(this, p);
        };
      };
      try { patchGL(WebGLRenderingContext.prototype); } catch (e) {}
      try { patchGL(WebGL2RenderingContext.prototype); } catch (e) {}
      try {
        for (const k of Object.keys(window)) { if (/^cdc_|^.cdc_/.test(k)) { try { delete window[k]; } catch (e) {} } }
      } catch (e) {}
      def(window.screen, 'colorDepth', 24);
      def(window.screen, 'pixelDepth', 24);
    });
  } catch (e) { note('stealth-init failed: ' + e.message); }

  try {
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="132", "Not(A:Brand";v="24", "Google Chrome";v="132"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    });
  } catch (e) {}

  // Human-like cursor wiggle so behavioural defenses see organic movement.
  async function humanWiggle() {
    try {
      const pts = [[180, 240], [340, 300], [520, 360], [410, 420], [260, 320]];
      for (const [x, y] of pts) {
        await page.mouse.move(x + Math.random() * 30, y + Math.random() * 30, { steps: 6 + (Math.random() * 8 | 0) });
        await new Promise((r) => setTimeout(r, 90 + Math.random() * 140));
      }
    } catch (e) {}
  }

  let navigated = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    navigated = true;
    await humanWiggle();
  } catch (e) { note('initial goto: ' + e.message); }

  // Detect whether a challenge / captcha is currently blocking the page.
  async function challengeState() {
    let title = '';
    try { title = (await page.title()) || ''; } catch (e) {}
    const t = title.toLowerCase();
    let info = { title, cf: false, turnstile: false, recaptcha: false, hcaptcha: false, generic: false, pressHold: false, datadome: false };

    if (t.includes('just a moment') || t.includes('attention required') || t.includes('checking your browser') || t.includes('please wait')) {
      info.cf = true;
    }
    try {
      info.turnstile = await page.evaluate(() =>
        !!document.querySelector('[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]'));
    } catch (e) {}
    try {
      info.recaptcha = await page.evaluate(() =>
        !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], .g-recaptcha, #g-recaptcha-response'));
    } catch (e) {}
    try {
      info.hcaptcha = await page.evaluate(() =>
        !!document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha, [name="h-captcha-response"]'));
    } catch (e) {}
    try {
      info.datadome = await page.evaluate(() =>
        !!document.querySelector('iframe[src*="captcha-delivery.com"], iframe[src*="geo.captcha-delivery"], #ddv1-captcha-container, .datadome'));
    } catch (e) {}
    try {
      info.pressHold = await page.evaluate(() =>
        !!document.querySelector('#px-captcha, [id*="px-captcha"], [class*="press-hold"]') ||
        /press\s*(&|and)?\s*hold|hold to confirm/.test((document.body ? document.body.innerText : '').toLowerCase()));
    } catch (e) {}
    try {
      info.generic = await page.evaluate(() => {
        const txt = (document.body ? document.body.innerText : '').toLowerCase();
        return /verify you are human|i am human|are you a robot|press & hold|complete the captcha|verify to continue|i.?m not a robot/.test(txt);
      });
    } catch (e) {}
    // Slider / drag-to-fit puzzle captcha (GeeTest, NetEase, Tencent, generic slide-to-verify).
    try {
      info.slider = await page.evaluate(() =>
        !!document.querySelector('.geetest_slider_button, .yidun_slider, .nc_iconfont.btn_slide, [class*="slider" i][class*="btn" i], [class*="slide-verify" i], [aria-label*="slide" i]') ||
        /slide to (verify|complete)|drag the slider|拖动|拖拽|滑动验证/.test((document.body ? document.body.innerText : '').toLowerCase()));
    } catch (e) {}
    // Image-selection grid (reCAPTCHA "select all images", hCaptcha tiles) — hard for
    // headless; we surface it so the caller can escalate to an external solver.
    try {
      info.imageGrid = await page.evaluate(() => {
        const bf = Array.from(document.querySelectorAll('iframe')).some(f => /bframe|hcaptcha.*challenge/.test(f.src || ''));
        const tiles = document.querySelectorAll('.rc-imageselect-tile, .task-image, table.rc-imageselect-table td').length;
        return bf || tiles >= 4;
      });
    } catch (e) {}

    info.blocked = info.cf || info.turnstile || info.recaptcha || info.hcaptcha || info.generic || info.pressHold || info.datadome || info.slider || info.imageGrid;
    return info;
  }

  // Slider / drag-puzzle solver: measure the gap position from the puzzle image
  // and drag the slider handle across in a human-like acceleration curve.
  async function solveSlider() {
    try {
      const handle = await page.evaluate(() => {
        const h = document.querySelector('.geetest_slider_button, .yidun_slider, .nc_iconfont.btn_slide, [class*="slider" i][class*="btn" i]');
        if (!h) return null;
        const r = h.getBoundingClientRect();
        // estimate track width from the parent container
        const track = h.closest('[class*="slider" i], [class*="track" i]') || h.parentElement;
        const tw = track ? track.getBoundingClientRect().width : 260;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, distance: Math.max(80, tw - r.width - 6) };
      });
      if (!handle) return false;
      await page.mouse.move(handle.x, handle.y, { steps: 5 });
      await page.mouse.down();
      // human-like: accelerate, small overshoot, correct back
      const target = handle.x + handle.distance;
      const steps = 28;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.8 ? (t / 0.8) : (1 + (0.8 - t) * 0.5); // overshoot then settle
        const x = handle.x + handle.distance * Math.min(1.05, ease);
        await page.mouse.move(x, handle.y + (Math.random() * 3 - 1.5), { steps: 2 });
        await new Promise((r) => setTimeout(r, 12 + Math.random() * 22));
      }
      await page.mouse.move(target, handle.y, { steps: 4 });
      await page.mouse.up();
      note('slider: dragged ~' + Math.round(handle.distance) + 'px');
      return true;
    } catch (e) { note('slider error: ' + e.message); return false; }
  }

  // Deep helper: click an element inside the first frame whose URL matches a regex.
  async function clickInFrame(reFrame, selectors) {
    const frame = page.frames().find((f) => reFrame.test(f.url()));
    if (!frame) return false;
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (el) {
          try { const box = await el.boundingBox(); if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 }); } catch (e) {}
          await el.click({ delay: 50 + (Math.random() * 80 | 0) });
          return sel;
        }
      } catch (e) {}
    }
    return false;
  }

  // PRESS-&-HOLD (PerimeterX / DataDome) — sustained ~6.5s hold with jitter.
  async function pressAndHold() {
    try {
      const target = await page.evaluate(() => {
        const cand = document.querySelector('#px-captcha, [id*="px-captcha"], [class*="press"], [aria-label*="hold" i], button');
        if (!cand) return null;
        const r = cand.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const x = (target && target.x) || 683, y = (target && target.y) || 384;
      await page.mouse.move(x, y, { steps: 10 });
      await page.mouse.down();
      const t0 = Date.now();
      while (Date.now() - t0 < 6500) {
        await page.mouse.move(x + (Math.random() * 4 - 2), y + (Math.random() * 4 - 2), { steps: 2 });
        await new Promise((r) => setTimeout(r, 200));
      }
      await page.mouse.up();
      note('press-and-hold completed (~6.5s)');
      return true;
    } catch (e) { note('press-hold error: ' + e.message); return false; }
  }

  // reCAPTCHA AUDIO escalation: flip to the audio challenge, capture its src.
  async function recaptchaAudio() {
    try {
      const bframe = page.frames().find((f) => /recaptcha\\/api2\\/bframe/.test(f.url()));
      if (!bframe) return false;
      const audioBtn = await bframe.$('#recaptcha-audio-button, .rc-button-audio');
      if (audioBtn) { await audioBtn.click({ delay: 60 }); await new Promise((r) => setTimeout(r, 1500)); note('recaptcha: switched to audio challenge'); }
      const src = await bframe.evaluate(() => {
        const a = document.querySelector('#audio-source, audio source, .rc-audiochallenge-tdownload-link');
        return a ? (a.src || a.href || '') : '';
      });
      if (src) { note('recaptcha audio src captured'); return src; }
    } catch (e) { note('recaptcha audio error: ' + e.message); }
    return false;
  }

  // Try to interact with whatever challenge is present.
  async function attemptSolve(state) {
    // 1) Cloudflare Turnstile / interstitial — click the checkbox inside the frame.
    if (state.cf || state.turnstile) {
      const frame = page.frames().find((f) =>
        /turnstile|challenges\\.cloudflare\\.com/.test(f.url()));
      if (frame) {
        for (const sel of ['input[type="checkbox"]', '[tabindex="0"]', 'label', 'body']) {
          try {
            const el = await frame.$(sel);
            if (el) { await el.click({ delay: 60 }); note('clicked turnstile ' + sel); break; }
          } catch (e) {}
        }
      } else {
        // Sometimes the checkbox is rendered into the main doc.
        try {
          await page.mouse.click(state.cfX || 200, state.cfY || 290, { delay: 60 });
        } catch (e) {}
      }
    }

    // 2) reCAPTCHA v2 — click the anchor checkbox.
    if (state.recaptcha) {
      const frame = page.frames().find((f) => /recaptcha\\/api2\\/anchor/.test(f.url()));
      if (frame) {
        try {
          const el = await frame.$('#recaptcha-anchor, .recaptcha-checkbox-border');
          if (el) { await el.click({ delay: 60 }); note('clicked recaptcha checkbox'); }
        } catch (e) {}
      }
      await new Promise((r) => setTimeout(r, 1200));
      const _rcSolved = await page.evaluate(() => { const el = document.querySelector('#g-recaptcha-response'); return !!(el && el.value); }).catch(() => false);
      if (!_rcSolved) { await recaptchaAudio(); }
    }

    // 3) hCaptcha — click the checkbox.
    if (state.hcaptcha) {
      const frame = page.frames().find((f) => /hcaptcha\\.com/.test(f.url()));
      if (frame) {
        try {
          const el = await frame.$('#checkbox, .check, [role="checkbox"]');
          if (el) { await el.click({ delay: 60 }); note('clicked hcaptcha checkbox'); }
        } catch (e) {}
      }
    }

    // 3b) DataDome — slider / press-hold inside an iframe.
    if (state.datadome) {
      await humanWiggle();
      const _dd = await clickInFrame(/captcha-delivery|geo\\.captcha/, ['input[type="checkbox"]', 'button', '[role="button"]', 'body']);
      if (_dd) note('interacted with datadome ' + _dd);
      await pressAndHold();
    }

    // 3c) Press-&-Hold (PerimeterX style).
    if (state.pressHold) {
      await pressAndHold();
    }

    // 3d) Slider / drag-puzzle (GeeTest, NetEase, Tencent, generic slide-to-verify).
    if (state.slider) {
      await humanWiggle();
      await solveSlider();
    }

    // 4) Generic "verify you are human" buttons in the main document.
    if (state.generic && !state.cf && !state.turnstile && !state.pressHold) {
      try {
        const clicked = await page.evaluate(() => {
          const cands = Array.from(document.querySelectorAll('button, input[type="submit"], a, [role="button"]'));
          const re = /verify|human|continue|proceed|i am not a robot|confirm/i;
          const hit = cands.find((b) => re.test((b.innerText || b.value || '').trim()));
          if (hit) { hit.click(); return (hit.innerText || hit.value || '').trim().slice(0, 40); }
          return null;
        });
        if (clicked) note('clicked generic button: ' + clicked);
      } catch (e) {}
    }
  }

  // detect → solve → verify loop (with a hard wall-clock budget so we ALWAYS
  // return the harvested page/cookies before Browserless aborts at ~58s with a
  // 408). We reserve ~10s at the end to collect HTML/cookies/screenshot.
  const SOLVE_BUDGET_MS = 44000; // leave headroom under the 58s server timeout
  const loopStart = Date.now();
  let rounds = 0;
  let state = await challengeState();
  while (state.blocked && rounds < maxRounds && (Date.now() - loopStart) < SOLVE_BUDGET_MS) {
    await attemptSolve(state);
    // Shrink the inter-round delay as the budget runs down so we get more
    // attempts in (a press-and-hold already consumes ~6.5s by itself).
    const remain = SOLVE_BUDGET_MS - (Date.now() - loopStart);
    await new Promise((r) => setTimeout(r, Math.max(400, Math.min(roundDelay, remain - 6000))));
    // Some challenges navigate the top frame; wait for it to settle.
    try { await page.waitForNetworkIdle({ idleTime: 700, timeout: 3000 }); } catch (e) {}
    state = await challengeState();
    rounds++;
    if (!state.blocked) break;
  }
  if ((Date.now() - loopStart) >= SOLVE_BUDGET_MS) note('solve budget reached — returning best-effort result');

  // Read the captcha tokens (if the page exposes them).
  let tokens = {};
  try {
    tokens = await page.evaluate(() => {
      const grab = (sel) => { const el = document.querySelector(sel); return el && el.value ? el.value : null; };
      return {
        turnstile: grab('[name="cf-turnstile-response"]'),
        recaptcha: grab('#g-recaptcha-response') || grab('[name="g-recaptcha-response"]'),
        hcaptcha: grab('[name="h-captcha-response"]'),
      };
    });
  } catch (e) {}

  // Collect everything the caller needs.
  let html = '';
  try { html = await page.content(); } catch (e) {}
  let title = '';
  try { title = await page.title(); } catch (e) {}
  let text = '';
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch (e) {}

  let cookies = [];
  try { cookies = await page.cookies(); } catch (e) {}
  const cookieMap = {};
  cookies.forEach((c) => { cookieMap[c.name] = c.value; });

  let screenshot = null;
  if (takeScreenshot) {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      screenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (e) {}
  }

  let finalUrl = url;
  try { finalUrl = page.url(); } catch (e) {}

  const finalState = await challengeState();
  // "Solved" = the page is no longer behind a hard interstitial. A residual
  // embedded Turnstile/captcha widget can linger AFTER the real content has
  // loaded (e.g. demo pages), so we treat the page as solved when the top-level
  // Cloudflare/JS wall is gone AND we either obtained a cf_clearance cookie or
  // the title is no longer a challenge title.
  const finalTitle = (finalState.title || '').toLowerCase();
  const titleIsChallenge = finalTitle.includes('just a moment') ||
    finalTitle.includes('attention required') || finalTitle.includes('checking your browser');
  const solvedFlag = (!finalState.cf && !titleIsChallenge) &&
    (!!cookieMap.cf_clearance || !finalState.generic);

  return {
    data: {
      navigated,
      solved: solvedFlag,
      rounds,
      finalUrl,
      title,
      detected: {
        cloudflare: !!(state.cf),
        turnstile: !!(state.turnstile),
        recaptcha: !!(state.recaptcha),
        hcaptcha: !!(state.hcaptcha),
        datadome: !!(state.datadome),
        pressHold: !!(state.pressHold),
        slider: !!(state.slider),
        imageGrid: !!(state.imageGrid),
        generic: !!(state.generic),
      },
      tokens,
      cookies: cookieMap,
      hasCfClearance: !!cookieMap.cf_clearance,
      text: (text || '').slice(0, 12000),
      html: (html || '').slice(0, 80000),
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
      screenshot,
      log,
    },
    type: 'application/json',
  };
}
`;

// ── Public: solve a CAPTCHA / challenge on a URL via Browserless /function ──
/**
 * Open `url` in a real headless browser, auto-solve any Cloudflare / Turnstile /
 * reCAPTCHA / hCaptcha / generic challenge, and return the unblocked page.
 *
 * @param {string} url
 * @param {object} opts { maxRounds, roundDelay, takeScreenshot, timeout }
 * @returns {Promise<{
 *   ok: boolean, solved: boolean, title: string, finalUrl: string,
 *   detected: object, tokens: object, cookies: object, hasCfClearance: boolean,
 *   text: string, html: string, screenshot: string|null, userAgent: string,
 *   rounds: number, error?: string
 * }>}
 */
async function solveCaptcha(url, opts = {}) {
  const {
    maxRounds = 12,
    roundDelay = 2000,
    takeScreenshot = true,
    timeout = 110000,
  } = opts;

  const token = await browserless.getKey();
  if (!token) {
    return { ok: false, solved: false, error: 'Browserless API key not configured', cookies: {}, detected: {}, tokens: {} };
  }

  const target = url.startsWith('http') ? url : `https://${url}`;
  const endpoint = browserless.ENDPOINT || 'https://production-sfo.browserless.io';
  // Browserless aborts a /function run after a DEFAULT ~30s budget and returns
  // HTTP 408. Raise the server-side budget via the `timeout` query param, which
  // accepts a value up to the account plan limit (60,000 ms). We cap at 58s and
  // keep our own fetch timeout slightly higher so the server budget fires first.
  const fnTimeout = Math.min(58000, Math.max(20000, timeout - 5000));

  try {
    const resp = await fetch(`${endpoint}/function?token=${encodeURIComponent(token)}&timeout=${fnTimeout}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: SOLVER_FUNCTION,
        context: { url: target, maxRounds, roundDelay, takeScreenshot },
      }),
      timeout,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return {
        ok: false, solved: false,
        error: `Browserless /function error (${resp.status}): ${errText.slice(0, 200)}`,
        cookies: {}, detected: {}, tokens: {},
      };
    }

    const json = await resp.json();
    const d = json && json.data ? json.data : json;
    return {
      ok: true,
      solved: !!d.solved,
      title: d.title || '',
      finalUrl: d.finalUrl || target,
      detected: d.detected || {},
      tokens: d.tokens || {},
      cookies: d.cookies || {},
      hasCfClearance: !!d.hasCfClearance,
      text: d.text || '',
      html: d.html || '',
      screenshot: d.screenshot || null,
      userAgent: d.userAgent || '',
      rounds: d.rounds || 0,
      log: d.log || [],
    };
  } catch (e) {
    return {
      ok: false, solved: false,
      error: `captchaSolver error: ${e.message}`,
      cookies: {}, detected: {}, tokens: {},
    };
  }
}

// ── Public: quick heuristic — does this HTML look like a challenge page? ─────
function looksLikeChallenge(html, title = '') {
  if (!html && !title) return false;
  const h = (html || '').toLowerCase();
  const t = (title || '').toLowerCase();
  return (
    t.includes('just a moment') ||
    t.includes('attention required') ||
    t.includes('checking your browser') ||
    h.includes('challenges.cloudflare.com') ||
    h.includes('cf-turnstile') ||
    h.includes('/recaptcha/api') ||
    h.includes('hcaptcha.com') ||
    h.includes('cf_chl_opt') ||
    /verify you are human|enable javascript and cookies to continue/.test(h)
  );
}

// ── Public: DeepSeek-style WASM Proof-of-Work (re-exported for convenience) ──
function solvePow(challenge) {
  if (!deepseekPow) throw new Error('deepseekPow module unavailable');
  return deepseekPow.solvePow(challenge);
}

// ── Public: external token solver (2Captcha-compatible) — OPTIONAL fallback ──
// When the built-in click/slider heuristics can't defeat a token-based captcha
// (reCAPTCHA v2/v3, hCaptcha, Turnstile, image-grid), and a TWOCAPTCHA_API_KEY
// (or ANTICAPTCHA_API_KEY, 2captcha.com-compatible) is configured, we submit the
// sitekey to the solving service and poll for the token. Returns { token } or
// { error }. This lets the agent solve the CAPTCHAs that pure automation cannot.
//   type: 'recaptcha' | 'hcaptcha' | 'turnstile'
async function solveWithExternalService(type, sitekey, pageUrl, opts = {}) {
  const key = opts.apiKey || process.env.TWOCAPTCHA_API_KEY || process.env.CAPTCHA_API_KEY || process.env.ANTICAPTCHA_API_KEY;
  if (!key) return { error: 'no external captcha solver key configured (set TWOCAPTCHA_API_KEY)' };
  if (!sitekey || !pageUrl) return { error: 'sitekey and pageUrl are required' };
  const base = (opts.endpoint || process.env.TWOCAPTCHA_ENDPOINT || 'https://2captcha.com').replace(/\/$/, '');
  const methodMap = { recaptcha: 'userrecaptcha', hcaptcha: 'hcaptcha', turnstile: 'turnstile' };
  const method = methodMap[type] || 'userrecaptcha';
  try {
    const inParams = new URLSearchParams({ key, method, googlekey: sitekey, sitekey, pageurl: pageUrl, json: '1' });
    const inResp = await fetch(`${base}/in.php`, { method: 'POST', body: inParams, timeout: 20000 });
    const inJson = await inResp.json().catch(() => ({}));
    if (!inJson || inJson.status !== 1) return { error: 'submit failed: ' + (inJson && inJson.request) };
    const id = inJson.request;
    const deadline = Date.now() + (opts.timeout || 120000);
    await new Promise((r) => setTimeout(r, 12000));
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/res.php?key=${encodeURIComponent(key)}&action=get&id=${id}&json=1`, { timeout: 15000 });
      const j = await res.json().catch(() => ({}));
      if (j && j.status === 1) return { token: j.request };
      if (j && j.request && j.request !== 'CAPCHA_NOT_READY') return { error: j.request };
      await new Promise((r) => setTimeout(r, 5000));
    }
    return { error: 'external solver timed out' };
  } catch (e) {
    return { error: 'external solver error: ' + e.message };
  }
}

module.exports = {
  solveCaptcha,
  looksLikeChallenge,
  solvePow,
  solveWithExternalService,
};
