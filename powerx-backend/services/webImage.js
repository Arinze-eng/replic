// ─────────────────────────────────────────────────────────────────────────────
// services/webImage.js — WEB IMAGE tool for the WormGPT / PowerX agent.
//
// The agent could already GENERATE images (generate_image → Pollinations/FLUX)
// and ANALYZE them (analyze_image), but it had NO way to go ONLINE, find a REAL
// photo, crop/resize it, and stage it for embedding into a PDF / PPTX / DOCX.
// This tool closes that gap — it is the backbone of "go online, get an image,
// crop it, and embed it well in whatever document the user wants".
//
// Tool name:  web_image   (aliases: image_search, find_image, fetch_image,
//                          crop_image, get_image)
//
// args:
//   query        {string}  what to search the web for (e.g. "golden gate bridge")
//   url          {string}  OR a DIRECT image URL to download instead of searching
//   count        {number}  how many candidate images to stage when searching (1..6, default 1)
//   filename     {string}  base name for the staged file(s) (default derived from query)
//   width        {number}  resize target width  (px) — keeps aspect unless height set
//   height       {number}  resize target height (px)
//   crop         {string}  "cover" | "contain" | "fill" | "inside" (sharp fit, default "cover")
//   crop_box     {object}  {left,top,width,height} exact pixel crop BEFORE resize (optional)
//   grayscale    {bool}    convert to grayscale
//   format       {string}  "png" | "jpeg" | "webp" (default "png")
//   host         {bool}    also upload to Cloudinary and return a permanent URL (default true)
//
// It STAGES the final image into the working dir via ctx.deliverBuffer(name,buf)
// so create_pdf({html:'<img src="name.png">'}) / create_pptx / documents can
// embed it directly, AND returns a small data-URI preview + hosted URL so the
// brain can also inline it straight into HTML.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const sharp = require('sharp');

function _fetch(url, opts = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const headers = Object.assign(
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    opts.headers || {},
  );
  return fetch(url, { ...opts, headers, signal: controller.signal }).finally(() => clearTimeout(t));
}

function _safe(name, fallback) {
  let n = String(name || fallback || 'image').replace(/[^\w.\-]/g, '_').replace(/_+/g, '_');
  if (!n) n = fallback || 'image';
  return n;
}

