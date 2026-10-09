// HackerX v7 — Browserless.io v2 integration for REAL web automation.
//
// Powers the WormGPT Agent's web superpowers: render JS-heavy pages, scrape
// structured content, take full screenshots (e.g. open TradingView and snap the
// chart), and render HTML→PDF. Falls back to cheerio-based scraping only when
// Browserless is genuinely unreachable.
//
// ⚠️ IMPORTANT — endpoint & API version:
//   The OLD `https://chrome.browserless.io` host is DEAD (returns HTTP 400) and
//   the v1 `/scrape` payload shape is gone. We use the v2 regional endpoint
//   (`https://production-sfo.browserless.io`) and the v2 REST contracts:
//     POST /content?token=KEY      {url, gotoOptions}                 → rendered HTML
//     POST /screenshot?token=KEY   {url, gotoOptions, options, viewport} → image bytes
//     POST /scrape?token=KEY       {url, elements:[{selector}], gotoOptions} → {data:[...]}
//     POST /pdf?token=KEY          {html|url, options}                → pdf bytes
//
// The API key is resolved at RUNTIME (admin panel → DB setting) first, then the
// BROWSERLESS_API_KEY env var, so an admin can rotate it live without redeploy.
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// 🦾 Power Scraper — the FINAL browser fallback (ported from the app's built-in
// `browse` MCP tool). When Browserless is down/out-of-units AND the plain
// cheerio fetch is blocked/empty, this multi-strategy scraper (rotating-UA
// direct fetch → r.jina.ai reader proxy → DDG/Bing search) still gets content.
let powerScraper = null;
try { powerScraper = require('./powerScraper'); } catch (_) { /* optional */ }

let db = null;
try { db = require('../db'); } catch (_) { /* db optional (unit tests) */ }

// Regional v2 endpoint. Overridable via env if the account is on another region
// (e.g. production-lon / production-ams). Default = SFO (verified working).
const BROWSERLESS_ENDPOINT = (process.env.BROWSERLESS_ENDPOINT || 'https://production-sfo.browserless.io').replace(/\/+$/, '');

// Runtime key cache (short TTL) so we don't hit the DB on every single call but
// still pick up admin changes within a few seconds.
let _keyCache = { value: null, ts: 0 };
const KEY_TTL = 15000;

async function getKey() {
  const now = Date.now();
  if (_keyCache.value && now - _keyCache.ts < KEY_TTL) return _keyCache.value;
  let key = '';
  try {
    if (db && db.getSetting) {
      const runtime = await db.getSetting('browserless_api_key');
      if (runtime && runtime.trim()) key = runtime.trim();
    }
  } catch (_) {}
  if (!key) key = (process.env.BROWSERLESS_API_KEY || '').trim();
  _keyCache = { value: key, ts: now };
  return key;
}

// Allow the admin route to flush the cache the instant a new key is saved.
function invalidateKeyCache() { _keyCache = { value: null, ts: 0 }; }

// Availability is keyed by the CURRENT token so changing the key re-checks.
let _availFor = { token: null, ok: null };

async function isAvailable() {
  const token = await getKey();
  if (!token) { _availFor = { token: null, ok: false }; return false; }
  if (_availFor.token === token && _availFor.ok !== null) return _availFor.ok;
  let ok = false;
  try {
    const resp = await fetch(`${BROWSERLESS_ENDPOINT}/content?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', gotoOptions: { waitUntil: 'domcontentloaded', timeout: 15000 } }),
      timeout: 20000,
    });
    ok = resp.ok; // 200 = good token
    if (!ok) { try { await resp.text(); } catch (_) {} }
  } catch (e) {
    ok = false;
  }
  _availFor = { token, ok };
  return ok;
}

// Explicit connectivity test for the admin "Test" button. Returns a structured
// result the UI can render (never throws).
async function testKey(overrideKey) {
  const token = (overrideKey && overrideKey.trim()) || (await getKey());
  if (!token) return { ok: false, status: 0, message: 'No Browserless API key configured.' };
  const started = Date.now();
  try {
    // Real end-to-end check: render example.com AND grab a tiny screenshot so we
    // prove both the content and screenshot capabilities the agent relies on.
    const resp = await fetch(`${BROWSERLESS_ENDPOINT}/screenshot?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com',
        gotoOptions: { waitUntil: 'networkidle2', timeout: 25000 },
        options: { type: 'jpeg', quality: 60, fullPage: false },
        viewport: { width: 800, height: 600 },
      }),
      timeout: 35000,
    });
    const ms = Date.now() - started;
    if (resp.ok) {
      const buf = await resp.buffer();
      return { ok: true, status: resp.status, ms, bytes: buf.length, endpoint: BROWSERLESS_ENDPOINT, message: `✅ Working — rendered + screenshotted example.com (${buf.length} bytes in ${ms}ms).` };
    }
    const text = await resp.text().catch(() => '');
    let msg = `❌ Browserless returned HTTP ${resp.status}.`;
    if (resp.status === 401 || resp.status === 403) msg = '❌ Invalid or unauthorized Browserless API key (401/403).';
    else if (resp.status === 429) msg = '⚠️ Rate limited / out of units (429). The key is valid but the plan is exhausted.';
    else if (text) msg += ' ' + text.slice(0, 160);
    return { ok: false, status: resp.status, ms, endpoint: BROWSERLESS_ENDPOINT, message: msg };
  } catch (e) {
    return { ok: false, status: 0, endpoint: BROWSERLESS_ENDPOINT, message: `❌ Could not reach Browserless: ${e.message}` };
  }
}

