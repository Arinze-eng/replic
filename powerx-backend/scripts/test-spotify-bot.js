// scripts/test-spotify-bot.js — E2E test for the bot Spotify downloader.
//
// Verifies the shared services/spotifyBot.js (used by BOTH the Telegram
// WormGPT bot and the WhatsApp WormGPT bot) end-to-end against the SAME public
// spotmate.online converter the website uses:
//   1) link detection for track / album / playlist (canonical, intl-xx, URI),
//   2) fetchTrack → a real MP3 buffer,
//   3) fetchCollection('album') → downloads every track (for the ZIP the bot builds).
//
// Run:  node scripts/test-spotify-bot.js
// Requires network access (hits spotmate.online + open.spotify.com embeds).
// The quota helpers (checkQuota/recordDownload) are NOT exercised here because
// they need Supabase — they simply wrap the SAME db helpers the website uses.

const spotifyBot = require('../services/spotifyBot');

const TRACK = 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'; // Rick Astley
const ALBUM = 'https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4';
const PLAYLIST = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

let failures = 0;
function assert(cond, label) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + label);
  if (!cond) failures++;
}

(async () => {
  console.log('== 1) link detection ==');
  assert(spotifyBot.detectSpotifyLink('grab ' + TRACK).kind === 'track', 'detects track link in text');
  assert(spotifyBot.detectSpotifyLink(ALBUM).kind === 'album', 'detects album link');
  assert(spotifyBot.detectSpotifyLink(PLAYLIST).kind === 'playlist', 'detects playlist link');
  assert(spotifyBot.detectSpotifyLink('spotify:track:4PTG3Z6ehGkBFwjybzWkR8').kind === 'track', 'detects spotify: URI');
  assert(spotifyBot.detectSpotifyLink('https://open.spotify.com/intl-en/track/4PTG3Z6ehGkBFwjybzWkR8').kind === 'track', 'detects intl-xx link');
  assert(spotifyBot.detectSpotifyLink('no link here') === null, 'ignores non-links');

  console.log('== 2) fetchTrack ==');
  const t = await spotifyBot.fetchTrack(TRACK);
  assert(t.ok && t.buffer && t.buffer.length > 100000, 'downloads a real MP3 (' + (t.ok ? t.buffer.length : t.error) + ' bytes)');
  assert(t.ok && /\.mp3$/i.test(t.filename), 'produces a .mp3 filename: ' + (t.filename || ''));

  console.log('== 3) fetchCollection(album) ==');
  let count = 0, total = 0;
  const r = await spotifyBot.fetchCollection('album', ALBUM,
    (track, buf) => { if (buf && buf.length > 1000) count++; },
    (meta) => { total = meta.trackCount; });
  assert(r.ok && r.downloaded > 0, 'downloads album tracks (' + (r.ok ? r.downloaded + '/' + r.trackCount : r.error) + ')');
  assert(count === r.downloaded, 'onTrack fired for every downloaded track');

  console.log('\n' + (failures ? '❌ ' + failures + ' check(s) FAILED' : '✅ ALL CHECKS PASSED'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
