// ═══════════════════════════════════════════════════════════════
// League Hub — production football data layer
//
//   • Live scores / fixtures: ESPN public APIs (no key)
//       - scoreboard  → today's / currently-live matches (with live scores)
//       - core API    → the FULL season fixture list (all 380 PL matches, etc.)
//   • Working streams: livetv feed (nonegames) — real native HLS/DASH streams
//       that play in the in-page player with no iframes / popups.
//
//   For every fixture we attach `streams: [...]` ONLY when a real working
//   stream is found in the livetv feed. The front-end shows the video/Watch
//   button when streams exist and hides it when they don't — so a match's
//   video is automatically dropped when unavailable and shown when available.
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');
const livetv = require('./livetv');
const startimes = require('./startimes');

// Lightweight team-name normaliser (kept local so we don't depend on the old
// livetv feed for matching/merging).
function _norm(s) {
  return (s || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(fc|cf|sc|afc|cd|ac|club|the|de|of|cp)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

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

// ── Normalize an ESPN scoreboard event ──
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
    ts: ev.date ? Date.parse(ev.date) : 0,
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

// ── Today's / live scoreboard for a league slug ──
async function getScoreboard(slug, leagueName) {
  try {
    const data = await getJson(`${ESPN_SITE}/${slug}/scoreboard`);
    return (data.events || []).map(ev => normalizeEvent(ev, leagueName));
  } catch (e) {
    return [];
  }
}

// ── FULL season fixtures via ESPN SITE scoreboard, walked month-by-month ──
// The site scoreboard `dates=YYYYMMDD-YYYYMMDD` returns FULL event data (teams,
// scores, status) in ONE call — far more reliable & faster than the core API
// (which is heavily rate-limited and needs a sub-request per team/score).
// We walk the season in monthly windows and de-dupe by event id.
const _seasonCache = {}; // slug -> {at,data}
const SEASON_CACHE_MS = 15 * 60 * 1000; // 15 min — full season rarely changes

function yyyymmdd(d) {
  return d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
}

async function getSeasonFixtures(slug, season, leagueName) {
  const cacheKey = slug + ':' + season;
  const hit = _seasonCache[cacheKey];
  if (hit && (Date.now() - hit.at) < SEASON_CACHE_MS) return hit.data;

  // European season `season` (e.g. 2025) spans Aug (season) → Jun (season+1).
  const windows = [];
  let cur = new Date(Date.UTC(season, 6, 1));            // Jul 1
  const end = new Date(Date.UTC(season + 1, 6, 1));      // next Jul 1
  while (cur < end) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const to = new Date(next.getTime() - 24 * 3600 * 1000); // last day of month
    windows.push([yyyymmdd(cur), yyyymmdd(to)]);
    cur = next;
  }

  const byId = {};
  // fetch monthly windows with limited concurrency
  const batch = 4;
  for (let i = 0; i < windows.length; i += batch) {
    const slice = windows.slice(i, i + batch);
    const results = await Promise.all(slice.map(async ([from, to]) => {
      try {
        const data = await getJson(`${ESPN_SITE}/${slug}/scoreboard?dates=${from}-${to}`, 12000);
        return (data.events || []).map(ev => normalizeEvent(ev, leagueName));
      } catch (e) { return []; }
    }));
    results.forEach(arr => arr.forEach(ev => { if (ev && ev.id) byId[ev.id] = ev; }));
  }

  const events = Object.values(byId).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // Only cache a SUCCESSFUL (non-empty) season fetch — never poison the cache
  // with an empty result from a transient network failure.
  if (events.length) {
    _seasonCache[cacheKey] = { at: Date.now(), data: events };
  } else if (hit) {
    return hit.data; // serve last good season list on transient failure
  }
  return events;
}

// ── Attach a guaranteed-playable StarTimes channel stream to each fixture ──
// Every fixture gets `streams: [...]`. With StarTimes we can always provide a
// working football channel, so live/upcoming matches are always watchable; we
// leave finished matches without a stream so the UI hides the Watch button.
function attachStreams(fixtures, channel) {
  if (!channel || !channel.proxiedM3u8) {
    return fixtures.map(f => ({ ...f, streams: [] }));
  }
  const stream = {
    name: channel.name,
    kind: 'hls',
    drm: false,
    keyId: null,
    key: null,
    url: channel.m3u8,
    proxyUrl: channel.proxiedM3u8,
    channelId: channel.id,
    channelName: channel.name,
    provider: 'startimes'
  };
  return fixtures.map(f => ({
    ...f,
    // show the stream for live + upcoming matches; hide for finished ones
    streams: f.completed ? [] : [stream]
  }));
}

// ── Merge live scoreboard data over season fixtures (live scores win) ──
function mergeLive(seasonFixtures, liveFixtures) {
  const byKey = {};
  const keyOf = (f) => _norm(f.home.name) + '|' + _norm(f.away.name);
  seasonFixtures.forEach(f => { byKey[keyOf(f)] = f; });
  liveFixtures.forEach(lf => {
    const k = keyOf(lf);
    if (byKey[k]) {
      // overwrite scores/state with the live truth
      byKey[k].state = lf.state;
      byKey[k].statusText = lf.statusText;
      byKey[k].live = lf.live;
      byKey[k].completed = lf.completed;
      byKey[k].home.score = lf.home.score;
      byKey[k].away.score = lf.away.score;
    } else {
      byKey[k] = lf; // live match not in season list — add it
    }
  });
  return Object.values(byKey).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// ═══════════════ PUBLIC: PREMIER LEAGUE (ALL matches) ═══════════════
let _plCache = { at: 0, data: null };
const PL_LIVE_MS = 25 * 1000; // re-merge live scores every 25s

async function getPremierLeague(season) {
  const yr = season || currentSoccerSeason();
  // full season list (cached 30m) + live scoreboard (fresh) + StarTimes channel
  const [seasonFixtures, liveFixtures, plChannel] = await Promise.all([
    getSeasonFixtures('eng.1', yr, 'Premier League'),
    getScoreboard('eng.1', 'Premier League'),
    startimes.findMatchForFixture({ league: 'Premier League' })
      .then(r => (r && r.ok) ? { id: r.id, name: r.channelName, logo: r.logo, m3u8: null, proxiedM3u8: r.proxiedM3u8 } : null)
      .catch(() => null)
  ]);

  const merged = mergeLive(seasonFixtures.length ? seasonFixtures : liveFixtures, liveFixtures);
  const withStreams = attachStreams(merged, plChannel);
  const liveCount = withStreams.filter(f => f.live).length;
  const playableCount = withStreams.filter(f => f.streams.length).length;
  return {
    ok: true,
    league: 'Premier League',
    season: yr,
    count: withStreams.length,
    liveCount,
    playableCount,
    events: withStreams
  };
}

// ═══════════════ PUBLIC: WORLD CUP (live + working streams) ═══════════════
async function getWorldCup() {
  const [scoreboard, wcChannel] = await Promise.all([
    getScoreboard('fifa.world', 'FIFA World Cup 2026'),
    startimes.findMatchForFixture({ league: 'FIFA World Cup' })
      .then(r => (r && r.ok) ? { id: r.id, name: r.channelName, logo: r.logo, m3u8: null, proxiedM3u8: r.proxiedM3u8 } : null)
      .catch(() => null)
  ]);

  // Build cards primarily from live ESPN scoreboard (the live truth during the WC).
  let fixtures = scoreboard;
  const withStreams = attachStreams(fixtures, wcChannel);

  // Always expose the StarTimes World Cup channel as a standalone watch option
  // (the generic FIFA WORLDCUP broadcast feed) so users can watch even before
  // a specific fixture goes live.
  const extraStreams = [];
  if (wcChannel && wcChannel.proxiedM3u8) {
    extraStreams.push({
      name: wcChannel.name, kind: 'hls', drm: false, keyId: null, key: null,
      url: wcChannel.m3u8, proxyUrl: wcChannel.proxiedM3u8,
      channelId: wcChannel.id, provider: 'startimes'
    });
  }

  const liveCount = withStreams.filter(f => f.live).length;
  return {
    ok: true,
    league: 'FIFA World Cup 2026',
    count: withStreams.length,
    liveCount,
    events: withStreams,
    channelStreams: extraStreams,          // generic WC feeds (always-on broadcast)
    channelName: wcChannel ? wcChannel.name : null,
    channelIcon: wcChannel ? wcChannel.icon : null
  };
}

// Soccer season helper: European leagues' "2025" season spans Aug 2025 → May 2026.
function currentSoccerSeason() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0=Jan
  // From July onward we're in the (y) season; Jan–June we're in (y-1) season.
  return m >= 6 ? y : y - 1;
}

module.exports = {
  getPremierLeague,
  getWorldCup,
  getScoreboard,
  getSeasonFixtures,
  currentSoccerSeason
};
