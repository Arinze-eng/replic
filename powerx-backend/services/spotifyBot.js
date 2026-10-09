// ─────────────────────────────────────────────────────────────────────────────
// services/spotifyBot.js — Shared Spotify downloader logic for the WormGPT bots
// (Telegram + WhatsApp).
//
// The website already has a fully-working Spotify → MP3 downloader
// (services/spotify.js + the /api/spotify/* routes in server.js). This module
// reuses that SAME proven converter so the bots behave EXACTLY like the site:
//
//   • Track   → one clean "Title - Artist.mp3".
//   • Album   → a "Album - Artist.zip" of MP3s (Telegram) OR per-track MP3s.
//   • Playlist→ a "Playlist - Owner.zip" of MP3s (Telegram) OR per-track MP3s.
//
// The SAME tiered daily quota the website enforces is applied here, shared via
// the very same db helpers (db.spotifyDailyLimit / spotifyTierName /
// getSpotifyDownloadCountToday / saveSpotifyDownload):
//
//   • Free  → 2 downloads/day
//   • Basic → 15 downloads/day
//   • Pro / Admin → unlimited
//   • PAYG feature-pass ("spotify") grants a temporary pass, exactly like the
//     website (applyFeaturePass is web-only, but PAYG passes bump the user's
//     tier which spotifyDailyLimit already honours).
//
// An album/playlist counts as ONE download against the daily limit — identical
// to the website. Listing/metadata is free; the quota is only charged once the
// file(s) are actually produced.
//
// This module is transport-agnostic: it returns plain results + Buffers and lets
// each bot deliver them with its own send primitives (Telegram sendAudio /
// sendDocument, WhatsApp audio/document). It NEVER throws to the bot — every
// public function returns a { ok, ... } result the caller can render.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../db');
const spotify = require('./spotify');

// Detect ANY Spotify link (track / album / playlist) in a free-text message so
// the bot can react the instant a user pastes one. Canonical, locale-prefixed
// (intl-xx) and spotify: URI forms are all accepted — mirrors the regexes in
// services/spotify.js.
const SPOTIFY_ANY_RE =
  /(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2,}\/)?|spotify:)(track|album|playlist)[/:][a-zA-Z0-9]+/i;

/**
 * Find the FIRST Spotify link in a message and classify it.
 * @param {string} text
 * @returns {{kind:'track'|'album'|'playlist', url:string}|null}
 */
function detectSpotifyLink(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(SPOTIFY_ANY_RE);
  if (!m) return null;
  return { kind: m[1].toLowerCase(), url: m[0] };
}

