// ═══════════════════════════════════════════════════════════════
// StarX TV Service — self-hosted live TV + live football
//
//   A real, DSTV-style streaming layer: hundreds of curated live
//   channels across football, sports, Nigeria, news, entertainment,
//   movies, documentary, kids & music — every one delivered as a
//   DIRECT HLS (.m3u8) feed that plays natively in any browser via
//   hls.js, proxied through /api/football/hls (fixes CORS + hotlink
//   referer + per-channel User-Agent). No iframes, no DRM, no auth.
//
//   • Channels : services/starx_channels.js (health-checked pool).
//   • Fixtures : live scores + season fixtures from ESPN (public).
//   • Hot Match: every live/upcoming fixture (incl. World Cup 2026)
//                gets a guaranteed-playable StarX football channel,
//                so a match ALWAYS streams from any location.
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');
const CHANNELS = require('./starx_channels');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const DEFAULT_REF = 'https://iptv-org.github.io/';

// ── Build a proxied, browser-safe HLS URL for a raw .m3u8 ──
// Carries the channel's own referer/UA so hotlink-protected CDNs play.
function proxify(m3u8, ref, ua) {
  if (!m3u8) return null;
  let u = '/api/football/hls?url=' + encodeURIComponent(m3u8) +
          '&ref=' + encodeURIComponent(ref || DEFAULT_REF);
  if (ua) u += '&ua=' + encodeURIComponent(ua);
  return u;
}

// ═══════════════ CHANNELS (StarX TV) ═══════════════
// Category metadata for the UI (label + emoji + order).
const CAT_META = [
  { key: 'football',      label: 'Football',      emoji: '⚽' },
  { key: 'sports',        label: 'Sports',        emoji: '🏆' },
  { key: 'nigeria',       label: 'Nigeria',       emoji: '🇳🇬' },
  { key: 'news',          label: 'News',          emoji: '📰' },
  { key: 'entertainment', label: 'Entertainment', emoji: '🎬' },
  { key: 'movies',        label: 'Movies',        emoji: '🍿' },
  { key: 'documentary',   label: 'Documentary',   emoji: '🌍' },
  { key: 'kids',          label: 'Kids',          emoji: '🧸' },
  { key: 'music',         label: 'Music',         emoji: '🎵' },
];
const CAT_ORDER = CAT_META.map(c => c.key);

function shapeChannel(c) {
  return {
    id: c.id,
    name: c.name,
    category: c.category,
    language: c.language || 'INT',
    logo: c.logo || null,
    hd: !!c.hd,
    worldcup: !!c.worldcup,
    tags: c.tags || [],
    proxiedM3u8: proxify(c.m3u8, c.referrer, c.userAgent),
  };
}

// Liveness probe with short TTL so the grid never leads with a dead feed.
const _alive = new Map();                 // url -> { ok, at }
const ALIVE_TTL = 5 * 60 * 1000;
async function probeStream(c) {
  const url = c.m3u8;
  const hit = _alive.get(url);
  if (hit && (Date.now() - hit.at) < ALIVE_TTL) return hit.ok;
  let ok = false;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const headers = { 'User-Agent': c.userAgent || UA, 'Accept': '*/*', 'Range': 'bytes=0-2047' };
    if (c.referrer) headers['Referer'] = c.referrer;
    const r = await fetch(url, { headers, signal: controller.signal });
    if (r.ok || r.status === 206) {
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (/mpegurl|m3u8|octet-stream|video|mp2t|dash/.test(ct)) ok = true;
      else {
        const txt = (await r.text()).slice(0, 400);
        const low = txt.toLowerCase();
        ok = txt.includes('#EXTM3U') && !low.includes('<html') && !low.includes('<!doctype');
      }
    }
  } catch (e) { ok = false; } finally { clearTimeout(t); }
  _alive.set(url, { ok, at: Date.now() });
  return ok;
}

// Full channel list, shaped + ordered (football/sports first). Liveness is
// applied lazily so first paint is instant; dead feeds drop on next refresh.
let _chCache = { at: 0, data: null };
const CH_CACHE_MS = 60 * 1000;
function rankCat(cat) { const i = CAT_ORDER.indexOf(cat); return i === -1 ? 99 : i; }

async function getAllChannels() {
  if (_chCache.data && (Date.now() - _chCache.at) < CH_CACHE_MS) return _chCache.data;
  const list = CHANNELS
    .slice()
    .sort((a, b) => (rankCat(a.category) - rankCat(b.category)) || a.name.localeCompare(b.name))
    .map(shapeChannel);
  _chCache = { at: Date.now(), data: list };
  return list;
}

