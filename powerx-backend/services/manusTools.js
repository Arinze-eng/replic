// ─────────────────────────────────────────────────────────────────────────────
// manusTools.js — Extra Manus-style tools for the WormGPT Agent.
//
// These augment the core agentEngine tool set with the capabilities that make
// Manus feel powerful, using only key-less / already-available backends so they
// work out of the box on Render with no extra config:
//
//   • fetch_url       — raw HTTP(S) request (GET/POST/PUT/DELETE, headers, body)
//   • generate_image  — text→image via Pollinations (free, no API key)
//   • create_chart    — data→chart PNG via QuickChart (Chart.js renderer, free)
//   • create_slides   — text/markdown → self-contained reveal.js HTML deck
//   • browser_action  — interactive browser (navigate + click/type/scroll +
//                       extract/screenshot) via Browserless /function (Puppeteer)
//   • deploy_site     — bundle an HTML file/dir in the workdir and publish it to
//                       a public URL (free static host) so it can be shared.
//
// Each tool follows the same contract as the core tools: async (args, ctx) and
// returns a STRING observation. Files are delivered via ctx.deliverBuffer /
// ctx.addFile, exactly like the existing tools.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Helpers ──────────────────────────────────────────────────────────────────
function safeName(name, fallback) {
  let n = String(name || fallback || 'file').replace(/[^\w.\-]/g, '_');
  if (!n) n = fallback || 'file';
  return n;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Cloudinary host helper ───────────────────────────────────────────────────
// Best-effort: upload an image/video buffer to Cloudinary and return a PERMANENT
// hosted URL. This "combines power" with the generation/editing backends
// (Replicate, HotBot, Cloudflare, …): they make the bytes, Cloudinary hosts &
// can transform them. If Cloudinary is NOT configured (or the upload fails) it
// returns null — the caller still delivers the raw bytes, so nothing breaks and
// the two services can be used together OR separately.
//   buffer : media bytes
//   opts   : { mime?, resourceType? ('image'|'video'), folder?, publicId?, tags? }
// returns  : hosted secure URL string, or null.
async function hostOnCloudinary(buffer, opts = {}) {
  try {
    const cloudinary = require('./cloudinary');
    if (!buffer || !buffer.length) return null;
    const out = await cloudinary.uploadBuffer(buffer, opts);
    return out && out.url ? out.url : null;
  } catch (_) {
    return null; // never let hosting break delivery
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: fetch_url — make a raw HTTP request and return status + headers + body.
// Use for REST APIs, webhooks, downloading JSON/text, posting payloads, etc.
//   args: { url, method?, headers?, body?, json? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolFetchUrl(args, ctx) {
  let url = (args.url || '').trim();
  if (!url) return '[fetch_url] No url. Pass {"url":"https://...", "method":"GET"}.';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const method = (args.method || 'GET').toUpperCase();
  const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (WormGPT-Agent)' }, args.headers || {});
  let body = args.body;
  if (body != null && typeof body !== 'string') { body = JSON.stringify(body); if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'; }
  if (args.json && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  try {
    const r = await fetchWithTimeout(url, { method, headers, body: (method === 'GET' || method === 'HEAD') ? undefined : body }, args.timeout_ms || 45000);
    const ct = r.headers.get('content-type') || '';
    const hdrs = {};
    r.headers.forEach((v, k) => { hdrs[k] = v; });
    // Binary download → deliver as a file instead of dumping bytes into the log.
    if (/(image|audio|video|octet-stream|pdf|zip|application\/(?!json|.*xml).*)/i.test(ct) && !/json|text|xml|html|javascript/i.test(ct)) {
      const buf = Buffer.from(await r.arrayBuffer());
      const fname = safeName(args.save_as || url.split('/').pop().split('?')[0] || 'download.bin', 'download.bin');
      await ctx.deliverBuffer(fname, buf);
      return `[fetch_url] ${method} ${url} → ${r.status}. Binary response (${ct}, ${(buf.length / 1024).toFixed(1)} KB) saved as ${fname} and queued for delivery.`;
    }
    let text = await r.text();
    const full = text.length;
    if (text.length > 8000) text = text.slice(0, 8000) + `\n…[truncated, ${full} chars total]`;
    return `[fetch_url] ${method} ${url}\nStatus: ${r.status} ${r.statusText}\nContent-Type: ${ct}\nHeaders: ${JSON.stringify(hdrs).slice(0, 600)}\n\nBody:\n${text}`;
  } catch (e) {
    return `[fetch_url] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: generate_image — text-to-image via Pollinations (free, no key).
//   args: { prompt, filename?, width?, height?, model? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolGenerateImage(args, ctx) {
  const prompt = (args.prompt || '').trim();
  if (!prompt) return '[generate_image] No prompt. Pass {"prompt":"a neon cyberpunk city at night"}.';
  const width = Math.min(Math.max(parseInt(args.width, 10) || 1024, 256), 2048);
  const height = Math.min(Math.max(parseInt(args.height, 10) || 1024, 256), 2048);
  const filename = safeName(args.filename || prompt.slice(0, 30), 'image').replace(/\.[^.]*$/, '') + '.jpg';
  if (ctx.onStep) ctx.onStep('🎨 generating image…');

  // Map requested w/h to the closest HotBot image_size string.
  const hbSize = (w, h) => {
    if (w === h) return '1024x1024';
    return w > h ? '1280x720' : '720x1280';
  };

  // 0) PRIMARY: REAL HotBot image generation (Seedream / Nano-Banana etc.).
  //    Best quality, no key required (anonymous free quota).
  try {
    const hotbot = require('./hotbot');
    if (hotbot.supportsImageGen && hotbot.supportsImageGen()) {
      const out = await hotbot.generateImageBuffer(prompt, {
        model: args.model && /seedream|recraft|ideogram|nano-banana|gpt-image|wan/i.test(args.model) ? args.model : undefined,
        image_size: hbSize(width, height),
        image_url: args.image_url || undefined,
      });
      if (out && out.buffer && out.buffer.length > 800) {
        const pngName = filename.replace(/\.jpg$/, '.png');
        await ctx.deliverBuffer(pngName, out.buffer);
        const hosted = await hostOnCloudinary(out.buffer, { mime: 'image/png', resourceType: 'image', folder: 'wormgpt/images', tags: ['generate_image', 'hotbot'] });
        return `[generate_image] Generated "${prompt}" via HotBot (${out.model}) → ${pngName} (${(out.buffer.length / 1024).toFixed(0)} KB). Image queued for delivery.` + (hosted ? ` Hosted on Cloudinary: ${hosted}` : '');
      }
    }
  } catch (e) {
    if (ctx.onStep) ctx.onStep(`(hotbot image failed: ${String(e.message).slice(0, 80)} — trying fallback)`);
  }

  // 1) FALLBACK: Cloudflare Workers AI (FLUX.1 schnell) — keys in Render env.
  try {
    const cloudflare = require('./cloudflare');
    const res = await cloudflare.generateImage(prompt, { seed: args.seed });
    if (res && res.image_base64) {
      const buf = Buffer.from(res.image_base64, 'base64');
      if (buf.length > 800) {
        await ctx.deliverBuffer(filename, buf);
        const hosted = await hostOnCloudinary(buf, { mime: 'image/png', resourceType: 'image', folder: 'wormgpt/images', tags: ['generate_image', 'cloudflare'] });
        return `[generate_image] Generated "${prompt}" via Cloudflare FLUX → ${filename} (${(buf.length / 1024).toFixed(0)} KB). Image queued for delivery.` + (hosted ? ` Hosted on Cloudinary: ${hosted}` : '');
      }
    }
  } catch (e) {
    if (ctx.onStep) ctx.onStep(`(cloudflare image failed: ${e.message.slice(0, 80)} — trying fallback)`);
  }

  // 1.5) FALLBACK: ToAPIs (paid gateway — nano-banana / Gemini-Flash-Image /
  //      Seedream / GPT-Image-2). Admin-updatable key (toapis_api_key). Used
  //      when the free engines are down/exhausted. Returns a real photorealistic
  //      image from the text prompt.
  try {
    const toapis = require('./toapis');
    if (await toapis.enabled()) {
      if (ctx.onStep) ctx.onStep('🎨 generating image via ToAPIs…');
      const t = await toapis.resolveGenerate(prompt, { width, height, model: args.toapis_model });
      if (t && t.buffer && t.buffer.length > 800) {
        const ext = t.mime === 'image/png' ? '.png' : (t.mime === 'image/webp' ? '.webp' : '.jpg');
        const tName = filename.replace(/\.[^.]*$/, ext);
        await ctx.deliverBuffer(tName, t.buffer);
        const hosted = await hostOnCloudinary(t.buffer, { mime: t.mime, resourceType: 'image', folder: 'wormgpt/images', tags: ['generate_image', 'toapis'] });
        return `[generate_image] Generated "${prompt}" via ToAPIs (${t.model}) → ${tName} (${(t.buffer.length / 1024).toFixed(0)} KB). Image queued for delivery.` + (hosted ? ` Hosted on Cloudinary: ${hosted}` : '');
      }
    }
  } catch (e) {
    if (ctx.onStep) ctx.onStep(`(toapis image failed: ${String(e.message).slice(0, 80)} — trying fallback)`);
  }

  // 2) FALLBACK: Pollinations (free, no key) — may be rate-limited.
  try {
    const model = (args.model || 'flux').replace(/[^\w-]/g, '');
    const seed = args.seed != null ? args.seed : Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${model}&seed=${seed}&nologo=true`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 120000);
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 1000) {
        await ctx.deliverBuffer(filename, buf);
        const hosted = await hostOnCloudinary(buf, { mime: 'image/jpeg', resourceType: 'image', folder: 'wormgpt/images', tags: ['generate_image', 'pollinations'] });
        return `[generate_image] Generated "${prompt}" → ${filename} (${width}x${height}, ${(buf.length / 1024).toFixed(0)} KB). Image queued for delivery.` + (hosted ? ` Hosted on Cloudinary: ${hosted}` : '');
      }
    }
    return `[generate_image] both image backends failed (cloudflare unavailable, pollinations returned ${r.status}). Ensure CF_API_TOKEN is set in Render env.`;
  } catch (e) {
    return `[generate_image] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_chart — render a Chart.js config to a PNG via QuickChart (free).
//   args: { type, labels, datasets | data, title?, filename?, width?, height? }
//   - simple form: {type:"bar", labels:[...], datasets:[{label,data},...]}
//   - advanced:    {chart:{...full Chart.js config...}}
// ─────────────────────────────────────────────────────────────────────────────
async function toolCreateChart(args, ctx) {
  let chartConfig = args.chart || args.config;
  if (!chartConfig) {
    const type = args.type || 'bar';
    const labels = args.labels || (Array.isArray(args.data) ? args.data.map((_, i) => `#${i + 1}`) : []);
    let datasets = args.datasets;
    if (!datasets && Array.isArray(args.data)) datasets = [{ label: args.title || 'Series', data: args.data }];
    if (!datasets || !datasets.length) return '[create_chart] Provide {type,labels,datasets} or a full {chart:{...}} Chart.js config.';
    chartConfig = {
      type,
      data: { labels, datasets },
      options: { plugins: { title: { display: !!args.title, text: args.title || '' }, legend: { display: true } } },
    };
  }
  const width = Math.min(parseInt(args.width, 10) || 800, 2000);
  const height = Math.min(parseInt(args.height, 10) || 500, 2000);
  const filename = safeName(args.filename || (args.title || 'chart'), 'chart').replace(/\.[^.]*$/, '') + '.png';
  try {
    if (ctx.onStep) ctx.onStep('📊 rendering chart…');
    const r = await fetchWithTimeout('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width, height, backgroundColor: 'white', format: 'png', chart: chartConfig }),
    }, 60000);
    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      return `[create_chart] chart service returned ${r.status}: ${errTxt.slice(0, 300)}`;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) return '[create_chart] empty chart returned. Check your config.';
    await ctx.deliverBuffer(filename, buf);
    return `[create_chart] Rendered chart → ${filename} (${width}x${height}, ${(buf.length / 1024).toFixed(0)} KB). Image queued for delivery.`;
  } catch (e) {
    return `[create_chart] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_slides — build a self-contained reveal.js HTML presentation.
//   args: { title?, slides:[{title?, content?, bullets?}] | markdown?, filename?, theme? }
//   - Either pass structured `slides`, OR `markdown` (slides split on "---").
// ─────────────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function mdInline(s) {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function slideBodyFromText(text) {
  const lines = String(text || '').split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (/^[-*]\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${mdInline(t.replace(/^[-*]\s+/, ''))}</li>`;
    } else if (/^#{1,3}\s+/.test(t)) {
      if (inList) { html += '</ul>'; inList = false; }
      const level = t.match(/^#+/)[0].length;
      html += `<h${level}>${mdInline(t.replace(/^#+\s+/, ''))}</h${level}>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${mdInline(t)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
async function toolCreateSlides(args, ctx) {
  const title = args.title || 'Presentation';
  const theme = (args.theme || 'black').replace(/[^\w-]/g, '');
  const filename = safeName(args.filename || title, 'slides').replace(/\.[^.]*$/, '') + '.html';
  let slidesHtml = '';
  let count = 0;

  if (Array.isArray(args.slides) && args.slides.length) {
    for (const s of args.slides) {
      let body = '';
      if (s.title) body += `<h2>${mdInline(s.title)}</h2>`;
      if (s.content) body += slideBodyFromText(s.content);
      if (Array.isArray(s.bullets) && s.bullets.length) {
        body += '<ul>' + s.bullets.map(b => `<li>${mdInline(b)}</li>`).join('') + '</ul>';
      }
      slidesHtml += `<section>${body}</section>`;
      count++;
    }
  } else if (args.markdown) {
    const decks = String(args.markdown).split(/^\s*---\s*$/m);
    for (const d of decks) {
      if (!d.trim()) continue;
      slidesHtml += `<section>${slideBodyFromText(d)}</section>`;
      count++;
    }
  } else {
    return '[create_slides] Provide either {"slides":[{title,content|bullets},...]} or {"markdown":"slide1\\n---\\nslide2"}.';
  }
  if (!count) return '[create_slides] No slides produced.';

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/theme/${theme}.css">
<style>.reveal h1,.reveal h2,.reveal h3{text-transform:none}.reveal section{font-size:.9em}.reveal code{background:#0003;padding:.1em .3em;border-radius:4px}</style>
</head><body>
<div class="reveal"><div class="slides">
<section><h1>${escapeHtml(title)}</h1>${args.subtitle ? `<p>${mdInline(args.subtitle)}</p>` : ''}</section>
${slidesHtml}
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@4.6.1/dist/reveal.js"></script>
<script>Reveal.initialize({hash:true,slideNumber:true});</script>
</body></html>`;

  await ctx.deliverBuffer(filename, Buffer.from(html, 'utf-8'));
  return `[create_slides] Built a ${count + 1}-slide reveal.js deck → ${filename}. Open it in a browser to present (arrow keys / Space). Queued for delivery. You can also deploy_site it to get a public link.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: browser_action — interactive browser via Browserless /function (real
// Puppeteer). Runs a sequence of steps (navigate/click/type/select/scroll/wait)
// then returns the page text and (optionally) a screenshot delivered as a file.
//   args: { url, steps:[{action,selector?,text?,ms?}], extract?(bool), screenshot?(bool|filename) }
// ─────────────────────────────────────────────────────────────────────────────
async function toolBrowserAction(args, ctx) {
  const url = (args.url || '').trim();
  if (!url) return '[browser_action] No url. Pass {"url":"...","steps":[{"action":"click","selector":"#btn"}]}.';

  const steps = Array.isArray(args.steps) ? args.steps : [];
  const wantShot = !!args.screenshot;
  const fullUrl = /^https?:\/\//i.test(url) ? url : 'https://' + url;

  // Browser workloads have an explicit Daytona-first policy independent of the
  // admin's general sandbox choice. Try the sandbox-native Chromium path before
  // Browserless. Basic selector-driven flows run entirely there; richer smart
  // actions still perform this Daytona-first navigation attempt, then retain the
  // proven Browserless smart-element engine as a functional fallback.
  let daytonaAttempt = null;
  try {
    const sandboxBrowser = require('./sandboxBrowser');
    const sessionKey = (ctx && (ctx.sessionKey || ctx.chatId)) || null;
    const nativeActions = [];
    let nativeCompatible = true;
    for (const step of steps) {
      const act = String(step.action || '').toLowerCase();
      if (act === 'click' && step.selector) nativeActions.push({ action: 'click', selector: step.selector });
      else if (['type', 'input', 'fill'].includes(act) && step.selector) nativeActions.push({ action: 'fill', selector: step.selector, text: step.text != null ? step.text : step.value });
      else if (act === 'press') nativeActions.push({ action: 'press', selector: step.selector || 'body', key: step.key || step.text || 'Enter' });
      else if (act === 'wait') nativeActions.push({ action: 'wait', seconds: Math.min(10, Math.max(0, Number(step.seconds != null ? step.seconds : (step.ms || 1000) / 1000) || 1)) });
      else if (['goto', 'navigate'].includes(act) && (step.url || step.text)) nativeActions.push({ action: 'goto', url: step.url || step.text });
      else if (act === 'scroll') nativeActions.push({ action: 'scroll', y: step.direction === 'up' ? -(Math.abs(Number(step.amount) || 1200)) : (Math.abs(Number(step.amount) || 1200)) });
      else if (['otp', 'two_factor', '2fa'].includes(act)) nativeActions.push({ action: act, selector: step.selector, code: step.code != null ? step.code : (step.value != null ? step.value : step.text) });
      else nativeCompatible = false;
    }
    daytonaAttempt = await sandboxBrowser.browseInSandbox(fullUrl, {
      sessionKey,
      maxRounds: args.max_rounds || 10,
      actions: nativeCompatible ? nativeActions : [],
      screenshot: wantShot,
    });
    if (daytonaAttempt && daytonaAttempt.ok && daytonaAttempt.auth && daytonaAttempt.auth.required) {
      return `[browser_action] AUTHENTICATION_REQUIRED (${daytonaAttempt.auth.kind || 'otp'}): ${daytonaAttempt.auth.message || 'User action is required.'}\n` +
        `The Daytona browser session is paused and saved. Ask the user for the code or approval, then resume this same session; do not restart navigation.\n` +
        `Current page: ${daytonaAttempt.finalUrl || fullUrl}\n\n${String(daytonaAttempt.text || '').slice(0, 6000)}`;
    }
    if (nativeCompatible && daytonaAttempt && daytonaAttempt.ok) {
      let report = `[browser_action] ${fullUrl} — via ${daytonaAttempt.backend} sandbox (Daytona attempted first)`;
      if (daytonaAttempt.finalUrl && daytonaAttempt.finalUrl !== fullUrl) report += `\n[final url] ${daytonaAttempt.finalUrl}`;
      if (daytonaAttempt.log && daytonaAttempt.log.length) report += `\nSteps:\n${daytonaAttempt.log.map(x => ' - ' + x).join('\n')}`;
      report += `\n\nPage text:\n${String(daytonaAttempt.text || '').slice(0, 6000)}`;
      if (wantShot && daytonaAttempt.screenshot && ctx && typeof ctx.deliverBuffer === 'function') {
        const b64 = String(daytonaAttempt.screenshot).split(',')[1] || '';
        if (b64) {
          const fname = safeName(typeof args.screenshot === 'string' ? args.screenshot : 'browser_action.jpg', 'browser_action.jpg').replace(/\.[^.]*$/, '') + '.jpg';
          await ctx.deliverBuffer(fname, Buffer.from(b64, 'base64'));
          report += `\n\n[screenshot saved as ${fname} and queued for delivery]`;
        }
      }
      return report;
    }
  } catch (_) { /* preserve the existing Browserless fallback */ }

  const browserless = require('./browserless');
  let token = null;
  try { if (typeof browserless.getKey === 'function') token = await browserless.getKey(); } catch (_) { token = null; }
  if (!token) token = process.env.BROWSERLESS_API_KEY || null;
  if (!token) {
    if (daytonaAttempt && daytonaAttempt.ok) {
      return `[browser_action] Daytona opened the page, but this smart action needs the fallback engine and Browserless is not configured.\n\nPage text:\n${String(daytonaAttempt.text || '').slice(0, 6000)}`;
    }
    return '[browser_action] Daytona was unavailable and Browserless is not configured. Configure Daytona or Browserless in Admin → Integrations.';
  }

  const endpoint = (process.env.BROWSERLESS_ENDPOINT || 'https://production-sfo.browserless.io').replace(/\/$/, '');
  // CAPTCHA auto-solve is ON by default so the agent can browse ANY site without
  // restrictions. Pass {"solve_captcha": false} to disable for a given call.
  const autoCaptcha = args.solve_captcha !== false && args.captcha !== false;
  // Auto-detect login fields and (optionally) sign in without the agent having
  // to know the selectors. Either pass {"login":{"username":"..","password":".."}}
  // OR a top-level {"username":"..","password":".."} and we'll do a smart_login.
  const loginCreds = (args.login && typeof args.login === 'object') ? args.login
    : ((args.username || args.password) ? { username: args.username, email: args.username, password: args.password } : null);

  // Puppeteer script executed remotely by Browserless.
  const fnCode = `
export default async function ({ page }) {
  const out = { log: [], text: '', screenshot: null, captcha: null, elements: null, currentUrl: '', pageData: null, found: undefined };

  // ── Stealth: hide automation fingerprints before any navigation ──────────
  try {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36');
  } catch (e) {}

  await page.setViewport({ width: ${parseInt(args.width,10)||1366}, height: ${parseInt(args.height,10)||768} });
  await page.goto(${JSON.stringify(fullUrl)}, { waitUntil: 'domcontentloaded', timeout: 35000 });

  // ── CAPTCHA / bot-challenge auto-solver ──────────────────────────────────
  // Detects & solves Cloudflare "Just a moment", Turnstile, reCAPTCHA v2,
  // hCaptcha and generic "verify you are human" interstitials so the rest of
  // the steps run on the REAL page, not a challenge wall.
  async function challengeState() {
    let title = ''; try { title = (await page.title()) || ''; } catch (e) {}
    const t = title.toLowerCase();
    const s = { title, cf: false, turnstile: false, recaptcha: false, hcaptcha: false, generic: false };
    if (t.includes('just a moment') || t.includes('attention required') || t.includes('checking your browser')) s.cf = true;
    try { s.turnstile = await page.evaluate(() => !!document.querySelector('[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]')); } catch (e) {}
    try { s.recaptcha = await page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha/api2/anchor"], .g-recaptcha, #g-recaptcha-response')); } catch (e) {}
    try { s.hcaptcha = await page.evaluate(() => !!document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha, [name="h-captcha-response"]')); } catch (e) {}
    try { s.generic = await page.evaluate(() => /verify you are human|i am human|are you a robot|press & hold|complete the captcha/.test((document.body?document.body.innerText:'').toLowerCase())); } catch (e) {}
    s.blocked = s.cf || s.turnstile || s.recaptcha || s.hcaptcha || s.generic;
    return s;
  }
  async function attemptSolve(s) {
    if (s.cf || s.turnstile) {
      const fr = page.frames().find(f => /turnstile|challenges\\.cloudflare\\.com/.test(f.url()));
      if (fr) { for (const sel of ['input[type="checkbox"]', '[tabindex="0"]', 'label', 'body']) { try { const el = await fr.$(sel); if (el) { await el.click({ delay: 60 }); break; } } catch (e) {} } }
      else { try { await page.mouse.click(200, 290, { delay: 60 }); } catch (e) {} }
    }
    if (s.recaptcha) { const fr = page.frames().find(f => /recaptcha\\/api2\\/anchor/.test(f.url())); if (fr) { try { const el = await fr.$('#recaptcha-anchor, .recaptcha-checkbox-border'); if (el) await el.click({ delay: 60 }); } catch (e) {} } }
    if (s.hcaptcha) { const fr = page.frames().find(f => /hcaptcha\\.com/.test(f.url())); if (fr) { try { const el = await fr.$('#checkbox, .check, [role="checkbox"]'); if (el) await el.click({ delay: 60 }); } catch (e) {} } }
    if (s.generic && !s.cf && !s.turnstile) { try { await page.evaluate(() => { const re=/verify|human|continue|proceed|i am not a robot|confirm/i; const b=Array.from(document.querySelectorAll('button,input[type=submit],a,[role=button]')).find(x=>re.test((x.innerText||x.value||'').trim())); if(b)b.click(); }); } catch (e) {} }
  }
  if (${autoCaptcha ? 'true' : 'false'}) {
    try {
      let st = await challengeState(); let rounds = 0;
      const detected = { cloudflare: st.cf, turnstile: st.turnstile, recaptcha: st.recaptcha, hcaptcha: st.hcaptcha, generic: st.generic };
      while (st.blocked && rounds < 8) {
        await attemptSolve(st);
        await new Promise(r => setTimeout(r, 2000));
        try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 4000 }); } catch (e) {}
        st = await challengeState(); rounds++;
      }
      if (detected.cloudflare || detected.turnstile || detected.recaptcha || detected.hcaptcha || detected.generic) {
        let cookies = []; try { cookies = await page.cookies(); } catch (e) {}
        const cookieMap = {}; cookies.forEach(c => { cookieMap[c.name] = c.value; });
        // Treat as solved if the hard wall is gone (cf interstitial cleared) OR
        // we obtained a cf_clearance cookie — a residual embedded widget may linger.
        const ftitle = (st.title || '').toLowerCase();
        const titleWall = ftitle.includes('just a moment') || ftitle.includes('attention required') || ftitle.includes('checking your browser');
        const reallySolved = (!st.cf && !titleWall) && (!!cookieMap.cf_clearance || !st.generic);
        out.captcha = { solved: reallySolved, rounds, detected, hasCfClearance: !!cookieMap.cf_clearance };
        out.log.push('captcha: ' + (reallySolved ? 'solved' : 'partial') + ' after ' + rounds + ' round(s)');
      }
    } catch (e) { out.log.push('captcha solver error: ' + e.message); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SMART ELEMENT ENGINE — runs IN-PAGE so the agent never needs exact CSS.
  // It can find inputs/buttons by visible label, placeholder, aria-label, name,
  // id, type or nearby text, and exposes a structured map of every interactive
  // element. This is what fixes "can't find the input field / login button".
  // ════════════════════════════════════════════════════════════════════════
  const SMART = () => {
    // Injected once; everything below lives in the page context.
    const W = window;
    if (W.__smart) return;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };
    const labelFor = (el) => {
      let parts = [];
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) parts.push(lab.innerText);
      }
      const wrap = el.closest('label'); if (wrap) parts.push(wrap.innerText);
      parts.push(el.getAttribute('aria-label') || '');
      parts.push(el.getAttribute('placeholder') || '');
      parts.push(el.getAttribute('name') || '');
      parts.push(el.getAttribute('title') || '');
      const ariaBy = el.getAttribute('aria-labelledby');
      if (ariaBy) { const t = document.getElementById(ariaBy); if (t) parts.push(t.innerText); }
      // text just before the field (common pattern)
      let prev = el.previousElementSibling;
      if (prev && prev.innerText && prev.innerText.length < 40) parts.push(prev.innerText);
      return parts.join(' ').replace(/\\s+/g, ' ').trim().toLowerCase();
    };
    // Build a stable, unique selector for an element.
    const selectorOf = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.name && el.tagName === 'INPUT') return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
      // data-testid is very common & stable
      const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
      if (tid) return '[data-testid="' + tid + '"]';
      // fall back to nth-of-type path (short)
      const path = [];
      let node = el;
      while (node && node.nodeType === 1 && path.length < 4) {
        let part = node.tagName.toLowerCase();
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.trim().split(/\\s+/).filter(c => c && !/\\d{4,}/.test(c)).slice(0, 2);
          if (cls.length) part += '.' + cls.map(c => CSS.escape(c)).join('.');
        }
        const parent = node.parentNode;
        if (parent) {
          const sib = Array.from(parent.children).filter(c => c.tagName === node.tagName);
          if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(node) + 1) + ')';
        }
        path.unshift(part);
        node = node.parentNode;
      }
      return path.join(' > ');
    };
    const allInteractive = () => Array.from(document.querySelectorAll(
      'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="textbox"], [contenteditable="true"], [onclick]'
    )).filter(visible);

    // Score how well an element matches a free-text "hint".
    const scoreMatch = (el, hint) => {
      hint = (hint || '').toLowerCase().trim();
      if (!hint) return 0;
      const text = ((el.innerText || el.value || '') + ' ' + labelFor(el)).toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      let s = 0;
      if (text === hint) s += 100;
      if (text.includes(hint)) s += 50;
      // word overlap
      const hw = hint.split(/\\s+/).filter(Boolean);
      hw.forEach(w => { if (text.includes(w)) s += 12; });
      // semantic synonyms for common login fields
      const syn = {
        username: ['username','user name','user','login','account','email','e-mail','userid','user id','phone','mobile'],
        password: ['password','pass','passwd','pwd'],
        email: ['email','e-mail','mail'],
        submit: ['login','log in','sign in','signin','submit','continue','next','enter','go','log on']
      };
      for (const k in syn) {
        if (hint.includes(k) || syn[k].includes(hint)) {
          if (syn[k].some(v => text.includes(v))) s += 30;
          if (k === 'password' && type === 'password') s += 60;
          if (k === 'email' && type === 'email') s += 40;
          if ((k === 'username' || k === 'email') && (type === 'text' || type === 'email' || type === 'tel' || !type)) s += 8;
        }
      }
      return s;
    };

    const resolve = (hint, kinds) => {
      const cands = allInteractive().filter(el => {
        if (!kinds) return true;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (kinds === 'input') return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
        if (kinds === 'click') return tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button' || type === 'submit' || type === 'button' || el.onclick;
        return true;
      });
      let best = null, bestScore = 0;
      cands.forEach(el => { const s = scoreMatch(el, hint); if (s > bestScore) { bestScore = s; best = el; } });
      return best && bestScore >= 12 ? { selector: selectorOf(best), score: bestScore } : null;
    };

    // Detect the login form trio: username/email field, password field, submit.
    const findLogin = () => {
      const inputs = allInteractive().filter(el => ['input','textarea'].includes(el.tagName.toLowerCase()));
      let pass = inputs.find(el => (el.getAttribute('type') || '').toLowerCase() === 'password');
      let user = null;
      if (pass) {
        // username is usually the visible text/email/tel input just before password
        const cand = inputs.filter(el => {
          const t = (el.getAttribute('type') || '').toLowerCase();
          return el !== pass && ['text','email','tel',''].includes(t);
        });
        // prefer the one immediately preceding the password field in DOM order
        const all = inputs;
        const pi = all.indexOf(pass);
        for (let i = pi - 1; i >= 0; i--) { if (cand.includes(all[i])) { user = all[i]; break; } }
        if (!user) user = cand.find(el => /user|email|mail|login|account|phone|mobile|name/i.test(labelFor(el))) || cand[0];
      } else {
        // No password yet (multi-step login e.g. Google) → just find email/user step
        user = inputs.find(el => {
          const t = (el.getAttribute('type') || '').toLowerCase();
          return ['email','text','tel'].includes(t) && /user|email|mail|login|account|phone/i.test(labelFor(el));
        }) || inputs.find(el => ['email','text'].includes((el.getAttribute('type')||'').toLowerCase()));
      }
      // submit button: inside the same form, or a global login/sign-in button
      let submit = null;
      const form = (pass && pass.form) || (user && user.form);
      const btns = allInteractive().filter(el => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        return tag === 'button' || type === 'submit' || el.getAttribute('role') === 'button' || (tag === 'a' && /log|sign|continue|next/i.test(el.innerText||''));
      });
      const re = /^(log\\s?in|sign\\s?in|signin|login|continue|next|submit|enter|log\\s?on)$/i;
      submit = btns.find(b => form && b.form === form && re.test((b.innerText||b.value||'').trim()))
            || btns.find(b => re.test((b.innerText||b.value||'').trim()))
            || btns.find(b => /log|sign|continue|next|submit/i.test((b.innerText||b.value||'').trim()))
            || (form ? btns.find(b => b.form === form) : null)
            || btns[0];
      return {
        username: user ? selectorOf(user) : null,
        password: pass ? selectorOf(pass) : null,
        submit: submit ? selectorOf(submit) : null,
      };
    };

    const inspect = () => {
      const map = { inputs: [], buttons: [], links: [], forms: 0, menus: [] };
      try { map.forms = document.querySelectorAll('form').length; } catch (e) {}
      allInteractive().slice(0, 90).forEach(el => {
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const lbl = labelFor(el).slice(0, 60) || (el.innerText||'').trim().slice(0,60);
        const entry = { selector: selectorOf(el), label: lbl, type: type || tag };
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
          if (type === 'radio' || type === 'checkbox') { entry.checked = !!el.checked; entry.name = el.getAttribute('name') || ''; }
          map.inputs.push(entry);
        }
        else if (tag === 'a') { entry.href = el.getAttribute('href') || ''; map.links.push(entry); }
        else map.buttons.push(entry);
      });
      // Menu / hamburger / nav toggles — very common blocker ("can't find the menu").
      try { map.menus = findMenus().map(m => ({ selector: selectorOf(m.el), label: m.why })); } catch (e) {}
      map.inputs = map.inputs.slice(0, 30);
      map.buttons = map.buttons.slice(0, 30);
      map.links = map.links.slice(0, 25);
      map.menus = map.menus.slice(0, 10);
      return map;
    };

    // ── Detect hamburger / menu / nav-toggle elements ────────────────────────
    // Recognises them by aria-label, class/id (hamburger/menu/nav/burger/toggle),
    // aria-expanded/aria-controls, role=button near <nav>/<header>, or the classic
    // 3-bar SVG / ☰ glyph. Returns the strongest candidates.
    const findMenus = () => {
      const out = [];
      const cands = Array.from(document.querySelectorAll(
        'button, a, [role="button"], [aria-label], [class*="menu" i], [class*="hamburger" i], [class*="burger" i], [class*="nav-toggle" i], [class*="navbar-toggle" i], [id*="menu" i], [id*="hamburger" i], svg, i'
      )).filter(visible);
      const seen = new Set();
      cands.forEach(el => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const cls = ((el.className && typeof el.className === 'string') ? el.className : '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const txt = (el.innerText || el.textContent || '').trim();
        const hasControls = el.hasAttribute('aria-controls') || el.hasAttribute('aria-expanded');
        let why = '';
        if (/menu|hamburger|burger|navigation|nav[- ]?toggle|open menu|toggle menu|main menu/.test(aria)) why = 'aria:' + aria;
        else if (/hamburger|burger|nav-?toggle|navbar-?toggle|menu-?(icon|button|toggle|btn)|mobile-?menu/.test(cls + ' ' + id)) why = 'class/id';
        else if (txt === '\u2630' || txt === '\u003D' || /^menu$/i.test(txt)) why = 'glyph/text';
        else if (hasControls && (/nav|menu/.test(cls + ' ' + id + ' ' + aria))) why = 'aria-controls';
        // 3-line SVG icon (hamburger) — 2-4 <line>/<rect>/<path> children in an SVG
        if (!why) {
          const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector && el.querySelector('svg');
          if (svg) {
            const lines = svg.querySelectorAll('line, rect, path').length;
            const near = el.closest('header, nav, [class*="header" i], [class*="navbar" i], [class*="topbar" i]');
            if (lines >= 2 && lines <= 5 && near && !txt) why = 'svg-hamburger';
          }
        }
        if (why) {
          // climb to the nearest clickable ancestor so a click actually fires
          let clickable = el;
          for (let i = 0; i < 3 && clickable; i++) {
            const t = clickable.tagName.toLowerCase();
            if (t === 'button' || t === 'a' || clickable.getAttribute('role') === 'button' || clickable.onclick || clickable.hasAttribute('aria-expanded')) break;
            clickable = clickable.parentElement || clickable;
          }
          const sel = selectorOf(clickable);
          if (!seen.has(sel)) { seen.add(sel); out.push({ el: clickable, why }); }
        }
      });
      return out.slice(0, 10);
    };

    // ── Read structured page content: title, headings, main text, and any
    // multiple-choice questions (radio/checkbox groups → for exam solving). ──
    const readPage = () => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const res = { title: clean(document.title), url: location.href, headings: [], text: '', questions: [] };
      try {
        res.headings = Array.from(document.querySelectorAll('h1,h2,h3'))
          .filter(visible).slice(0, 40).map(h => clean(h.innerText).slice(0, 140)).filter(Boolean);
      } catch (e) {}
      // Group radio/checkbox inputs by name → a likely quiz/exam question.
      try {
        const groups = {};
        Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(visible).forEach(inp => {
          const name = inp.getAttribute('name') || ('_' + (inp.id || Math.random()));
          (groups[name] = groups[name] || []).push(inp);
        });
        Object.keys(groups).forEach(name => {
          const opts = groups[name];
          if (!opts.length) return;
          // question text = nearest fieldset legend / preceding heading / container text
          let q = '';
          const fs = opts[0].closest('fieldset');
          if (fs) { const lg = fs.querySelector('legend'); if (lg) q = clean(lg.innerText); }
          if (!q) {
            let node = opts[0].closest('li, .question, [class*="question" i], form, div');
            if (node) { const h = node.querySelector('label, p, h1,h2,h3,h4,legend,.q,.question-text'); if (h) q = clean(h.innerText).slice(0, 300); }
          }
          res.questions.push({
            name,
            type: (opts[0].getAttribute('type') || '').toLowerCase(),
            question: q.slice(0, 300),
            options: opts.slice(0, 12).map(o => ({ selector: selectorOf(o), label: labelFor(o).slice(0, 120) || clean(o.value), checked: !!o.checked })),
          });
        });
      } catch (e) {}
      try { res.text = clean(document.body ? document.body.innerText : '').slice(0, 6000); } catch (e) {}
      return res;
    };

    // Find a clickable/visible element by its visible text (exact-ish), return selector.
    const findByText = (text, kinds) => {
      const r = resolve(text, kinds || null);
      return r ? r : null;
    };

    W.__smart = { resolve, findLogin, inspect, selectorOf, labelFor, findMenus, readPage, findByText };
  };

  // Helper (Node side of the function) to (re)inject the smart engine & call it.
  async function smartCall(method, ...a) {
    await page.evaluate('(' + SMART.toString() + ')()');
    return await page.evaluate((m, args2) => window.__smart[m].apply(null, args2), method, a);
  }

  // Resolve a step's target to a concrete selector. Order of preference:
  //   1) explicit s.selector that actually matches
  //   2) smart resolve by s.text / s.label / s.hint
  async function resolveTarget(s, kind) {
    // 1) explicit selector that exists
    if (s.selector) {
      try { const el = await page.$(s.selector); if (el) return s.selector; } catch (e) {}
    }
    // 2) smart by hint text
    const hint = s.label || s.hint || s.field || s.target || s.text || s.name || '';
    if (hint || kind) {
      const r = await smartCall('resolve', hint, kind);
      if (r && r.selector) return r.selector;
    }
    return s.selector || null;
  }

  // High-level: perform an auto login with given creds (no selectors needed).
  async function doSmartLogin(creds) {
    const info = await smartCall('findLogin');
    out.log.push('smart_login detected: ' + JSON.stringify(info));
    const uname = creds.username || creds.user || creds.email || creds.login || '';
    const pword = creds.password || creds.pass || '';
    let did = 0;
    if (info.username && uname) {
      try { await page.click(info.username, { clickCount: 3 }).catch(()=>{}); await page.type(info.username, String(uname), { delay: 25 }); did++; out.log.push('ok: filled username → ' + info.username); }
      catch (e) { out.log.push('FAIL: fill username — ' + e.message); }
    }
    if (info.password && pword) {
      try { await page.click(info.password, { clickCount: 3 }).catch(()=>{}); await page.type(info.password, String(pword), { delay: 25 }); did++; out.log.push('ok: filled password → ' + info.password); }
      catch (e) { out.log.push('FAIL: fill password — ' + e.message); }
    }
    if (info.submit) {
      try {
        await Promise.all([
          page.click(info.submit).catch(()=>{}),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(()=>{}),
        ]);
        did++; out.log.push('ok: clicked submit → ' + info.submit);
      } catch (e) { out.log.push('FAIL: submit — ' + e.message); }
    } else if (info.password) {
      // No submit button found → press Enter in the password field.
      try { await page.keyboard.press('Enter'); await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(()=>{}); out.log.push('ok: pressed Enter to submit'); } catch (e) {}
    }
    return did;
  }

  // If creds were passed at the top level, run a smart login first.
  const LOGIN_CREDS = ${JSON.stringify(loginCreds)};
  if (LOGIN_CREDS && (LOGIN_CREDS.username || LOGIN_CREDS.email || LOGIN_CREDS.password)) {
    try { await new Promise(r => setTimeout(r, 600)); await doSmartLogin(LOGIN_CREDS); }
    catch (e) { out.log.push('smart_login error: ' + e.message); }
  }

  // ── Run the explicit step list with the smart resolver as a safety net ────
  const steps = ${JSON.stringify(steps)};
  for (const s of steps) {
    try {
      const act = (s.action || '').toLowerCase();
      if (act === 'inspect' || act === 'map' || act === 'elements') {
        out.elements = await smartCall('inspect');
        out.log.push('ok: inspect (' + (out.elements.inputs.length) + ' inputs, ' + (out.elements.buttons.length) + ' buttons, ' + (out.elements.links.length) + ' links)');
      }
      else if (act === 'smart_login' || act === 'login') {
        const creds = s.credentials || { username: s.username || s.user || s.email, email: s.email || s.username, password: s.password || s.pass };
        const n = await doSmartLogin(creds);
        out.log.push('ok: smart_login filled ' + n + ' field(s)');
      }
      else if (act === 'click' || act === 'click_text') {
        const sel = await resolveTarget(s, 'click');
        if (!sel) throw new Error('could not locate a clickable element for "' + (s.text||s.label||s.selector||'') + '"');
        try { await page.waitForSelector(sel, { timeout: 8000 }); } catch (e) {}
        await Promise.all([
          page.click(sel).catch(async () => { await page.evaluate(x => { const e = document.querySelector(x); if (e) e.click(); }, sel); }),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(()=>{}),
        ]);
        out.log.push('ok: click → ' + sel);
      }
      else if (act === 'type' || act === 'input' || act === 'fill' || act === 'fill_field') {
        const sel = await resolveTarget(s, 'input');
        if (!sel) throw new Error('could not locate an input for "' + (s.field||s.label||s.text||s.selector||'') + '"');
        try { await page.waitForSelector(sel, { timeout: 8000 }); } catch (e) {}
        // value can come from s.value (fill) or s.text (type)
        const val = String(s.value != null ? s.value : (s.text || ''));
        await page.click(sel, { clickCount: 3 }).catch(()=>{});
        await page.type(sel, val, { delay: 25 });
        out.log.push('ok: fill → ' + sel);
      }
      else if (act === 'select') { const sel = await resolveTarget(s, 'input'); await page.select(sel, String(s.value != null ? s.value : (s.text || ''))); out.log.push('ok: select → ' + sel); }
      else if (act === 'press') { await page.keyboard.press(String(s.text || s.key || 'Enter')); out.log.push('ok: press ' + (s.text||s.key||'Enter')); }
      else if (act === 'scroll') { const dy = (s.direction === 'up' ? -1 : 1) * (parseInt(s.amount,10) || 0); if (dy) { await page.evaluate(y => window.scrollBy(0, y), dy); } else if (s.to === 'bottom') { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); } else if (s.to === 'top') { await page.evaluate(() => window.scrollTo(0, 0)); } else { await page.evaluate(() => window.scrollBy(0, window.innerHeight)); } out.log.push('ok: scroll'); }
      else if (act === 'wait') { await new Promise(r => setTimeout(r, Math.min(s.ms || 1500, 15000))); out.log.push('ok: wait ' + (s.ms||1500) + 'ms'); }
      else if (act === 'waitforselector' || act === 'waitfor') { const sel = await resolveTarget(s, null); await page.waitForSelector(sel, { timeout: 15000 }); out.log.push('ok: waitForSelector ' + sel); }
      else if (act === 'wait_for_text' || act === 'waitfortext') {
        const needle = String(s.text || s.value || '').toLowerCase(); const deadline = Date.now() + Math.min(s.timeout || 15000, 25000); let found = false;
        while (Date.now() < deadline) { try { found = await page.evaluate(n => (document.body ? document.body.innerText : '').toLowerCase().includes(n), needle); } catch (e) {} if (found) break; await new Promise(r => setTimeout(r, 500)); }
        out.log.push((found ? 'ok' : 'FAIL') + ': wait_for_text "' + needle.slice(0,40) + '"');
      }
      else if (act === 'goto' || act === 'navigate') { await page.goto(/^https?:/i.test(s.url||s.text||'') ? (s.url||s.text) : 'https://' + (s.url||s.text||''), { waitUntil: 'domcontentloaded', timeout: 30000 }); out.log.push('ok: goto ' + (s.url||s.text)); }
      else if (act === 'back') { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); out.log.push('ok: back'); }
      else if (act === 'forward') { await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); out.log.push('ok: forward'); }
      else if (act === 'reload' || act === 'refresh') { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{}); out.log.push('ok: reload'); }
      else if (act === 'hover') {
        const sel = await resolveTarget(s, null);
        if (!sel) throw new Error('could not locate an element to hover for "' + (s.text||s.label||s.selector||'') + '"');
        try { await page.hover(sel); } catch (e) { await page.evaluate(x => { const el = document.querySelector(x); if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); }, sel); }
        out.log.push('ok: hover → ' + sel);
      }
      else if (act === 'open_menu' || act === 'hamburger' || act === 'menu' || act === 'toggle_menu') {
        // Locate & click a hamburger / nav-menu toggle so mobile/collapsed navs open.
        const map = await smartCall('inspect');
        let sel = s.selector || ((map.menus && map.menus.length) ? map.menus[0].selector : null);
        if (!sel) throw new Error('no hamburger/menu toggle found on this page');
        try { await page.waitForSelector(sel, { timeout: 6000 }); } catch (e) {}
        await page.click(sel).catch(async () => { await page.evaluate(x => { const e = document.querySelector(x); if (e) e.click(); }, sel); });
        await new Promise(r => setTimeout(r, 700));
        out.log.push('ok: open_menu → ' + sel);
      }
      else if (act === 'check' || act === 'uncheck' || act === 'set_checkbox' || act === 'radio' || act === 'choose') {
        const sel = await resolveTarget(s, 'input');
        if (!sel) throw new Error('could not locate a checkbox/radio for "' + (s.text||s.label||s.selector||'') + '"');
        const want = (act === 'uncheck') ? false : (s.checked != null ? !!s.checked : true);
        await page.evaluate((x, w) => { const el = document.querySelector(x); if (el) { if (el.checked !== w) el.click(); } }, sel, want);
        out.log.push('ok: ' + (want ? 'check' : 'uncheck') + ' → ' + sel);
      }
      else if (act === 'upload' || act === 'upload_file' || act === 'attach') {
        // Upload a file to a <input type=file>. s.path = a path in the sandbox/workdir.
        const sel = s.selector || (await resolveTarget(s, 'input')) || 'input[type="file"]';
        try {
          const handle = await page.$(sel);
          if (handle && typeof handle.uploadFile === 'function' && s.path) { await handle.uploadFile(s.path); out.log.push('ok: upload ' + s.path + ' → ' + sel); }
          else out.log.push('FAIL: upload — file input not found or no path (pass {"action":"upload","selector":"input[type=file]","path":"/abs/file"})');
        } catch (e) { out.log.push('FAIL: upload — ' + e.message); }
      }
      else if (act === 'read' || act === 'extract' || act === 'extract_content' || act === 'understand' || act === 'read_page') {
        out.pageData = await smartCall('readPage');
        out.log.push('ok: read_page (' + (out.pageData.headings ? out.pageData.headings.length : 0) + ' headings, ' + (out.pageData.questions ? out.pageData.questions.length : 0) + ' question group(s))');
      }
      else if (act === 'find' || act === 'find_element' || act === 'locate') {
        const r = await smartCall('findByText', s.text || s.label || s.hint || '', s.kind || null);
        out.found = r ? r.selector : null;
        out.log.push((r ? 'ok: found → ' + r.selector : 'FAIL: no element matching "' + (s.text||s.label||'') + '"'));
      }
      else if (act === 'answer_question' || act === 'answer' || act === 'select_option') {
        // Pick an option in a radio/checkbox group by matching the option's visible text.
        const data = await smartCall('readPage');
        const want = String(s.option || s.value || s.text || '').toLowerCase().trim();
        let picked = null;
        for (const q of (data.questions || [])) {
          if (s.name && q.name !== s.name) continue;
          if (s.question && !(q.question||'').toLowerCase().includes(String(s.question).toLowerCase())) continue;
          const opt = (q.options || []).find(o => (o.label||'').toLowerCase().includes(want)) || (want.match(/^[a-d]$/) ? q.options['abcd'.indexOf(want)] : null);
          if (opt) { picked = opt.selector; break; }
        }
        if (!picked) throw new Error('no matching option "' + want + '" found among question groups');
        await page.evaluate(x => { const el = document.querySelector(x); if (el && !el.checked) el.click(); }, picked);
        out.log.push('ok: answer_question → ' + picked);
      }
      else { out.log.push('skip: unknown action "' + s.action + '"'); }
    } catch (e) {
      out.log.push('FAIL: ' + s.action + (s.selector ? ' ' + s.selector : '') + ' — ' + e.message);
      // On failure, attach a fresh element map so the agent can self-correct
      // on the next call instead of guessing selectors blindly.
      try { if (!out.elements) out.elements = await smartCall('inspect'); } catch (e2) {}
    }
  }
  await new Promise(r => setTimeout(r, 800));
  try { out.currentUrl = page.url(); } catch (e) {}
  out.text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, 8000);
  // If the caller asked to inspect (or nothing happened) ensure a map exists.
  if (!out.elements && ${steps.length === 0 ? 'true' : 'false'}) {
    try { out.elements = await smartCall('inspect'); } catch (e) {}
  }
  ${wantShot ? `out.screenshot = (await page.screenshot({ type: 'jpeg', quality: 80, encoding: 'base64' }));` : ''}
  return { data: out, type: 'application/json' };
}`;

  try {
    if (ctx.onStep) ctx.onStep('🖱️ driving an interactive browser…');
    // Raise the Browserless server-side execution budget (default ~30s → 58s,
    // capped at the plan's 60s limit) so the CAPTCHA detect→solve→verify loop
    // has time to finish before Browserless aborts with HTTP 408.
    const r = await fetchWithTimeout(`${endpoint}/function?token=${encodeURIComponent(token)}&timeout=58000`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/javascript' },
      body: fnCode,
    }, 120000);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return `[browser_action] browserless returned ${r.status}: ${t.slice(0, 300)}`;
    }
    const data = await r.json();
    const out = data && data.data ? data.data : data;
    let header = `[browser_action] ${fullUrl}`;
    if (out.currentUrl && out.currentUrl !== fullUrl) header += `\n[final url] ${out.currentUrl}`;
    if (out.captcha) {
      const det = Object.entries(out.captcha.detected || {}).filter(([, v]) => v).map(([k]) => k);
      header += `\n[captcha] ${out.captcha.solved ? '✅ solved' : '⚠️ partial'}` +
                (det.length ? ` (${det.join(', ')})` : '') +
                (out.captcha.hasCfClearance ? ', cf_clearance obtained' : '') +
                ` — ${out.captcha.rounds} round(s)`;
    }
    let report = `${header}\nSteps:\n${(out.log || []).map(l => ' - ' + l).join('\n') || ' (none)'}`;
    // Render the discovered element map so the agent can see EXACTLY what inputs
    // and buttons exist (with ready-to-use selectors) and self-correct.
    if (out.elements) {
      const m = out.elements;
      const fmt = (arr) => (arr || []).map(e => `    • [${e.type}] "${e.label || ''}"${e.checked != null ? ` [${e.checked ? 'checked' : 'unchecked'}]` : ''} → ${e.selector}`).join('\n');
      report += `\n\n[page elements] ${m.forms || 0} form(s)`;
      if (m.inputs && m.inputs.length) report += `\n  Inputs:\n${fmt(m.inputs)}`;
      if (m.buttons && m.buttons.length) report += `\n  Buttons:\n${fmt(m.buttons)}`;
      if (m.menus && m.menus.length) report += `\n  Menus/Hamburgers:\n${(m.menus || []).map(e => `    • "${e.label || ''}" → ${e.selector}`).join('\n')}`;
      if (m.links && m.links.length) report += `\n  Links:\n${fmt(m.links)}`;
      report += `\n(Tip: re-call browser_action using these selectors, or use {"action":"fill","field":"password","value":"…"} / {"action":"click","text":"Log in"} / {"action":"open_menu"} to open a hamburger nav / {"action":"smart_login","username":"…","password":"…"} — no exact selector needed.)`;
    }
    // Structured page understanding (from {"action":"read"}): headings + any quiz/exam questions.
    if (out.pageData) {
      const p = out.pageData;
      report += `\n\n[page understanding] title: ${p.title || '(none)'}`;
      if (p.headings && p.headings.length) report += `\n  Headings: ${p.headings.slice(0, 20).join(' | ')}`;
      if (p.questions && p.questions.length) {
        report += `\n  Detected ${p.questions.length} question group(s):`;
        p.questions.slice(0, 15).forEach((q, i) => {
          report += `\n   Q${i + 1} [${q.type}] ${q.question || '(no text)'}`;
          (q.options || []).forEach(o => { report += `\n      - "${o.label}"${o.checked ? ' ✓' : ''} → ${o.selector}`; });
        });
        report += `\n  (To answer: {"action":"answer_question","question":"<part of question text>","option":"<answer text or a/b/c/d>"} — or read the questions, work out the correct answer, then answer_question each.)`;
      }
    }
    if (out.found !== undefined) report += `\n\n[find] ${out.found ? ('matched → ' + out.found) : 'no element matched'}`;
    report += `\n\nPage text:\n${(out.text || '').slice(0, 6000)}`;
    if (out.screenshot) {
      const fname = safeName(typeof args.screenshot === 'string' ? args.screenshot : 'browser_action.jpg', 'browser_action.jpg').replace(/\.[^.]*$/, '') + '.jpg';
      await ctx.deliverBuffer(fname, Buffer.from(out.screenshot, 'base64'));
      report += `\n\n[screenshot saved as ${fname} and queued for delivery]`;
    }
    return report;
  } catch (e) {
    return `[browser_action] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: deploy_site — publish an HTML file (or a folder bundled to one page)
