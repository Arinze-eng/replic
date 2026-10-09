// Live E2E test for the "forwarded file never reaches Capy" fix.
// Simulates a Telegram-forwarded file as a raw Buffer, runs it through the
// ACTUAL capy.uploadBuffersToPublic() (now Supabase-first), then creates a real
// Capy thread with the resulting attachmentUrls and verifies Capy read the file.
//
// Run: CAPY_API_KEY=capy_... node scripts/test-capy-file-upload-fix.js

process.env.CAPY_API_KEY = process.env.CAPY_API_KEY || 'capy_i9N9c8URbTdnXVpn8lMds8dw6Re4hxAOVNEVdzZeBk0';
process.env.CAPY_HEAD = process.env.CAPY_HEAD || '1';

const capy = require('../services/capy');

function log(...a) { console.log('[test]', ...a); }

async function main() {
  const marker = 'ZULU_' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const content = `${marker}: The secret color of the sky in this test is bright purple.`;
  const buf = Buffer.from(content, 'utf8');

  // 1) Upload a raw buffer exactly like the Telegram bot does (via agentCapyFirst).
  log('Uploading a raw buffer through capy.uploadBuffersToPublic (Supabase-first)…');
  const hosted = await capy.uploadBuffersToPublic(
    [{ name: 'secret_note.txt', buffer: buf, mime: 'text/plain' }],
    { userId: 'e2e-test', onStep: (s) => log('  upload:', s), max: 8 }
  );
  if (!hosted.length || !hosted[0].url) {
    console.error('❌ FAIL: uploadBuffersToPublic returned no URL — file would never reach Capy.');
    process.exit(1);
  }
  const url = hosted[0].url;
  log('✅ Hosted URL:', url);
  const isSupabase = /supabase\.co\/storage\/v1\/object\/public\//.test(url);
  log(isSupabase ? '✅ Using Supabase Storage (reliable primary host).'
                 : '⚠️  Not Supabase (fell back to a public host) — still OK.');

  // 2) Verify the URL is publicly fetchable and has our content.
  const fetch = require('node-fetch');
  const r = await fetch(url, { timeout: 20000 });
  const got = await r.text();
  if (!got.includes(marker)) {
    console.error('❌ FAIL: hosted URL did not serve our file content. Got:', got.slice(0, 120));
    process.exit(1);
  }
  log('✅ Hosted URL serves the correct file content.');

  // 3) Full Capy loop: submit with attachmentUrls, poll, verify Capy read it.
  log('Submitting to Capy with attachmentUrls and polling (real thread)…');
  const out = await capy.run(
    {
      message: 'Download the file at the attachmentUrls. Reply with ONLY the marker code (the ' +
        'ZULU_ token) found inside it, and what secret color it names. Be brief.',
      attachmentUrls: [url],
    },
    { ceilingMs: 4 * 60 * 1000, intervalMs: 6000, onStep: (s) => log('  capy:', s) }
  );
  const reply = String(out && out.reply || '');
  log('Capy reply:', JSON.stringify(reply.slice(0, 300)));
  if (reply.includes(marker) && /purple/i.test(reply)) {
    log('✅ PASS: Capy downloaded and read the forwarded file correctly.');
    process.exit(0);
  }
  console.error('❌ FAIL: Capy reply did not contain the marker/color from the file.');
  process.exit(1);
}

main().catch((e) => { console.error('❌ ERROR:', e && e.stack || e); process.exit(1); });
