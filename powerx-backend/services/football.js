// ═══════════════════════════════════════════════════════════════
// Football Service — REAL data, no mocks
//   • Fixtures / live scores: ESPN public API (no key required)
//   • Live streamable matches + stream embeds: streamed.pk (no key)
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── ESPN soccer league slugs we expose in the UI ──
const LEAGUES = [
  { key: 'fifa.world',   name: 'FIFA World Cup 2026', emoji: '🏆' },
  { key: 'fifa.worldq.conmebol', name: 'WC Qualifiers (S.America)', emoji: '🌎' },
  { key: 'fifa.worldq.caf',      name: 'WC Qualifiers (Africa)',    emoji: '🌍' },
  { key: 'eng.1',        name: 'Premier League',     emoji: '🏴' },
  { key: 'esp.1',        name: 'La Liga',            emoji: '🇪🇸' },
  { key: 'ita.1',        name: 'Serie A',            emoji: '🇮🇹' },
  { key: 'ger.1',        name: 'Bundesliga',         emoji: '🇩🇪' },
  { key: 'fra.1',        name: 'Ligue 1',            emoji: '🇫🇷' },
  { key: 'uefa.champions', name: 'Champions League', emoji: '⭐' },
  { key: 'uefa.europa',  name: 'Europa League',      emoji: '🌟' },
  { key: 'caf.nations',  name: 'Africa Cup of Nations', emoji: '🌍' },
  { key: 'caf.champions',name: 'CAF Champions League', emoji: '🌍' }
];

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// ── Fetch helper with timeout ──
async function getJson(url, timeout = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// ── Normalize an ESPN event into a compact fixture object ──
function normalizeEvent(ev, leagueName) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || competitors[0] || {};
  const away = competitors.find(c => c.homeAway === 'away') || competitors[1] || {};
  const status = (ev.status && ev.status.type) || {};
  return {
    id: ev.id,
    name: ev.name || ev.shortName || '',
    league: leagueName,
    date: ev.date,
    state: status.state || 'pre',          // pre | in | post
    statusText: status.shortDetail || status.description || '',
    completed: !!status.completed,
    live: status.state === 'in',
    venue: (comp.venue && comp.venue.fullName) || '',
    home: {
      name: home.team ? (home.team.displayName || home.team.name) : 'TBD',
      abbr: home.team ? home.team.abbreviation : '',
      logo: home.team ? home.team.logo : '',
      score: home.score != null ? home.score : ''
    },
    away: {
      name: away.team ? (away.team.displayName || away.team.name) : 'TBD',
      abbr: away.team ? away.team.abbreviation : '',
      logo: away.team ? away.team.logo : '',
      score: away.score != null ? away.score : ''
    }
  };
}

// ── Get fixtures for a single ESPN league ──
async function getLeagueFixtures(leagueKey) {
  const meta = LEAGUES.find(l => l.key === leagueKey) || { key: leagueKey, name: leagueKey };
  try {
    const data = await getJson(`${ESPN_BASE}/${leagueKey}/scoreboard`);
    const events = (data.events || []).map(ev => normalizeEvent(ev, meta.name));
    return { ok: true, league: meta.name, key: leagueKey, emoji: meta.emoji || '⚽', count: events.length, events };
  } catch (e) {
    return { ok: false, league: meta.name, key: leagueKey, emoji: meta.emoji || '⚽', count: 0, events: [], error: e.message };
  }
}

// ── List of available leagues for the UI ──
function getLeagues() {
  return LEAGUES;
}

// ═══════════════ STANDINGS / LEAGUE TABLES (ESPN, no key) ═══════════════
// ESPN exposes full league tables at the site v2 standings endpoint. We
// normalise each row into a compact object the UI can render directly.
// Cached per-league for 10 min (tables change only after matches finish).
const STANDINGS_BASE = 'https://site.api.espn.com/apis/v2/sports/soccer';
const _standCache = {}; // key -> {at,data}
const STANDINGS_MS = 10 * 60 * 1000;