// from the working dir to a PUBLIC URL so the user gets a shareable link.
//
// Uses SELF-HOSTED deployment — saves the HTML to <app_root>/deployed/<slug>/
// which is served by the Express server at /deployed/<slug>. This ALWAYS works,
// no external host needed, pages render correctly in any browser.
//
//   args: { path? (html file in workdir, default index.html), html? (inline) }
// ─────────────────────────────────────────────────────────────────────────────
async function toolDeploySite(args, ctx) {
  let html = args.html;
  let srcName = 'index.html';
  try {
    if (!html) {
      let rel = (args.path || '').replace(/^\.?\/+/, '');
      if (!rel) {
        const files = await ctx.fsx.list();
        const htmls = files.filter(f => /\.html?$/i.test(f.rel));
        const idx = htmls.find(f => /(^|\/)index\.html?$/i.test(f.rel)) || htmls[0];
        if (!idx) return '[deploy_site] No HTML file found in the working dir. Create one (write_file/edit_file/create_slides) or pass {"html":"<...>"}.';
        rel = idx.rel;
      }
      if (!(await ctx.fsx.exists(rel))) return `[deploy_site] "${rel}" not found. Use list_files to see what exists.`;
      html = await ctx.fsx.readText(rel);
      srcName = rel.split('/').pop();
    }
  } catch (e) {
    return `[deploy_site] could not read source: ${e.message}`;
  }
  if (!html || !html.trim()) return '[deploy_site] HTML is empty.';

  // A live deployment is a completion boundary. Reject bare, inaccessible, or
  // inert frontends instead of publishing a page merely because HTML exists.
  try {
    const { inspectHtml } = require('./frontendQuality');
    const qa = inspectHtml(html, { task: ctx.taskText || '', filename: srcName });
    if (!qa.ok) {
      return `[deploy_site] FRONTEND QA FAILED (${qa.score}/100): ${qa.issues.join('; ')}. Fix the page, add responsive behavior and accessible interactions, then deploy again.`;
    }
    if (ctx.onStep) ctx.onStep(`🎨 frontend QA passed (${qa.score}/100); deploying…`);
  } catch (e) {
    return `[deploy_site] frontend verification error: ${e.message}`;
  }

  if (ctx.onStep) ctx.onStep('🚀 deploying to a public URL…');

  // ── SELF-HOSTED DEPLOYMENT (always works, serves with correct content-type) ──
  // Saves HTML to <app_root>/deployed/<slug>/index.html which is served at /deployed/<slug>
  try {
    const slug = crypto.createHash('md5').update(html).digest('hex').slice(0, 10) + '_' + 
                 srcName.replace(/[^\w.\-]/g, '_').replace(/\.html?$/i, '');
    const deployDir = path.join(__dirname, '..', 'deployed', slug);
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(path.join(deployDir, 'index.html'), html, 'utf-8');
    // Write extra assets if provided
    if (args.assets && typeof args.assets === 'object') {
      for (const [assetName, assetContent] of Object.entries(args.assets)) {
        fs.writeFileSync(path.join(deployDir, assetName.replace(/[^\w.\-]/g, '_')), String(assetContent), 'utf-8');
      }
    }
    // Determine public URL (Render external URL or localhost fallback)
    const selfUrl = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`).replace(/\/+$/, '');
    const publicUrl = `${selfUrl}/deployed/${slug}`;
    console.log(`[deploy_site] Deployed: ${srcName} → ${publicUrl}`);
    return `[deploy_site] ✅ **Deployed successfully!**\n\n🔗 **Live link:** ${publicUrl}\n\nOpen it in any browser — your page is rendered with full HTML/CSS/JS support. Share the link with anyone!`;
  } catch (e) {
    // Absolute fallback: return the HTML as a delivered file
    if (ctx.onStep) ctx.onStep(`⚠️ self-host deploy failed: ${e.message.slice(0, 100)} — delivering HTML as file instead`);
    await ctx.deliverBuffer(srcName || 'page.html', Buffer.from(html, 'utf-8'));
    return `[deploy_site] ⚠️ Could not deploy to server (${e.message}). The HTML file is delivered as an attachment — upload it to tiiny.host or static.app to get a public link.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: collect the site files to deploy from the working dir.
//
// If `args.path` points to a directory, deploy everything under it (relative to
// that dir, so /dist/index.html → /index.html). If it points to a single .html
// file, deploy just that file as index.html. If omitted, deploy the whole
// working dir (excluding scratch scripts, VCS noise and any agent-generated
// archives). Returns [{ rel, buffer }]. Reads through ctx.fsx so it works on
// BOTH the sandbox and the local backend — and never touches the existing
// deliverBuffer / addFile delivery pathway.
// ─────────────────────────────────────────────────────────────────────────────
async function collectSiteFiles(args, ctx) {
  // Inline HTML shortcut: {html:"<...>"} → a one-file site.
  if (args.html && typeof args.html === 'string' && args.html.trim()) {
    return [{ rel: 'index.html', buffer: Buffer.from(args.html, 'utf-8') }];
  }

  const all = await ctx.fsx.list();
  const isJunk = (rel) =>
    /(^|\/)_step_/.test(rel) ||
    /(^|\/)\.git(\/|$)/.test(rel) ||
    /(^|\/)node_modules(\/|$)/.test(rel) ||
    /(^|\/)\.mkarchive_/.test(rel) ||
    /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tar\.xz)$/i.test(rel);

  let target = (args.path || args.dir || '').trim();
  // Normalise: treat ".", "./", "/" as "whole working dir" (empty target).
  if (target === '.' || target === './' || target === '/') target = '';
  target = target.replace(/^\.?\/+/, '').replace(/\/+$/, '');

  // Single HTML file requested → deploy it as index.html.
  if (target && /\.html?$/i.test(target)) {
    if (!(await ctx.fsx.exists(target))) {
      throw new Error(`"${target}" not found. Use list_files to see what exists.`);
    }
    const buf = await ctx.fsx.downloadBuffer(target);
    return [{ rel: 'index.html', buffer: buf }];
  }

  // Directory (or whole workdir) → gather everything under it.
  const prefix = target ? target + '/' : '';
  const picked = all.filter(f => !isJunk(f.rel) && (!prefix || f.rel.startsWith(prefix)));

  // If a dir was named but is actually a file, or nothing matched, fall back to
  // any html in the workdir.
  let files = [];
  for (const f of picked) {
    const rel = prefix ? f.rel.slice(prefix.length) : f.rel;
    if (!rel) continue;
    try {
      const buf = await ctx.fsx.downloadBuffer(f.rel);
      files.push({ rel, buffer: buf });
    } catch (_) { /* skip unreadable file */ }
  }

  // Ensure there is an index.html at the root so the deploy serves something.
  if (files.length && !files.some(f => /^index\.html?$/i.test(f.rel))) {
    const firstHtml = files.find(f => /\.html?$/i.test(f.rel));
    if (firstHtml) {
      files.push({ rel: 'index.html', buffer: firstHtml.buffer });
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: deploy_cloudflare_pages — deploy the working dir (or a folder/HTML in
// it) to Cloudflare Pages and return a PUBLIC, PERSISTENT *.pages.dev link.
//
// Per-user URL isolation: the project name is derived from ctx.userKey, so the
// SAME user re-deploying updates the SAME site (same URL), while a DIFFERENT
// user gets a DIFFERENT project (different URL) — exactly as requested.
//
//   args: { path? (dir or .html in workdir), html? (inline) }
// ─────────────────────────────────────────────────────────────────────────────
async function toolDeployCloudflarePages(args, ctx) {
  const cloudflarePages = require('./cloudflarePages');

  // Collect the files ONCE up front so we can reuse them for the fallback path
  // if Cloudflare is unavailable / the token lacks the Pages:Edit permission.
  let files;
  try {
    files = await collectSiteFiles(args, ctx);
  } catch (e) {
    return `[deploy_cloudflare_pages] ${e.message}`;
  }
  if (!files || !files.length) {
    return '[deploy_cloudflare_pages] No files to deploy. Create a site first (write_file/edit_file/create_slides) or pass {"html":"<...>"} / {"path":"dist"}.';
  }

  // Graceful fallback to the always-on self-hosted deploy_site. We use this
  // whenever Cloudflare Pages is NOT configured, OR the live deploy fails (e.g.
  // the API token is a Workers-AI token that lacks the "Cloudflare Pages: Edit"
  // permission → Cloudflare returns an Authentication error). The user STILL
  // gets a working public link instead of a dead-end error.
  const fallbackToSelfHost = async (reason) => {
    if (ctx.onStep) ctx.onStep(`⚠️ Cloudflare Pages unavailable (${String(reason).slice(0, 80)}) — using the built-in deploy instead…`);
    // Find the index.html (or first html) among the collected files to feed deploy_site.
    const idx = files.find(f => /^index\.html?$/i.test(f.rel)) || files.find(f => /\.html?$/i.test(f.rel));
    const inlineHtml = idx ? idx.buffer.toString('utf-8') : null;
    const assets = {};
    for (const f of files) {
      if (idx && f.rel === idx.rel) continue;
      // Only inline reasonably small text/asset files into the self-host bundle.
      if (f.buffer && f.buffer.length <= 2 * 1024 * 1024) assets[f.rel] = f.buffer.toString('utf-8');
    }
    const out = await toolDeploySite(inlineHtml ? { html: inlineHtml, assets } : { path: args.path || '.' }, ctx);
    return `[deploy_cloudflare_pages] ⚠️ Cloudflare Pages was not usable (${reason}). Deployed to the built-in public host instead:\n\n${out.replace(/^\[deploy_site\]\s*/, '')}`;
  };

  if (!cloudflarePages.enabled()) {
    return await fallbackToSelfHost('CF_PAGES_ACCOUNT_ID / CF_PAGES_API_TOKEN not configured');
  }

  if (ctx.onStep) ctx.onStep('🌩️ deploying to Cloudflare Pages…');
  try {
    const res = await cloudflarePages.deploy({
      userKey: ctx.userKey || 'anon',
      files,
      onStep: ctx.onStep,
    });
    return `[deploy_cloudflare_pages] ✅ **Deployed to Cloudflare Pages!**\n\n` +
      `🔗 **Live link:** ${res.url}\n` +
      `📦 Project: \`${res.project}\` (${res.fileCount} file(s))${res.created ? ' — newly created' : ' — updated existing site'}\n\n` +
      `This link is PERSISTENT — re-deploying as the same user updates this exact URL. Share it with anyone.`;
  } catch (e) {
    // Auth / permission / network errors → fall back so the user still gets a link.
    const m = String(e.message || e);
    if (/auth|token|permission|401|403|10000|9109|1000|network|fetch|timeout|ENOTFOUND|ECONN/i.test(m)) {
      try { return await fallbackToSelfHost(m); }
      catch (e2) { return `[deploy_cloudflare_pages] error: ${m} (and fallback also failed: ${e2.message})`; }
    }
    return `[deploy_cloudflare_pages] error: ${m}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: deploy_github — commit the working dir (or a folder/HTML in it) to the
// SINGLE hard-locked repo Arinze-eng/urlpower @ main. Cannot push anywhere else.
//
//   args: { path? (dir or .html in workdir), html? (inline), message? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolDeployGithub(args, ctx) {
  const githubDeploy = require('./githubDeploy');
  if (!githubDeploy.enabled()) {
    return '[deploy_github] GitHub deploy is not configured (GITHUB_DEPLOY_TOKEN missing).';
  }
  let files;
  try {
    files = await collectSiteFiles(args, ctx);
  } catch (e) {
    return `[deploy_github] ${e.message}`;
  }
  if (!files || !files.length) {
    return '[deploy_github] No files to commit. Create a site first (write_file/edit_file) or pass {"html":"<...>"} / {"path":"dist"}.';
  }
  if (ctx.onStep) ctx.onStep(`🐙 deploying to ${githubDeploy.OWNER}/${githubDeploy.REPO}…`);
  try {
    const res = await githubDeploy.deploy({
      files,
      message: args.message,
      onStep: ctx.onStep,
    });
    return `[deploy_github] ✅ **Committed to ${res.repo}@${res.branch}** (${res.fileCount} file(s)).\n\n` +
      `🔗 **Repo:** ${res.htmlUrl}\n` +
      `📝 **Commit:** ${res.commitUrl}\n\n` +
      `(This is the ONLY repo the bot can deploy to.)`;
  } catch (e) {
    return `[deploy_github] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_presentation — design a BEAUTIFUL slide deck and export it as
// PPTX (PowerPoint), PDF (print-quality, MathJax-typeset), or BOTH. Also always
// delivers a viewable .html version of the deck.
//
// This is the preferred way to make presentations: write good structured
// content, pick a theme, and get a polished file. Math (\\( \\) / $ $$) is
// typeset in the PDF and shown as plain text in the PPTX.
//
//   args: {
//     title, subtitle?, author?, theme?, colors?   (exact custom palette supported)
//     slides: [{ title, subtitle?, bullets, content, notes, image, layout,
//                metrics:[{value,label}], cards:[{title,text}],
//                chart:{labels,values}, quote, attribution, transition }]
//       OR markdown:"# S1\n- a\n---\n# S2"
//     format?: "pptx" | "pdf" | "both"  (default "both")
//     filename?: base name (no extension)
//   }
// ─────────────────────────────────────────────────────────────────────────────
async function toolCreatePresentation(args, ctx) {
  let pres;
  try { pres = require('./presentationBuilder'); }
  catch (e) { return `[create_presentation] presentation engine unavailable: ${e.message}`; }

  const title = args.title || 'Presentation';
  const subtitle = args.subtitle || '';
  const author = args.author || '';
  // COLOURFUL BY DEFAULT: if the agent didn't pick a theme (or picked a dull
  // one), choose a vibrant themed palette so decks are never a flat black slide.
  const VIBRANT = ['ocean', 'sunset', 'forest', 'midnight', 'slate'];
  let theme = String(args.theme || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!theme || !pres.THEMES[theme]) {
    // deterministic pick from the title so re-runs are stable but still colourful
    let h = 0; for (const c of String(title)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    theme = VIBRANT[h % VIBRANT.length];
  }
  const base = safeName(args.filename || title, 'presentation').replace(/\.[^.]*$/, '');
  const fmt = String(args.format || 'both').toLowerCase();
  const wantPptx = fmt === 'pptx' || fmt === 'both' || fmt === 'all';
  const wantPdf = fmt === 'pdf' || fmt === 'both' || fmt === 'all';

  let slides = pres.normalizeSlides(args);
  if (!slides.length) {
    return '[create_presentation] No slides. Pass {"slides":[{"title":"...","bullets":["...","..."]}]} or {"markdown":"# Slide 1\\n- point\\n---\\n# Slide 2"}.';
  }

  // ── CONTENT GUARD: never deliver empty/thin slides ──────────────────────────
  // A slide must carry real content. If a slide has a title but NO bullets and
  // NO content (the common "blank slide" bug), we synthesise a sensible bullet
  // from the title/subtitle so the deck always has substance inside each slide.
  slides = slides.map((s) => {
    const hasBullets = Array.isArray(s.bullets) && s.bullets.some(b => String(b || '').trim());
    const hasContent = String(s.content || '').trim().length > 0;
    const hasVisualContent = !!(s.image || s.quote || s.chart || s.section || (s.metrics && s.metrics.length) || (s.cards && s.cards.length));
    if (!hasBullets && !hasContent && !hasVisualContent) {
      const seed = String(s.subtitle || s.title || '').trim();
      s.bullets = seed
        ? [`Overview of ${seed}`, `Key evidence and implications for ${seed}`, `Recommended action and next step`]
        : ['Key point one', 'Key point two', 'Key point three'];
    }
    if (!String(s.notes || '').trim()) {
      const detail = hasBullets ? s.bullets.join(' ') : (s.content || s.quote || 'Explain the visual evidence and its implication.');
      s.notes = `${s.title || 'Slide'} — ${detail}`;
    }
    return s;
  });

  const delivered = [];
  const notes = [];
  // ANIMATIONS: on by default (the user wants animated PowerPoint). The viewable
  // .html gets entrance animations + slide transitions + keyboard/click nav; the
  // PDF is rendered from a STATIC (non-animated) build so every slide prints.
  const animate = args.animate === undefined ? true : !!args.animate;

  // Always build + deliver the beautiful HTML deck (viewable & deployable).
  let html;
  try {
    html = pres.buildHtmlDeck({ title, subtitle, author, slides, theme, colors: args.colors || args.palette, animate });
    await ctx.deliverBuffer(`${base}.html`, Buffer.from(html, 'utf-8'));
    delivered.push(`${base}.html`);
  } catch (e) {
    notes.push(`html build failed: ${e.message}`);
  }

  // PPTX via pptxgenjs.
  if (wantPptx) {
    if (ctx.onStep) ctx.onStep(`📊 designing a colourful PowerPoint (.pptx, "${theme}" theme)…`);
    try {
      const buf = await pres.buildPptx({ title, subtitle, author, slides, theme, colors: args.colors || args.palette, animate });
      const qa = buf && pres.validatePptx(buf, { minSlides: slides.length + 1, requireVisuals: true, requireTransitions: animate });
      if (buf && buf.length > 500 && qa && qa.ok) {
        await ctx.deliverBuffer(`${base}.pptx`, buf);
        delivered.push(`${base}.pptx`);
        notes.push(`PowerPoint QA: ${qa.slides} slides, ${qa.colors.length} colors, ${qa.media} embedded images, ${qa.notes} note pages, ${qa.transitions} native transitions`);
      } else { notes.push(`pptx verification failed: ${qa ? qa.issues.join('; ') : 'empty output'}`); }
    } catch (e) { notes.push(`pptx failed: ${e.message}`); }
  }

  // PDF via HTML→PDF (Browserless, MathJax). Uses a STATIC deck so all slides
  // render one-per-page (never just the first animated slide).
  if (wantPdf) {
    if (ctx.onStep) ctx.onStep('📄 rendering print-quality PDF (HTML→PDF, MathJax)…');
    try {
      const pdfHtml = pres.buildHtmlDeck({ title, subtitle, author, slides, theme, colors: args.colors || args.palette, animate: false });
      const browserless = require('./browserless');
      const buf = await browserless.htmlToPdf(pdfHtml, {
        waitFor: 6000,
        format: 'A4',
        landscape: true,
        margin: { top: '0', bottom: '0', left: '0', right: '0' },
      });
      if (buf && buf.length > 800) {
        await ctx.deliverBuffer(`${base}.pdf`, buf);
        delivered.push(`${base}.pdf`);
      } else { notes.push('pdf came back empty'); }
    } catch (e) {
      notes.push(`pdf render failed (${e.message.slice(0, 120)}); the .html deck is delivered — open it and "Print → Save as PDF" for an identical PDF`);
    }
  }

  if (!delivered.length) return `[create_presentation] failed to produce any file. ${notes.join(' | ')}`;
  let msg = `[create_presentation] ✅ Built a ${slides.length + 1}-slide "${theme}" deck${animate ? ' (ANIMATED viewable HTML — fade/slide/zoom entrances + slide transitions, ◀▶/Space/click to navigate)' : ''} → delivered: ${delivered.join(', ')}.`;
  if (notes.length) msg += `\nNotes: ${notes.join(' | ')}.`;
  msg += `\n(You can also deploy_site / deploy_cloudflare_pages the .html to share it as a live link.)`;
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit_image — EDIT an existing image with a text instruction via the
// Replicate image-editing model (FLUX-Kontext). This is what powers "remove the
// background", "add a hat", "remove the person on the left", "make it a cartoon",
// "change the sky to sunset", etc. on the WhatsApp / Telegram bot.
//
// The source image is the one the user ATTACHED (an isImage attachment). If
// several images are attached, the agent can pick one by {"name":"image.jpg"}.
//   args: { prompt (the edit instruction), name? (which attached image), filename?, model? }
// Delivers the edited image back to the user via ctx.deliverBuffer.
// ─────────────────────────────────────────────────────────────────────────────
async function toolEditImage(args, ctx) {
  const prompt = (args.prompt || args.instruction || args.edit || '').trim();
  if (!prompt) {
    return '[edit_image] No edit instruction. Pass {"prompt":"remove the background"} describing the change to make to the attached image.';
  }

  // Locate the source image: a named attachment, else the first/last image sent.
  const images = (ctx.attachments || []).filter(a => a.isImage && a.buffer && a.buffer.length);
  if (!images.length) {
    const names = (ctx.attachments || []).map(a => a.name).join(', ') || '(none)';
    return `[edit_image] No image is attached to edit. The user must SEND an image along with the request. Attached files: ${names}.`;
  }
  let src = images[images.length - 1]; // default: the most recent image
  if (args.name) {
    const want = String(args.name).toLowerCase();
    const match = images.find(a => String(a.name || '').toLowerCase() === want)
               || images.find(a => String(a.name || '').toLowerCase().includes(want));
    if (match) src = match;
  }

  const baseName = safeName(args.filename || ('edited_' + (src.name || 'image')), 'edited_image')
    .replace(/\.[^.]*$/, '');

  // ── Precision wrapper ───────────────────────────────────────────────────────
  // FLUX.2 does PRECISE localized edits, but two things dramatically improve
  // fidelity: (1) explicitly telling it to PRESERVE everything else, and
  // (2) NOT asking it to redraw small paragraph/body text. Diffusion image
  // editors reliably re-render LARGE display text (titles, banners, names) but
  // GARBLE small body text into gibberish. So we instruct it to change only the
  // requested (typically prominent) text and to keep all small body text exactly
  // as-is. This is what makes "change the name BECKY to DAVID" keep the poster,
  // portrait, logos, fonts and every small paragraph identical.
  let editPrompt = prompt;
  if (!args.raw) {
    editPrompt =
      'Edit image 0: ' + prompt +
      '. Apply ONLY this change and nothing else. If the change is to text, replace ONLY the specific ' +
      'prominent text requested, matching the original font, weight, size, color, casing and position exactly. ' +
      'Do NOT alter, redraw or regenerate any small paragraph or body text — keep all small/body text pixel-identical ' +
      'to the original (never turn readable text into gibberish). Keep every other part of the image exactly the same — ' +
      'preserve the original subject, faces, identities, pose, composition, layout, fonts, text, colors, ' +
      'lighting, textures, logos and background. Do not remove, add, distort, crop, recolor or alter anything ' +
      'that was not requested. Maintain photorealistic, sharp, high-resolution detail with no blur and no ' +
      'compression artifacts. The result must look natural and seamlessly integrated.';
  }

  // ── Engine selection: precise FLUX.2 (FREE) → SD-1.5 img2img (FREE) → Replicate ──
  // 1) Cloudflare FLUX.2 (free, PRECISE instruction edits — best quality, keeps
  //    text/faces/layout). 2) Cloudflare SD-1.5 img2img (free, global restyle —
  //    only as a degraded fallback). 3) Replicate FLUX-Kontext (paid) if a key
  //    is configured. This keeps existing deployments working unchanged while
  //    making precise editing the DEFAULT for everyone.
  let out = null;
  let engine = '';
  const errs = [];
  let cf = null;
  let neuronExhausted = false; // true when CF accounts hit the daily free neuron cap
  try { cf = require('./cloudflare'); } catch (_) { cf = null; }

  // 1) Cloudflare FLUX.2 precise editing (free). Try the high-quality "dev"
  //    model first; if every account is out of neurons, retry with the cheaper
  //    distilled "klein-9b" variant (fewer neurons per edit) before giving up —
  //    this squeezes more free precise edits out of the same accounts.
  if (cf && cf.editImageFlux2) {
    const flux2Models = [undefined /* default = flux-2-dev */];
    if (process.env.CF_FLUX2_FALLBACK_MODEL !== 'off') {
      flux2Models.push(process.env.CF_FLUX2_FALLBACK_MODEL || '@cf/black-forest-labs/flux-2-klein-9b');
    }
    for (const m of flux2Models) {
      if (out) break;
      try {
        if (await cf.imageEditEnabled()) {
          if (typeof ctx.onStep === 'function') {
            ctx.onStep('🎯 precise editing via Cloudflare FLUX.2' + (m ? ' (' + m.split('/').pop() + ')' : '') + '…');
          }
          const fxOut = await cf.editImageFlux2(src.buffer, editPrompt, {
            model: m,
            steps: args.num_steps || args.steps,
            guidance: args.guidance,
            seed: args.seed,
            timeout_ms: 180000,
          });
          if (fxOut && fxOut.buffer && fxOut.buffer.length >= 500) {
            out = fxOut;
            engine = 'Cloudflare Workers AI (' + (fxOut.model || 'flux-2-dev') + ', free, precise)';
          }
        } else {
          errs.push('cloudflare: no active key');
          break;
        }
      } catch (e) {
        errs.push('flux2' + (m ? '(' + m.split('/').pop() + ')' : '') + ': ' + e.message);
        if (e && e.neuronExhausted) neuronExhausted = true;
        // If it was a neuron cap, the klein retry on the SAME exhausted accounts
        // will also fail — but it's cheap to try once and may succeed if klein
        // costs fewer neurons than the small leftover budget. Continue the loop.
      }
    }
  }

  // 2) Cloudflare SD-1.5 img2img (free) — LOW-FIDELITY GLOBAL restyle.
  //    IMPORTANT: SD-1.5 cannot do precise text/identity edits; at low strength
  //    it returns an almost-unchanged image (the old "it gave the image as-is"
  //    bug). So we only use it when (a) FLUX.2 failed for a NON-exhaustion reason
  //    (i.e. a key is still available) AND (b) the caller explicitly allows a
  //    restyle fallback via args.allow_img2img / args.restyle. We never silently
  //    pass off a near-identical SD-1.5 result as a precise edit.
  const allowImg2Img = args.allow_img2img === true || args.restyle === true;
  if (!out && cf && cf.editImage && allowImg2Img && !neuronExhausted) {
    try {
      if (await cf.imageEditEnabled()) {
        const cfOut = await cf.editImage(src.buffer, prompt, {
          strength: typeof args.strength === 'number' ? args.strength : 0.55,
          num_steps: args.num_steps,
          guidance: args.guidance,
          timeout_ms: 120000,
        });
        if (cfOut && cfOut.buffer && cfOut.buffer.length >= 500) {
          out = cfOut;
          engine = 'Cloudflare Workers AI (' + (cfOut.model || 'sd-1.5-img2img') + ', free, restyle)';
        }
      }
    } catch (e) {
      errs.push('cloudflare-img2img: ' + e.message);
      if (e && e.neuronExhausted) neuronExhausted = true;
      if (typeof ctx.onStep === 'function') ctx.onStep('⚠️ Cloudflare img2img failed, trying Replicate fallback…');
    }
  }

  // 2.5) ToAPIs fallback (paid, DIFFERENT provider — unaffected by the CF neuron
  //    cap). ToAPIs is an OpenAI-compatible gateway exposing nano-banana /
  //    Gemini-Flash-Image / FLUX-Kontext / Seedream / GPT-Image-2, all excellent
  //    at PRECISE instruction-based edits. Its image API needs a PUBLIC source
  //    URL (base64 not accepted), so we host the source on Cloudinary first
  //    (same media pipeline the rest of the tools use) and pass that URL.
  //    Admin-updatable key: Admin → Integrations → ToAPIs (toapis_api_key).
  if (!out) {
    try {
      const toapis = require('./toapis');
      if (await toapis.enabled()) {
        if (typeof ctx.onStep === 'function') ctx.onStep('🎯 precise editing via ToAPIs (nano-banana / FLUX-Kontext)…');
        // Host the source image so ToAPIs can fetch it by URL.
        let srcUrl = await hostOnCloudinary(src.buffer, {
          mime: src.mime || 'image/png', resourceType: 'image',
          folder: 'wormgpt/edits-src', tags: ['edit_image', 'toapis-src'],
        });
        if (!srcUrl) {
          errs.push('toapis: could not host source image (Cloudinary not configured)');
        } else {
          const tOut = await toapis.resolveEdit(srcUrl, editPrompt, {
            width: args.width, height: args.height,
            model: args.toapis_model,
          });
          if (tOut && tOut.buffer && tOut.buffer.length >= 500) {
            out = tOut;
            engine = 'ToAPIs (' + (tOut.model || 'nano-banana') + ', precise)';
          }
        }
      } else {
        errs.push('toapis: no key configured');
      }
    } catch (e) {
      errs.push('toapis: ' + e.message);
      if (typeof ctx.onStep === 'function') ctx.onStep('⚠️ ToAPIs edit failed, trying Replicate fallback…');
    }
  }

  // 3) Replicate fallback (paid, DIFFERENT provider — unaffected by CF neuron
  //    cap). This is the correct fallback when CF is exhausted: it does precise
  //    FLUX-Kontext edits. Only runs if a Replicate key is configured.
  if (!out) {
    try {
      const replicate = require('./replicate');
      if (typeof ctx.onStep === 'function') ctx.onStep('🎯 precise editing via Replicate FLUX-Kontext…');
      const rOut = await replicate.editImage(src.buffer, editPrompt, {
        model: args.model,
        mime: src.mime,
        onStep: ctx.onStep,
      });
      if (rOut && rOut.buffer && rOut.buffer.length >= 500) {
        out = rOut;
        engine = 'Replicate (' + (rOut.model || 'flux-kontext') + ', precise)';
      }
    } catch (e) {
      errs.push('replicate: ' + e.message);
    }
  }

  if (!out || !out.buffer || out.buffer.length < 500) {
    // Be HONEST about why — especially the daily free neuron cap, which is the
    // #1 real-world cause of "the edit didn't change anything".
    if (neuronExhausted) {
      return `[edit_image] ⚠️ Precise editing is temporarily unavailable: every configured Cloudflare account has used up its FREE daily Workers AI neuron allocation (10,000/day), and no paid fallback succeeded. ` +
             `Precise editing resumes automatically when the daily quota resets, OR immediately if you add another Cloudflare account key (CF_ACCOUNT_ID_2 + CF_API_TOKEN_2), top up the ToAPIs key (Admin → Integrations → ToAPIs), or add a Replicate API key. ` +
             `(I did NOT return the image unchanged — that low-fidelity SD-1.5 fallback is now disabled so you never get a fake "no-op" edit.) Details: ${errs.join(' | ')}`;
    }
    return `[edit_image] the edit produced no usable image. Tried: ${errs.join(' | ') || 'no engines available'}. ` +
           `(Free precise editing uses Cloudflare Workers AI FLUX.2 — set the Cloudflare account id + AI token in Admin → Integrations. ` +
           `Paid precise fallbacks: ToAPIs (toapis_api_key) and Replicate — set either in Admin → Integrations.)`;
  }

  try {
    const ext = out.mime === 'image/png' ? '.png' : (out.mime === 'image/webp' ? '.webp' : '.jpg');
    const fname = baseName + ext;
    await ctx.deliverBuffer(fname, out.buffer);
    // Combine power with Cloudinary: the engine edited the bytes, Cloudinary
    // hosts the result on a permanent CDN URL (best-effort; null if unconfigured).
    const hosted = await hostOnCloudinary(out.buffer, { mime: out.mime, resourceType: 'image', folder: 'wormgpt/edits', tags: ['edit_image', 'img2img'] });
    return `[edit_image] ✅ Edited the image ("${prompt}") via ${engine} → ${fname} (${(out.buffer.length / 1024).toFixed(0)} KB). Edited image queued for delivery to the user.` + (hosted ? ` Hosted on Cloudinary: ${hosted}` : '');
  } catch (e) {
    return `[edit_image] error delivering edited image: ${e.message}.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: host_media — upload an IMAGE or VIDEO to Cloudinary and return its
// permanent, shareable CDN URL. Works on:
//   • an ATTACHED file the user sent (pick by {"name":"clip.mp4"} or default to
//     the most recent image/video attachment), OR
//   • a remote {"url":"https://…"} the agent downloads first.
// This is how Cloudinary "combines power" with the image/video tools: generate
// or edit the media, then host it here for a clean public link (and optional
// transformation). Requires Cloudinary configured in Admin → Integrations.
//   args: { url?, name?, public_id?, folder?, transformation? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolHostMedia(args, ctx) {
  let cloudinary;
  try { cloudinary = require('./cloudinary'); }
  catch (e) { return `[host_media] Cloudinary module unavailable: ${e.message}`; }
  if (!cloudinary.enabled()) {
    // enabled() is a cheap check; getCreds() still resolves DB — so try anyway,
    // but give a clear hint if truly unconfigured.
    const creds = await cloudinary.getCreds().catch(() => null);
    if (!creds || !creds.cloudName || !creds.apiKey || !creds.apiSecret) {
      return '[host_media] Cloudinary is not configured. Add the Cloud Name, API Key and API Secret in Admin → Integrations → Cloudinary, then retry.';
    }
  }

  let buffer = null, mime = null, label = '';

  // 1) Remote URL → download the bytes.
  const url = (args.url || '').trim();
  if (url) {
    try {
      const r = await fetchWithTimeout(/^https?:\/\//i.test(url) ? url : 'https://' + url, { headers: { 'User-Agent': 'Mozilla/5.0 (WormGPT-Agent)' } }, 120000);
      if (!r.ok) return `[host_media] could not download ${url} (HTTP ${r.status}).`;
      buffer = Buffer.from(await r.arrayBuffer());
      mime = r.headers.get('content-type') || cloudinary.sniffMime(buffer);
      label = url.split('/').pop().split('?')[0] || 'remote-media';
    } catch (e) { return `[host_media] download error: ${e.message}`; }
  } else {
    // 2) Attached media (image or video).
    const media = (ctx.attachments || []).filter(a => a.buffer && a.buffer.length && (a.isImage || /^video\//i.test(a.mime || '') || /\.(mp4|mov|webm|mkv|avi|gif)$/i.test(a.name || '')));
    if (!media.length) {
      return '[host_media] No media attached and no {"url"} given. The user must SEND an image/video, or pass a remote URL to host.';
    }
    let src = media[media.length - 1];
    if (args.name) {
      const want = String(args.name).toLowerCase();
      const m = media.find(a => String(a.name || '').toLowerCase() === want) || media.find(a => String(a.name || '').toLowerCase().includes(want));
      if (m) src = m;
    }
    buffer = src.buffer; mime = src.mime || cloudinary.sniffMime(buffer); label = src.name || 'attachment';
  }

  if (!buffer || !buffer.length) return '[host_media] nothing to upload.';
  const resourceType = cloudinary.isVideoMime(mime) ? 'video' : 'image';
  try {
    const out = await cloudinary.uploadBuffer(buffer, {
      mime,
      resourceType,
      folder: args.folder || 'wormgpt/uploads',
      publicId: args.public_id || undefined,
      tags: ['host_media'],
    });
    if (!out || !out.url) {
      return '[host_media] Cloudinary upload failed (check the credentials in Admin → Integrations).';
    }
    let extra = '';
    if (args.transformation && out.publicId) {
      const turl = await cloudinary.buildUrl(out.publicId, args.transformation, resourceType);
      if (turl) extra = ` Transformed: ${turl}`;
    }
    const dims = out.width && out.height ? ` ${out.width}x${out.height}` : '';
    return `[host_media] ✅ Hosted ${resourceType} "${label}" on Cloudinary${dims} (${((out.bytes || buffer.length) / 1024).toFixed(0)} KB) → ${out.url}${extra}`;
  } catch (e) {
    return `[host_media] error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_market_price — DETERMINISTIC, reliable LIVE market data for trading.
//
// This is the FIX for the "fail to fetch / agent fights a JS webpage" problem.
// Instead of asking the agent to scrape MarketWatch/TradingView (anti-bot, JS
// rendered → "incomplete content"), this tool hits CLEAN JSON APIs directly with
// a robust multi-source fallback chain, so a live price ALWAYS comes back fast.
//
//   args: {
//     symbol: "XAUUSD"|"gold"|"EURUSD"|"GBPUSD"|"BTC"|"ETH"|"NAS100"|"US30"|"SPX"|"AAPL"…,
//     interval?: "1m|5m|15m|30m|1h|4h|1d" (default "15m"),
//     range?:    "1d|5d|1mo|3mo" (default "5d"),
//     candles?:  number of recent candles to summarise (default 60)
//   }
//
// Returns a STRING observation containing: live spot price, source, timestamp,
// day high/low, recent OHLC closes, and computed swing high / swing low — exactly
// what the trading-skills workflow needs for an accurate, pip-exact setup.
// ─────────────────────────────────────────────────────────────────────────────

// Map a user symbol → { kind, gold, yahoo, fxPair, cryptoId, label }.
function _resolveSymbol(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[\s_\-\/]/g, '');
  const M = {
    XAUUSD: { kind: 'gold', label: 'XAUUSD (Gold spot)' },
    GOLD:   { kind: 'gold', label: 'XAUUSD (Gold spot)' },
    XAU:    { kind: 'gold', label: 'XAUUSD (Gold spot)' },
    GC:     { kind: 'gold', label: 'XAUUSD (Gold futures GC=F)' },
    XAGUSD: { kind: 'yahoo', yahoo: 'SI=F', label: 'XAGUSD (Silver)' },
    SILVER: { kind: 'yahoo', yahoo: 'SI=F', label: 'XAGUSD (Silver)' },
    // Forex
    EURUSD: { kind: 'yahoo', yahoo: 'EURUSD=X', label: 'EUR/USD' },
    GBPUSD: { kind: 'yahoo', yahoo: 'GBPUSD=X', label: 'GBP/USD' },
    USDJPY: { kind: 'yahoo', yahoo: 'USDJPY=X', label: 'USD/JPY' },
    AUDUSD: { kind: 'yahoo', yahoo: 'AUDUSD=X', label: 'AUD/USD' },
    USDCAD: { kind: 'yahoo', yahoo: 'USDCAD=X', label: 'USD/CAD' },
    NZDUSD: { kind: 'yahoo', yahoo: 'NZDUSD=X', label: 'NZD/USD' },
    USDCHF: { kind: 'yahoo', yahoo: 'USDCHF=X', label: 'USD/CHF' },
    EURJPY: { kind: 'yahoo', yahoo: 'EURJPY=X', label: 'EUR/JPY' },
    GBPJPY: { kind: 'yahoo', yahoo: 'GBPJPY=X', label: 'GBP/JPY' },
    // Indices (futures proxies tradeable + chart-rich)
    NAS100: { kind: 'yahoo', yahoo: 'NQ=F', label: 'NAS100 (NQ=F)' },
    NASDAQ: { kind: 'yahoo', yahoo: '^IXIC', label: 'Nasdaq Composite' },
    US30:   { kind: 'yahoo', yahoo: 'YM=F', label: 'US30 (YM=F)' },
    DOW:    { kind: 'yahoo', yahoo: '^DJI', label: 'Dow Jones' },
    SPX:    { kind: 'yahoo', yahoo: '^GSPC', label: 'S&P 500' },
    SP500:  { kind: 'yahoo', yahoo: '^GSPC', label: 'S&P 500' },
    US500:  { kind: 'yahoo', yahoo: 'ES=F', label: 'US500 (ES=F)' },
    GER40:  { kind: 'yahoo', yahoo: '^GDAXI', label: 'DAX (GER40)' },
    UK100:  { kind: 'yahoo', yahoo: '^FTSE', label: 'FTSE 100' },
    USOIL:  { kind: 'yahoo', yahoo: 'CL=F', label: 'WTI Crude (CL=F)' },
    UKOIL:  { kind: 'yahoo', yahoo: 'BZ=F', label: 'Brent Crude (BZ=F)' },
    // Crypto (mapped to coingecko id + yahoo fallback)
    BTCUSD: { kind: 'crypto', cryptoId: 'bitcoin', yahoo: 'BTC-USD', label: 'BTC/USD' },
    BTCUSDT:{ kind: 'crypto', cryptoId: 'bitcoin', yahoo: 'BTC-USD', label: 'BTC/USD' },
    BTC:    { kind: 'crypto', cryptoId: 'bitcoin', yahoo: 'BTC-USD', label: 'BTC/USD' },
    ETHUSD: { kind: 'crypto', cryptoId: 'ethereum', yahoo: 'ETH-USD', label: 'ETH/USD' },
    ETH:    { kind: 'crypto', cryptoId: 'ethereum', yahoo: 'ETH-USD', label: 'ETH/USD' },
    SOL:    { kind: 'crypto', cryptoId: 'solana', yahoo: 'SOL-USD', label: 'SOL/USD' },
    BNB:    { kind: 'crypto', cryptoId: 'binancecoin', yahoo: 'BNB-USD', label: 'BNB/USD' },
    XRP:    { kind: 'crypto', cryptoId: 'ripple', yahoo: 'XRP-USD', label: 'XRP/USD' },
    DOGE:   { kind: 'crypto', cryptoId: 'dogecoin', yahoo: 'DOGE-USD', label: 'DOGE/USD' },
  };
  if (M[s]) return Object.assign({ symbol: s }, M[s]);
  // Forex pattern e.g. XXXYYY (6 letters) → Yahoo FX
  if (/^[A-Z]{6}$/.test(s)) return { symbol: s, kind: 'yahoo', yahoo: s + '=X', label: s.slice(0,3) + '/' + s.slice(3) };
  // Crypto pattern e.g. FOOUSDT / FOOUSD → coingecko by symbol guess + yahoo
  if (/USDT?$/.test(s) && s.length <= 10) {
    const base = s.replace(/USDT?$/, '');
    return { symbol: s, kind: 'crypto', cryptoId: null, cryptoSym: base, yahoo: base + '-USD', label: base + '/USD' };
  }
  // Fallback: treat as a stock ticker on Yahoo.
  return { symbol: s, kind: 'yahoo', yahoo: s, label: s };
}

const _YF_INTERVAL = { '1m':'1m','2m':'2m','5m':'5m','15m':'15m','30m':'30m','60m':'60m','1h':'60m','4h':'60m','1d':'1d','1wk':'1wk','1w':'1wk' };

async function _getJson(url, timeout = 15000) {
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, timeout);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// Aggregate 60m candles into 4h buckets when the user asked for 4h.
function _aggregate4h(ts, o, h, l, c) {
  const out = { ts: [], o: [], h: [], l: [], c: [] };
  for (let i = 0; i < ts.length; i += 4) {
    const slH = h.slice(i, i + 4).filter(x => x != null);
    const slL = l.slice(i, i + 4).filter(x => x != null);
    if (!slH.length || !slL.length) continue;
    out.ts.push(ts[i]);
    out.o.push(o[i]);
    out.h.push(Math.max(...slH));
    out.l.push(Math.min(...slL));
    const cc = c.slice(i, i + 4).filter(x => x != null);
    out.c.push(cc.length ? cc[cc.length - 1] : null);
  }
  return out;
}

async function _yahooCandles(yahooSym, interval, range) {
  const yi = _YF_INTERVAL[interval] || '15m';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${yi}&range=${encodeURIComponent(range)}`;
  const j = await _getJson(url, 20000);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no chart result');
  const meta = res.meta || {};
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  let ts = res.timestamp || [];
  let o = q.open || [], h = q.high || [], l = q.low || [], c = q.close || [];
  if (interval === '4h') { const a = _aggregate4h(ts, o, h, l, c); ts = a.ts; o = a.o; h = a.h; l = a.l; c = a.c; }
  return { meta, ts, o, h, l, c };
}

async function toolGetMarketPrice(args, ctx) {
  const sym = _resolveSymbol(args.symbol || args.ticker || args.pair || 'XAUUSD');
  const interval = String(args.interval || args.timeframe || '15m').toLowerCase();
  const range = String(args.range || '5d').toLowerCase();
  const wantN = Math.min(Math.max(parseInt(args.candles, 10) || 60, 5), 300);
  const lines = [];
  lines.push(`[get_market_price] ${sym.label} — interval=${interval}, range=${range}`);

  let spot = null, spotSrc = null, spotTime = null;
  const cross = [];

  // ── 1) Spot price (with cross-check) ──
  try {
    if (sym.kind === 'gold') {
      try {
        const g = await _getJson('https://api.gold-api.com/price/XAU', 12000);
        if (g && g.price) { spot = +g.price; spotSrc = 'gold-api.com (spot)'; spotTime = g.updatedAt; }
      } catch (_) {}
      // cross-check with PAXG (tokenised gold) via coingecko
      try { const p = await _getJson('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd', 10000); if (p && p['pax-gold']) cross.push(`PAXG≈$${p['pax-gold'].usd} (coingecko)`); } catch (_) {}
    } else if (sym.kind === 'crypto') {
      // coingecko by id → coinbase → binance.us  (api.binance.com is geo-blocked on Render)
      if (sym.cryptoId) {
        try { const p = await _getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${sym.cryptoId}&vs_currencies=usd`, 10000); if (p && p[sym.cryptoId]) { spot = +p[sym.cryptoId].usd; spotSrc = 'coingecko.com'; } } catch (_) {}
      }
      if (spot == null && (sym.cryptoSym || sym.symbol)) {
        const cb = (sym.cryptoSym || sym.symbol).replace(/USDT?$/, '');
        try { const p = await _getJson(`https://api.coinbase.com/v2/prices/${cb}-USD/spot`, 10000); if (p && p.data && p.data.amount) { spot = +p.data.amount; spotSrc = 'coinbase.com'; } } catch (_) {}
      }
      if (spot == null) {
        const bs = (sym.symbol.endsWith('USDT') ? sym.symbol : (sym.cryptoSym || sym.symbol).replace(/USD$/, '') + 'USDT');
        try { const p = await _getJson(`https://api.binance.us/api/v3/ticker/price?symbol=${bs}`, 10000); if (p && p.price) { spot = +p.price; spotSrc = 'binance.us'; } } catch (_) {}
      }
    }
  } catch (_) {}

  // ── 2) OHLC candles (Yahoo is the universal source) ──
  let candleSrc = null, meta = {}, closes = [], highs = [], lows = [], times = [];
  const yahooSym = sym.yahoo || (sym.kind === 'gold' ? 'GC=F' : null);
  if (yahooSym) {
    try {
      const cc = await _yahooCandles(yahooSym, interval, range);
      meta = cc.meta || {};
      candleSrc = `Yahoo Finance (${yahooSym})`;
      const idx = cc.ts.map((t, i) => i).filter(i => cc.c[i] != null);
      times = idx.map(i => cc.ts[i]);
      closes = idx.map(i => +cc.c[i]);
      highs  = idx.map(i => cc.h[i] != null ? +cc.h[i] : +cc.c[i]);
      lows   = idx.map(i => cc.l[i] != null ? +cc.l[i] : +cc.c[i]);
      // If spot still unknown, use the chart's regularMarketPrice.
      if (spot == null && meta.regularMarketPrice != null) { spot = +meta.regularMarketPrice; spotSrc = candleSrc + ' regularMarketPrice'; spotTime = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null; }
      if (sym.kind !== 'gold' && meta.regularMarketPrice != null) cross.push(`${yahooSym} last=${(+meta.regularMarketPrice).toFixed(4)} (Yahoo)`);
    } catch (e) {
      lines.push(`⚠️ Yahoo candles failed for ${yahooSym}: ${e.message}`);
    }
  }

  if (spot == null) {
    return lines.join('\n') + `\n❌ Could not fetch a live price for "${args.symbol}". Try a clearer symbol (e.g. XAUUSD, EURUSD, BTC, NAS100, AAPL) or use fetch_url on api.gold-api.com / Yahoo Finance directly.`;
  }

  // ── 3) Compute levels from candles ──
  const recentN = Math.min(wantN, closes.length);
  const rClose = closes.slice(-recentN), rHigh = highs.slice(-recentN), rLow = lows.slice(-recentN);
  const swingHigh = rHigh.length ? Math.max(...rHigh) : null;
  const swingLow  = rLow.length ? Math.min(...rLow) : null;
  const dec = (sym.label.includes('JPY')) ? 3 : (sym.kind === 'gold' || sym.kind === 'crypto' || /500|NAS|US30|DOW|DAX|FTSE|OIL/i.test(sym.label)) ? 2 : 5;
  const fmt = (x) => (x == null ? 'n/a' : (+x).toFixed(dec));

  lines.push(`💲 LIVE PRICE: ${fmt(spot)}  (source: ${spotSrc}${spotTime ? ', ts=' + spotTime : ''})`);
  if (cross.length) lines.push(`🔁 cross-check: ${cross.join(' | ')}`);
  if (candleSrc) lines.push(`🕯️ candles: ${candleSrc} | interval=${interval} | ${closes.length} bars`);
  if (meta.regularMarketDayHigh != null) lines.push(`📊 day high=${fmt(meta.regularMarketDayHigh)} | day low=${fmt(meta.regularMarketDayLow)}`);
  if (swingHigh != null) lines.push(`🔺 swing high (last ${recentN} bars)=${fmt(swingHigh)} | 🔻 swing low=${fmt(swingLow)}`);
  if (rClose.length) {
    const show = rClose.slice(-15).map(x => fmt(x));
    lines.push(`📈 recent ${interval} closes (last ${show.length}): ${show.join(', ')}`);
  }
  // weekend / stale guard
  if (meta.regularMarketTime) {
    const ageMin = Math.round((Date.now() / 1000 - meta.regularMarketTime) / 60);
    if (ageMin > 90) lines.push(`⚠️ last market tick was ~${ageMin} min ago (market may be closed / weekend) — treat levels as the most recent session.`);
  }
  lines.push(`✅ Use THIS live price for entry/SL/TP. Re-derive pip math exactly and verify direction (Sell Limit ABOVE / Buy Limit BELOW current price).`);
  return lines.join('\n');
}

// Public wrapper for the analysis engine: resolve any user symbol → Yahoo
// candles. Returns { ts, o, h, l, c } (or throws). Used by tradingEngine
// .fetchCandles as the geo-block-safe fallback candle source.
async function _yahooCandlesPublic(symbolRaw, interval = '15m', range = '5d') {
  const sym = _resolveSymbol(symbolRaw || 'BTC');
  const yahooSym = sym.yahoo || (sym.kind === 'gold' ? 'GC=F' : sym.symbol);
  return await _yahooCandles(yahooSym, String(interval).toLowerCase(), String(range).toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// getSpot — LIGHTWEIGHT live-price fetch (no candles) used by the real-time
// market-watch ticker (services/marketWatch.js). Reuses the exact multi-source
// fallback chain as get_market_price so watched levels use the SAME price the
// agent quotes. Returns { price:Number, source:String, symbol } or null.
// ─────────────────────────────────────────────────────────────────────────────
async function getSpot(symbolRaw) {
  const sym = _resolveSymbol(symbolRaw || 'XAUUSD');
  let spot = null, src = null;
  const alt = [];   // cross-check prices from independent sources
  try {
    if (sym.kind === 'gold') {
      try { const g = await _getJson('https://api.gold-api.com/price/XAU', 10000); if (g && g.price) { spot = +g.price; src = 'gold-api.com'; } } catch (_) {}
    } else if (sym.kind === 'crypto') {
      if (sym.cryptoId) {
        try { const p = await _getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${sym.cryptoId}&vs_currencies=usd`, 9000); if (p && p[sym.cryptoId]) { spot = +p[sym.cryptoId].usd; src = 'coingecko.com'; } } catch (_) {}
      }
      if (spot == null && (sym.cryptoSym || sym.symbol)) {
        const cb = (sym.cryptoSym || sym.symbol).replace(/USDT?$/, '');
        try { const p = await _getJson(`https://api.coinbase.com/v2/prices/${cb}-USD/spot`, 9000); if (p && p.data && p.data.amount) { spot = +p.data.amount; src = 'coinbase.com'; } } catch (_) {}
      } else if (spot != null && (sym.cryptoSym || sym.symbol)) {
        // We have coingecko — grab coinbase as an INDEPENDENT cross-check.
        const cb = (sym.cryptoSym || sym.symbol).replace(/USDT?$/, '');
        try { const p = await _getJson(`https://api.coinbase.com/v2/prices/${cb}-USD/spot`, 8000); if (p && p.data && p.data.amount) alt.push(+p.data.amount); } catch (_) {}
      }
      if (spot == null) {
        const bs = (sym.symbol.endsWith('USDT') ? sym.symbol : (sym.cryptoSym || sym.symbol).replace(/USD$/, '') + 'USDT');
        try { const p = await _getJson(`https://api.binance.us/api/v3/ticker/price?symbol=${bs}`, 9000); if (p && p.price) { spot = +p.price; src = 'binance.us'; } } catch (_) {}
      }
    }
  } catch (_) {}
  // Universal Yahoo fallback (also covers forex / indices / stocks). Also used as
  // an independent cross-check for gold/crypto when we already have a primary.
  {
    const yahooSym = sym.yahoo || (sym.kind === 'gold' ? 'GC=F' : sym.symbol);
    if (yahooSym && (spot == null || sym.kind === 'gold' || sym.kind === 'crypto')) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1m&range=1d`;
        const j = await _getJson(url, 12000);
        const res = j && j.chart && j.chart.result && j.chart.result[0];
        const m = res && res.meta;
        if (m && m.regularMarketPrice != null) {
          const yp = +m.regularMarketPrice;
          if (spot == null) { spot = yp; src = `Yahoo (${yahooSym})`; }
          else if (Number.isFinite(yp)) alt.push(yp);
        }
      } catch (_) {}
    }
  }
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return null;

  // ── 🎯 ACCURACY GUARD (protects TP/SL alerts from a bad/stale feed) ──────────
  // If we have ≥1 independent cross-check and the primary diverges from it by an
  // implausible amount (>2% for spot/crypto/gold), trust the MEDIAN of the
  // sources instead of a single possibly-glitched feed. This stops a one-off bad
  // tick from firing a false TP/SL alert.
  let verified = false, crossPrice = null;
  if (alt.length) {
    const nearest = alt.reduce((a, b) => Math.abs(b - spot) < Math.abs(a - spot) ? b : a, alt[0]);
    crossPrice = nearest;
    const divPct = Math.abs(spot - nearest) / Math.max(1e-9, spot) * 100;
    if (divPct <= 2) { verified = true; }
    else {
      // Diverged too far → use the median of [primary, ...alt] as the safe value.
      const all = [spot, ...alt].sort((a, b) => a - b);
      spot = all[Math.floor(all.length / 2)];
      src = src + ' (median-cross-verified)';
      verified = true;
    }
  }
  return { price: spot, source: src || 'live', symbol: sym.symbol, verified, crossPrice };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: watch_market — start a REAL-TIME watch that alerts the user the instant
// a live price crosses a target (TP / SL / above / below / touch).
//   args: {
//     symbol: "XAUUSD"|"BTC"|"EURUSD"…,
//     tp?: number, sl?: number, above?: number, below?: number,
//     targets?: [{ type:'tp'|'sl'|'above'|'below'|'touch', price:Number }],
//     interactive?: bool  // run a fresh agent analysis when it fires
//   }
// The bot injects ctx.chatId so the ticker knows who to alert. Persisted +
// crash-safe via services/marketWatch.js.
// ─────────────────────────────────────────────────────────────────────────────
async function toolWatchMarket(args, ctx) {
  let mw = null;
  try { mw = require('./marketWatch'); } catch (_) { mw = null; }
  if (!mw) return '[watch_market] Market-watch engine unavailable.';
  const chatId = (ctx && (ctx.chatId || ctx.sessionKey || ctx.jid)) || args.chatId;
  if (!chatId) return '[watch_market] No chat/session to deliver alerts to — this tool only works from the Telegram/WhatsApp agent.';
  const symbol = String(args.symbol || args.ticker || args.pair || '').trim();
  if (!symbol) return '[watch_market] Provide a symbol (e.g. XAUUSD, BTC, EURUSD).';

  const targets = Array.isArray(args.targets) ? args.targets.slice() : [];
  const push = (type, v) => { const p = parseFloat(v); if (Number.isFinite(p)) targets.push({ type, price: p, label: type.toUpperCase() }); };
  push('tp', args.tp); push('sl', args.sl); push('above', args.above); push('below', args.below);
  if (args.target != null) push('touch', args.target);
  if (!targets.length) return '[watch_market] Provide at least one target: tp, sl, above, below, or targets:[…].';

  try {
    const entry = await mw.add(String(chatId), symbol, targets, { interval: args.interval || '15m', interactive: !!args.interactive });
    const legs = entry.targets.map(l => `${l.label} ${mw._fmt(l.price)}`).join(', ');
    return `[watch_market] ✅ Now watching *${entry.symbol}* in real time (checked every ~45s).\n` +
      `Alert legs: ${legs}\n` +
      (entry.startPrice != null ? `Current price: ${mw._fmt(entry.startPrice)} (${entry.startSrc || 'live'})\n` : '') +
      `I'll message you the INSTANT any leg is hit. (list_watches to review, stop_watch to cancel.)`;
  } catch (e) {
    return `[watch_market] ${e.message || e}`;
  }
}

async function toolListWatches(args, ctx) {
  let mw = null; try { mw = require('./marketWatch'); } catch (_) { mw = null; }
  if (!mw) return '[list_watches] Market-watch engine unavailable.';
  const chatId = (ctx && (ctx.chatId || ctx.sessionKey || ctx.jid)) || args.chatId;
  if (!chatId) return '[list_watches] Only available from the Telegram/WhatsApp agent.';
  const items = await mw.list(String(chatId));
  if (!items.length) return '[list_watches] You have no active market watches.';
  return '[list_watches] Active watches:\n' + items.map((w, i) => `${i + 1}. ${mw.describe(w)}`).join('\n');
}

async function toolStopWatch(args, ctx) {
  let mw = null; try { mw = require('./marketWatch'); } catch (_) { mw = null; }
  if (!mw) return '[stop_watch] Market-watch engine unavailable.';
  const chatId = (ctx && (ctx.chatId || ctx.sessionKey || ctx.jid)) || args.chatId;
  if (!chatId) return '[stop_watch] Only available from the Telegram/WhatsApp agent.';
  const n = await mw.stopAll(String(chatId));
  return `[stop_watch] Cancelled ${n} market watch${n === 1 ? '' : 'es'}.`;
}

// Shared trading helpers. These were accidentally removed while deleting an
// unrelated database tool, leaving every trading entry point (including the
// monitor) to throw `_tradeChatId is not defined` / `_tradingEngine is not
// defined` before it could provide feedback.
let _trading = null;
function _tradingEngine() {
  if (_trading) return _trading;
  try { _trading = require('./tradingEngine'); } catch (_) { _trading = null; }
  return _trading;
}
function _tradeChatId(args, ctx) {
  return (ctx && (ctx.chatId || ctx.sessionKey || ctx.jid)) || (args && args.chatId) || null;
}

// Tool: trade_watch — one intent-aware entry point for every trading watch.
// It can arm a feedback-only market monitor, watch explicit SL/TP/price levels,
// run analysis/signal generation, or open a PAPER trade whose SL/TP is tracked
// by the wick-aware trading engine. It never places a REAL order implicitly.
async function toolTradeWatch(args = {}, ctx = {}) {
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[trade_watch] A chat/session is required so updates have an owner.';
  const symbol = String(args.symbol || args.ticker || args.pair || '').trim();
  if (!symbol) return '[trade_watch] Provide a market symbol (for example BTC/USDT, XAUUSD, or EURUSD).';

  const intent = String(args.intent || args.action || args.mode || 'monitor').toLowerCase();
  const wantsAnalysis = !!args.analysis || /analy|signal|setup|all/.test(intent);
  const wantsPaper = /paper|sandbox|test|simulate|open/.test(intent) || !!args.paper;
  const chunks = [];

  if (wantsAnalysis) {
    chunks.push(await toolAnalyzeMarket({ ...args, symbol }, ctx));
    if (args.signal !== false) chunks.push(await toolTradeSignal({ ...args, symbol }, ctx));
  }

  // A sandbox/paper watch becomes a tracked PAPER position only when the order
  // parameters are complete. Otherwise it remains a non-executing price watch.
  const hasTradePlan = (args.side || args.direction) && (args.amount || args.size || args.qty) && (args.sl != null || args.stopLoss != null || args.tp != null || args.takeProfit != null);
  if (wantsPaper && hasTradePlan) {
    chunks.push(await toolOpenTrade({ ...args, symbol, mode: 'PAPER' }, ctx));
    return '[trade_watch]\n' + chunks.join('\n\n');
  }

  let mw = null;
  try { mw = require('./marketWatch'); } catch (_) { mw = null; }
  if (!mw) return '[trade_watch] Market-watch engine unavailable.';
  const targets = Array.isArray(args.targets) ? args.targets.slice() : [];
  const push = (type, value) => {
    const price = Number(value);
    if (Number.isFinite(price) && price > 0) targets.push({ type, price, label: type.toUpperCase() });
  };
  push('tp', args.tp != null ? args.tp : args.takeProfit);
  push('sl', args.sl != null ? args.sl : args.stopLoss);
  push('above', args.above);
  push('below', args.below);
  push('touch', args.target != null ? args.target : args.price);

  try {
    const entry = await mw.add(String(chatId), symbol, targets, {
      interval: args.interval || args.timeframe || '15m',
      interactive: args.interactive !== false,
      feedback: true,
      feedbackMs: Number(args.feedbackMs || args.feedback_ms) || undefined,
      feedbackMovePct: Number(args.feedbackMovePct || args.move_pct) || undefined,
    });
    const legs = entry.targets.length
      ? entry.targets.map(l => `${l.label} ${mw._fmt(l.price)}`).join(', ')
      : 'all meaningful price changes and periodic status feedback';
    chunks.push(`✅ Watching ${entry.symbol} continuously.\nWatch scope: ${legs}` +
      (entry.startPrice != null ? `\nVerified live snapshot: ${mw._fmt(entry.startPrice)} (${entry.startSrc || 'live feed'})` : '') +
      `\nUse list_watches to review or stop_watch to cancel.`);
    chunks.push('Market analysis is probabilistic, not guaranteed; live quotes and level events are cross-checked where independent feeds are available.');
    return '[trade_watch]\n' + chunks.join('\n\n');
  } catch (e) {
    return `[trade_watch] ${e.message || e}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Automation Tools — push code, configure APK CI, trigger, and monitor.
// GitHub credentials stay host-side; persistent sandbox workers call these
// through the authenticated bridge, so no PAT is exposed inside a sandbox.
// ─────────────────────────────────────────────────────────────────────────────

async function collectRepositoryFiles(args, ctx) {
  const all = await ctx.fsx.list();
  let target = String(args.path || args.dir || '.').trim();
  if (target === '.' || target === './' || target === '/') target = '';
  target = target.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const prefix = target ? `${target}/` : '';
  const ignored = /(^|\/)(?:\.git|node_modules|\.dart_tool|build|dist|coverage|\.gradle|\.idea|\.agent_runtime|\.agent_inbox|\.agent_outbox)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:apk|aab|jks|keystore|zip|tar|tgz)$/i;
  const maxFiles = Math.max(1, Math.min(parseInt(args.max_files, 10) || 5000, 10000));
  const picked = all.filter(f => (!prefix || f.rel.startsWith(prefix)) && !ignored.test(f.rel)).slice(0, maxFiles);
  const files = [];
  for (const f of picked) {
    const rel = prefix ? f.rel.slice(prefix.length) : f.rel;
    if (!rel) continue;
    try { files.push({ rel, buffer: await ctx.fsx.downloadBuffer(f.rel) }); } catch (_) {}
  }
  return files;
}

async function toolGithubPush(args, ctx) {
  const automation = require('./githubAutomation');
  const repo = String(args.repo || args.repository || process.env.GITHUB_DEPLOY_REPO || '').trim();
  if (!repo) return '[github_push] Need {"repo":"owner/name","path":"project"}.';
  try {
    const files = await collectRepositoryFiles(args, ctx);
    if (!files.length) return '[github_push] No source files found at the requested path.';
    if (ctx.onStep) ctx.onStep(`🐙 pushing ${files.length} verified source file(s) to ${repo}…`);
    const result = await automation.pushFiles({ repo, branch: args.branch, files, message: args.message });
    return `[github_push] ✅ Pushed ${result.files} source file(s) to ${result.repo}@${result.branch}.\nCommit: ${result.sha}\n${result.url}`;
  } catch (e) {
    return `[github_push] error: ${e.message}`;
  }
}

async function toolGithubApk(args, ctx) {
  const automation = require('./githubAutomation');
  const action = String(args.action || 'build').toLowerCase();
  const repo = String(args.repo || args.repository || '').trim();
  if (!repo) return '[github_apk] Need {"repo":"owner/name","action":"setup|trigger|watch|build"}.';
  try {
    if (action === 'setup' || action === 'configure') {
      const result = await automation.ensureFlutterWorkflow({
        repo, branch: args.branch, workflow: args.workflow || 'build-apk.yml',
        projectDir: args.project_dir || args.projectDir || '.', artifactName: args.artifact_name,
      });
      return `[github_apk] ✅ APK workflow configured in ${result.repo}@${result.branch}.\nCommit: ${result.sha}\n${result.url}`;
    }
    if (action === 'trigger' || action === 'dispatch') {
      const dispatch = await automation.dispatchWorkflow({ repo, branch: args.branch, workflow: args.workflow, inputs: args.inputs || {} });
      const run = await automation.findDispatchedRun(dispatch, { timeoutSeconds: args.locate_timeout_seconds, pollSeconds: args.poll_seconds });
      return `[github_apk] 🚀 APK workflow dispatched. run_id=${run.id} status=${run.status}\n${run.html_url}`;
    }
    if (action === 'watch' || action === 'monitor') {
      if (!args.run_id) return '[github_apk] watch requires run_id from trigger.';
      const result = await automation.watchRun({ repo, runId: args.run_id, maxWaitSeconds: args.max_wait_seconds, pollSeconds: args.poll_seconds,
        onPoll: run => {
          if (!ctx.onStep) return;
          if (run.pollError) ctx.onStep(`⚠️ APK monitor retry ${run.retry}: ${run.pollError}`);
          else ctx.onStep(`🔄 APK run #${run.id}: ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`);
        },
      });
      if (result.ok) {
        for (const artifact of (result.artifacts || [])) {
          if (artifact.buffer && ctx.deliverBuffer) await ctx.deliverBuffer(`${safeName(artifact.name, 'apk-artifact')}.zip`, artifact.buffer);
        }
        return `[github_apk] ✅ APK run #${result.run.id} succeeded and produced ${(result.artifacts || []).length} artifact(s).\n${result.run.html_url}`;
      }
      if (result.timedOut) return `[github_apk] ⏰ run #${args.run_id} is still active after the polling deadline. Poll it again; do not dispatch a duplicate.`;
      if (result.monitorFailed) return `[github_apk] ⚠️ The monitor temporarily lost GitHub after repeated retries; the APK run was not marked failed. Resume watching run #${args.run_id} instead of dispatching a duplicate. ${result.error || ''}`;
      const diag = (result.diagnostics || []).map(d => `FAILED JOB: ${d.job}\nFAILED STEP: ${d.step}\n${d.log}`).join('\n\n').slice(-30000);
      return `[github_apk] ❌ APK run #${result.run && result.run.id} failed. Diagnose these logs, edit the project, run tests in the sandbox, use github_push, then trigger and watch a new run.\n\n${diag}`;
    }
    if (action === 'build' || action === 'dispatch_and_watch') {
      const dispatch = await automation.dispatchWorkflow({ repo, branch: args.branch, workflow: args.workflow, inputs: args.inputs || {} });
      const run = await automation.findDispatchedRun(dispatch, { timeoutSeconds: args.locate_timeout_seconds, pollSeconds: args.poll_seconds });
      return await toolGithubApk({ ...args, action: 'watch', repo, run_id: run.id }, ctx);
    }
    return `[github_apk] Unknown action "${action}". Use setup, trigger, watch, or build.`;
  } catch (e) {
    return `[github_apk] error: ${e.message}`;
  }
}

// ── GitHub API helper ──────────────────────────────────────────────────────────
const GH_API = 'https://api.github.com';
function ghHeaders(token) {
  if (!token) return {};
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'WormGPT-Agent',
  };
}

// Resolve GITHUB_TOKEN: env → DB setting → null.
async function _resolveGithubToken() {
  if (process.env.GITHUB_DEPLOY_TOKEN) return process.env.GITHUB_DEPLOY_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const db = require('../db');
    if (db && db.getSetting) {
      const v = await db.getSetting('github_deploy_token').catch(() => null);
      if (v) return v;
      const v2 = await db.getSetting('github_token').catch(() => null);
      if (v2) return v2;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: github_scan — scan a GitHub repository for structure, CI/CD, deps, etc.
//   args: { repo: "owner/repo", branch? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolGithubScan(args, ctx) {
  const repoS = (args.repo || args.repository || '').trim();
  if (!repoS || !repoS.includes('/')) return '[github_scan] Need a repo: {"repo":"owner/repo"}.';
  const [owner, repo] = repoS.split('/');
  const branch = args.branch || '';
  const token = args.token || await _resolveGithubToken();
  const hdrs = ghHeaders(token);
  const lines = [];
  lines.push(`[github_scan] 🔍 Scanning ${owner}/${repo}${branch ? ' @ ' + branch : ''}...`);

  try {
    // Repo info
    const infoR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}`, { headers: hdrs }, 15000);
    if (!infoR.ok) return `[github_scan] ${owner}/${repo} → HTTP ${infoR.status}: ${(await infoR.text().catch(()=>'')).slice(0, 200)}`;
    const info = await infoR.json();
    lines.push(`📋 ${info.full_name} | ⭐ ${info.stargazers_count} | 🍴 ${info.forks_count} | 📝 ${info.open_issues_count} open issues`);
    lines.push(`   Language: ${info.language || 'N/A'} | Default branch: ${info.default_branch} | License: ${(info.license && info.license.spdx_id) || 'N/A'}`);
    if (info.description) lines.push(`   Description: ${info.description}`);
    if (info.topics && info.topics.length) lines.push(`   Topics: ${info.topics.join(', ')}`);

    // Branches
    const brR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/branches?per_page=20`, { headers: hdrs }, 15000);
    if (brR.ok) {
      const brs = await brR.json();
      lines.push(`🌿 Branches (${brs.length}${brs.length >= 20 ? '+' : ''}): ${brs.map(b => b.name).join(', ')}`);
    }

    // Workflows (CI/CD)
    const wfR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/workflows`, { headers: hdrs }, 15000);
    if (wfR.ok) {
      const wfs = await wfR.json();
      const wfList = (wfs.workflows || []);
      if (wfList.length) {
        lines.push(`⚙️ Workflows: ${wfList.map(w => `${w.name} (${w.state})`).join(' | ')}`);
      } else {
        lines.push(`⚙️ No GitHub Actions workflows found.`);
      }
    }

    // Recent commits
    const commitR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/commits?per_page=5`, { headers: hdrs }, 15000);
    if (commitR.ok) {
      const commits = await commitR.json();
      lines.push(`📝 Recent commits:`);
      for (const c of commits) {
        const msg = (c.commit.message || '').split('\n')[0].slice(0, 80);
        lines.push(`   ${c.sha.slice(0,7)} — ${msg} (${c.commit.author.name})`);
      }
    }

    // Latest release
    const relR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/releases/latest`, { headers: hdrs }, 10000);
    if (relR.ok) {
      const rel = await relR.json();
      lines.push(`🏷️ Latest release: ${rel.tag_name} — ${(rel.name || rel.tag_name)}`);
    }

    // Content scan (top-level files)
    const treeR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/git/trees/${branch || info.default_branch}?recursive=0`, { headers: hdrs }, 15000);
    if (treeR.ok) {
      const tree = await treeR.json();
      const files = (tree.tree || []).map(t => t.path).filter(p => !p.includes('/'));
      lines.push(`📁 Root files: ${files.join(', ')}`);
    }

    return lines.join('\n');
  } catch (e) {
    return `[github_scan] Error scanning ${owner}/${repo}: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: github_workflow — trigger, list, or check GitHub Actions workflows
//   args: { repo: "owner/repo", action: "trigger"|"list"|"status", workflow_id?,
//           ref?, inputs? }
// ─────────────────────────────────────────────────────────────────────────────
async function toolGithubWorkflow(args, ctx) {
  const repoS = (args.repo || args.repository || '').trim();
  if (!repoS || !repoS.includes('/')) return '[github_workflow] Need a repo: {"repo":"owner/repo"}.';
  const [owner, repo] = repoS.split('/');
  const action = (args.action || 'list').toLowerCase();
  const token = args.token || await _resolveGithubToken();
  const hdrs = ghHeaders(token);
  const lines = [];

  try {
    if (action === 'list') {
      // List all workflows
      const wfR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/workflows`, { headers: hdrs }, 15000);
      if (!wfR.ok) return `[github_workflow] HTTP ${wfR.status}`;
      const wfs = await wfR.json();
      const wfList = (wfs.workflows || []);
      if (!wfList.length) return `[github_workflow] No workflows in ${owner}/${repo}.`;
      lines.push(`[github_workflow] ${owner}/${repo} workflows:`);
      for (const w of wfList) {
        lines.push(`  ID=${w.id} | ${w.name} | state=${w.state} | path=${w.path}`);
      }
      return lines.join('\n');
    }

    if (action === 'trigger' || action === 'dispatch') {
      const wfId = args.workflow_id || args.workflow;
      if (!wfId) {
        // Auto-discover: find first workflow with "build" or "apk" in name
        const wfR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/workflows`, { headers: hdrs }, 15000);
        if (!wfR.ok) return `[github_workflow] Cannot list workflows — HTTP ${wfR.status}`;
        const wfs = await wfR.json();
        const buildWf = (wfs.workflows || []).find(w => /build|apk|flutter|android|release/i.test(w.name));
        if (!buildWf) return `[github_workflow] No build workflow found. List workflows first with action:"list".`;
        return await _triggerWorkflow(owner, repo, buildWf.id, args, hdrs, lines);
      }
      return await _triggerWorkflow(owner, repo, wfId, args, hdrs, lines);
    }

    if (action === 'status' || action === 'runs') {
      const runR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs?per_page=10`, { headers: hdrs }, 15000);
      if (!runR.ok) return `[github_workflow] HTTP ${runR.status}`;
      const runs = await runR.json();
      const runList = (runs.workflow_runs || []);
      if (!runList.length) return `[github_workflow] No workflow runs in ${owner}/${repo}.`;
      lines.push(`[github_workflow] Recent runs in ${owner}/${repo}:`);
      for (const r of runList) {
        const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : r.status === 'in_progress' ? '🔄' : '⏳';
        lines.push(`  ${icon} #${r.id} | ${r.name} | ${r.status}/${r.conclusion || 'N/A'} | branch=${r.head_branch} | ${r.created_at}`);
      }
      return lines.join('\n');
    }

    return `[github_workflow] Unknown action "${action}". Use: list, trigger, status.`;
  } catch (e) {
    return `[github_workflow] Error: ${e.message}`;
  }
}