// ── Fallback: scrape using cheerio (no browserless) ────────────────────────
async function fallbackScrape(url) {
  const targetUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });
    const html = await resp.text();
    const parsed = parseHtml(html, targetUrl);
    // If the simple fetch was blocked/empty (CF, 403, JS wall), escalate to the
    // power scraper (rotating UA + r.jina.ai reader) before giving up.
    if (parsed && parsed.text && parsed.text.trim().length >= 80) return parsed;
  } catch (_) { /* fall through to power scraper */ }
  return await powerScrapeFallback(targetUrl);
}

// 🦾 Power-scraper fallback → returns the SAME shape parseHtml produces so the
// rest of the pipeline (scrapeUrl/browseUrl) is untouched. Best-effort: returns
// an empty-text object if even the power scraper fails.
async function powerScrapeFallback(targetUrl) {
  if (!powerScraper) return { title: '', description: '', text: '', links: [], html: '' };
  try {
    const r = await powerScraper.browse(targetUrl, { maxChars: 8000, timeout: 30000 });
    if (r && r.text) {
      return {
        title: r.title || '',
        description: r.description || '',
        text: r.text,
        links: r.links || [],
        html: '',
      };
    }
  } catch (_) {}
  return { title: '', description: '', text: '', links: [], html: '' };
}

// Shared HTML → {title, description, text, links} extractor.
function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const description = $('meta[name="description"]').attr('content') || '';
  $('script, style, nav, footer, header, aside, noscript, svg').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  const links = [];
  $('a[href]').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim().slice(0, 80);
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        links.push({ text, href: fullUrl });
      } catch (e) {}
    }
  });
  return { title, description, text: bodyText, links: links.slice(0, 25), html: html.slice(0, 60000) };
}

// ── Fallback: Bing web search via cheerio ──────────────────────────────────
async function fallbackWebSearch(query) {
  let results = '';
  try {
    const resp = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });
    const html = await resp.text();
    const $ = cheerio.load(html);
    $('.b_algo').slice(0, 6).each((i, el) => {
      const title = $(el).find('h2 a').text().trim();
      const snippet = $(el).find('.b_caption p').text().trim();
      if (title) results += `- ${title}\n`;
      if (snippet) results += `  ${snippet}\n\n`;
    });
  } catch (_) { /* fall through to power scraper */ }
  if (results && results.trim().length > 40) return results;
  // Bing blocked / empty → power scraper (DuckDuckGo → Bing, rotating UA).
  if (powerScraper) {
    try {
      const r = await powerScraper.search(query, { timeout: 18000 });
      if (r && r.trim()) return r;
    } catch (_) {}
  }
  return results || 'No search results found';
}

// ── v2 helper: POST to a browserless endpoint, return Response or throw ─────
async function blPost(path, payload, { timeout = 45000 } = {}) {
  const token = await getKey();
  if (!token) throw new Error('Browserless API key not configured');
  const resp = await fetch(`${BROWSERLESS_ENDPOINT}${path}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout,
  });
  return resp;
}

/**
 * Take a screenshot of a URL using Browserless v2 `/screenshot`.
 * Tuned for JS-heavy SPAs (TradingView, dashboards): waits for network idle so
 * charts/widgets are fully painted. Returns a data: URI (base64 JPEG/PNG).
 *
 * options: { width, height, fullPage, type, quality, waitUntil, timeout, selector }
 */
async function screenshotUrl(url, options = {}) {
  const available = await isAvailable();
  if (!available) throw new Error('Browserless screenshot unavailable — check the Browserless API key in the admin panel.');

  const {
    width = 1366, height = 768,
    fullPage = false,
    type = 'jpeg', quality = 80,
    waitUntil = 'networkidle2',
    timeout = 45000,
    selector = null,
  } = options;

  const shotOptions = { type, fullPage };
  if (type === 'jpeg') shotOptions.quality = quality;
  if (selector) { shotOptions.selector = selector; shotOptions.fullPage = false; }

  const payload = {
    url: url.startsWith('http') ? url : `https://${url}`,
    gotoOptions: { waitUntil, timeout },
    options: shotOptions,
    viewport: { width, height },
  };

  const resp = await blPost('/screenshot', payload, { timeout: timeout + 10000 });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Browserless screenshot error (${resp.status}): ${text.slice(0, 200)}`);
  }
  const buffer = await resp.buffer();
  const mime = type === 'png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * Get fully-rendered HTML for a URL via Browserless v2 `/content`, then parse
 * it (title/description/text/links). Falls back to cheerio fetch.
 */
async function scrapeUrl(url) {
  const available = await isAvailable();
  if (!available) return await fallbackScrape(url);
  const targetUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const resp = await blPost('/content', {
      url: targetUrl,
      gotoOptions: { waitUntil: 'networkidle2', timeout: 40000 },
    }, { timeout: 50000 });
    if (!resp.ok) return await fallbackScrape(url);
    const html = await resp.text();
    return parseHtml(html, targetUrl);
  } catch (e) {
    return await fallbackScrape(url);
  }
}

/**
 * Structured scrape via Browserless v2 `/scrape` (elements API). Returns the
 * raw v2 {data:[...]} payload for callers that want specific selectors.
 */
async function scrapeElements(url, selectors = ['body']) {
  const available = await isAvailable();
  if (!available) throw new Error('Browserless unavailable for element scrape');
  const resp = await blPost('/scrape', {
    url: url.startsWith('http') ? url : `https://${url}`,
    elements: selectors.map(s => ({ selector: s })),
    gotoOptions: { waitUntil: 'networkidle2', timeout: 40000 },
  }, { timeout: 50000 });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Browserless scrape error (${resp.status}): ${text.slice(0, 200)}`);
  }
  return await resp.json();
}

/**
 * Web search (rendered Bing via Browserless preferred, fallback to cheerio).
 */
async function webSearchViaBrowserless(query) {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`;
  try {
    const scraped = await scrapeUrl(searchUrl);
    if (scraped && scraped.text) {
      const lines = scraped.text.split('\n').map(l => l.trim()).filter(l => l.length > 15);
      const results = lines.join('\n');
      if (results.length > 50) return results.slice(0, 6000);
    }
  } catch (e) {}
  return await fallbackWebSearch(query);
}