// Read the admin-configured Spotify { free, basic } limit overrides from the
// settings store (admin panel → Limits). Falls back to db.js defaults (2 / 15)
// when unset/invalid. Mirrors server.js getSpotifyOverrides() so the bots and
// the website share the exact same runtime-tunable limits.
async function getSpotifyOverrides() {
  const read = async (key, def) => {
    try {
      const raw = await db.getSetting(key);
      const n = parseInt(String(raw == null ? '' : raw).trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : def;
    } catch (_) {
      return def;
    }
  };
  return {
    free: await read('limit_spotify_free', 2),
    basic: await read('limit_spotify_basic', 15),
  };
}

/**
 * Check whether this user may perform ONE more Spotify download today.
 * Returns { allowed, tier, limit, used, remaining, unlimited, message }.
 * Never throws.
 */
async function checkQuota(userId) {
  let user = null;
  try {
    user = await db.getUserById(userId);
  } catch (_) {
    user = null;
  }
  if (!user || user.blocked) {
    return {
      allowed: false,
      blocked: true,
      tier: 'Free',
      message: '⛔ Your account is not available. Send /logout then /start to re-link, or contact support.',
    };
  }

  const overrides = await getSpotifyOverrides();
  const limit = db.spotifyDailyLimit(user, overrides);
  const tier = db.spotifyTierName(user);
  const unlimited = limit === Infinity;
  const used = await db.getSpotifyDownloadCountToday(userId);
  const remaining = unlimited ? Infinity : Math.max(0, limit - used);

  if (!unlimited && used >= limit) {
    const upsell =
      tier === 'Free'
        ? 'Subscribe to *Basic* (15 downloads/day) or *Pro* (unlimited) to keep downloading.'
        : 'Upgrade to *Pro* for unlimited Spotify downloads!';
    return {
      allowed: false,
      paywall: true,
      tier,
      limit,
      used,
      remaining: 0,
      unlimited: false,
      message:
        `⚠️ *Daily Spotify download limit reached* (${tier}: ${limit}/day). ${upsell}\n\n` +
        `🔓 Upgrade here 👉 https://hackerx-v7-d5s4.onrender.com\n\nYour quota renews at midnight.`,
    };
  }

  return { allowed: true, tier, limit, used, remaining, unlimited };
}

/** Record ONE successful download against the daily quota (free/basic only). */
async function recordDownload(userId, unlimited) {
  if (unlimited) return; // Pro/Admin are never metered — matches the website.
  try {
    await db.saveSpotifyDownload(userId);
  } catch (_) {
    /* best-effort — never blocks delivery */
  }
}

/**
 * Resolve + download a SINGLE track. Returns:
 *   { ok:true, filename, buffer, title, artists, durationMs, cover }
 *   { ok:false, error }
 * Does NOT touch the quota (the caller records the download after delivery).
 */
async function fetchTrack(url) {
  try {
    const t = await spotify.resolveTrack(url);
    const fetch = require('node-fetch');
    const up = await fetch(t.downloadUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!up.ok) {
      return { ok: false, error: `Upstream download failed (HTTP ${up.status}). Please try again.` };
    }
    const buffer = await up.buffer();
    if (!buffer || buffer.length < 1024) {
      return { ok: false, error: 'The converted file came back empty. Please try again.' };
    }
    return {
      ok: true,
      filename: spotify.safeFilename(t.title, t.artists),
      buffer,
      title: t.title,
      artists: t.artists,
      durationMs: t.durationMs,
      cover: t.cover,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Could not download this track.' };
  }
}

/**
 * Resolve an album/playlist and download every track in parallel, handing each
 * finished MP3 buffer to onTrack(track, buffer) so the caller can add it to a
 * ZIP or send it directly. Returns { ok, name, artistsOrOwner, trackCount, ok:count,
 * failed:[...] } — mirrors the website's album/playlist download flow.
 *
 * @param {'album'|'playlist'} kind
 * @param {string} url
 * @param {(track, buffer)=>void} onTrack
 * @param {(meta)=>void} [onMeta]  called once with { name, artistsOrOwner, trackCount }
 */
async function fetchCollection(kind, url, onTrack, onMeta) {
  try {
    const col =
      kind === 'album'
        ? await spotify.resolveAlbum(url)
        : await spotify.resolvePlaylist(url);
    const name = col.name;
    const artistsOrOwner = kind === 'album' ? col.artists : col.owner;
    if (onMeta) {
      try { onMeta({ name, artistsOrOwner, trackCount: col.trackCount }); } catch (_) {}
    }
    if (!col.tracks || !col.tracks.length) {
      return { ok: false, error: `No downloadable tracks were found on this ${kind}.` };
    }
    const { ok, failed } = await spotify.downloadTracksParallel(col.tracks, {
      onTrack,
    });
    return {
      ok: true,
      name,
      artistsOrOwner,
      trackCount: col.trackCount,
      downloaded: ok,
      failed,
      tracks: col.tracks,
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : `Could not read this ${kind}.` };
  }
}

/** Build a zero-padded "NN - Title - Artist.mp3" filename for a collection track. */
function collectionTrackName(track, total) {
  const pad = String(total).length;
  const num = String(track.index).padStart(pad, '0');
  return `${num} - ${spotify.safeFilename(track.title, track.artists)}`;
}

module.exports = {
  SPOTIFY_ANY_RE,
  detectSpotifyLink,
  getSpotifyOverrides,
  checkQuota,
  recordDownload,
  fetchTrack,
  fetchCollection,
  collectionTrackName,
  // re-export the safe-name helpers so callers name ZIPs identically to the site
  safeAlbumName: spotify.safeAlbumName,
  safePlaylistName: spotify.safePlaylistName,
  safeFilename: spotify.safeFilename,
};