async function _triggerWorkflow(owner, repo, wfId, args, hdrs, lines) {
  const ref = args.ref || args.branch || 'main';
  const inputs = args.inputs || {};
  const body = { ref };
  if (Object.keys(inputs).length) body.inputs = inputs;

  const r = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/workflows/${wfId}/dispatches`, {
    method: 'POST', headers: hdrs, body: JSON.stringify(body),
  }, 15000);

  if (r.status === 204) {
    lines.push(`[github_workflow] 🚀 Triggered workflow ID=${wfId} on ${ref} in ${owner}/${repo}.`);
    lines.push(`  Monitor with: github_monitor repo:"${owner}/${repo}"`);
    // Get the run ID by fetching the latest run
    try {
      const runR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs?per_page=3&event=workflow_dispatch`, { headers: hdrs }, 10000);
      if (runR.ok) {
        const runs = await runR.json();
        const latest = (runs.workflow_runs || [])[0];
        if (latest) {
          lines.push(`  Latest run: #${latest.id} (${latest.status}) — html_url: ${latest.html_url}`);
        }
      }
    } catch (_) {}
    return lines.join('\n');
  }
  const errText = await r.text().catch(() => '');
  return `[github_workflow] Failed to trigger (HTTP ${r.status}): ${errText.slice(0, 300)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: github_monitor — monitor a workflow run to completion, get logs/artifacts
//   args: { repo: "owner/repo", run_id? (auto-find latest if omitted),
//           interval_seconds? (default 20), max_wait_seconds? (default 1800) }
// ─────────────────────────────────────────────────────────────────────────────
async function toolGithubMonitor(args, ctx) {
  const repoS = (args.repo || args.repository || '').trim();
  if (!repoS || !repoS.includes('/')) return '[github_monitor] Need a repo: {"repo":"owner/repo"}.';
  const [owner, repo] = repoS.split('/');
  const token = args.token || await _resolveGithubToken();
  const hdrs = ghHeaders(token);
  const interval = Math.max(10, parseInt(args.interval_seconds, 10) || 20);
  const maxWait = Math.min(3600, Math.max(60, parseInt(args.max_wait_seconds, 10) || 1800));
  const lines = [];
  lines.push(`[github_monitor] 👀 Monitoring ${owner}/${repo}...`);

  try {
    let runId = args.run_id;
    if (!runId) {
      // Auto-find latest run
      const runR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs?per_page=3`, { headers: hdrs }, 10000);
      if (!runR.ok) return `[github_monitor] Cannot fetch runs — HTTP ${runR.status}`;
      const runs = await runR.json();
      const latest = (runs.workflow_runs || [])[0];
      if (!latest) return `[github_monitor] No workflow runs found in ${owner}/${repo}.`;
      runId = latest.id;
      lines.push(`  Auto-selected latest run: #${runId} (${latest.name})`);
    }

    // Poll until completion
    let elapsed = 0;
    let status = 'queued', conclusion = null;
    const startTime = Date.now();

    while (status === 'queued' || status === 'in_progress' || status === 'pending' || status === 'waiting') {
      const r = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}`, { headers: hdrs }, 10000);
      if (!r.ok) {
        lines.push(`  ⚠️ HTTP ${r.status} polling run #${runId} — will retry`);
      } else {
        const data = await r.json();
        status = data.status;
        conclusion = data.conclusion;
        const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
        lines.push(`  [${elapsedMin}m] Status: ${status} | Conclusion: ${conclusion || 'N/A'}`);

        if (status === 'completed') break;
      }

      if (elapsed >= maxWait) {
        lines.push(`  ⏰ Monitoring timed out after ${elapsed}s — workflow is still ${status}.`);
        lines.push(`  Check manually: https://github.com/${owner}/${repo}/actions/runs/${runId}`);
        return lines.join('\n');
      }

      // Progressive backoff
      const wait = Math.min(interval + elapsed * 0.1, 60);
      await new Promise(res => setTimeout(res, wait * 1000));
      elapsed += wait;
    }

    if (conclusion === 'success') {
      lines.push(`✅ Workflow #${runId} SUCCEEDED!`);

      // Get artifacts
      const artR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`, { headers: hdrs }, 10000);
      if (artR.ok) {
        const arts = await artR.json();
        const artList = (arts.artifacts || []);
        if (artList.length) {
          lines.push(`📦 Artifacts (${artList.length}):`);
          for (const a of artList) {
            lines.push(`  ${a.name} | ${(a.size_in_bytes / 1024 / 1024).toFixed(1)} MB | expires: ${a.expired ? 'EXPIRED' : a.expires_at}`);
            // Download the artifact if ctx has deliverBuffer
            if (ctx && ctx.deliverBuffer && !a.expired) {
              try {
                const dlR = await fetchWithTimeout(a.archive_download_url, { headers: hdrs }, 60000);
                if (dlR.ok) {
                  const buf = Buffer.from(await dlR.arrayBuffer());
                  const fname = safeName(a.name, 'artifact') + '.zip';
                  await ctx.deliverBuffer(fname, buf);
                  lines.push(`    ✅ Downloaded as ${fname} (${(buf.length / 1024).toFixed(0)} KB)`);
                }
              } catch (e) {
                lines.push(`    ⚠️ Download failed: ${e.message}`);
              }
            }
          }
        }
      }
    } else if (conclusion === 'failure') {
      lines.push(`❌ Workflow #${runId} FAILED.`);

      // Get failed job logs
      const jobsR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { headers: hdrs }, 10000);
      if (jobsR.ok) {
        const jobs = await jobsR.json();
        const failedJobs = (jobs.jobs || []).filter(j => j.conclusion === 'failure');
        for (const job of failedJobs) {
          lines.push(`  🔴 Failed job: ${job.name} (step: ${job.steps ? job.steps.find(s => s.conclusion === 'failure')?.name || 'unknown' : 'unknown'})`);
          // Try to get logs
          try {
            const logR = await fetchWithTimeout(`${GH_API}/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, { headers: hdrs }, 30000);
            if (logR.ok) {
              const logText = (await logR.text()).split('\n');
              // Get the last 50 lines — where errors usually are
              const tail = logText.slice(-50);
              lines.push(`  📋 Log tail (last ${tail.length} lines):`);
              for (const l of tail) lines.push(`    ${l}`);
            }
          } catch (_) {
            lines.push(`  Check: ${job.html_url}`);
          }
        }
      }
    } else {
      lines.push(`⚠️ Workflow #${runId} ended with conclusion: ${conclusion || 'unknown'}.`);
    }

    lines.push(`🔗 ${`https://github.com/${owner}/${repo}/actions/runs/${runId}`}`);
    return lines.join('\n');
  } catch (e) {
    return `[github_monitor] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: run_php — write & EXECUTE PHP inside the sandbox (lint + run), and
// optionally serve it. First-class PHP support so the agent can build/test PHP
// webshells, uploaders, DB clients and PoCs and PROVE they work (php -l + run).
// ─────────────────────────────────────────────────────────────────────────────
async function toolRunPhp(args, ctx) {
  const code = args.code || args.content || '';
  const file = safeName(args.filename || 'script.php', 'script.php').replace(/[^.]*$/, m => m) || 'script.php';
  const fname = /\.php$/i.test(file) ? file : `${file}.php`;
  const serve = !!args.serve;
  const port = parseInt(args.port, 10) || 8080;
  if (!code.trim() && !args.path) {
    return '[run_php] No PHP. Pass {"code":"<?php ... ?>","filename":"x.php"} (optionally {"serve":true,"port":8080}).';
  }
  if (!ctx.fsx || typeof ctx.fsx.sh !== 'function') {
    return '[run_php] needs a live sandbox (fsx.sh). None available.';
  }
  const target = args.path || fname;
  try {
    // Write the PHP file (unless the agent points at an existing path).
    if (code.trim()) {
      try { await ctx.fsx.uploadBuffer(target, Buffer.from(code, 'utf-8')); }
      catch (_) { await ctx.fsx.sh(`cat > '${target}' <<'PHP_EOF_9271'\n${code}\nPHP_EOF_9271`); }
      try { ctx.addFile && ctx.addFile(target, target.split('/').pop()); } catch (_) {}
    }
    // Ensure PHP is installed (idempotent, quiet). Sandboxes run as a NON-root
    // user (Novita/Runloop/Daytona = user `user`), so package installs need
    // `sudo`. We try sudo first, then plain apt (CodeSandbox runs as real root),
    // so PHP installs on EVERY backend.
    const ensure = `command -v php >/dev/null 2>&1 || { sudo apt-get update -qq >/dev/null 2>&1 || apt-get update -qq >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq php-cli php-mysql php-sqlite3 php-curl >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq php-cli php-mysql php-sqlite3 php-curl >/dev/null 2>&1; }; php --version 2>&1 | head -1`;
    const ver = await ctx.fsx.sh(ensure);
    const phpVer = ((ver && (ver.output || ver.stdout)) || '').trim().split('\n')[0] || 'php (version unknown)';
    // Lint first.
    const lintR = await ctx.fsx.sh(`php -l '${target}' 2>&1`);
    const lint = ((lintR && (lintR.output || lintR.stdout)) || '').trim();
    if (/error|parse error/i.test(lint) && !/No syntax errors/i.test(lint)) {
      return `[run_php] ${phpVer}\n❌ Lint FAILED for ${target}:\n${lint.slice(0, 1500)}\nFix the PHP and retry.`;
    }
    if (serve) {
      // Start a background PHP dev server and probe it.
      const startR = await ctx.fsx.sh(
        `pkill -f "php -S 0.0.0.0:${port}" 2>/dev/null; (php -S 0.0.0.0:${port} >/tmp/php_${port}.log 2>&1 &) ; sleep 1.5; curl -s -m 8 "http://127.0.0.1:${port}/${target}" 2>&1 | head -c 4000; echo; echo "--- server log ---"; tail -5 /tmp/php_${port}.log 2>/dev/null`
      );
      const out = ((startR && (startR.output || startR.stdout)) || '').trim();
      return `[run_php] ${phpVer}\n✅ Lint OK. Serving ${target} on :${port} (php -S). Response:\n${out.slice(0, 4000)}`;
    }
    // Run via CLI.
    const runR = await ctx.fsx.sh(`php '${target}' 2>&1 | head -c 8000`);
    const out = ((runR && (runR.output || runR.stdout)) || '').trim();
    return `[run_php] ${phpVer}\n✅ Lint OK. CLI output of ${target}:\n${out.slice(0, 8000) || '(no output)'}`;
  } catch (e) {
    return `[run_php] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Tool: open_trade — open a PAPER (default) or REAL trade with SL/TP.
//   args: { exchange:"binance"|"bybit", symbol, side:"buy"|"sell", amount,
//           entry?, sl?, tp?, mode:"PAPER"|"REAL", leverage? }
async function toolOpenTrade(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[open_trade] Trading engine unavailable (ccxt not installed).';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[open_trade] Trading only works from the Telegram/WhatsApp agent (needs a chat to own the trade & send alerts).';
  try {
    const trade = await te.openTrade({
      chatId: String(chatId),
      userId: (ctx && ctx.userId) || null,
      exchange: args.exchange || args.ex || 'binance',
      symbol: args.symbol || args.pair || args.ticker,
      side: args.side || args.direction,
      amount: args.amount || args.size || args.qty,
      entry: args.entry != null ? args.entry : (args.price != null ? args.price : undefined),
      sl: args.sl != null ? args.sl : args.stopLoss,
      tp: args.tp != null ? args.tp : args.takeProfit,
      mode: args.mode || 'PAPER',
      leverage: args.leverage || args.lev,
      note: args.note,
    });
    return `[open_trade] ✅ Opened. I'm now watching it 24/7 and will alert you the instant SL or TP is hit.\n\n` +
      te._formatOpen(trade) + `\n\nTrade ID: ${trade.id}`;
  } catch (e) {
    return `[open_trade] ❌ ${e.message || e}`;
  }
}

// Tool: close_trade — manually close a trade now (market close in REAL mode).
//   args: { id } (or closes the only open trade / most recent if omitted)
async function toolCloseTrade(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[close_trade] Trading engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[close_trade] Only available from the Telegram/WhatsApp agent.';
  try {
    let id = args.id || args.tradeId;
    if (!id) {
      const open = await te.listTrades(String(chatId), { status: 'OPEN' });
      if (!open.length) return '[close_trade] You have no open trades.';
      if (open.length > 1 && !args.all) {
        return '[close_trade] You have multiple open trades — specify which id to close:\n' +
          open.map(t => `• ${t.id} — ${t.symbol} ${t.side} (${t.mode})`).join('\n');
      }
      if (args.all) {
        const closed = [];
        for (const t of open) { try { const r = await te.closeTrade(String(chatId), t.id, { reason: 'MANUAL' }); closed.push(r); } catch (_) {} }
        return `[close_trade] ✅ Closed ${closed.length} trade(s).\n` +
          closed.map(t => `• ${t.symbol}: ${te._money(t.pnl)}${Number.isFinite(t.r) ? ` [${t.r.toFixed(1)}R]` : ''}`).join('\n');
      }
      id = open[0].id;
    }
    const t = await te.closeTrade(String(chatId), id, { reason: 'MANUAL' });
    return `[close_trade] ✅ Closed.\n` + te._formatHit(t, 'MANUAL', t.exit);
  } catch (e) {
    return `[close_trade] ❌ ${e.message || e}`;
  }
}

// Tool: list_trades — show open (and optionally closed) trades.
async function toolListTrades(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[list_trades] Trading engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[list_trades] Only available from the Telegram/WhatsApp agent.';
  const status = args.status ? String(args.status).toUpperCase() : (args.all ? null : 'OPEN');
  const trades = await te.listTrades(String(chatId), { status, limit: args.limit || 25 });
  if (!trades.length) return `[list_trades] No ${status ? status.toLowerCase() + ' ' : ''}trades.`;
  const lines = trades.map(t => {
    const dir = t.side === 'buy' ? 'LONG' : 'SHORT';
    if (t.status === 'OPEN') {
      return `🟡 ${t.id} · ${t.symbol} ${dir} (${t.mode}) · entry ${te._fmt(t.entry)}` +
        (t.sl != null ? ` · SL ${te._fmt(t.sl)}` : '') + (t.tp != null ? ` · TP ${te._fmt(t.tp)}` : '') +
        (t.lastPrice != null ? ` · now ${te._fmt(t.lastPrice)}` : '');
    }
    const badge = t.closeReason === 'TP' ? '🎯' : t.closeReason === 'SL' ? '🛑' : '✅';
    return `${badge} ${t.id} · ${t.symbol} ${dir} (${t.mode}) · ${te._money(t.pnl)}${Number.isFinite(t.r) ? ` [${t.r.toFixed(1)}R]` : ''} · ${t.closeReason}`;
  });
  return `[list_trades] ${trades.length} trade(s):\n` + lines.join('\n');
}

// Tool: trade_stats — winrate, total PnL, avg R.
async function toolTradeStats(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[trade_stats] Trading engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[trade_stats] Only available from the Telegram/WhatsApp agent.';
  const s = await te.stats(String(chatId));
  if (!s.closed && !s.open) return '[trade_stats] No trades yet. Open a PAPER trade to start testing a strategy.';
  return `[trade_stats] 📊 Your trading stats\n` +
    `Open: ${s.open}  •  Closed: ${s.closed}\n` +
    `Wins: ${s.wins}  •  Losses: ${s.losses}\n` +
    (s.winrate != null ? `Winrate: ${s.winrate.toFixed(1)}%\n` : '') +
    `Total PnL: ${te._money(s.totalPnl)}\n` +
    (s.avgR != null ? `Avg R: ${s.avgR.toFixed(2)}R\n` : '') +
    (s.bestPnl != null ? `Best: ${te._money(s.bestPnl)}  •  Worst: ${te._money(s.worstPnl)}` : '');
}

// Tool: connect_exchange — save the user's REAL API keys (per chat) so REAL
// mode can place live orders. Keys are stored in the same settings store.
async function toolConnectExchange(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[connect_exchange] Trading engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[connect_exchange] Only available from the Telegram/WhatsApp agent.';
  try {
    await te.saveCreds(String(chatId), args.exchange || args.ex, args.apiKey || args.api_key || args.key, args.secret || args.apiSecret || args.api_secret, { password: args.password });
    const ex = te._exLabel(require('./tradingEngine').normSymbol ? (args.exchange || '') : (args.exchange || ''));
    return `[connect_exchange] ✅ ${args.exchange} API keys saved for this chat. You can now open REAL trades (mode:"REAL"). ` +
      `⚠️ For your safety, use API keys with FUTURES trade permission ONLY and NO withdrawal permission. Say "disconnect <exchange>" anytime to remove them.`;
  } catch (e) {
    return `[connect_exchange] ❌ ${e.message || e}`;
  }
}

// Tool: disconnect_exchange — remove saved REAL API keys.
async function toolDisconnectExchange(args, ctx) {
  const te = _tradingEngine();
  if (!te || !te.enabled()) return '[disconnect_exchange] Trading engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[disconnect_exchange] Only available from the Telegram/WhatsApp agent.';
  await te.clearCreds(String(chatId), args.exchange || args.ex || null);
  return `[disconnect_exchange] ✅ Removed ${args.exchange ? args.exchange + ' ' : ''}API keys for this chat. REAL trading is now disabled${args.exchange ? ' for that exchange' : ''}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS TOOLS — the trading BRAIN. Backed by services/tradingAnalysis.js +
// tradingEngine.fetchCandles. All read-only, safe to run any time.
// ─────────────────────────────────────────────────────────────────────────────
let _ta = null;
function _analysis() { if (_ta) return _ta; try { _ta = require('./tradingAnalysis'); } catch (_) { _ta = null; } return _ta; }

async function _candlesFor(args) {
  const te = _tradingEngine();
  const exchange = args.exchange || args.ex || 'binance';
  const symbol = args.symbol || args.pair || args.ticker || 'BTC/USDT';
  const timeframe = String(args.timeframe || args.interval || args.tf || '15m').toLowerCase();
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 200, 30), 500);
  let candles = [];
  if (te && te.fetchCandles) {
    try { candles = await te.fetchCandles(exchange, symbol, { timeframe, limit }); } catch (_) { candles = []; }
  }
  return { candles, exchange, symbol, timeframe };
}

// Tool: analyze_market — full multi-pillar read (structure + indicators + regime).
async function toolAnalyzeMarket(args, ctx) {
  const ta = _analysis();
  if (!ta) return '[analyze_market] Analysis engine unavailable.';
  const { candles, symbol, timeframe } = await _candlesFor(args);
  if (!candles.length) return `[analyze_market] Could not fetch candles for ${symbol} (${timeframe}). Try a clearer symbol (BTC, ETH, SOL, XAUUSD, EURUSD).`;
  const sig = ta.signal(candles);
  if (!sig) return `[analyze_market] Not enough candle history for ${symbol} — need ≥30 bars.`;
  const ind = sig.indicators, st = sig.structure;
  const f = (x) => (x == null ? 'n/a' : x);
  const L = [];
  L.push(`📊 MARKET ANALYSIS — ${symbol} (${timeframe})`);
  L.push(`Price: ${f(ind.price)}`);
  L.push('');
  L.push(`🧭 Structure: ${st.trend.toUpperCase()} (${st.detail})`);
  L.push(`   Support: ${f(st.support)}  •  Resistance: ${f(st.resistance)}`);
  if (st.breakout) L.push(`   ⚡ Breakout: ${st.breakout.toUpperCase()}`);
  L.push(`   Volume: ${f(st.volume.now)} (avg ${f(st.volume.avg20)})${st.volume.spike ? ' 🔊 SPIKE' : ''}`);
  L.push('');
  L.push(`📐 Indicators:`);
  L.push(`   EMA 20/50/200: ${f(ind.ema20)} / ${f(ind.ema50)} / ${f(ind.ema200)}`);
  L.push(`   RSI: ${f(ind.rsi)}  •  Stoch %K: ${f(ind.stochastic && ind.stochastic.k)}  •  CCI: ${f(ind.cci)}  •  ROC: ${f(ind.roc)}%`);
  L.push(`   MACD hist: ${f(ind.macd && ind.macd.hist)}  •  ADX: ${f(ind.adx && ind.adx.adx)} (+DI ${f(ind.adx && ind.adx.plusDI)} / -DI ${f(ind.adx && ind.adx.minusDI)})`);
  L.push(`   ATR: ${f(ind.atr)}  •  Supertrend: ${f(ind.supertrend && ind.supertrend.trend)}`);
  if (ind.bollinger) L.push(`   Bollinger: mid ${f(ind.bollinger.mid)} | %B ${f(ind.bollinger.pctB)} | bw ${f(ind.bollinger.bandwidth)}`);
  L.push('');
  L.push(`🎯 BIAS: ${sig.bias}  •  GRADE: ${sig.grade}  •  Conviction: ${(sig.conviction * 100).toFixed(0)}%`);
  L.push(`   Confluence: ${sig.agree}/${sig.totalSignals} signals agree`);
  L.push(`   Regime: ${sig.regime}  •  Volatility: ${sig.volState}`);
  L.push(`   ${sig.summary}`);
  return '[analyze_market]\n' + L.join('\n');
}

// Tool: trade_signal — actionable signal + suggested entry/SL/TP with R:R.
async function toolTradeSignal(args, ctx) {
  const ta = _analysis();
  if (!ta) return '[trade_signal] Analysis engine unavailable.';
  const { candles, symbol, timeframe } = await _candlesFor(args);
  if (!candles.length) return `[trade_signal] Could not fetch candles for ${symbol}.`;
  const sig = ta.signal(candles);
  if (!sig) return `[trade_signal] Not enough history for ${symbol}.`;
  if (sig.bias === 'NEUTRAL') {
    return `[trade_signal] ${symbol} (${timeframe}) → NO-TRADE. ${sig.summary}`;
  }
  const side = sig.bias === 'LONG' ? 'buy' : 'sell';
  const rr = Number(args.rr) || 2;
  const method = args.method === 'structure' ? 'structure' : 'atr';
  const plan = ta.suggestSlTp(candles, { side, rr, method });
  const L = [];
  L.push(`🎯 TRADE SIGNAL — ${symbol} (${timeframe})`);
  L.push(`Setup: ${sig.grade} ${sig.bias}  •  Conviction ${(sig.conviction * 100).toFixed(0)}%  •  ${sig.agree}/${sig.totalSignals} agree`);
  L.push(`Regime: ${sig.regime} | Vol: ${sig.volState}`);
  if (plan) {
    L.push('');
    L.push(`Entry: ${plan.entry}`);
    L.push(`SL: ${plan.sl}   TP: ${plan.tp}   (${method}, ATR ${plan.atr})`);
    if (plan.riskReward) L.push(`R:R = ${plan.riskReward.rr} (${plan.riskReward.quality})`);
  }
  L.push('');
  L.push(sig.grade === 'A+' || sig.grade === 'A'
    ? `✅ High-quality ${sig.bias} — consider ${side.toUpperCase()} with the levels above.`
    : `⚠️ ${sig.grade} setup — only take with strict risk (≤1% ) or wait for A/A+.`);
  L.push(`(To act: open_trade exchange:${args.exchange || 'binance'} symbol:${symbol} side:${side} amount:<size> sl:${plan ? plan.sl : ''} tp:${plan ? plan.tp : ''} mode:PAPER)`);
  return '[trade_signal]\n' + L.join('\n');
}

// Tool: position_size — risk-based sizing.
async function toolPositionSize(args, ctx) {
  const ta = _analysis();
  if (!ta) return '[position_size] Analysis engine unavailable.';
  const r = ta.positionSize({
    account: args.account || args.balance || args.equity,
    riskPct: args.riskPct != null ? args.riskPct : (args.risk != null ? args.risk : 1),
    entry: args.entry, sl: args.sl, leverage: args.leverage || 1,
  });
  if (!r.valid) return `[position_size] ❌ ${r.reason}`;
  return `[position_size] 📏 Risk ${args.riskPct != null ? args.riskPct : (args.risk != null ? args.risk : 1)}% of $${args.account || args.balance || args.equity}\n` +
    `Size: ${r.size} units  •  Risk: $${r.riskAmount}  •  Per-unit risk: ${r.perUnitRisk}\n` +
    `Notional: $${r.notional}  •  Margin @ ${r.leverage}x: $${r.marginUsed}`;
}

// Tool: risk_check — validate a proposed trade's R:R + drawdown status.
async function toolRiskCheck(args, ctx) {
  const ta = _analysis(); const te = _tradingEngine();
  if (!ta) return '[risk_check] Analysis engine unavailable.';
  const rr = ta.riskReward({ side: (args.side || 'buy'), entry: args.entry, sl: args.sl, tp: args.tp });
  const L = ['[risk_check] 🛡️ Risk review'];
  if (!rr) L.push('Provide entry, sl and tp for R:R.');
  else {
    L.push(`R:R = ${rr.rr} (${rr.quality})  •  Risk ${rr.risk} / Reward ${rr.reward}`);
    if (!rr.dirOK) L.push('⚠️ SL/TP are on the WRONG side of entry for this direction.');
  }
  // drawdown from recent closed trades
  const chatId = _tradeChatId(args, ctx);
  if (te && chatId) {
    try {
      const closed = await te.listTrades(String(chatId), { status: 'CLOSED', limit: 50 });
      const dd = ta.drawdownMonitor(closed);
      L.push(`Loss streak: ${dd.lossStreak}  •  Max DD: $${dd.maxDrawdown}`);
      L.push(dd.reduceSize ? `🔻 ${dd.action}` : `✅ ${dd.action}`);
    } catch (_) {}
  }
  // session context
  const ses = ta.sessionContext();
  L.push(`Session: ${ses.session}${ses.overlap ? ' — ' + ses.overlap : ''}`);
  if (ses.warnings.length) ses.warnings.forEach(w => L.push('⚠️ ' + w));
  return L.join('\n');
}

// Tool: performance_report — winrate by setup, expectancy, equity curve.
async function toolPerformanceReport(args, ctx) {
  const ta = _analysis(); const te = _tradingEngine();
  if (!ta || !te) return '[performance_report] Engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  if (!chatId) return '[performance_report] Only available from the agent (needs a chat).';
  const closed = await te.listTrades(String(chatId), { status: 'CLOSED', limit: 500 });
  const p = ta.performance(closed);
  if (!p.trades) return '[performance_report] No closed trades yet. Run some PAPER trades to build a track record.';
  const L = ['[performance_report] 📈 Performance'];
  L.push(`Trades: ${p.trades} (W ${p.wins} / L ${p.losses})  •  Winrate: ${p.winrate}%`);
  L.push(`Avg win: ${te._money(p.avgWin)}  •  Avg loss: ${te._money(p.avgLoss)}`);
  L.push(`Expectancy/trade: ${te._money(p.expectancy)}  •  Profit factor: ${p.profitFactor != null ? p.profitFactor : 'n/a'}`);
  L.push(`Total PnL: ${te._money(p.totalPnl)}  •  Avg R: ${p.avgR != null ? p.avgR + 'R' : 'n/a'}`);
  L.push(`Equity: ${te._money(p.equityCurve.length ? p.equityCurve[p.equityCurve.length - 1] : 0)} (peak ${te._money(p.peakEquity)})${p.inDrawdown ? ' — in drawdown' : ' — at/near highs'}`);
  if (p.byReason && p.byReason.length) L.push('By outcome: ' + p.byReason.map(r => `${r.key} ${r.winrate}% (${te._money(r.pnl)})`).join(' | '));
  if (p.bySymbol && p.bySymbol.length) L.push('By symbol: ' + p.bySymbol.slice(0, 5).map(r => `${r.key} ${r.winrate}% (${te._money(r.pnl)})`).join(' | '));
  if (p.byDay && p.byDay.length) L.push('By day: ' + p.byDay.map(r => `${r.key.slice(0, 3)} ${te._money(r.pnl)}`).join(' | '));
  return L.join('\n');
}

// Tool: health_check — execution/exchange health (latency, feed, balance).
async function toolHealthCheck(args, ctx) {
  const ta = _analysis(); const te = _tradingEngine();
  if (!ta || !te) return '[health_check] Engine unavailable.';
  const chatId = _tradeChatId(args, ctx);
  let creds = null;
  const exchange = args.exchange || 'binance';
  if (chatId && args.real) { try { creds = await te.getCreds(String(chatId), exchange); } catch (_) {} }
  const h = await ta.health(te, { chatId, exchange, symbol: args.symbol || 'BTC/USDT', creds });
  const L = ['[health_check] 🩺 Trading system health: ' + (h.ok ? 'OK ✅' : 'ISSUES ⚠️')];
  for (const c of h.checks) L.push(`${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  return L.join('\n');
}

module.exports = {
  toolFetchUrl,
  toolGetMarketPrice,
  getSpot,
  _yahooCandlesPublic,
  toolWatchMarket,
  toolListWatches,
  toolStopWatch,
  toolTradeWatch,
  toolOpenTrade,
  toolCloseTrade,
  toolListTrades,
  toolTradeStats,
  toolConnectExchange,
  toolDisconnectExchange,
  toolAnalyzeMarket,
  toolTradeSignal,
  toolPositionSize,
  toolRiskCheck,
  toolPerformanceReport,
  toolHealthCheck,
  toolGenerateImage,
  toolEditImage,
  toolHostMedia,
  toolCreateChart,
  toolCreateSlides,
  toolCreatePresentation,
  toolBrowserAction,
  toolDeploySite,
  toolDeployCloudflarePages,
  toolDeployGithub,
  toolGithubScan,
  toolGithubWorkflow,
  toolGithubMonitor,
  toolGithubPush,
  toolGithubApk,
  toolRunPhp,
  collectSiteFiles,
};