/**
 * Browse a URL: rendered text + a screenshot (so the agent can both read and
 * SEE the page). Used by the WormGPT agent's `browse` tool.
 *
 * CAPTCHA-AWARE: if the first render returns a Cloudflare / Turnstile /
 * reCAPTCHA / hCaptcha challenge page (instead of the real content), this
 * automatically escalates to the CAPTCHA solver (services/captchaSolver.js),
 * which opens the URL in a real headless browser, solves the challenge, and
 * returns the unblocked page + harvested cookies (cf_clearance). This is what
 * lets the agent "browse any website without restrictions".
 */
async function browseUrl(url, opts = {}) {
  const scraped = await scrapeUrl(url);
  let screenshot = null;

  // ── Detect bot-defense challenge & auto-solve ──────────────────────────
  // Lazy-require to avoid a circular import (captchaSolver requires browserless).
  let captcha = null;
  try { captcha = require('./captchaSolver'); } catch (_) {}

  const challengeDetected = captcha && opts.solveCaptcha !== false && (
    captcha.looksLikeChallenge(scraped && scraped.html, scraped && scraped.title) ||
    !scraped || !scraped.text || scraped.text.trim().length < 40
  );

  if (challengeDetected) {
    try {
      const solved = await captcha.solveCaptcha(url, {
        maxRounds: opts.maxRounds || 12,
        roundDelay: opts.roundDelay || 2000,
        takeScreenshot: true,
      });
      if (solved && solved.ok && (solved.text || solved.solved)) {
        let content = '';
        if (solved.title) content += `# ${solved.title}\n\n`;
        if (solved.text) content += solved.text.slice(0, 8000);
        const detected = Object.entries(solved.detected || {})
          .filter(([, v]) => v).map(([k]) => k);
        return {
          text: content || '(No content extracted)',
          screenshot: solved.screenshot || null,
          captcha: {
            solved: solved.solved,
            detected,
            hasCfClearance: solved.hasCfClearance,
            cookies: solved.cookies || {},
            tokens: solved.tokens || {},
            finalUrl: solved.finalUrl,
            rounds: solved.rounds,
          },
        };
      }
    } catch (e) { /* fall through to normal content below */ }
  }

  try { screenshot = await screenshotUrl(url); } catch (e) { /* screenshot optional */ }

  let content = '';
  if (scraped) {
    if (scraped.title) content += `# ${scraped.title}\n\n`;
    if (scraped.description) content += `Description: ${scraped.description}\n\n`;
    if (scraped.text) content += scraped.text.slice(0, 8000);
    if (Array.isArray(scraped.links) && scraped.links.length) {
      content += '\n\n--- Links ---\n';
      scraped.links.slice(0, 20).forEach(l => { if (l.text || l.href) content += `- ${l.text || ''}: ${l.href}\n`; });
    }
  }
  return { text: content || '(No content extracted)', screenshot };
}

/**
 * Render an HTML string (or URL) to a PDF Buffer using Browserless v2 `/pdf`.
 * Used by the agent's create_pdf tool for real, multi-page, MathJax-typeset
 * PDFs. Throws if Browserless is unavailable so the caller can fall back.
 */
// Detect whether an HTML doc needs client-side JS (MathJax) to render maths.
function _needsMathJax(html) {
  const s = String(html || '');
  return /mathjax|tex-svg\.js|tex-chtml\.js|__mjReady/i.test(s);
}

// Turn a rendered HTML string into a STATIC, self-contained document that no
// longer needs JS to display maths: after Browserless `/content` has run
// MathJax (baking every equation into inline <svg>/mjx-container markup), we
// strip the MathJax loader + config scripts so the follow-up `/pdf` render does
// NOT re-run (and blank) the equations. All other markup/styles are preserved.
function _freezeTypesetHtml(bakedHtml) {
  let s = String(bakedHtml || '');
  // Remove the external MathJax loader (<script src=".../tex-svg.js">).
  s = s.replace(/<script[^>]*(?:tex-svg|tex-chtml|tex-mml|mathjax)[^>]*>\s*<\/script>/gi, '');
  // Remove any inline <script> that references MathJax / __mjReady (config +
  // readiness shims). This is safe because the equations are already baked.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) =>
    /MathJax|__mjReady|tex-svg|tex-chtml/i.test(m) ? '' : m);
  return s;
}