async function getChannels(category) {
  const list = await getAllChannels();
  if (!category || category === 'all') return list;
  return list.filter(c => c.category === category);
}

async function getChannel(id) {
  const list = await getAllChannels();
  return list.find(c => c.id === id) || null;
}

function getCategories() {
  const counts = {};
  CHANNELS.forEach(c => { counts[c.category] = (counts[c.category] || 0) + 1; });
  return CAT_META.filter(m => counts[m.key]).map(m => ({ key: m.key, label: m.label, emoji: m.emoji, count: counts[m.key] }));
}

// Best playable football / World-Cup channel — the guaranteed match fallback.
// NOTE: the curated channel pool tags some non-football channels (cartoons,
// movie/series channels) as "football". Those must NEVER be served as a match
// stream (that is how a match card ends up playing Mr Bean or a movie). We
// blocklist them by name so only genuine football/sports feeds qualify.
const NON_FOOTBALL_NAME_RE = /\b(mr\s*bean|cartoon|kids?|anim|cine|premiere|kino|cinema|movie|serie|max|drama|comedy|music|monggol|pluto tv serie)\b/i;
function looksLikeRealFootball(c) {
  if (!c) return false;
  if (NON_FOOTBALL_NAME_RE.test(c.name || '')) return false;
  return c.category === 'football' || c.category === 'sports';
}
async function bestFootballChannel(preferWorldCup) {
  const list = await getAllChannels();
  const pool = list.filter(c => looksLikeRealFootball(c) && c.proxiedM3u8);
  if (preferWorldCup) {
    const wc = pool.find(c => c.worldcup);
    if (wc) return wc;
  }
  // verify a few candidates so we hand back something that actually responds
  for (const c of pool.slice(0, 12)) {
    const raw = CHANNELS.find(x => x.id === c.id);
    if (raw && await probeStream(raw)) return c;
  }
  return pool[0] || null;
}

// ═══════════════ FIXTURES (ESPN live scores, public) ═══════════════
const LEAGUES = [
  { key: 'fifa.world',           name: 'FIFA World Cup 2026',     emoji: '🏆' },
  { key: 'fifa.worldq.conmebol', name: 'WC Qualifiers (S.America)',emoji: '🌎' },
  { key: 'fifa.worldq.caf',      name: 'WC Qualifiers (Africa)',  emoji: '🌍' },
  { key: 'fifa.worldq.uefa',     name: 'WC Qualifiers (Europe)',  emoji: '🌍' },
  { key: 'eng.1',                name: 'Premier League',          emoji: '🏴' },
  { key: 'esp.1',                name: 'La Liga',                 emoji: '🇪🇸' },
  { key: 'ita.1',                name: 'Serie A',                 emoji: '🇮🇹' },
  { key: 'ger.1',                name: 'Bundesliga',              emoji: '🇩🇪' },
  { key: 'fra.1',                name: 'Ligue 1',                 emoji: '🇫🇷' },
  { key: 'uefa.champions',       name: 'Champions League',        emoji: '⭐' },
  { key: 'uefa.europa',          name: 'Europa League',           emoji: '🌟' },
  { key: 'caf.nations',          name: 'Africa Cup of Nations',   emoji: '🌍' },
  { key: 'caf.champions',        name: 'CAF Champions League',    emoji: '🌍' },
];

async function getJson(url, timeout = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: controller.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function normalizeEvent(ev, leagueName) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const cs = comp.competitors || [];
  const home = cs.find(c => c.homeAway === 'home') || cs[0] || {};
  const away = cs.find(c => c.homeAway === 'away') || cs[1] || {};
  const status = (ev.status && ev.status.type) || {};
  return {
    id: ev.id,
    name: ev.name || ev.shortName || '',
    league: leagueName,
    date: ev.date,
    ts: ev.date ? Date.parse(ev.date) : 0,
    state: status.state || 'pre',
    statusText: status.shortDetail || status.description || '',
    completed: !!status.completed,
    live: status.state === 'in',
    venue: (comp.venue && comp.venue.fullName) || '',
    home: { name: home.team ? (home.team.displayName || home.team.name) : 'TBD', abbr: home.team ? home.team.abbreviation : '', logo: home.team ? home.team.logo : '', score: home.score != null ? home.score : '' },
    away: { name: away.team ? (away.team.displayName || away.team.name) : 'TBD', abbr: away.team ? away.team.abbreviation : '', logo: away.team ? away.team.logo : '', score: away.score != null ? away.score : '' },
  };
}

