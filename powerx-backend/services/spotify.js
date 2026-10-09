// ─────────────────────────────────────────────────────────────────────────────
// services/spotify.js — Spotify track → MP3 downloader
//
// HOW IT WORKS (verified end-to-end before shipping):
//   1. Parse the Spotify track/URL → track ID.
//   2. Open a session with spotmate.online (a public Spotify→MP3 converter):
//        a. GET the homepage to receive the Laravel session + XSRF-TOKEN cookie.
//        b. URL-decode the XSRF-TOKEN cookie → send it back as `X-XSRF-TOKEN`
//           on the API calls (this is what satisfies Laravel's CSRF guard).
//   3. POST /getTrackData  → returns track metadata (name, artists, cover, dur).
//   4. POST /convert       → returns a direct, time-limited MP3 download URL.
//   5. The route handler streams that MP3 back to the browser as an attachment.
//
// This runs cleanly from a datacenter IP (Render) — unlike yt-dlp/YouTube which
// is bot-walled on cloud hosts. No API keys required.
//
// Metadata-only validation also uses Spotify's public embed page as a fast,
// dependency-free sanity check / fallback for the track title.
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SPOTMATE_BASE = 'https://spotmate.online';

// Accepts canonical, locale-prefixed and URI forms:
//   https://open.spotify.com/track/{id}
//   https://open.spotify.com/intl-en/track/{id}
//   spotify:track:{id}
const SPOTIFY_TRACK_RE =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,}\/)?|spotify:)track[/:]([a-zA-Z0-9]+)/;

/** Extract a Spotify track ID from any supported URL/URI form. Returns null. */
function extractTrackId(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.trim().match(SPOTIFY_TRACK_RE);
  return m ? m[1] : null;
}

// Accepts canonical, locale-prefixed and URI forms for ALBUMS:
//   https://open.spotify.com/album/{id}
//   https://open.spotify.com/intl-en/album/{id}
//   spotify:album:{id}
const SPOTIFY_ALBUM_RE =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,}\/)?|spotify:)album[/:]([a-zA-Z0-9]+)/;

/** Extract a Spotify album ID from any supported URL/URI form. Returns null. */
function extractAlbumId(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.trim().match(SPOTIFY_ALBUM_RE);
  return m ? m[1] : null;
}

// Accepts canonical, locale-prefixed and URI forms for PLAYLISTS:
//   https://open.spotify.com/playlist/{id}
//   https://open.spotify.com/intl-en/playlist/{id}
//   spotify:playlist:{id}
const SPOTIFY_PLAYLIST_RE =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,}\/)?|spotify:)playlist[/:]([a-zA-Z0-9]+)/;

/** Extract a Spotify playlist ID from any supported URL/URI form. Returns null. */
function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const m = input.trim().match(SPOTIFY_PLAYLIST_RE);
  return m ? m[1] : null;
}

/** Parse all Set-Cookie headers into a { name: value } map. */
function parseSetCookies(res) {
  const jar = {};
  // node-fetch v2 exposes raw() to get the array of set-cookie strings.
  let raw = [];
  try {
    raw = res.headers.raw()['set-cookie'] || [];
  } catch (_) {
    const single = res.headers.get('set-cookie');
    if (single) raw = [single];
  }
  for (const line of raw) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Open a spotmate session: returns { jar, xsrf }.
 * `xsrf` is the URL-decoded XSRF-TOKEN cookie, used as the X-XSRF-TOKEN header.
 */
async function openSession() {
  const res = await fetch(`${SPOTMATE_BASE}/en`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`spotmate session init failed (HTTP ${res.status})`);
  await res.text(); // drain body
  const jar = parseSetCookies(res);
  const xsrfRaw = jar['XSRF-TOKEN'];
  if (!xsrfRaw) throw new Error('spotmate session: no XSRF-TOKEN cookie issued');
  const xsrf = decodeURIComponent(xsrfRaw);
  return { jar, xsrf };
}

function apiHeaders(session, json = true) {
  const h = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    'x-xsrf-token': session.xsrf,
    origin: SPOTMATE_BASE,
    referer: `${SPOTMATE_BASE}/en`,
    cookie: cookieHeader(session.jar),
  };
  if (json) h['content-type'] = 'application/json';
  return h;
}