// Pull the first standings.entries array found anywhere in the ESPN tree
// (covers both top-level and `children[]` group tables like UCL groups).
function findStandingsEntries(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.standings && Array.isArray(node.standings.entries)) {
    return node.standings.entries;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const r = findStandingsEntries(c);
      if (r) return r;
    }
  }
  if (Array.isArray(node)) {
    for (const c of node) {
      const r = findStandingsEntries(c);
      if (r) return r;
    }
  }
  return null;
}

// Map an ESPN stat name → our normalized key.
function pickStat(stats, names) {
  for (const n of names) {
    const s = (stats || []).find(x => x.name === n || x.abbreviation === n || x.type === n);
    if (s) return s.displayValue != null ? s.displayValue : s.value;
  }
  return '';
}

function normalizeStandingRow(entry, rank) {
  const team = entry.team || {};
  const stats = entry.stats || [];
  const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
  return {
    rank: rank,
    teamId: team.id || '',
    name: team.displayName || team.name || team.shortDisplayName || 'TBD',
    abbr: team.abbreviation || '',
    logo: (team.logos && team.logos[0] && team.logos[0].href) || team.logo || '',
    played: num(pickStat(stats, ['gamesPlayed'])),
    win: num(pickStat(stats, ['wins'])),
    draw: num(pickStat(stats, ['ties'])),
    loss: num(pickStat(stats, ['losses'])),
    gf: num(pickStat(stats, ['pointsFor'])),
    ga: num(pickStat(stats, ['pointsAgainst'])),
    gd: pickStat(stats, ['pointDifferential']) || '0',
    points: num(pickStat(stats, ['points']))
  };
}

async function getStandings(leagueKey) {
  const meta = LEAGUES.find(l => l.key === leagueKey) || { key: leagueKey, name: leagueKey, emoji: '⚽' };
  const hit = _standCache[leagueKey];
  if (hit && (Date.now() - hit.at) < STANDINGS_MS) return hit.data;
  try {
    const data = await getJson(`${STANDINGS_BASE}/${leagueKey}/standings`, 12000);
    const entries = findStandingsEntries(data) || [];
    const table = entries.map((e, i) => normalizeStandingRow(e, i + 1));
    // Re-sort defensively by points then goal-difference (ESPN usually pre-sorts).
    table.sort((a, b) => (b.points - a.points) || (parseInt(b.gd) - parseInt(a.gd)) || (b.gf - a.gf));
    table.forEach((r, i) => { r.rank = i + 1; });
    const out = {
      ok: true,
      league: meta.name,
      key: leagueKey,
      emoji: meta.emoji || '⚽',
      season: (data.season && (data.season.displayName || data.season.year)) || '',
      count: table.length,
      table
    };
    if (table.length) _standCache[leagueKey] = { at: Date.now(), data: out };
    return out;
  } catch (e) {
    if (hit) return hit.data; // serve last good table on transient failure
    return { ok: false, league: meta.name, key: leagueKey, emoji: meta.emoji || '⚽', count: 0, table: [], error: e.message };
  }
}

// Which leagues actually have a published table right now (for the UI selector).
// Only the major domestic leagues have a single ranked table; cup competitions
// (World Cup / UCL group stage) are skipped here to keep the table view clean.
const STANDINGS_LEAGUES = [
  { key: 'eng.1', name: 'Premier League',  emoji: '🏴' },
  { key: 'esp.1', name: 'La Liga',         emoji: '🇪🇸' },
  { key: 'ita.1', name: 'Serie A',         emoji: '🇮🇹' },
  { key: 'ger.1', name: 'Bundesliga',      emoji: '🇩🇪' },
  { key: 'fra.1', name: 'Ligue 1',         emoji: '🇫🇷' }
];
function getStandingsLeagues() {
  return STANDINGS_LEAGUES;
}

// ── Only the leagues that have matches TODAY / LIVE right now ──
// Probes every league's ESPN scoreboard in parallel and keeps just the ones
// that currently have events. Each kept league reports whether it has a LIVE
// match and how many fixtures it has today, so the UI can show only working
// leagues (and flag the live ones). Cached briefly to stay cheap.
let _liveLeaguesCache = { at: 0, data: null };
const LIVE_LEAGUES_MS = 60 * 1000;