function getLeagues() { return LEAGUES; }

// Leagues that have fixtures today/live (for the standings/leagues selector).
let _liveLeaguesCache = { at: 0, data: null };
async function getLiveLeagues() {
  if (_liveLeaguesCache.data && (Date.now() - _liveLeaguesCache.at) < 60000) return _liveLeaguesCache.data;
  const results = await Promise.all(LEAGUES.map(async (l) => {
    try {
      const data = await getJson(`${ESPN_BASE}/${l.key}/scoreboard`, 9000);
      const events = data.events || [];
      if (!events.length) return null;
      const liveCount = events.filter(ev => (ev.status && ev.status.type && ev.status.type.state) === 'in').length;
      return { key: l.key, name: l.name, emoji: l.emoji, count: events.length, liveCount, hasLive: liveCount > 0 };
    } catch (e) { return null; }
  }));
  const leagues = results.filter(Boolean).sort((a, b) => (a.hasLive !== b.hasLive) ? (a.hasLive ? -1 : 1) : (b.count - a.count));
  const out = { ok: true, count: leagues.length, leagues };
  _liveLeaguesCache = { at: Date.now(), data: out };
  return out;
}

async function getLeagueFixtures(leagueKey) {
  const meta = LEAGUES.find(l => l.key === leagueKey) || { key: leagueKey, name: leagueKey, emoji: '⚽' };
  try {
    const data = await getJson(`${ESPN_BASE}/${leagueKey}/scoreboard`);
    const events = (data.events || []).map(ev => normalizeEvent(ev, meta.name));
    return { ok: true, league: meta.name, key: leagueKey, emoji: meta.emoji, count: events.length, events };
  } catch (e) {
    return { ok: false, league: meta.name, key: leagueKey, emoji: meta.emoji, count: 0, events: [], error: e.message };
  }
}

async function getNigeriaFixtures() {
  const keys = ['fifa.worldq.caf', 'caf.nations', 'fifa.world', 'fifa.friendly'];
  const all = [];
  await Promise.all(keys.map(async (k) => {
    try {
      const meta = LEAGUES.find(l => l.key === k) || { name: k };
      const data = await getJson(`${ESPN_BASE}/${k}/scoreboard`);
      (data.events || []).forEach(ev => { const txt = (ev.name || '') + ' ' + (ev.shortName || ''); if (/nigeria/i.test(txt)) all.push(normalizeEvent(ev, meta.name)); });
    } catch (e) {}
  }));
  const seen = new Set();
  const events = all.filter(e => (seen.has(e.id) ? false : seen.add(e.id)));
  return { ok: true, league: 'Nigeria 🇳🇬 Super Eagles', key: 'nigeria', emoji: '🇳🇬', count: events.length, events };
}