/**
 * Fetch track metadata from spotmate.
 * Returns { id, name, artists:[{name}], album:{images:[{url}]}, duration_ms }.
 */
async function getTrackData(trackUrl) {
  const session = await openSession();
  const res = await fetch(`${SPOTMATE_BASE}/getTrackData`, {
    method: 'POST',
    headers: apiHeaders(session),
    body: JSON.stringify({ spotify_url: trackUrl }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('spotmate getTrackData returned non-JSON (service may be down)');
  }
  if (!res.ok || data.error || data.message) {
    throw new Error(`spotmate getTrackData error: ${data.message || `HTTP ${res.status}`}`);
  }
  // attach the live session so convert() can reuse the same CSRF/cookies
  data.__session = session;
  return data;
}

/**
 * Resolve the direct MP3 download URL for a Spotify track URL.
 * Reuses an existing session if provided (avoids a second handshake).
 * Returns a string URL.
 */
async function getDownloadUrl(trackUrl, session) {
  if (!session) session = await openSession();
  const res = await fetch(`${SPOTMATE_BASE}/convert`, {
    method: 'POST',
    headers: apiHeaders(session),
    body: JSON.stringify({ urls: trackUrl }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error('spotmate convert returned non-JSON (service may be down)');
  }
  if (res.status === 419) throw new Error('spotmate session expired — retry');
  if (!res.ok || data.error || !data.url) {
    throw new Error(`spotmate convert error: ${data.message || data.error || `HTTP ${res.status}`}`);
  }
  return data.url;
}

/**
 * Spotify public embed-page metadata fallback (no third party). Fast existence
 * check + reliable title/artist source. Returns { title, artists } or null.
 */
async function getEmbedMetadata(trackId) {
  try {
    const res = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    const pp = data && data.props && data.props.pageProps;
    const entity =
      (pp && pp.state && pp.state.data && pp.state.data.entity) ||
      (pp && pp.data && pp.data.entity) ||
      (pp && pp.entity);
    if (!entity) return null;
    const title = entity.name || entity.title || null;
    let artists = entity.subtitle || '';
    if (Array.isArray(entity.artists)) {
      artists = entity.artists.map((a) => a && a.name).filter(Boolean).join(', ');
    }
    return title ? { title, artists } : null;
  } catch (_) {
    return null;
  }
}

/**
 * High-level: given a Spotify track URL/URI, return everything the frontend
 * needs: { id, url, title, artists, cover, durationMs, downloadUrl }.
 *
 * `downloadUrl` is the direct (time-limited) MP3 link. The route handler
 * proxies/streams it so the browser saves a clean "Title - Artist.mp3".
 */
async function resolveTrack(input) {
  const id = extractTrackId(input);
  if (!id) {
    const err = new Error('Invalid Spotify track URL. Paste a link like https://open.spotify.com/track/...');
    err.status = 400;
    throw err;
  }
  const canonical = `https://open.spotify.com/track/${id}`;

  let meta;
  try {
    meta = await getTrackData(canonical);
  } catch (e) {
    // Surface a clean, user-facing error; keep the cause in the message tail.
    const err = new Error(`Could not read this track from Spotify. ${e.message}`);
    err.status = 502;
    throw err;
  }

  const session = meta.__session;
  const title = meta.name || '';
  const artists = Array.isArray(meta.artists)
    ? meta.artists.map((a) => a && a.name).filter(Boolean).join(', ')
    : '';
  const cover =
    meta.album && Array.isArray(meta.album.images) && meta.album.images[0]
      ? meta.album.images[0].url
      : '';

  let downloadUrl;
  try {
    // Use the resilient converter (multi-attempt, fresh-session-on-failure,
    // backoff) instead of a single call. This makes the single-track bot/web
    // download as robust as the batch path against spotmate's transient
    // 419/429/CSRF failures from a datacenter IP.
    downloadUrl = await convertTrackFast(canonical, { session });
  } catch (e) {
    // Final retry with a brand-new session (covers 419/expired CSRF).
    try {
      downloadUrl = await convertTrackFast(canonical);
    } catch (e2) {
      const err = new Error(`Could not prepare the MP3 for this track. ${e2.message}`);
      err.status = 502;
      throw err;
    }
  }

  return {
    id,
    url: canonical,
    title,
    artists,
    cover,
    durationMs: meta.duration_ms || null,
    downloadUrl,
  };
}

/** Build a safe "Title - Artist.mp3" filename (cross-platform-safe). */
function safeFilename(title, artists) {
  const base = [title, artists].filter(Boolean).join(' - ') || 'spotify-track';
  const cleaned = base
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${cleaned || 'spotify-track'}.mp3`;
}

/** Build a safe folder/zip base name from an album title + artist. */
function safeAlbumName(name, artists) {
  const base = [name, artists].filter(Boolean).join(' - ') || 'spotify-album';
  const cleaned = base
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'spotify-album';
}

/** Build a safe folder/zip base name from a playlist title + owner. */
function safePlaylistName(name, owner) {
  const base = [name, owner].filter(Boolean).join(' - ') || 'spotify-playlist';
  const cleaned = base
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'spotify-playlist';
}

// ─────────────────────────────────────────────────────────────────────────────
// ALBUM SUPPORT
//
// spotmate.online only converts ONE track at a time (its /convert endpoint),
// and it has no album endpoint. So to support albums we:
//   1. Read the album's public Spotify EMBED page (no API key, works from a
//      datacenter IP — the SAME technique getEmbedMetadata() already uses for
//      single tracks) to get the album title, cover, and the full ordered
//      track list (each track exposes its real `spotify:track:{id}` URI).
//   2. For each track we reuse the EXISTING, proven resolveTrack()/spotmate
//      /convert flow — i.e. an album download is literally N single-track
//      downloads, so it behaves identically to the working single downloader.
//
// The route handler zips the per-track MP3s into one "Album - Artist.zip".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read album metadata + the ordered track list from Spotify's public embed page.
 * Returns { id, name, artists, cover, tracks: [{ id, url, title, artists,
 * durationMs, index }] } or throws a clean, user-facing error.
 */
async function getAlbumMetadata(albumId) {
  const res = await fetch(`https://open.spotify.com/embed/album/${albumId}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Could not read this album from Spotify (HTTP ${res.status}).`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (!m) throw new Error('Could not parse the album page (Spotify layout changed).');

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (_) {
    throw new Error('Could not parse the album data.');
  }
  const pp = data && data.props && data.props.pageProps;
  const entity =
    (pp && pp.state && pp.state.data && pp.state.data.entity) ||
    (pp && pp.data && pp.data.entity) ||
    (pp && pp.entity);
  if (!entity) throw new Error('This album has no readable track list.');

  const name = entity.name || entity.title || 'Album';
  const albumArtists = entity.subtitle || '';
  let cover = '';
  if (entity.coverArt && Array.isArray(entity.coverArt.sources) && entity.coverArt.sources.length) {
    cover = entity.coverArt.sources[entity.coverArt.sources.length - 1].url || '';
  } else if (entity.visualIdentity && Array.isArray(entity.visualIdentity.image) && entity.visualIdentity.image.length) {
    cover = entity.visualIdentity.image[entity.visualIdentity.image.length - 1].url || '';
  }

  const rawList = Array.isArray(entity.trackList)
    ? entity.trackList
    : (entity.trackListData && Array.isArray(entity.trackListData.tracks))
      ? entity.trackListData.tracks
      : [];

  const tracks = [];
  rawList.forEach((t, i) => {
    // Pull the real track id from the spotify:track:{id} URI.
    const uri = t.uri || '';
    const idMatch = uri.match(/spotify:track:([a-zA-Z0-9]+)/);
    const tid = idMatch ? idMatch[1] : null;
    if (!tid) return; // skip episodes / unplayable rows
    tracks.push({
      id: tid,
      url: `https://open.spotify.com/track/${tid}`,
      title: t.title || t.name || `Track ${i + 1}`,
      artists: (t.subtitle ||
        (Array.isArray(t.artists) ? t.artists.map((a) => a && a.name).filter(Boolean).join(', ') : '') ||
        albumArtists || '').replace(/\u00a0/g, ' ').trim(),
      durationMs: t.duration || null,
      index: i + 1,
    });
  });

  if (!tracks.length) throw new Error('No downloadable tracks were found on this album.');

  return { id: albumId, name, artists: albumArtists, cover, tracks };
}

/**
 * High-level album resolver. Given any Spotify album URL/URI, returns
 * { id, url, name, artists, cover, trackCount, tracks }.
 * Each track entry is everything the frontend needs to list + download it.
 * NOTE: this does NOT pre-resolve every MP3 link (that would hammer spotmate
 * and time out on big albums) — per-track MP3 links are resolved lazily by the
 * download endpoint, exactly like the single-track flow.
 */
async function resolveAlbum(input) {
  const id = extractAlbumId(input);
  if (!id) {
    const err = new Error('Invalid Spotify album URL. Paste a link like https://open.spotify.com/album/...');
    err.status = 400;
    throw err;
  }
  let meta;
  try {
    meta = await getAlbumMetadata(id);
  } catch (e) {
    const err = new Error(e.message || 'Could not read this album from Spotify.');
    err.status = 502;
    throw err;
  }
  return {
    id,
    url: `https://open.spotify.com/album/${id}`,
    name: meta.name,
    artists: meta.artists,
    cover: meta.cover,
    trackCount: meta.tracks.length,
    tracks: meta.tracks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYLIST SUPPORT
//
// Identical architecture to albums: read the public embed page for metadata +
// track list, then resolve each track through the proven spotmate converter.
// The route handler zips per-track MP3s into one "Playlist - Owner.zip".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read playlist metadata + the ordered track list from Spotify's public embed page.
 * Returns { id, name, owner, cover, tracks: [{ id, url, title, artists,
 * durationMs, index }] } or throws a clean, user-facing error.
 */
async function getPlaylistMetadata(playlistId) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`Could not read this playlist from Spotify (HTTP ${res.status}).`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  if (!m) throw new Error('Could not parse the playlist page (Spotify layout changed).');

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (_) {
    throw new Error('Could not parse the playlist data.');
  }
  const pp = data && data.props && data.props.pageProps;
  const entity =
    (pp && pp.state && pp.state.data && pp.state.data.entity) ||
    (pp && pp.data && pp.data.entity) ||
    (pp && pp.entity);
  if (!entity) throw new Error('This playlist has no readable track list.');

  const name = entity.name || entity.title || 'Playlist';
  const owner = entity.subtitle || '';
  let cover = '';
  if (entity.coverArt && Array.isArray(entity.coverArt.sources) && entity.coverArt.sources.length) {
    cover = entity.coverArt.sources[entity.coverArt.sources.length - 1].url || '';
  } else if (entity.visualIdentity && Array.isArray(entity.visualIdentity.image) && entity.visualIdentity.image.length) {
    cover = entity.visualIdentity.image[entity.visualIdentity.image.length - 1].url || '';
  }

  const rawList = Array.isArray(entity.trackList)
    ? entity.trackList
    : (entity.trackListData && Array.isArray(entity.trackListData.tracks))
      ? entity.trackListData.tracks
      : [];

  const tracks = [];
  rawList.forEach((t, i) => {
    const uri = t.uri || '';
    const idMatch = uri.match(/spotify:track:([a-zA-Z0-9]+)/);
    const tid = idMatch ? idMatch[1] : null;
    if (!tid) return; // skip episodes / unplayable rows
    tracks.push({
      id: tid,
      url: `https://open.spotify.com/track/${tid}`,
      title: t.title || t.name || `Track ${i + 1}`,
      artists: (t.subtitle ||
        (Array.isArray(t.artists) ? t.artists.map((a) => a && a.name).filter(Boolean).join(', ') : '') ||
        owner || '').replace(/\u00a0/g, ' ').trim(),
      durationMs: t.duration || null,
      index: i + 1,
    });
  });

  if (!tracks.length) throw new Error('No downloadable tracks were found on this playlist.');

  return { id: playlistId, name, owner, cover, tracks };
}

/**
 * High-level playlist resolver. Given any Spotify playlist URL/URI, returns
 * { id, url, name, owner, cover, trackCount, tracks }.
 * Same contract as resolveAlbum — does NOT pre-resolve MP3 links.
 */
async function resolvePlaylist(input) {
  const id = extractPlaylistId(input);
  if (!id) {
    const err = new Error('Invalid Spotify playlist URL. Paste a link like https://open.spotify.com/playlist/...');
    err.status = 400;
    throw err;
  }
  let meta;
  try {
    meta = await getPlaylistMetadata(id);
  } catch (e) {
    const err = new Error(e.message || 'Could not read this playlist from Spotify.');
    err.status = 502;
    throw err;
  }
  return {
    id,
    url: `https://open.spotify.com/playlist/${id}`,
    name: meta.name,
    owner: meta.owner,
    cover: meta.cover,
    trackCount: meta.tracks.length,
    tracks: meta.tracks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAST BATCH DOWNLOADER (albums + playlists)
//
// The original album/playlist flow called resolveTrack() for every track, which
// (a) opened a BRAND-NEW spotmate session per track (full GET /en handshake) and
// (b) fetched /getTrackData metadata we don't actually need for the ZIP (the
// embed page already gave us title/artists). On a big playlist that's
// N × (handshake + metadata + convert + download) — all strictly sequential —
// which is why users stared at "preparing…" for ages.
//
// This batch path fixes both:
//   • ONE shared spotmate session reused across all tracks (re-minted only on
//     419/expiry), so we pay the handshake cost ~once instead of N times.
//   • Skips /getTrackData entirely — goes straight to /convert (the only call
//     that yields the MP3 URL).
//   • Runs through a small concurrency POOL (parallel converts + downloads)
//     instead of one-at-a-time, the single biggest speedup for long lists.
//
// The proven single-track resolveTrack()/getDownloadUrl() flow is left fully
// intact and is still used by the single-track route.
// ─────────────────────────────────────────────────────────────────────────────

/** Default parallelism for batch downloads. Tunable via SPOTIFY_DL_CONCURRENCY.
 *  Lowered from 8 → 4: spotmate.online aggressively rate-limits BURSTS of
 *  parallel /convert calls coming from a single datacenter IP (Render), which is
 *  why the bots — hitting it with 8-wide concurrency — got "None of the tracks
 *  could be downloaded" while the website (users hitting it one track at a time)
 *  worked fine. 4 is a safe balance of speed vs. not tripping the limiter, and
 *  combined with per-track retries below it makes album/playlist ZIPs reliable
 *  from a cloud host. */
const BATCH_CONCURRENCY = Math.max(
  1,
  Math.min(12, parseInt(process.env.SPOTIFY_DL_CONCURRENCY || '4', 10) || 4)
);

/** How many times to retry a single track's convert before giving up. */
const TRACK_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(6, parseInt(process.env.SPOTIFY_TRACK_RETRIES || '3', 10) || 3)
);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Convert ONE track to its direct MP3 URL, resilient to the transient failures
 * that plague a shared spotmate session under parallel load from a cloud IP:
 * expired CSRF (HTTP 419), rate-limit (429), and generic 5xx/timeouts.
 *
 * Strategy: up to TRACK_MAX_ATTEMPTS tries with exponential backoff + jitter.
 *   • Attempt 1 uses the shared batch session (cheap — no handshake).
 *   • On failure we mint a BRAND-NEW session (so a throttled/expired shared
 *     session can't doom every remaining track) and, when a shared holder is
 *     supplied, swap it in so the rest of the batch benefits from the fresh one.
 *
 * @param {string} trackUrl   canonical https://open.spotify.com/track/{id}
 * @param {object} sessionRef { session } holder shared across the batch (optional)
 * @returns {Promise<string>} direct MP3 download URL
 */
async function convertTrackFast(trackUrl, sessionRef) {
  sessionRef = sessionRef || {};
  let lastErr;
  for (let attempt = 1; attempt <= TRACK_MAX_ATTEMPTS; attempt++) {
    try {
      if (!sessionRef.session) sessionRef.session = await openSession();
      return await getDownloadUrl(trackUrl, sessionRef.session);
    } catch (e) {
      lastErr = e;
      // Mint a fresh session for the next attempt (covers 419 / expired CSRF /
      // a session the rate-limiter has soured on).
      try { sessionRef.session = await openSession(); } catch (_) { sessionRef.session = null; }
      if (attempt < TRACK_MAX_ATTEMPTS) {
        // Exponential backoff with jitter: ~0.6s, ~1.4s, ~2.6s … eases the
        // spotmate rate-limiter instead of hammering it.
        const base = 400 * Math.pow(1.8, attempt - 1);
        await sleep(base + Math.floor(Math.random() * 400));
      }
    }
  }
  throw lastErr || new Error('convert failed');
}

/**
 * Resolve + fetch the MP3 bytes for one track. Returns a Buffer.
 * Throws on any failure (caller decides whether to skip the track). The MP3
 * download itself gets one retry too (the CDN link is time-limited and can
 * hiccup), re-resolving a fresh link if the first byte-fetch fails.
 */
async function fetchTrackBuffer(trackUrl, sessionRef) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const downloadUrl = await convertTrackFast(trackUrl, sessionRef);
      const up = await fetch(downloadUrl, { headers: { 'user-agent': UA } });
      if (!up.ok) throw new Error(`HTTP ${up.status}`);
      const buf = await up.buffer();
      if (!buf || buf.length < 1024) throw new Error('empty file');
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(600 + Math.floor(Math.random() * 400));
    }
  }
  throw lastErr || new Error('download failed');
}

/**
 * Download an ordered track list IN PARALLEL (bounded concurrency) and hand
 * each finished MP3 buffer to onTrack(track, buffer). Tracks that fail are
 * collected and skipped — one bad track never kills the batch, exactly like
 * the original sequential loop.
 *
 * @param {Array}    tracks    [{ id, url, title, artists, index }, ...]
 * @param {object}   opts
 * @param {Function} opts.onTrack    (track, buffer) => void   — add to ZIP here
 * @param {number}   [opts.concurrency]
 * @returns {Promise<{ ok:number, failed:string[] }>}
 */
async function downloadTracksParallel(tracks, opts) {
  opts = opts || {};
  const onTrack = opts.onTrack || function () {};
  const concurrency = Math.max(1, Math.min(12, opts.concurrency || BATCH_CONCURRENCY));

  // ONE shared session for the whole batch (re-minted only on expiry inside
  // convertTrackFast). Avoids N handshakes.
  const sessionRef = { session: null };
  try {
    sessionRef.session = await openSession();
  } catch (_) {
    // If even the first handshake fails, let per-track logic mint one lazily.
    sessionRef.session = null;
  }

  let ok = 0;
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= tracks.length) return;
      const t = tracks[i];
      try {
        const buf = await fetchTrackBuffer(t.url, sessionRef);
        onTrack(t, buf);
        ok += 1;
      } catch (_) {
        failed.push(`${t.index}. ${t.title}`);
      }
    }
  }

  const workers = [];
  const n = Math.min(concurrency, tracks.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  return { ok, failed };
}

module.exports = {
  extractTrackId,
  extractAlbumId,
  extractPlaylistId,
  resolveTrack,
  resolveAlbum,
  resolvePlaylist,
  getAlbumMetadata,
  getPlaylistMetadata,
  getTrackData,
  getDownloadUrl,
  getEmbedMetadata,
  convertTrackFast,
  fetchTrackBuffer,
  downloadTracksParallel,
  safeFilename,
  safeAlbumName,
  safePlaylistName,
};
