// ═══════════════════════════════════════════════════════════════
// Live TV Service — REAL working football streams
//   Source: nonegames.online live-football backend (the same feed the
//   "Live Football TV HD" Android app consumes).
//   The upstream `links` field is obfuscated; we decode it server-side:
//      hex string  →  nibble-swap each pair  →  hex→bytes  →  base64  →  JSON
//   Decoded payload = { links: [ { name, link, type } ] }
//   Each `link` is either:
//      "<manifest .mpd/.m3u8 url>"                       (clear)
//   or "<manifest url>*<keyId-hex>:<key-hex>"            (ClearKey DRM)
//   These play natively in any browser via Shaka Player (DASH + HLS + ClearKey),
//   so there are NO iframes, NO ad/popunder sandbox errors.
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

const UPSTREAM = 'https://nonegames.online/livefootballtvhd4/select.php';
const UA = 'okhttp/4.9.0';
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000; // refresh channel list every 60s

// ── Decode the obfuscated `links` blob ──
function decodeLinks(hexBlob) {
  if (!hexBlob || typeof hexBlob !== 'string') return null;
  try {
    // 1) swap each hex nibble pair: "AB" -> "BA"
    let swapped = '';
    for (let i = 0; i + 1 < hexBlob.length; i += 2) {
      swapped += hexBlob[i + 1] + hexBlob[i];
    }
    if (swapped.length % 2 === 1) swapped = swapped.slice(0, -1);
    // 2) hex -> bytes (latin1 string == base64 ascii)
    const b64 = Buffer.from(swapped, 'hex').toString('latin1');
    // 3) base64 -> utf8 JSON
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// ── Split "url*kid:key" into a structured stream descriptor ──
function parseStream(rawLink, name, type) {
  if (!rawLink) return null;
  let url = rawLink.trim();
  let keyId = null, key = null;
  const star = url.indexOf('*');
  if (star !== -1) {
    const drmPart = url.slice(star + 1);
    url = url.slice(0, star);
    const colon = drmPart.indexOf(':');
    if (colon !== -1) {
      keyId = drmPart.slice(0, colon).trim();
      key = drmPart.slice(colon + 1).trim();
    }
  }
  const lower = url.toLowerCase();
  let kind = 'other';
  if (lower.includes('.mpd')) kind = 'dash';
  else if (lower.includes('.m3u8')) kind = 'hls';
  else if (lower.includes('.mp4')) kind = 'mp4';
  return {
    name: name || 'Stream',
    url,
    kind,                       // dash | hls | mp4 | other
    drm: !!(keyId && key),
    keyId: keyId || null,
    key: key || null,
    raw: rawLink
  };
}

// ── Fetch + decode the full channel list ──
async function fetchChannels() {
  const now = Date.now();
  if (_cache.data && (now - _cache.at) < CACHE_MS) return _cache.data;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  let arr;
  try {
    const resp = await fetch(UPSTREAM, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('upstream HTTP ' + resp.status);
    arr = await resp.json();
  } finally {
    clearTimeout(t);
  }

  const channels = [];
  (Array.isArray(arr) ? arr : []).forEach(entry => {
    if (entry.visible && String(entry.visible) === '0') return;
    const decoded = decodeLinks(entry.links);
    if (!decoded || !Array.isArray(decoded.links)) return;
    const streams = decoded.links
      .map(l => parseStream(l.link, l.name, l.type))
      .filter(s => s && /^https?:\/\//i.test(s.url));
    if (!streams.length) return;
    // Order for INSTANT, reliable playback:
    //   1) clear HLS  2) clear DASH  3) DRM HLS  4) DRM DASH  5) other
    const rank = (s) => {
      if (!s.drm && s.kind === 'hls')  return 0;
      if (!s.drm && s.kind === 'dash') return 1;
      if (s.drm  && s.kind === 'hls')  return 2;
      if (s.drm  && s.kind === 'dash') return 3;
      return 4;
    };
    streams.sort((a, b) => rank(a) - rank(b));
    channels.push({
      id: entry.id,
      name: entry.name,
      icon: entry.icon || null,
      type: entry.type || 'internal',
      count: streams.length,
      streams
    });
  });

  const data = { ok: true, count: channels.length, channels, fetchedAt: now };
  _cache = { at: now, data };
  return data;
}

// ═══════════════ LIVENESS CHECK — drop dead stream URLs ═══════════════
// Aggregated stream URLs frequently go dead (404 / parked HTML / timeout).
// We probe each unique URL with a quick HEAD→GET and cache the verdict, then
// filter channels so only streams that actually respond are exposed. This is
// what guarantees "only leagues/channels that are live & working show up".
const _alive = new Map();            // url -> { ok, at }
const ALIVE_TTL = 90 * 1000;         // re-check a URL at most every 90s

async function probeStream(url) {
  const cached = _alive.get(url);
  if (cached && (Date.now() - cached.at) < ALIVE_TTL) return cached.ok;
  let ok = false;
  // DRM/.mpd manifests on some CDNs reject HEAD — use a tiny ranged GET and
  // only inspect status + that it isn't an HTML error page.
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': APP_UA, 'Accept': '*/*', 'Range': 'bytes=0-2047' },
      signal: controller.signal
    });
    if (resp.ok || resp.status === 206) {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (/mpegurl|m3u8|dash|octet-stream|video|mp2t|application\/xml/.test(ct)) {
        ok = true;
      } else {
        // Inspect a small chunk: real manifests start with #EXTM3U or <MPD/<?xml.
        const txt = (await resp.text()).slice(0, 400);
        const low = txt.toLowerCase();
        const html = low.includes('<!doctype') || low.includes('<html') || low.includes('<head');
        ok = (txt.includes('#EXTM3U') || low.includes('<mpd') || low.includes('<?xml')) && !html;
      }
    }
  } catch (e) {
    ok = false;
  } finally {
    clearTimeout(t);
  }
  _alive.set(url, { ok, at: Date.now() });
  return ok;
}

// Return the channel list with ONLY live/working streams; channels with no
// working stream left are dropped entirely.
let _liveCache = { at: 0, data: null };
const LIVE_CACHE_MS = 45 * 1000;

async function fetchLiveChannels() {
  if (_liveCache.data && (Date.now() - _liveCache.at) < LIVE_CACHE_MS) return _liveCache.data;
  const all = await fetchChannels();

  // Collect unique URLs and probe them with limited concurrency.
  const urls = [...new Set(all.channels.flatMap(c => c.streams.map(s => s.url)))];
  const BATCH = 12;
  for (let i = 0; i < urls.length; i += BATCH) {
    const slice = urls.slice(i, i + BATCH);
    await Promise.all(slice.map(u => probeStream(u)));
  }

  const channels = [];
  all.channels.forEach(c => {
    const live = c.streams.filter(s => {
      const v = _alive.get(s.url);
      return v && v.ok;
    });
    if (live.length) {
      channels.push({ ...c, streams: live, count: live.length });
    }
  });

  // If the probe wiped EVERYTHING out (e.g. our outbound network blocked), fall
  // back to the unfiltered list so the page never goes empty by mistake.
  const data = channels.length
    ? { ok: true, count: channels.length, channels, fetchedAt: Date.now(), filtered: true }
    : { ...all, filtered: false };
  _liveCache = { at: Date.now(), data };
  return data;
}

// ── Get one channel by id ──
async function getChannel(id) {
  const all = await fetchChannels();
  return all.channels.find(c => String(c.id) === String(id)) || null;
}

// ── Get a channel by fuzzy name match (e.g. "premier", "world cup") ──
async function findChannelByName(re) {
  const all = await fetchChannels();
  return all.channels.find(c => re.test(c.name || '')) || null;
}

// ── Normalise a team / fixture string for fuzzy matching ──
// We deliberately DO NOT strip distinguishing words like "united", "city",
// "forest", "albion" — those are exactly what separate "Nottingham Forest"
// from "Nottingham"-anything. We only strip generic club suffixes/articles.
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(fc|cf|sc|afc|cd|ac|club|the|de|of|cp)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a stream name like "Brighton vs Manchester SD" into [homeStr, awayStr].
function streamTeams(streamName) {
  // strip trailing quality tags (SD, HD, HD 2, FHD, 4K, etc.)
  let n = (streamName || '').replace(/\b(sd|hd|fhd|4k|uhd|h265|h264)\s*\d*\b/gi, ' ').trim();
  const parts = n.split(/\s+vs?\s+|\s+v\s+|\s+-\s+/i);
  return parts.map(p => normName(p)).filter(Boolean);
}

// Tokens (>=3 chars) of a name.
function tokens(s) {
  return normName(s).split(' ').filter(t => t.length >= 3);
}

// Fraction of `aTok` words that appear in the `bStr` blob (0..1).
function overlap(aTok, bStr) {
  if (!aTok.length) return 0;
  const hits = aTok.filter(t => bStr.includes(t)).length;
  return hits / aTok.length;
}

// ── Find streams (within a channel) that match a given fixture by team names ──
// POSITION-AWARE + STRICT to avoid false positives:
//   • Both teams must clearly match (strong word overlap on each side).
//   • Tries home↔streamHome / away↔streamAway first, then the swapped order.
// Returns the matched stream descriptors, best first.
function matchStreamsInChannel(channel, home, away) {
  if (!channel || !channel.streams) return [];
  const homeTok = tokens(home);
  const awayTok = tokens(away);
  if (!homeTok.length || !awayTok.length) return [];

  const MIN = 0.6; // require ≥60% of each team's words to be present

  const scored = channel.streams.map(s => {
    const teams = streamTeams(s.name);
    if (teams.length < 2) {
      // single-blob stream name — require BOTH teams present somewhere in it
      const blob = teams.join(' ');
      const h = overlap(homeTok, blob), a = overlap(awayTok, blob);
      const score = (h >= MIN && a >= MIN) ? 100 * (h + a) / 2 : 0;
      return { s, score };
    }
    const sHome = teams[0], sAway = teams.slice(1).join(' ');
    // straight orientation
    const straight = Math.min(overlap(homeTok, sHome), overlap(awayTok, sAway));
    // swapped orientation (feeds sometimes list away first)
    const swapped  = Math.min(overlap(homeTok, sAway), overlap(awayTok, sHome));
    const best = Math.max(straight, swapped);
    const score = best >= MIN ? 100 * best : 0;
    return { s, score };
  }).filter(x => x.score > 0);

  return scored.sort((a, b) => b.score - a.score).map(x => x.s);
}

module.exports = {
  fetchChannels, fetchLiveChannels, getChannel, findChannelByName, matchStreamsInChannel,
  normName, streamTeams, tokens, decodeLinks, parseStream, probeStream, UA, APP_UA
};
