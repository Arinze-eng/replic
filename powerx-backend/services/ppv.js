// ═══════════════════════════════════════════════════════════════
// PPV.to Service — secondary live stream source (reliable, JSON API)
//   • Endpoint: https://api.ppv.to/api/streams  (mirror: api.ppv.st)
//   • Returns categories → streams, each with a ready-to-play `iframe`
//     embed (self-contained Clappr + hls.js player, no framing blocks).
//   • We expose football matches with normalised fields matching the
//     streamed.pk shape the front-end already understands.
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PPV_BASES = ['https://api.ppv.to', 'https://api.ppv.st'];

async function getJson(url, timeout = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://ppv.to/' },
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } finally { clearTimeout(t); }
}

async function ppvFetch(path, timeout = 10000) {
  let lastErr;
  for (const base of PPV_BASES) {
    try { return await getJson(base + path, timeout); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('ppv unavailable');
}

let _cache = { ts: 0, data: null };
const CACHE_MS = 30000;

// Football-ish category names from ppv.to (it labels soccer as "Football").
const FOOTBALL_CAT = /^(football|soccer)$/i;

// Return normalised football matches: { id, title, category, date, isLive,
// poster, iframe, viewers, source:'ppv' }. `iframe` plays directly in-page.
async function getFootballMatches() {
  if (_cache.data && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;
  let out = [];
  try {
    const d = await ppvFetch('/api/streams');
    const cats = (d && d.streams) || [];
    const now = Date.now();
    cats.forEach(cat => {
      if (!FOOTBALL_CAT.test(cat.category || '')) return;
      (cat.streams || []).forEach(s => {
        if (!s || !s.iframe) return;
        const starts = (s.starts_at || 0) * 1000;
        const ends = (s.ends_at || 0) * 1000;
        const isLive = !!s.always_live || (starts && starts <= now && (!ends || ends > now));
        out.push({
          id: 'ppv-' + s.id,
          title: s.name || '',
          category: 'football',
          date: starts || null,
          ends: ends || null,
          isLive,
          alwaysLive: !!s.always_live,
          poster: s.poster || null,
          iframe: s.iframe,
          viewers: parseInt(s.viewers || '0', 10) || 0,
          source: 'ppv'
        });
      });
    });
  } catch (e) { /* return whatever we have */ }
  const result = { ok: true, count: out.length, matches: out };
  _cache = { ts: Date.now(), data: result };
  return result;
}

// Find the best ppv football match for a fixture by fuzzy team-name match.
function norm(s) {
  return (s || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(fc|cf|sc|afc|cd|ac|club|the|de|of)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(s) { return norm(s).split(' ').filter(t => t.length >= 3); }

async function findMatch({ home, away, title } = {}) {
  let matches = [];
  try { const r = await getFootballMatches(); matches = r.matches || []; } catch (e) {}
  const hT = tokens(home), aT = tokens(away);
  let best = null, bestScore = 0;
  for (const m of matches) {
    const mt = norm(m.title);
    let score = 0;
    const hHit = hT.length && hT.some(t => mt.includes(t));
    const aHit = aT.length && aT.some(t => mt.includes(t));
    if (hHit && aHit) score += 100; else if (hHit || aHit) score += 30;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (best && bestScore >= 100) return { ok: true, ...best };
  return { ok: false };
}

module.exports = { getFootballMatches, findMatch, UA };
