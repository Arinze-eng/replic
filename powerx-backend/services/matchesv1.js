// ═══════════════════════════════════════════════════════════════
// Matches V1 Service — live football matches extracted from the
// LiveFootballTV Android app (com.livefootballtv.lfbtv_g).
//
//   Source chain reverse-engineered from the app's bundled DEX:
//     livemenu.json (apps.sportsbd.live)
//        └─ live.json
//             └─ server1check.bdixsports.live/all/app_allapp_football.php
//                  └─ footballxt.com/score/livematch.php   ← LIVE schedule
//                       └─ isportslive8.com/football/detail.html
//                            ?matchId=<id>&accessKey=<key>  ← match stream
//
//   livematch.php renders a Live + Upcoming match schedule (FIFA World Cup,
//   top leagues) where every match links to an iSports live-stream / animated
//   match view. We scrape that page server-side (cheerio), normalize it into
//   clean JSON, and expose it as /api/football/matchesv1 so the website can
//   list matches and play them in the in-page embed player.
// ═══════════════════════════════════════════════════════════════
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// Primary live-schedule page (resolved from the app's live.json redirect).
const LIVEMATCH_URL = 'https://footballxt.com/score/livematch.php';
// The app's menu endpoints (used to discover per-league fixture pages).
const LIVEMENU_URL  = 'http://apps.sportsbd.live/tsportszone/footballtv/livemenu.json';

const DEFAULT_LOGO = 'https://img.footballxt.com/all/score/football/img/default.jpg';

// ── Tiny in-memory cache (live data changes minute-to-minute) ──
let _cache = { ts: 0, data: null };
const CACHE_MS = 45 * 1000; // 45s — fresh enough for a live schedule

async function fetchText(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Referer': 'https://footballxt.com/'
      },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Normalize a possibly-spaced logo URL; fall back to the brand default.
function cleanLogo(src) {
  if (!src) return DEFAULT_LOGO;
  const s = src.trim();
  if (!s || s === ' ') return DEFAULT_LOGO;
  return s;
}

// Parse the livematch.php HTML into structured live + upcoming matches.
function parseLiveMatch(html) {
  const $ = cheerio.load(html);
  const matches = [];

  $('.match-card').each((_, card) => {
    const $card = $(card);
    const isLive = $card.hasClass('live') || $card.find('.live-dot').length > 0;

    // The anchor carries the iSports stream URL (matchId + accessKey).
    const $a = $card.is('a') ? $card : ($card.find('a').first().length ? $card.find('a').first() : $card.closest('a'));
    let streamUrl = ($a && $a.attr && $a.attr('href')) ? $a.attr('href').trim() : '';
    // Some live cards are wrapped the other way (a > match-card); recover href.
    if (!streamUrl) {
      const parentA = $card.parent('a');
      if (parentA && parentA.attr('href')) streamUrl = parentA.attr('href').trim();
    }

    const league = ($card.find('.league').first().clone().children().remove().end().text() || '')
      .replace(/\s+/g, ' ').trim();

    const teams = $card.find('.team');
    if (teams.length < 2) return;

    const homeName = $(teams[0]).find('.team-name').text().trim();
    const awayName = $(teams[1]).find('.team-name').text().trim();
    const homeLogo = cleanLogo($(teams[0]).find('img').attr('src'));
    const awayLogo = cleanLogo($(teams[1]).find('img').attr('src'));
    if (!homeName && !awayName) return;

    const score = $card.find('.score').text().replace(/\s+/g, ' ').trim();
    const startTs = parseInt($card.find('.live-time').attr('data-start') || '0', 10) || null;
    const kickoffTs = parseInt($card.find('.countdown').attr('data-time') || '0', 10) || null;

    // Extract matchId + accessKey for a clean machine-readable shape.
    let matchId = null, accessKey = null;
    if (streamUrl) {
      const mId = streamUrl.match(/[?&]matchId=([^&]+)/i);
      const mKey = streamUrl.match(/[?&]accessKey=([^&]+)/i);
      if (mId) matchId = decodeURIComponent(mId[1]);
      if (mKey) accessKey = decodeURIComponent(mKey[1]);
    }

    matches.push({
      id: matchId || (homeName + '-' + awayName).replace(/\s+/g, '_').toLowerCase(),
      league: league || 'Football',
      home: { name: homeName, logo: homeLogo },
      away: { name: awayName, logo: awayLogo },
      title: (homeName && awayName) ? (homeName + ' vs ' + awayName) : (homeName || awayName),
      isLive,
      status: isLive ? 'LIVE' : 'UPCOMING',
      score: isLive ? (score || '0 - 0') : null,
      kickoff: isLive ? (startTs || null) : (kickoffTs || null),
      matchId,
      accessKey,
      // The iSports embeddable live/animation stream — plays in the in-page
      // iframe player. This is the ACTUAL feed the LiveFootballTV app opens.
      streamUrl: streamUrl || null,
      embedUrl: streamUrl || null,
      source: 'isportslive8'
    });
  });

  return matches;
}

// ── Public: full Matches V1 payload (live first, then upcoming) ──
async function getMatches() {
  const now = Date.now();
  if (_cache.data && (now - _cache.ts) < CACHE_MS) return _cache.data;

  let matches = [];
  try {
    const html = await fetchText(LIVEMATCH_URL);
    matches = parseLiveMatch(html);
  } catch (e) {
    // On upstream failure, serve the last good payload if we have one.
    if (_cache.data) return _cache.data;
    return {
      ok: false,
      provider: 'matchesv1',
      error: 'Upstream live schedule unavailable: ' + e.message,
      live: [], upcoming: [], count: 0
    };
  }

  const live = matches.filter(m => m.isLive);
  const upcoming = matches.filter(m => !m.isLive)
    .sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));

  const payload = {
    ok: true,
    provider: 'matchesv1',
    source: 'LiveFootballTV / iSports (footballxt)',
    count: matches.length,
    liveCount: live.length,
    upcomingCount: upcoming.length,
    live,
    upcoming,
    matches,
    updatedAt: Date.now()
  };

  _cache = { ts: now, data: payload };
  return payload;
}

module.exports = { getMatches, parseLiveMatch, LIVEMATCH_URL };