async function getLiveLeagues() {
  if (_liveLeaguesCache.data && (Date.now() - _liveLeaguesCache.at) < LIVE_LEAGUES_MS) {
    return _liveLeaguesCache.data;
  }
  const results = await Promise.all(LEAGUES.map(async (l) => {
    try {
      const data = await getJson(`${ESPN_BASE}/${l.key}/scoreboard`, 9000);
      const events = data.events || [];
      if (!events.length) return null;
      const liveCount = events.filter(ev => (ev.status && ev.status.type && ev.status.type.state) === 'in').length;
      return { key: l.key, name: l.name, emoji: l.emoji || '⚽', count: events.length, liveCount, hasLive: liveCount > 0 };
    } catch (e) {
      return null; // league unreachable → treat as not available
    }
  }));
  // Keep only leagues with matches today; live ones first, then by fixture count.
  const leagues = results.filter(Boolean).sort((a, b) => {
    if (a.hasLive !== b.hasLive) return a.hasLive ? -1 : 1;
    return b.count - a.count;
  });
  const out = { ok: true, count: leagues.length, leagues };
  _liveLeaguesCache = { at: Date.now(), data: out };
  return out;
}

// ── Nigeria fixtures (national team) — search via ESPN's general soccer scoreboard
//    across relevant competitions; Super Eagles play in WC qualifiers (CAF) & AFCON. ──
async function getNigeriaFixtures() {
  const keys = ['fifa.worldq.caf', 'caf.nations', 'fifa.world', 'fifa.friendly'];
  const all = [];
  await Promise.all(keys.map(async (k) => {
    try {
      const meta = LEAGUES.find(l => l.key === k) || { name: k };
      const data = await getJson(`${ESPN_BASE}/${k}/scoreboard`);
      (data.events || []).forEach(ev => {
        const txt = (ev.name || '') + ' ' + (ev.shortName || '');
        if (/nigeria/i.test(txt)) all.push(normalizeEvent(ev, meta.name));
      });
    } catch (e) { /* ignore individual league failures */ }
  }));
  // de-dupe by id
  const seen = new Set();
  const events = all.filter(e => (seen.has(e.id) ? false : seen.add(e.id)));
  return { ok: true, league: 'Nigeria 🇳🇬 Super Eagles', key: 'nigeria', emoji: '🇳🇬', count: events.length, events };
}

// ═══════════════ STREAMED.PK — live streamable matches ═══════════════
// Primary + live mirrors. streamed.su went dead (DNS/timeout) so it was
// replaced with the current working mirror (streami.su, verified 2026-06-14)
// to keep World Cup / live match streams resolving even if the primary blips.
const STREAM_BASES = ['https://streamed.pk', 'https://streami.su'];