// Ask Browserless `/content` to render the page (running MathJax) and return
// the fully-typeset HTML. This is the ONE endpoint that reliably executes the
// client-side MathJax on this account — `/pdf` and `/screenshot` snapshot the
// page WITHOUT waiting for the JS-generated SVG, which is why maths came out
// blank. We reuse the typeset output for both PDF and image rendering.
async function renderTypesetContent(html, { waitFor = 15000 } = {}) {
  const resp = await blPost('/content', {
    html,
    gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
    waitForFunction: { fn: '() => window.__mjReady === true', timeout: waitFor },
  }, { timeout: waitFor + 45000 });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Browserless /content error (${resp.status}): ${t.slice(0, 160)}`);
  }
  return await resp.text();
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL Chromium HTML→PDF (primary, dependency-free, NO payload limit)
//
// The hosted Browserless `/pdf` endpoint (a) does not run client-side MathJax
// before snapshotting and (b) 500s on large payloads (e.g. a solved-question
// HTML with an embedded base64 matplotlib diagram + MathJax). Rendering with a
// LOCAL headless Chromium avoids BOTH problems: it executes MathJax fully, has
// no request-size limit, and works offline. This is the PRIMARY renderer;
// Browserless is the fallback when no Chromium binary is present.
// ─────────────────────────────────────────────────────────────────────────────
let _chromePathCache; // undefined = unresolved, '' = none, string = path
function _resolveChromePath() {
  if (_chromePathCache !== undefined) return _chromePathCache;
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    process.env.CHROMIUM_BIN,
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { _chromePathCache = c; return c; } } catch (_) {}
  }
  // Scan a puppeteer-managed cache (installed via `@puppeteer/browsers` at
  // build time, e.g. ~/.cache/puppeteer or ./.cache/puppeteer). This makes the
  // renderer work even when no system chromium package is present.
  const cacheRoots = [
    process.env.PUPPETEER_CACHE_DIR,
    path.join(process.env.HOME || '/root', '.cache', 'puppeteer'),
    path.join(process.cwd(), '.cache', 'puppeteer'),
    '/app/.cache/puppeteer',
  ].filter(Boolean);
  for (const root of cacheRoots) {
    try {
      const found = _scanForChrome(fs, path, root);
      if (found) { _chromePathCache = found; return found; }
    } catch (_) {}
  }
  _chromePathCache = '';
  return '';
}

// Recursively look for a `chrome`/`chromium` executable under a cache dir.
function _scanForChrome(fs, path, root, depth = 0) {
  if (depth > 6 || !fs.existsSync(root)) return '';
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return ''; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && /^(chrome|chromium|chrome-headless-shell)$/.test(e.name)) {
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (_) {}
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = _scanForChrome(fs, path, path.join(root, e.name), depth + 1);
      if (found) return found;
    }
  }
  return '';
}

// Provision a Chromium at runtime if none is installed (last-resort safety net
// for hosts that ship no browser). Downloads into the puppeteer cache using the
// `@puppeteer/browsers` CLI, then re-resolves the path. Returns true on success.
let _installTried = false;
async function _ensureLocalChromium() {
  if (_installTried) return !!_resolveChromePath();
  _installTried = true;
  try {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR ||
      path.join(process.cwd(), '.cache', 'puppeteer');
    execFileSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', cacheDir], {
      stdio: 'ignore', timeout: 180000,
    });
    _chromePathCache = undefined; // force re-scan
    return !!_resolveChromePath();
  } catch (_) {
    return false;
  }
}


// Render HTML → PDF Buffer with a local headless Chromium.
//
// ⚡ HIGH-FIDELITY RENDER: this is the DEFINITIVE fix for blank equations and
// missing diagrams/charts. The old version rewrote CDN <script>s to `async`
// and only gave a 500ms settle, so MathJax (SVG) and JS-drawn charts
// (Chart.js / mermaid / plotly / matplotlib-as-<img>) were snapshotted before
// they finished — producing empty maths and no charts. We now:
//   1) Load the doc and WAIT for the network to go idle (CDN scripts fetched).
//   2) Actively wait for every rendering signal that could exist:
//        • MathJax  → window.__mjReady OR MathJax.typesetPromise resolved
//        • Charts   → window.__chartReady OR <canvas> painted
//        • Images   → every <img> decoded (complete && naturalWidth>0)
//        • Fonts    → document.fonts.ready
//   3) If MathJax is loaded but never signalled ready, we force a typeset
//      IN-PAGE (belt-and-braces) so equations are ALWAYS baked to SVG.
//   4) A generous adaptive settle so the final paint lands before print.
// Everything is best-effort with sane caps so a slow/blocked CDN can never
// hang the request — but when the network is up you get pixel-perfect output.
// ─────────────────────────────────────────────────────────────────────────────
// ⚡ PERSISTENT BROWSER SINGLETON
//
// Cold-launching a fresh Chromium on EVERY create_pdf call cost ~1–2s of pure
// startup, which is a big chunk of the "too slow" complaint — especially on
// Render where the container CPU is modest and the first render after a cold
// deploy is the worst. We now launch Chromium ONCE and reuse it across every
// PDF/image request. Each request still gets its OWN isolated page (opened +
// closed per call) so there is no state leakage between documents. If the
// shared browser ever dies/disconnects, the next call transparently relaunches.
// ─────────────────────────────────────────────────────────────────────────────
let _browserSingleton = null;   // the live puppeteer Browser (or null)
let _browserLaunching = null;   // in-flight launch promise (dedupes concurrency)

async function _getBrowser() {
  // Reuse a healthy, connected browser.
  if (_browserSingleton && _browserSingleton.isConnected && _browserSingleton.isConnected()) {
    return _browserSingleton;
  }
  // If a launch is already in flight, await it instead of starting a second one.
  if (_browserLaunching) return _browserLaunching;

  const exe = _resolveChromePath();
  if (!exe) throw new Error('no local Chromium');
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); }
  catch (_) { throw new Error('puppeteer-core not installed'); }

  _browserLaunching = (async () => {
    const browser = await puppeteer.launch({
      executablePath: exe,
      headless: 'new',
      // High ceiling so a single slow render can't kill the shared browser.
      protocolTimeout: 120000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars',
        '--force-color-profile=srgb',
      ],
    });
    // Auto-clear the singleton if Chromium crashes/disconnects so the next
    // request relaunches cleanly instead of using a dead handle.
    browser.on('disconnected', () => { if (_browserSingleton === browser) _browserSingleton = null; });
    _browserSingleton = browser;
    _browserLaunching = null;
    return browser;
  })();

  try { return await _browserLaunching; }
  catch (e) { _browserLaunching = null; throw e; }
}

// Gracefully close the shared browser (used by tests / graceful shutdown).
async function _shutdownBrowser() {
  const b = _browserSingleton;
  _browserSingleton = null;
  _browserLaunching = null;
  if (b) { try { await b.close(); } catch (_) {} }
}

// Cheap content sniffers so a PLAIN document (no maths, no JS charts, no images)
// skips every "wait for rendering" step and prints almost instantly. This is
// the core of the speed-up: only pay for the waits a document actually needs.
function _htmlNeedsMath(s) {
  s = String(s || '');
  return /mathjax|tex-svg|tex-chtml|tex-mml|mjx-container|\\\(|\\\[|\$\$/i.test(s);
}
function _htmlNeedsCharts(s) {
  s = String(s || '');
  return /<canvas\b|chart\.js|chartjs|mermaid|plotly|__chartReady/i.test(s);
}
function _htmlHasImages(s) {
  return /<img\b/i.test(String(s || ''));
}

// Render HTML → PDF Buffer using the SHARED headless Chromium.
//
// ⚡ FAST + FAITHFUL: reuses the persistent browser (no per-call launch) and
// only waits for the rendering signals the document actually contains:
//   • maths  → wait for MathJax (flag / library state) then force-typeset
//   • charts → wait for __chartReady or a painted <canvas>
//   • images → wait for every <img> to decode
//   • fonts  → document.fonts.ready
// A plain prose/HTML doc skips ALL of these and prints in a few hundred ms.
async function localHtmlToPdf(html, options = {}) {
  const src = String(html);
  const needMath = _htmlNeedsMath(src);
  const needCharts = _htmlNeedsCharts(src);
  const hasImages = _htmlHasImages(src);
  const needsNetwork = needMath || needCharts || /<link\b[^>]+stylesheet|src\s*=\s*["']https?:/i.test(src);

  // Adaptive wait ceiling: heavy (maths/charts) docs get a generous cap so a
  // slow CDN still finishes; plain docs get a tiny one so they never dawdle.
  const heavy = needMath || needCharts;
  const waitCap = Math.max(heavy ? 15000 : 4000, options.waitFor || 0);

  const browser = await _getBrowser();
  const page = await browser.newPage();
  try {
    // Print media so @media print CSS applies; wide viewport so charts/canvas
    // that size to the window get real pixels before print.
    await page.emulateMediaType('print');
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 2 });

    // Load the document. Docs that pull remote scripts/styles wait for the
    // network to go idle (so MathJax/Chart.js are fetched); self-contained
    // docs only need DOMContentLoaded — far faster. Either way we cap the wait
    // so a blocked CDN can't hang the request.
    const waitUntil = needsNetwork ? 'networkidle0' : 'domcontentloaded';
    try {
      await page.setContent(src, { waitUntil, timeout: waitCap });
    } catch (_) {
      try { await page.setContent(src, { waitUntil: 'domcontentloaded', timeout: 6000 }); } catch (__) {}
    }

    // ── MathJax (only if the doc actually has maths) ───────────────────────
    if (needMath) {
      try {
        await page.waitForFunction(`
          (function(){
            try {
              if (window.__mjReady === true) return true;
              if (window.MathJax && MathJax.startup && MathJax.startup.document &&
                  MathJax.startup.document.state && MathJax.startup.document.state() >= 10) return true;
              if (!window.MathJax && !/\\\\\\(|\\\\\\[|\\$\\$/.test(document.body ? document.body.textContent : '')) return true;
              return false;
            } catch(e){ return true; }
          })()
        `, { timeout: waitCap, polling: 200 });
      } catch (_) { /* fall through to forced typeset */ }

      // Belt-and-braces: if MathJax exists but nothing is baked yet, force it.
      try {
        await page.evaluate(async () => {
          if (window.MathJax && MathJax.typesetPromise &&
              !document.querySelector('mjx-container, svg[data-mml-node], .MathJax')) {
            try { await MathJax.typesetPromise(); } catch (e) {}
          }
        });
      } catch (_) {}
    }

    // ── Charts / canvases (only if present) ────────────────────────────────
    if (needCharts) {
      try {
        await page.waitForFunction(`
          (function(){
            try {
              if (window.__chartReady === true) return true;
              var cs = document.querySelectorAll('canvas');
              if (!cs.length) return true;
              for (var i=0;i<cs.length;i++){ if (!cs[i].width || !cs[i].height) return false; }
              return true;
            } catch(e){ return true; }
          })()
        `, { timeout: Math.min(waitCap, 10000), polling: 200 });
      } catch (_) {}
    }

    // ── Images (only if present) — wait until every <img> decodes ──────────
    if (hasImages) {
      try {
        await page.evaluate(async () => {
          const imgs = Array.from(document.images || []);
          await Promise.all(imgs.map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise(res => {
              const done = () => res();
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
              if (img.decode) img.decode().then(done).catch(done);
              setTimeout(done, 6000);
            });
          }));
        });
      } catch (_) {}
    }

    // Web fonts: quick, cheap, and only matters when we actually waited above.
    if (heavy || hasImages) {
      try { await page.evaluate(async () => { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } }); } catch (_) {}
    }

    // ── Print-hardening cleanup (fixes duplicated content + leaked script text)
    // Only meaningful when the doc had scripts / MathJax. Strips scripts (all
    // rendering is done) and MathJax's assistive-MML duplicate so print media
    // doesn't double the content / page count.
    if (needMath || needCharts || /<script\b/i.test(src)) {
      try {
        await page.evaluate(() => {
          document.querySelectorAll('script').forEach(s => s.remove());
          document.querySelectorAll('mjx-assistive-mml, .MJX_Assistive_MathML').forEach(n => n.remove());
          const st = document.createElement('style');
          st.textContent =
            'mjx-assistive-mml{display:none!important;}' +
            'mjx-container[jax="SVG"]>svg{overflow:visible;}' +
            '@media print{mjx-assistive-mml{display:none!important;}}';
          document.head.appendChild(st);
        });
      } catch (_) {}
    }

    // Final settle so the last paint lands — short for plain docs, a touch more
    // for heavy ones (SVG/canvas compositing).
    await new Promise((r) => setTimeout(r, heavy ? 350 : 120));

    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      format: options.format || 'A4',
      margin: options.margin || { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    return Buffer.from(pdf);
  } finally {
    // Close the PAGE (not the shared browser) so the next request is instant.
    try { await page.close(); } catch (_) {}
  }
}

async function htmlToPdf(html, options = {}) {
  // ── PRIMARY: local headless Chromium (no size limit, runs MathJax + JS
  // charts, produces high-fidelity print PDFs). This is now the guaranteed
  // engine — we retry it (cold Chromium can flake once on Render) and, if the
  // binary is genuinely missing, auto-install one via puppeteer's browser
  // manager before giving up. Browserless is only a remote last resort.
  let lastLocalErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const buf = await localHtmlToPdf(html, options);
      if (buf && buf.length > 600) return buf;
      lastLocalErr = new Error(`local render produced ${buf ? buf.length : 0} bytes`);
    } catch (e) {
      lastLocalErr = e;
      // If there's simply no Chromium, try to provision one once, then retry.
      if (/no local Chromium/i.test(e.message) && attempt === 1) {
        const installed = await _ensureLocalChromium();
        if (!installed) break; // can't install → skip to Browserless fallback
      }
    }
  }

  // ── FALLBACK: Browserless (only if a key is configured). Optional — the app
  // runs fine with no Browserless key because the local engine above handles
  // everything. Kept so a deployment that DOES have a key still has a backup.
  const available = await isAvailable().catch(() => false);
  if (!available) {
    throw new Error(`Local HTML→PDF failed and no Browserless fallback configured: ${lastLocalErr ? lastLocalErr.message : 'unknown'}`);
  }

  const pdfOptions = {
    printBackground: true,
    format: options.format || 'A4',
    margin: options.margin || { top: '20mm', bottom: '20mm', left: '16mm', right: '16mm' },
  };

  // Direct-render a STATIC (already-typeset) HTML doc to PDF via `/pdf`. No JS
  // wait needed because there's nothing left to execute.
  const renderStaticPdf = async (staticHtml) => {
    const resp = await blPost('/pdf', {
      html: staticHtml,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
      options: pdfOptions,
    }, { timeout: 70000 });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Browserless /pdf error (${resp.status}): ${t.slice(0, 200)}`);
    }
    return await resp.buffer();
  };


  // ── PATH A — maths present: TWO-STEP pipeline ────────────────────────────
  // 1) `/content` runs MathJax → HTML with every equation baked into inline
  //    <svg>.  2) freeze (strip MathJax scripts)  3) `/pdf` the static HTML.
  if (_needsMathJax(html)) {
    if (/mjx-container/i.test(html)) {
      try { return await renderStaticPdf(_freezeTypesetHtml(html)); }
      catch (_) { /* fall through to single-step below */ }
    } else {
      try {
        const typeset = await renderTypesetContent(html, { waitFor: options.waitFor || 15000 });
        if (typeset) {
          const frozen = _freezeTypesetHtml(typeset);
          try { return await renderStaticPdf(frozen); }
          catch (e2) {
            try { return await renderStaticPdf(_freezeTypesetHtml(typeset)); } catch (_) {}
          }
        }
      } catch (e) { /* fall back to single-step below */ }
    }
  }

  // ── PATH B — no maths (or two-step unavailable): single-step `/pdf` ──────
  try {
    return await renderStaticPdf(html);
  } catch (e) {
    const resp = await blPost('/pdf', {
      html,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
      waitForTimeout: options.waitFor || 4000,
      options: pdfOptions,
    }, { timeout: 70000 });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Browserless /pdf error (${resp.status}): ${(text || e.message).slice(0, 200)}`);
    }
    return await resp.buffer();
  }
}

/**
 * Render an HTML string to a PNG/JPEG image Buffer via Browserless v2
 * `/screenshot`. Used to turn a MathJax-typeset HTML snippet into a clean image
 * so LaTeX/maths can be sent as a picture on chat platforms (WhatsApp/Telegram)
 * where raw "\\frac{}{}" looks ugly. Waits for window.__mjReady (set by the math
 * HTML template) so equations are fully typeset before the snapshot.
 *
 * options: { type='png', fullPage=true, width, height, waitFor }
 */
async function htmlToImage(html, options = {}) {
  const type = options.type === 'jpeg' ? 'jpeg' : 'png';

  // ── PRIMARY: local headless Chromium (runs MathJax, no payload limit) ────
  try {
    const exe = _resolveChromePath();
    if (exe) {
      const puppeteer = require('puppeteer-core');
      const waitCap = Math.max(20000, options.waitFor || 0);
      const browser = await puppeteer.launch({
        executablePath: exe, headless: 'new', protocolTimeout: waitCap + 60000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
      });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: options.width || 760, height: options.height || 200, deviceScaleFactor: 2 });
        // Keep CDN scripts as-is and wait for network idle so MathJax/Chart.js
        // actually load. Cap so a blocked CDN can't hang.
        try {
          await page.setContent(String(html), { waitUntil: 'networkidle0', timeout: waitCap });
        } catch (_) {
          try { await page.setContent(String(html), { waitUntil: 'domcontentloaded', timeout: 8000 }); } catch (__) {}
        }
        // Wait for MathJax readiness (flag or library state), else force typeset.
        try {
          await page.waitForFunction(`
            (function(){ try {
              if (window.__mjReady === true) return true;
              if (window.MathJax && MathJax.startup && MathJax.startup.document &&
                  MathJax.startup.document.state && MathJax.startup.document.state() >= 10) return true;
              if (!window.MathJax) return true;
              return false;
            } catch(e){ return true; } })()
          `, { timeout: waitCap, polling: 200 });
        } catch (_) {}
        try {
          await page.evaluate(async () => {
            if (window.MathJax && MathJax.typesetPromise &&
                !document.querySelector('mjx-container, .MathJax')) {
              try { await MathJax.typesetPromise(); } catch (e) {}
            }
          });
        } catch (_) {}
        // Wait for charts + images + fonts.
        try {
          await page.waitForFunction(`(function(){ try {
            if (window.__chartReady === true) return true;
            var cs=document.querySelectorAll('canvas'); if(!cs.length) return true;
            for(var i=0;i<cs.length;i++){ if(!cs[i].width||!cs[i].height) return false; } return true;
          } catch(e){ return true; } })()`, { timeout: Math.min(waitCap, 12000), polling: 200 });
        } catch (_) {}
        try {
          await page.evaluate(async () => {
            await Promise.all(Array.from(document.images||[]).map(img =>
              (img.complete && img.naturalWidth>0) ? Promise.resolve() :
              new Promise(res => { const d=()=>res(); img.addEventListener('load',d,{once:true}); img.addEventListener('error',d,{once:true}); if(img.decode) img.decode().then(d).catch(d); setTimeout(d,8000); })));
            if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
          });
        } catch (_) {}
        // Strip scripts + assistive MML so no config text leaks into the image.
        try {
          await page.evaluate(() => {
            document.querySelectorAll('script').forEach(s => s.remove());
            document.querySelectorAll('mjx-assistive-mml, .MJX_Assistive_MathML').forEach(n => n.remove());
          });
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 600));
        const shot = await page.screenshot({
          type,
          fullPage: options.fullPage !== false,
          ...(type === 'jpeg' ? { quality: options.quality || 90 } : {}),
        });
        const buf = Buffer.from(shot);
        if (buf && buf.length > 200) return buf;
      } finally { try { await browser.close(); } catch (_) {} }
    }
  } catch (_) { /* fall back to Browserless below */ }

  const available = await isAvailable();
  if (!available) throw new Error('Browserless image render requires a working Browserless key');
  const shotOptions = { type, fullPage: options.fullPage !== false };
  if (type === 'jpeg') shotOptions.quality = options.quality || 90;
  const viewport = { width: options.width || 760, height: options.height || 200 };

  // Same blank-math root cause as htmlToPdf: the `/screenshot` endpoint does not
  // reliably wait for client-side MathJax on this account. When the doc has
  // maths, TWO-STEP it: `/content` renders MathJax → freeze → screenshot the
  // static (already-typeset) HTML so the equations are actually captured.
  let renderHtml = html;
  if (_needsMathJax(html)) {
    try {
      const typeset = await renderTypesetContent(html, { waitFor: options.waitFor || 15000 });
      if (typeset && /mjx-container|<svg/i.test(typeset)) renderHtml = _freezeTypesetHtml(typeset);
      else if (typeset) renderHtml = _freezeTypesetHtml(typeset);
    } catch (_) { /* fall back to single-step below */ }
  }

  const shoot = async (h, extra) => blPost('/screenshot', {
    html: h,
    gotoOptions: { waitUntil: 'networkidle0', timeout: 45000 },
    options: shotOptions,
    viewport,
    ...extra,
  }, { timeout: 60000 });

  // Static (frozen) HTML needs no JS wait; raw HTML falls back to the readiness
  // flag then a fixed delay.
  let resp = renderHtml !== html
    ? await shoot(renderHtml, {})
    : await shoot(html, { waitForFunction: { fn: '() => window.__mjReady === true', timeout: options.waitFor || 8000 } });
  if (!resp.ok) {
    const firstErr = await resp.text().catch(() => '');
    resp = await shoot(renderHtml, { waitForTimeout: options.waitFor || 4000 });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Browserless /screenshot(html) error (${resp.status}): ${(text || firstErr).slice(0, 200)}`);
    }
  }
  return await resp.buffer();
}