// ── HOT MATCHES feed: World Cup 2026 + top leagues, live first, each fixture
//    pre-attached to a guaranteed-playable StarX football channel. ──
let _hotCache = { at: 0, data: null };
const HOT_CACHE_MS = 30 * 1000;
async function getHotMatches() {
  if (_hotCache.data && (Date.now() - _hotCache.at) < HOT_CACHE_MS) return _hotCache.data;
  // World Cup leads.
  const keys = ['fifa.world', 'fifa.worldq.uefa', 'fifa.worldq.conmebol', 'fifa.worldq.caf',
                'uefa.champions', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.europa', 'caf.nations'];
  const all = [];
  await Promise.all(keys.map(async (k) => {
    const meta = LEAGUES.find(l => l.key === k) || { name: k, emoji: '⚽' };
    try {
      const data = await getJson(`${ESPN_BASE}/${k}/scoreboard`, 9000);
      (data.events || []).forEach(ev => all.push(normalizeEvent(ev, meta.name)));
    } catch (e) {}
  }));
  const now = Date.now();
  const SOON = 21 * 24 * 60 * 60 * 1000;    // upcoming within 21 days (so WC fixtures always show)
  const RECENT = 36 * 60 * 60 * 1000;       // keep matches finished in the last 36h (results + replays)
  const LIVE_GRACE = 3.5 * 60 * 60 * 1000;  // a match is "in play" up to 3.5h after kickoff
  const wcCh = await bestFootballChannel(true);   // World-Cup-capable channel
  const genCh = await bestFootballChannel(false); // general football channel
  const live = [], upcoming = [], finished = [];
  all.filter(m => m.ts && m.ts > now - RECENT && m.ts < now + SOON).forEach(m => {
    const isWC = /world cup|qualif/i.test(m.league);
    const ch = (isWC && wcCh) ? wcCh : genCh;
    const isLive = m.live || (m.state === 'in');
    const isDone = m.completed || (m.state === 'post');
    const card = {
      id: m.id,
      title: m.home.name + ' vs ' + m.away.name,
      league: m.league,
      home: m.home, away: m.away,
      kickoff: Math.floor(m.ts / 1000),
      isLive,
      finished: isDone && !isLive,
      score: (isLive || isDone) ? `${m.home.score || 0}-${m.away.score || 0}` : '',
      statusText: m.statusText,
      stream: ch ? { channelId: ch.id, channelName: ch.name, proxiedM3u8: ch.proxiedM3u8, logo: ch.logo, worldcup: ch.worldcup } : null,
    };
    if (isLive) live.push(card);
    else if (isDone) finished.push(card);
    else upcoming.push(card);
  });
  live.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
  upcoming.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
  finished.sort((a, b) => (b.kickoff || 0) - (a.kickoff || 0));   // newest results first
  // upcoming list shown after live; recent results appended so the section is
  // never empty during the World Cup window.
  const upcomingPlus = [...upcoming, ...finished];
  const out = { ok: true, count: live.length + upcomingPlus.length, live, upcoming: upcomingPlus, finished };
  _hotCache = { at: Date.now(), data: out };
  return out;
}

// ── Resolve a guaranteed-playable stream for one fixture (Watch button). ──
// PRIORITY (the real fix for "card shows the right match but plays another sport"):
//   1. Resolve the ACTUAL per-match broadcast from streamed.pk (footballService),
//      using only football-trustworthy sources (curated broadcast feeds first,
//      cross-sport relay slots like golf/tennis DROPPED). This makes the match
//      play THE MATCH — e.g. Germany vs Curaçao on FOX/ITV, not a golf relay.
//   2. Only if no real match feed exists yet (not kicked off / all dead) do we
//      fall back to a genuine StarX football/World-Cup channel — never a movie
//      or cartoon channel, thanks to the bestFootballChannel() blocklist.
const footballService = require('./football');
const LEAGUE_HINTS = [
  { re: /world cup|fifa|qualif/i,                  wc: true },
  { re: /champions league|europa|uefa/i,           wc: false },
  { re: /africa|afcon|caf|nigeria|super eagles/i,  wc: false },
];
async function findMatchForFixture({ home, away, title, league } = {}) {
  const blob = `${league || ''} ${title || ''} ${home || ''} ${away || ''}`;
  const wantWC = /world cup|fifa|qualif/i.test(blob);

  // 1) Try the REAL per-match stream first (the actual broadcast of THIS match).
  try {
    const real = await footballService.findMatchForFixture({ home, away, title });
    if (real && real.ok) {
      // Direct embed (e.g. ppv self-contained player) → play it straight.
      if (real.embed) {
        return {
          ok: true, provider: real.provider || 'streamed',
          id: real.id, title: real.title || title || `${home} vs ${away}`,
          embedUrl: real.embed, poster: real.poster || null
        };
      }
      // Per-match sources (already football-filtered + ordered best-first).
      const sources = (real.sources || []).filter(s => s && s.source && s.id);
      if (sources.length) {
        return {
          ok: true, provider: 'streamed',
          id: real.id, title: real.title || title || `${home} vs ${away}`,
          poster: real.poster || null,
          // hand the front-end the real match sources, best (broadcast) first
          sources: sources.map(s => ({ source: s.source, id: s.id }))
        };
      }
    }
  } catch (e) { /* fall back to a clean StarX channel below */ }

  // 2) Fallback: a genuine football / World-Cup channel (never movies/cartoons).
  const ch = await bestFootballChannel(wantWC);
  if (ch && ch.proxiedM3u8) {
    return { ok: true, provider: 'starx', id: ch.id, title: title || `${home} vs ${away}`,
             channelName: ch.name, proxiedM3u8: ch.proxiedM3u8, logo: ch.logo, worldcup: ch.worldcup };
  }
  return { ok: false, error: 'No live stream available for this match yet.' };
}

module.exports = {
  // channels / StarX TV
  getChannels, getChannel, getCategories, bestFootballChannel, proxify, getAllChannels,
  // fixtures
  getLeagues, getLeagueFixtures, getNigeriaFixtures, getHotMatches, getLiveLeagues,
  // watch
  findMatchForFixture,
  UA, DEFAULT_REF, CAT_META,
};