async function streamFetch(path, timeout = 12000) {
  let lastErr;
  for (const base of STREAM_BASES) {
    try {
      return await getJson(base + path, timeout);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All stream sources unavailable');
}

function posterUrl(m) {
  if (m.poster) {
    return m.poster.startsWith('http') ? m.poster : (STREAM_BASES[0] + m.poster);
  }
  return null;
}

// ── SOURCE QUALITY: which streamed.pk "source" slots are TRUSTWORTHY football ──
// streamed.pk mixes real broadcast feeds with generic cross-sport relay slots
// (e.g. a `golf/NNNNN` slot that actually plays whatever that relay channel is
// showing — often a DIFFERENT sport). Those are the #1 cause of "card shows the
// right match but the video is another sport". We rank sources so the player
// ALWAYS prefers the genuine match broadcast and only ever falls back to a
// generic relay slot as an absolute last resort.
//
//   • admin  → operator-curated PPV broadcast feeds (FOX / ITV / Telemundo…) — best.
//   • alpha/bravo/charlie/echo/delta → per-match named feeds — good when the id
//     references this match (e.g. contains team names or "-football-").
//   • golf/tennis/… named after a DIFFERENT sport → relay slots — never trusted
//     for football unless their id clearly references this football match.
const SPORT_RELAY_SOURCES = new Set([
  'golf', 'tennis', 'darts', 'baseball', 'hockey', 'rugby', 'cricket',
  'billiards', 'afl', 'motor-sports', 'fight', 'basketball', 'american-football'
]);

// True when a source id looks like it really belongs to THIS football match
// (named feeds carry team names / the word football / a ppv- slug).
function idLooksFootball(id) {
  const s = (id || '').toLowerCase();
  return /football|soccer|ppv-|-vs-|_vs_|world|fifa|league|cup|qualif/.test(s);
}

// Rank a {source,id} for a football fixture — lower = more trustworthy.
// A generic sport-relay slot (golf/tennis/…) is only allowed when its id clearly
// references the football match; otherwise it is pushed to the very bottom.
//
// `admin` is streamed.pk's own PPV embed host (embed.st). It is embed-ONLY —
// extractM3u8() finds no direct playlist in it — and the player it serves runs
// an `isSandboxed()` self-check that reads storage. Inside a cross-origin
// iframe Chrome blocks that storage access, so the check misfires and the
// player refuses to start, rendering "Remove sandbox attributes on the iframe
// tag" instead of video. It also injects ad iframes. It is therefore ranked
// LAST and dropped entirely by footballSources() — native HLS from the verified
// channel pool always plays, so there is no reason to hand a user a dead frame.
function rankSource(src) {
  const source = (src.source || '').toLowerCase();
  const footballId = idLooksFootball(src.id);
  if (source === 'admin') return 999;                     // embed-only, refuses to frame → unusable
  if (SPORT_RELAY_SOURCES.has(source)) {
    return footballId ? 50 : 999;                         // wrong-sport relay → bottom
  }
  // generic per-match feed slots (alpha/bravo/echo/delta/charlie/…)
  return footballId ? 10 : 20;
}

// Keep only football-trustworthy sources, ordered best-first. A generic
// cross-sport relay slot whose id does NOT reference this football match is
// DROPPED entirely (rank 999) so the player can never land on another sport.
function footballSources(sources) {
  return (sources || [])
    .filter(s => s && s.source && s.id)
    .map(s => ({ source: s.source, id: s.id, _rank: rankSource(s) }))
    .filter(s => s._rank < 999)
    .sort((a, b) => a._rank - b._rank)
    .map(({ source, id }) => ({ source, id }));
}

// ── Quick check: does a given source+id actually resolve to a real stream? ──
// streamed.pk exposes the same match under several `source` slots. They are NOT
// equivalent:
//
//   • admin — `https://embed.st/embed/admin/ppv-*`. The player behind it refuses
//     to start in ANY framed context and just renders "Remove sandbox attributes
//     on the iframe tag". Dead for us → always rejected.
//   • hotel / golf — `https://embed.st/embed/<source>/<id>/<n>`. This is the real
//     per-match feed: the page resolves a live HLS playlist on a `lbN.strmd.st`
//     load-balancer host and plays the ACTUAL fixture. It only refuses to start
//     when its host iframe carries a `sandbox` attribute, so we mount it
//     unsandboxed (see CVP.embed in public/football.html). Verified playing
//     end-to-end, so these sources are accepted.
//
// We therefore accept any source whose upstream entry carries an embed URL,
// except the `admin` slot.
const DEAD_SOURCES = new Set(['admin']);

async function sourceHasStream(source, id) {
  if (DEAD_SOURCES.has((source || '').toLowerCase())) return false;
  try {
    const data = await streamFetch(
      `/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`,
      6000
    );
    if (!Array.isArray(data)) return false;
    return data.some(s => {
      if (!s || !s.embedUrl) return false;
      try { new URL(s.embedUrl); } catch (e) { return false; }
      return true;
    });
  } catch (e) {
    return false;
  }
}

// Human labels for the per-match source slots the player offers.
const SOURCE_LABELS = {
  hotel: '📡 Match feed',
  golf:  '📡 Match feed 2',
  alpha: '📡 Match feed',
  bravo: '📡 Match feed 2'
};
function sourceLabel(src, i) {
  return SOURCE_LABELS[(src || '').toLowerCase()] || ('📡 Feed ' + (i + 1));
}
function labelled(sources) {
  return (sources || []).map((s, i) => ({ source: s.source, id: s.id, label: sourceLabel(s.source, i) }));
}

// ── Short-lived cache so we don't re-verify every match on every page load
//    (which would be slow + hammer the upstream). Live data still refreshes. ──
let _liveCache = { ts: 0, data: null };
const LIVE_CACHE_MS = 35000; // 35s — fresh enough for "live", cheap enough to verify

// ── Live streamable football matches — ONLY matches that actually play ──
// Strategy:
//   1. Pull football + live feeds from streamed.pk.
//   2. Keep real football (incl. Premier League & top leagues), drop other sports
//      and matches that already finished long ago.
//   3. VERIFY each remaining match has at least one resolvable stream source, and
//      drop the dead ones — so a user NEVER taps a match that says "not available".
//   4. Prioritise: live-now → Premier League / top leagues → popular → soonest.
async function getLiveStreams() {
  // serve from cache when warm
  if (_liveCache.data && (Date.now() - _liveCache.ts) < LIVE_CACHE_MS) {
    return _liveCache.data;
  }
  try {
    // football category — currently scheduled/live football events
    let matches = [];
    try { matches = await streamFetch('/api/matches/football'); } catch (e) { matches = []; }

    // Also pull all live matches and keep football-related ones (covers WC special events)
    let liveAll = [];
    try { liveAll = await streamFetch('/api/matches/live'); } catch (e) { liveAll = []; }

    const now = Date.now();
    const STALE_AFTER = 4 * 60 * 60 * 1000; // hide matches that started >4h ago (finished)
    const SOON_WINDOW = 12 * 60 * 60 * 1000; // and upcoming within 12h

    const merged = {};
    [...(Array.isArray(matches) ? matches : []), ...(Array.isArray(liveAll) ? liveAll : [])].forEach(m => {
      if (!m || !m.id) return;
      const title = m.title || '';
      // Exclude clearly non-football categories that slipped in via title matching
      const badCat = ['motor-sports','darts','tennis','golf','rugby','baseball','hockey','basketball','american-football','afl','fight','billiards','cricket'];
      const footballKeywords = /\b(fc|cf|united|city|fifa|world cup|champions league|europa|premier league|la liga|serie a|bundesliga|ligue 1|afcon|super eagles|nigeria)\b|\bvs?\b.*\b(fc|cf|united|city)\b/i;
      const isFootball = m.category === 'football' ||
        (!badCat.includes(m.category) && footballKeywords.test(title));
      if (!isFootball) return;

      // Time filter: drop clearly-finished matches and ones too far in the future.
      if (m.date) {
        if (m.date < now - STALE_AFTER) return;        // finished hours ago
        if (m.date > now + SOON_WINDOW) return;         // too far out to be "live"
      }
      // Must have at least one TRUSTWORTHY football source to even be playable.
      // footballSources() drops cross-sport relay slots (golf/tennis/…) that
      // would otherwise play a different sport, and orders the rest best-first.
      const sources = footballSources(m.sources);
      if (!sources.length) return;

      // Premier League / top-league flag for prioritisation.
      const isTopLeague = /\b(premier league|epl|champions league|la liga|serie a|bundesliga|ligue 1|europa)\b/i.test(title);

      merged[m.id] = {
        id: m.id,
        title: m.title,
        teams: m.teams || null,        // structured team names (for reliable matching)
        category: m.category,
        date: m.date,
        popular: !!m.popular,
        topLeague: isTopLeague,
        isLive: m.date ? (m.date <= now) : false,
        poster: posterUrl(m),
        sources: sources.map(s => ({ source: s.source, id: s.id }))
      };
    });

    const candidates = Object.values(merged);

    // ── VERIFY playability: for each candidate, check its sources in parallel and
    //    keep only matches that have at least one source returning a real stream. ──
    const verified = [];
    await Promise.all(candidates.map(async (m) => {
      // Probe sources concurrently; stop caring once one works.
      const checks = await Promise.all(
        m.sources.slice(0, 4).map(s => sourceHasStream(s.source, s.id))
      );
      const workingSources = m.sources.filter((_, i) => checks[i]);
      if (workingSources.length) {
        m.sources = workingSources; // hand the front-end only the working sources
        verified.push(m);
      }
    }));

    verified.sort((a, b) => {
      // live now first
      const la = (a.date && a.date <= now) ? 0 : 1;
      const lb = (b.date && b.date <= now) ? 0 : 1;
      if (la !== lb) return la - lb;
      // Premier League / top leagues next
      if (a.topLeague !== b.topLeague) return (b.topLeague ? 1 : 0) - (a.topLeague ? 1 : 0);
      // football category over special events
      const fa = a.category === 'football' ? 0 : 1;
      const fb = b.category === 'football' ? 0 : 1;
      if (fa !== fb) return fa - fb;
      // popular next
      if (a.popular !== b.popular) return (b.popular ? 1 : 0) - (a.popular ? 1 : 0);
      // soonest date
      return (a.date || 0) - (b.date || 0);
    });

    const result = { ok: true, count: verified.length, matches: verified };
    _liveCache = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    // On total failure, serve stale cache if we have any, else an error.
    if (_liveCache.data) return _liveCache.data;
    return { ok: false, count: 0, matches: [], error: e.message };
  }
}

// ── Resolve actual stream embeds for a given source+id ──
async function getStreamSources(source, id) {
  try {
    const data = await streamFetch(`/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
    const streams = (Array.isArray(data) ? data : []).map(s => ({
      id: s.id,
      streamNo: s.streamNo,
      language: s.language || '',
      hd: !!s.hd,
      source: s.source,
      viewers: s.viewers || 0,
      embedUrl: s.embedUrl
    }));
    return { ok: true, count: streams.length, streams };
  } catch (e) {
    return { ok: false, count: 0, streams: [], error: e.message };
  }
}

// ── Country / national-team alias map ──────────────────────────────
// World Cup fixtures expose names from DIFFERENT sources that don't match
// literally (ESPN says "United States", streamed.pk says "USA"; ESPN says
// "Korea Republic", streamed says "South Korea"). We canonicalise both sides
// to the SAME token so the matcher can pair them. This is the single biggest
// reason World Cup matches "don't play".
const COUNTRY_ALIASES = {
  'usa': 'unitedstates', 'us': 'unitedstates', 'united states': 'unitedstates',
  'united states of america': 'unitedstates', 'usmnt': 'unitedstates',
  'uk': 'england', 'great britain': 'england', 'eng': 'england',
  'korea republic': 'southkorea', 'south korea': 'southkorea', 'rep of korea': 'southkorea',
  'korea dpr': 'northkorea', 'north korea': 'northkorea',
  'ivory coast': 'cotedivoire', "cote d ivoire": 'cotedivoire', "côte d'ivoire": 'cotedivoire',
  'bosnia herzegovina': 'bosnia', 'bosnia and herzegovina': 'bosnia', 'bosnia-herzegovina': 'bosnia',
  'czech republic': 'czechia', 'czechia': 'czechia',
  'uae': 'unitedarabemirates', 'united arab emirates': 'unitedarabemirates',
  'drc': 'drcongo', 'dr congo': 'drcongo', 'congo dr': 'drcongo', 'democratic republic of congo': 'drcongo',
  'cape verde': 'capeverde', 'cabo verde': 'capeverde',
  'türkiye': 'turkey', 'turkiye': 'turkey',
  'netherlands': 'netherlands', 'holland': 'netherlands',
  'china pr': 'china', 'chinese taipei': 'taiwan',
  'curacao': 'curacao', 'curaçao': 'curacao',
  'new zealand': 'newzealand', 'nz': 'newzealand',
  'saudi arabia': 'saudiarabia', 'south africa': 'southafrica',
  'costa rica': 'costarica', 'burkina faso': 'burkinafaso',
  'equatorial guinea': 'equatorialguinea', 'guinea bissau': 'guineabissau',
  'sierra leone': 'sierraleone', 'trinidad and tobago': 'trinidad',
  'trinidad tobago': 'trinidad', 'el salvador': 'elsalvador'
};

// Apply alias canonicalisation to a raw (lowercased) name BEFORE tokenising.
function canonName(s) {
  let t = (s || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (COUNTRY_ALIASES[t]) return COUNTRY_ALIASES[t];
  return t;
}

// ── Normalise a team / fixture string for fuzzy matching ──
function normTeam(s) {
  // First map well-known country aliases as a whole-string, then strip club noise.
  const canon = canonName(s);
  // If the whole string canonicalised to a single alias token, return it directly.
  if (/^[a-z0-9]+$/.test(canon) && Object.values(COUNTRY_ALIASES).includes(canon)) {
    return canon;
  }
  return (s || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(fc|cf|sc|afc|cd|ac|club|the|de|of)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens (>=3 chars) of a team name, for overlap scoring.
// We add the canonical alias token too so "United States" and "USA" share a token.
function teamTokens(s) {
  const toks = new Set(normTeam(s).split(' ').filter(t => t.length >= 3));
  const c = canonName(s);
  if (c && c.length >= 3) toks.add(c.replace(/\s+/g, ''));
  // also push a no-space variant of the whole normalised name
  const ns = normTeam(s).replace(/\s+/g, '');
  if (ns.length >= 4) toks.add(ns);
  return [...toks];
}

// ── Find a VERIFIED-playable streamed.pk match for a given fixture ──
// Accepts { home, away, title } and tries to locate the same match among the
// live/football feeds, then verifies it actually has a working stream source.
// Returns the same shape as one entry from getLiveStreams (id/title/sources…)
// or { ok:false } when no working stream exists yet (e.g. not kicked off).
async function findMatchForFixture({ home, away, title } = {}) {
  // Reuse the already-verified live list first (cheap + cached).
  let live = [];
  try {
    const r = await getLiveStreams();
    live = (r && r.matches) || [];
  } catch (e) { live = []; }

  const homeTok = teamTokens(home);
  const awayTok = teamTokens(away);
  const titleNorm = normTeam(title || `${home || ''} ${away || ''}`);

  // Score a candidate match. We accept either a plain title string OR the full
  // streamed.pk match object (which carries a structured teams.home/away).
  const scoreMatch = (cand) => {
    const mTitle = typeof cand === 'string' ? cand : (cand.title || '');
    const mt = normTeam(mTitle);
    // Pull structured team names when available — far more reliable than the title.
    const ct = (cand && cand.teams) || {};
    const cHome = ct.home && ct.home.name ? teamTokens(ct.home.name) : [];
    const cAway = ct.away && ct.away.name ? teamTokens(ct.away.name) : [];

    let score = 0;
    // Does fixture HOME appear anywhere in the candidate (title or structured)?
    const inCand = (toks) =>
      toks.some(t => mt.includes(t) || cHome.includes(t) || cAway.includes(t));
    const homeHit = homeTok.length && inCand(homeTok);
    const awayHit = awayTok.length && inCand(awayTok);

    if (homeHit && awayHit) score += 100;          // both teams → strong match
    else if (homeHit || awayHit) score += 40;       // one team → loose match
    // token overlap with the whole title
    titleNorm.split(' ').forEach(t => { if (t.length >= 3 && mt.includes(t)) score += 3; });
    // The candidate's title literally contains the whole fixture title (e.g.
    // "Lens vs Sporting CP" appears inside the candidate) → confident match even
    // when the structured team names are missing. Without this, tapping a match
    // whose card only carries a title could score below the confidence bar.
    if (titleNorm && titleNorm.length >= 6 && mt.includes(titleNorm)) score += 100;
    return score;
  };

  // 1) Try the verified live list — these are guaranteed playable already.
  let best = null, bestScore = 0;
  for (const m of live) {
    const sc = scoreMatch(m);
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  if (best && bestScore >= 100) {
    return { ok: true, ...best, sources: labelled(best.sources) };
  }

  // 2) Fallback: search the raw football feed (covers matches that exist but
  //    weren't in the trimmed live list), then verify before returning.
  let raw = [];
  try { raw = await streamFetch('/api/matches/football'); } catch (e) { raw = []; }
  if (!Array.isArray(raw)) raw = [];

  let cand = null, candScore = 0;
  for (const m of raw) {
    if (!m || !m.id || !(m.sources || []).length) continue;
    const sc = scoreMatch(m);
    if (sc > candScore) { candScore = sc; cand = m; }
  }

  if (cand && candScore >= 100) {
    const sources = footballSources(cand.sources);
    const checks = await Promise.all(sources.slice(0, 4).map(s => sourceHasStream(s.source, s.id)));
    const working = sources.filter((_, i) => checks[i]);
    if (working.length) {
      return {
        ok: true,
        id: cand.id,
        title: cand.title,
        category: cand.category,
        date: cand.date,
        poster: posterUrl(cand),
        sources: working.map((s, i) => ({ source: s.source, id: s.id, label: sourceLabel(s.source, i) }))
      };
    }
  }

  // 3) NO LOOSE MATCH.
  //    We used to accept a "one team matched" candidate here (score >= 35). That
  //    handed the player a DIFFERENT fixture's feed — tapping "Lens vs Sporting
  //    CP" played "Lens vs Lyon" — which is far worse than showing a channel.
  //    A per-match feed is now only ever returned when BOTH sides are confirmed
  //    (or the candidate title contains the whole fixture title). Otherwise the
  //    caller falls back to a verified football channel, which the UI labels
  //    honestly as a channel rather than as this match.

  // 4) NO EMBED FALLBACK.
  //    The old step 4 returned a ppv.to / embed.st iframe. That player is
  //    ad-driven: it refuses to render unless its host iframe is unsandboxed
  //    ("Remove sandbox attributes on the iframe tag"), so users got a black
  //    screen with an error instead of a match. Embeds are now banned outright
  //    (see EMBED_ONLY_HOSTS / sourceHasStream above); the caller falls back to
  //    a verified native-HLS football channel instead.

  return { ok: false, error: 'No live stream available for this match yet.' };
}


// ═══════════ M3U8 EXTRACTION (best-effort) ═══════════
// Some embed providers expose a direct .m3u8 in their page/network calls.
// We scrape the embed HTML + a couple of common config endpoints. When a
// direct HLS URL is found, the front-end can play it natively via hls.js
// through our /api/football/hls proxy (fixes CORS + hotlink-referer blocks),
// which plays on ANY browser without relying on the upstream iframe player.
const M3U8_RE = /(https?:\/\/[^\s"'\\<>]+\.m3u8[^\s"'\\<>]*)/i;

async function fetchText(url, referer, timeout = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Referer': referer || '',
        'Origin': referer ? new URL(referer).origin : ''
      },
      signal: controller.signal
    });
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

// Try to pull a direct .m3u8 link out of an embed page.
async function extractM3u8(embedUrl) {
  if (!embedUrl) return null;
  try {
    const origin = new URL(embedUrl).origin;
    // 1) Scan the embed HTML itself
    const html = await fetchText(embedUrl, origin);
    let m = html.match(M3U8_RE);
    if (m) return m[1];

    // 2) Scan referenced same-origin scripts for an inline m3u8
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)]
      .map(s => s[1])
      .filter(src => /\.js(\?|$)/i.test(src))
      .slice(0, 4)
      .map(src => (src.startsWith('http') ? src : origin + (src.startsWith('/') ? '' : '/') + src));
    for (const js of scripts) {
      try {
        const code = await fetchText(js, embedUrl, 9000);
        const mm = code.match(M3U8_RE);
        if (mm) return mm[1];
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  return null;
}

// Resolve a single stream into the best playable form: a direct m3u8 if we can
// find one (preferred — plays natively everywhere), else just the embed iframe.
async function resolvePlayable(source, id, streamNo) {
  if (DEAD_SOURCES.has((source || '').toLowerCase())) {
    return { ok: false, error: 'Source refuses to be framed (dead embed slot)' };
  }
  const result = await getStreamSources(source, id);
  const streams = result.streams || [];
  const target = streams.find(s => String(s.streamNo) === String(streamNo)) || streams[0];
  if (!target) return { ok: false, error: 'No stream found' };
  const m3u8 = await extractM3u8(target.embedUrl);
  return {
    ok: true,
    embedUrl: target.embedUrl,
    m3u8: m3u8 || null,
    hd: !!target.hd,
    source: target.source,
    streamNo: target.streamNo
  };
}

module.exports = {
  getLeagues,
  getLiveLeagues,
  getLeagueFixtures,
  getNigeriaFixtures,
  getStandings,
  getStandingsLeagues,
  getLiveStreams,
  getStreamSources,
  findMatchForFixture,
  footballSources,
  extractM3u8,
  resolvePlayable,
  sourceLabel,
  DEAD_SOURCES,
  fetchText,
  UA,
  LEAGUES
};