// ── DuckDuckGo image search (keyless) ────────────────────────────────────────
// 1) hit the token page to get the `vqd` token, 2) call i.js with it.
async function ddgImageSearch(query, max = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  // Step 1: obtain the vqd token.
  let vqd = '';
  try {
    const r = await _fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`);
    const html = await r.text();
    const m = html.match(/vqd=["']?([\d-]+)["']?/) || html.match(/vqd=([\d-]+)&/);
    if (m) vqd = m[1];
  } catch (_) {}
  if (!vqd) {
    // Fallback token endpoint.
    try {
      const r = await _fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(q)}`);
      // Some responses embed vqd in a redirect/JS blob.
      const txt = await r.text();
      const m = txt.match(/vqd=([\d-]+)/);
      if (m) vqd = m[1];
    } catch (_) {}
  }
  if (!vqd) return [];
  // Step 2: fetch the image results JSON.
  try {
    const u = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}&vqd=${vqd}&f=,,,&p=1`;
    const r = await _fetch(u, { headers: { Referer: 'https://duckduckgo.com/' } });
    if (!r.ok) return [];
    const j = await r.json();
    const results = Array.isArray(j.results) ? j.results : [];
    return results
      .map(x => ({ image: x.image, thumbnail: x.thumbnail, title: x.title, width: x.width, height: x.height, source: x.url }))
      .filter(x => x.image && /^https?:\/\//i.test(x.image))
      .slice(0, Math.max(1, Math.min(max, 12)));
  } catch (_) {
    return [];
  }
}

// Download an image URL and return its raw buffer (best-effort; tries thumbnail).
async function downloadImage(url, thumb) {
  const tryUrls = [url, thumb].filter(Boolean);
  for (const u of tryUrls) {
    try {
      const r = await _fetch(u, { headers: { Referer: 'https://duckduckgo.com/' } }, 30000);
      if (!r.ok) continue;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf && buf.length > 800 && (ct.startsWith('image/') || !ct)) return { buffer: buf, mime: ct || 'image/jpeg' };
    } catch (_) { /* try next */ }
  }
  return null;
}

// Apply crop/resize/format transforms with sharp. Never throws — falls back to
// the original bytes on any sharp error (some exotic formats).
async function transformImage(buffer, args = {}) {
  try {
    let img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata().catch(() => ({}));
    // Exact-pixel crop BEFORE resize.
    if (args.crop_box && typeof args.crop_box === 'object') {
      const b = args.crop_box;
      const left = Math.max(0, parseInt(b.left || b.x || 0, 10));
      const top = Math.max(0, parseInt(b.top || b.y || 0, 10));
      let width = parseInt(b.width || b.w || 0, 10);
      let height = parseInt(b.height || b.h || 0, 10);
      if (width > 0 && height > 0 && meta.width && meta.height) {
        width = Math.min(width, meta.width - left);
        height = Math.min(height, meta.height - top);
        if (width > 0 && height > 0) img = img.extract({ left, top, width, height });
      }
    }
    const w = args.width ? parseInt(args.width, 10) : null;
    const h = args.height ? parseInt(args.height, 10) : null;
    if (w || h) {
      const fit = ['cover', 'contain', 'fill', 'inside', 'outside'].includes(args.crop) ? args.crop : 'cover';
      img = img.resize({ width: w || null, height: h || null, fit, withoutEnlargement: false });
    }
    if (args.grayscale) img = img.grayscale();
    const fmt = ['png', 'jpeg', 'jpg', 'webp'].includes(String(args.format || '').toLowerCase())
      ? String(args.format).toLowerCase().replace('jpg', 'jpeg') : 'png';
    if (fmt === 'png') img = img.png({ compressionLevel: 9 });
    else if (fmt === 'jpeg') img = img.jpeg({ quality: 88 });
    else if (fmt === 'webp') img = img.webp({ quality: 88 });
    const out = await img.toBuffer();
    return { buffer: out, ext: fmt === 'jpeg' ? 'jpg' : fmt, mime: `image/${fmt}` };
  } catch (_) {
    return { buffer, ext: 'png', mime: 'image/png' };
  }
}

async function hostOnCloudinary(buffer, mime) {
  try {
    const cloudinary = require('./cloudinary');
    if (!buffer || !buffer.length) return null;
    const out = await cloudinary.uploadBuffer(buffer, { mime, resourceType: 'image', folder: 'wormgpt/web_image', tags: ['web_image'] });
    return out && out.url ? out.url : null;
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// The tool entrypoint. Wired into agentEngine's dispatcher.
// ─────────────────────────────────────────────────────────────────────────────
async function toolWebImage(args = {}, ctx = {}) {
  const onStep = typeof ctx.onStep === 'function' ? ctx.onStep : () => {};
  const wantHost = args.host !== false;
  const directUrl = (args.url || '').trim();
  const query = (args.query || '').trim();

  if (!directUrl && !query) {
    return '[web_image] Provide either {"query":"what to find online"} or {"url":"https://direct-image-url"}. Optional: width, height, crop ("cover"|"contain"), crop_box {left,top,width,height}, grayscale, format ("png"|"jpeg"|"webp"), filename, count.';
  }

  // Gather candidate image sources.
  let candidates = [];
  if (directUrl) {
    candidates = [{ image: directUrl }];
  } else {
    onStep(`🔎 searching the web for images: "${query}"…`);
    const results = await ddgImageSearch(query, Math.max(4, parseInt(args.count || 1, 10) + 3));
    if (!results.length) {
      return `[web_image] No images found online for "${query}". Try a simpler/more common query, or pass a direct {"url":"..."}.`;
    }
    candidates = results;
  }

  const wantCount = Math.max(1, Math.min(parseInt(args.count || 1, 10) || 1, 6));
  const baseName = _safe(args.filename || query || 'web_image', 'web_image').replace(/\.[^.]*$/, '');
  const staged = [];
  const lines = [];

  let idx = 0;
  for (const cand of candidates) {
    if (staged.length >= wantCount) break;
    const dl = await downloadImage(cand.image, cand.thumbnail);
    if (!dl) continue;
    onStep(`🖼️ processing image ${staged.length + 1}/${wantCount}…`);
    const t = await transformImage(dl.buffer, args);
    const nm = `${baseName}${wantCount > 1 ? '_' + (idx + 1) : ''}.${t.ext}`;
    try { await ctx.deliverBuffer(nm, t.buffer); } catch (e) { onStep(`(stage failed: ${e.message})`); continue; }
    let hosted = null;
    if (wantHost) { try { hosted = await hostOnCloudinary(t.buffer, t.mime); } catch (_) {} }
    staged.push({ name: nm, bytes: t.buffer.length, hosted, source: cand.source || cand.image });
    lines.push(
      `• ${nm} (${(t.buffer.length / 1024).toFixed(0)} KB)` +
      (hosted ? ` — hosted: ${hosted}` : '') +
      (cand.source ? ` — from ${String(cand.source).slice(0, 80)}` : ''),
    );
    idx++;
  }

  if (!staged.length) {
    return `[web_image] Found candidate(s) but could not download/process a usable image${query ? ` for "${query}"` : ''}. Try a different query or a direct URL.`;
  }

  const first = staged[0];
  const embedHint =
    `\n\nTO EMBED: reference "${first.name}" directly — e.g. create_pdf({html:'<img src="${first.name}" style="max-width:100%">…'}), ` +
    `create_pptx with an image slide pointing at "${first.name}", or the documents tool. ` +
    (first.hosted ? `You can also use the hosted URL ${first.hosted} in HTML.` : '');

  return `[web_image] Staged ${staged.length} image(s) into the working dir and queued for delivery:\n${lines.join('\n')}${embedHint}`;
}

module.exports = { toolWebImage, ddgImageSearch, downloadImage, transformImage };
