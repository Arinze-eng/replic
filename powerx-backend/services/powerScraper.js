// HackerX v7 — Power Scraper (the "browser tool that works when others fail").
//
// A robust, dependency-light scraper ported from the Flutter app's built-in
// `browse` MCP tool (bluter_mcp_tools.py). It is the FINAL fallback in the
// agent's browser chain: when Browserless.io is down/out-of-units and the
// plain cheerio fetch is blocked or returns junk, this kicks in with several
// independent strategies so the agent can STILL read the page / get search
// results.
//
// Strategies (tried in order, first non-empty wins):
//   1. Direct fetch with a rotating pool of realistic browser User-Agents +
//      full browser headers (mirrors the app's in-app WebView request).
//   2. r.jina.ai reader proxy — a free, keyless "read this URL as clean text"
//      service that renders JS and bypasses many soft blocks. Used when the
//      direct fetch is blocked (403/429/empty) or yields too little text.
//   3. Smart HTML → readable-text extraction (cheerio, with a regex fallback)
//      identical in spirit to the app's `html` package parsing.
//
// For SEARCH it queries DuckDuckGo's HTML endpoint (no API key, very tolerant)
// and falls back to Bing — both parsed with cheerio.
//
// ZERO new dependencies: reuses `node-fetch` + `cheerio` already in package.json.
// Every function is defensive and NEVER throws to the caller — on total
// failure it returns a structured `{ error }` object so the fallback chain in
// browserless.js can decide what to do next.

const fetch = require('node-fetch');
let cheerio = null;
try { cheerio = require('cheerio'); } catch (_) { /* regex fallback below */ }

// Rotating pool of realistic UAs (desktop + the app's Android WebView UA).
const _UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
function _pickUA(i) { return _UA_POOL[i % _UA_POOL.length]; }

function _normUrl(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

// Smart HTML → {title, description, text, links}. Uses cheerio when present,
// otherwise a regex stripper (mirrors the app's _strip_html fallback).
function _extract(html, baseUrl) {
  if (!html) return { title: '', description: '', text: '', links: [] };
  if (cheerio) {
    try {
      const $ = cheerio.load(html);
      const title = ($('title').first().text() || '').trim();
      const description = $('meta[name="description"]').attr('content')
        || $('meta[property="og:description"]').attr('content') || '';
      $('script, style, noscript, svg, nav, footer, header, aside, iframe, form').remove();
      let text = ($('main').text() || $('article').text() || $('body').text() || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim();
      const links = [];
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const t = $(el).text().trim().slice(0, 80);
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const full = href.startsWith('http') ? href : new URL(href, baseUrl).href;
            links.push({ text: t, href: full });
          } catch (_) {}
        }
      });
      return { title, description, text, links: links.slice(0, 25) };
    } catch (_) { /* fall through to regex */ }
  }
  // Regex fallback (no cheerio).
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? tm[1].replace(/\s+/g, ' ').trim() : '';
  let text = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title, description: '', text, links: [] };
}

// One direct HTTP fetch attempt. Returns { ok, status, html } (never throws).
async function _fetchOnce(url, uaIndex, timeoutMs) {
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      timeout: timeoutMs,
      headers: {
        'User-Agent': _pickUA(uaIndex),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const status = resp.status;
    let html = '';
    try { html = await resp.text(); } catch (_) {}
    return { ok: resp.ok, status, html };
  } catch (e) {
    return { ok: false, status: 0, html: '', error: e.message };
  }
}

// r.jina.ai reader proxy — keyless "read this URL as clean text". Great at
// bypassing soft blocks & rendering JS. Returns plain text (never throws).
async function _jinaReader(url, timeoutMs) {
  try {
    const proxied = 'https://r.jina.ai/' + url; // accepts the full http(s):// URL
    const resp = await fetch(proxied, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': _pickUA(0),
        'Accept': 'text/plain, text/markdown, */*',
        'X-Return-Format': 'text',
      },
    });
    if (!resp.ok) return '';
    const txt = await resp.text();
    return (txt || '').trim();
  } catch (_) { return ''; }
}

// Heuristic: does this look like a block / error / anti-bot interstitial rather
// than the real page content? Used to force escalation to the reader proxy even
// when the block page itself has >80 chars of "error" text.
function _looksBlocked(status, ex) {
  if (status === 403 || status === 429 || status === 503 || status === 401) return true;
  const t = ((ex && ex.title) || '').toLowerCase();
  const b = ((ex && ex.text) || '').toLowerCase().slice(0, 600);
  const needles = [
    'too many req', 'rate limit', 'access denied', 'forbidden',
    'just a moment', 'attention required', 'verify you are human',
    'enable javascript', 'captcha', 'are you a robot', 'request blocked',
    'cloudflare', 'wikimedia error', 'unusual traffic',
  ];
  return needles.some(n => t.includes(n) || b.includes(n));
}