// ── 🔴 LIVE screen adapter (FINAL fallback in the browser-use chain) ──────────
// Provides a liveScreen / cloudflareBrowserRun-COMPATIBLE session object so
// autoLiveScreen.js can treat Browserless as a real live provider. It does NOT
// need a sandbox or a graphical desktop: it simply re-screenshots the URL the
// agent is browsing a few times per second (Browserless v2 /screenshot) and
// emits those JPEG frames over the SAME `event: screen` SSE channel the web app
// and the APK already render. There is no hosted live URL (Browserless renders
// per-request), so directUrl() returns null and the UI uses the frame stream.
//
// This is the LAST resort: it only runs when neither the Daytona desktop nor
// Cloudflare Live could come up — guaranteeing the user still SEES the agent's
// browsing instead of an endless "Connecting to the live screen…".
//
// Returns a session: { provider, backend, isRunning, openUrl, exec, directUrl,
// refresh, stop }.
async function startLiveScreen(opts = {}) {
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const available = await isAvailable();
  if (!available) throw new Error('Browserless live unavailable — no working Browserless API key.');

  const width = parseInt(opts.width, 10) || 1280;
  const height = parseInt(opts.height, 10) || 800;
  const quality = Math.min(90, Math.max(30, parseInt(opts.quality, 10) || 60));
  const fps = Math.min(4, Math.max(1, parseInt(opts.fps, 10) || 2)); // Browserless is per-request → keep modest
  const intervalMs = Math.max(400, Math.round(1000 / fps));
  const maxMs = parseInt(opts.maxMs, 10) || 10 * 60 * 1000;

  onStep('🖼️ starting Browserless live view (server-rendered screenshots)…');

  let running = true;
  let currentUrl = (opts.startUrl && String(opts.startUrl).trim()) || 'https://www.google.com';
  let frameCount = 0;
  let lastSig = '';
  const startedAt = Date.now();

  // Background loop: screenshot the current URL → emit a frame. Best-effort; a
  // failed shot just skips that tick. Only emits CHANGED frames (cheap sig).
  const loop = (async () => {
    while (running) {
      if (Date.now() - startedAt > maxMs) { running = false; break; }
      const url = currentUrl;
      try {
        const dataUri = await screenshotUrl(url, {
          width, height, fullPage: false, type: 'jpeg', quality,
          waitUntil: 'domcontentloaded', timeout: 20000,
        });
        const b64 = (dataUri.split(',')[1]) || '';
        if (b64 && b64.length > 256) {
          const sig = b64.length + ':' + b64.charCodeAt(60) + ':' + b64.charCodeAt(b64.length - 1);
          if (sig !== lastSig) {
            lastSig = sig;
            frameCount++;
            onFrame(b64, { w: width, h: height, ts: Date.now(), n: frameCount, url });
          }
        }
      } catch (_) { /* skip this frame; keep streaming */ }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  })();

  const session = {
    provider: 'browserless',
    backend: 'Browserless',
    isRunning: () => running,

    async openUrl(url) {
      if (!url) return;
      const full = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      currentUrl = full;
      lastSig = ''; // force the next frame to emit even if dimensions match
      onStep('🌐 opening ' + full + ' in the Browserless live view…');
    },

    // No interactive desktop here — Browserless renders per-request.
    async exec() { return { output: '' }; },

    // Browserless has no persistent hosted live URL, so the UI uses the frame
    // stream (emitted via onFrame above). Returning null signals "frames only".
    async directUrl() { return null; },
    async refresh() { return null; },

    async stop() {
      running = false;
      try { await loop; } catch (_) {}
      onStep('🛑 Browserless live view stopped (' + frameCount + ' frames streamed).');
    },
  };

  return session;
}

module.exports = {
  screenshotUrl, scrapeUrl, scrapeElements, webSearchViaBrowserless,
  browseUrl, isAvailable, htmlToPdf, htmlToImage, testKey, getKey, invalidateKeyCache,
  startLiveScreen,
  // Exposed for the two-step MathJax pipeline + unit tests.
  renderTypesetContent, _needsMathJax, _freezeTypesetHtml,
  localHtmlToPdf, _resolveChromePath,
  // Persistent-browser lifecycle (used by tests + graceful shutdown).
  _getBrowser, _shutdownBrowser,
  ENDPOINT: BROWSERLESS_ENDPOINT,
  // 🦾 Direct access to the power scraper (final fallback browser tool).
  powerScrape: (url, opts) => (powerScraper ? powerScraper.browse(url, opts) : Promise.resolve({ url, error: 'power scraper unavailable' })),
  powerSearch: (q, opts) => (powerScraper ? powerScraper.search(q, opts) : Promise.resolve('')),
  // CAPTCHA / challenge solving (lazy-loaded to avoid a circular require).
  get solveCaptcha() { return require('./captchaSolver').solveCaptcha; },
};