/**
 * Scrape a URL with the multi-strategy power scraper.
 * Returns { url, status, title, description, content, text, links, length,
 *           truncated, source } or { url, error }.
 */
async function browse(url, { maxChars = 8000, timeout = 30000 } = {}) {
  const target = _normUrl(url);
  if (!target) return { url, error: 'no url' };

  // ── Strategy 1: direct fetch, rotating UA (up to 2 tries) ────────────────
  let best = null;
  let blocked = false;
  for (let i = 0; i < 2; i++) {
    const r = await _fetchOnce(target, i, timeout);
    if (r.html) {
      const ex = _extract(r.html, target);
      const isBlock = _looksBlocked(r.status, ex);
      if (!isBlock && ex.text && ex.text.length >= 80) {
        best = { ...ex, status: r.status, source: 'direct' };
        break;
      }
      if (isBlock) blocked = true;
      // keep the longest partial result as a candidate (only if not already a
      // clean success) so we have SOMETHING if every strategy fails.
      if (!best || (ex.text || '').length > (best.text || '').length) {
        best = { ...ex, status: r.status, source: 'direct', _block: isBlock };
      }
    } else { blocked = true; }
    // Hard block / empty → try the next UA, then the reader proxy.
    if (r.status === 403 || r.status === 429 || r.status === 503) { blocked = true; break; }
  }

  const needEscalation =
    blocked ||
    !best || !best.text || best.text.length < 200 || best._block === true;

  // ── Strategy 2: r.jina.ai reader proxy (render + de-block) ───────────────
  if (needEscalation) {
    const reader = await _jinaReader(target, timeout);
    // Use jina when it returns meaningful content AND (we were blocked OR jina
    // simply has more real text than the direct candidate).
    const directLen = (best && !best._block && best.text) ? best.text.length : 0;
    if (reader && reader.length > 80 && reader.length >= directLen) {
      const firstLine = (reader.split('\n').find(l => l.trim().length > 0) || '').trim();
      best = {
        title: (best && !best._block && best.title) || firstLine.replace(/^#+\s*/, '').slice(0, 200),
        description: (best && !best._block && best.description) || '',
        text: reader,
        links: (best && !best._block && best.links) || [],
        status: 200,
        source: 'jina',
      };
    }
  }

  // If all we have is a block/error page, report it as an error so the caller
  // (and the agent) can escalate to run_code / an alternate source.
  if (!best || !best.text || best._block === true) {
    return { url: target, error: 'all strategies returned no readable content (page blocked or empty)' };
  }

  const text = best.text;
  const truncated = text.length > maxChars;
  let content = '';
  if (best.title) content += `# ${best.title}\n\n`;
  if (best.description) content += `Description: ${best.description}\n\n`;
  content += text.slice(0, maxChars);
  if (Array.isArray(best.links) && best.links.length) {
    content += '\n\n--- Links ---\n';
    best.links.slice(0, 20).forEach(l => { if (l.text || l.href) content += `- ${l.text || ''}: ${l.href}\n`; });
  }

  return {
    url: target,
    status: best.status || 200,
    title: best.title || '',
    description: best.description || '',
    content,
    text: text.slice(0, maxChars),
    links: best.links || [],
    length: text.length,
    truncated,
    source: best.source,
  };
}

// ── SEARCH: DuckDuckGo HTML (keyless, tolerant) → Bing fallback ────────────
async function _ddgSearch(query, timeout) {
  try {
    const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await _fetchOnce(u, 0, timeout);
    if (!r.html || !cheerio) return '';
    const $ = cheerio.load(r.html);
    let out = '';
    $('.result').slice(0, 8).each((i, el) => {
      const title = $(el).find('.result__a').first().text().trim();
      const snippet = $(el).find('.result__snippet').first().text().trim();
      if (title) out += `- ${title}\n`;
      if (snippet) out += `  ${snippet}\n\n`;
    });
    return out.trim();
  } catch (_) { return ''; }
}

async function _bingSearch(query, timeout) {
  try {
    const u = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`;
    const r = await _fetchOnce(u, 1, timeout);
    if (!r.html || !cheerio) return '';
    const $ = cheerio.load(r.html);
    let out = '';
    $('.b_algo').slice(0, 8).each((i, el) => {
      const title = $(el).find('h2 a').text().trim();
      const snippet = $(el).find('.b_caption p').text().trim();
      if (title) out += `- ${title}\n`;
      if (snippet) out += `  ${snippet}\n\n`;
    });
    return out.trim();
  } catch (_) { return ''; }
}

/**
 * Web search via the power scraper. DuckDuckGo first (most tolerant), then Bing.
 * Returns a plain string of results, or '' if nothing worked.
 */
async function search(query, { timeout = 20000 } = {}) {
  if (!query) return '';
  const ddg = await _ddgSearch(query, timeout);
  if (ddg && ddg.length > 40) return ddg;
  const bing = await _bingSearch(query, timeout);
  return bing || ddg || '';
}

module.exports = { browse, search, _extract, _normUrl };
