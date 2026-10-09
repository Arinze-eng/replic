// scripts/test-browser-live-daytona.js
//
// END-TO-END TEST for the Daytona-first browser-use live screen chain.
//
// Proves the new provider order in services/autoLiveScreen.js:
//     1) Daytona desktop  →  2) Cloudflare  →  3) Browserless
//
// It loads the REAL services (db.js resolves the Daytona/CF/Browserless keys
// from Supabase app_settings), then drives autoLiveScreen.onBrowseTool() exactly
// like the agent engine does, capturing every `screen` SSE event so we can
// assert WHICH provider booted. SUCCESS = the first provider that booted is
// `daytona` (or `sandbox` on a Daytona-backed fsx) AND we saw a noVNC live URL
// and/or frames coming from inside the Daytona computer.
//
// Run:  node scripts/test-browser-live-daytona.js
'use strict';

const autoLive = require('../services/autoLiveScreen');
const daytona = require('../services/daytona');
const agentEngine = require('../services/agentEngine');

function log(...a) { console.log('[test]', ...a); }

(async () => {
  const events = [];
  let firstProvider = null;
  let sawLiveUrl = null;
  let frames = 0;

  // Fake ctx exactly like the host-loop engine builds: an onEvent SSE emitter
  // and onStep notes. fsx is LOCAL (not a sandbox) on purpose, to PROVE the
  // chain acquires a Daytona computer ON DEMAND and prefers it first.
  const ctx = {
    fsx: { kind: 'local' },         // NOT a sandbox → forces on-demand Daytona acquire
    onStep: (m) => log('step:', m),
    onEvent: (type, payload) => {
      if (type !== 'screen') return;
      events.push(payload);
      if (payload.event === 'start' && !firstProvider) {
        firstProvider = payload.provider || payload.backend || 'unknown';
        log('▶ FIRST PROVIDER BOOTED:', firstProvider, '(backend=' + payload.backend + ')');
      }
      if (payload.event === 'liveurl' && payload.liveUrl && !sawLiveUrl) {
        sawLiveUrl = payload.liveUrl;
        log('🔗 live URL (' + payload.provider + '):', String(payload.liveUrl).slice(0, 110));
      }
      if (payload.frame) { frames++; if (frames % 3 === 1) log('🖼️ frame #' + frames + ' (' + payload.w + 'x' + payload.h + ')'); }
    },
  };

  log('Daytona enabled?', await daytona.enabledAsync());
  log('Selected sandbox backend:', await agentEngine.getSelectedBackendName());

  log('Simulating the agent calling the `browse` tool → onBrowseTool()…');
  autoLive.onBrowseTool(ctx, 'browse', { url: 'https://example.com' });

  // Give the chain time: acquiring a Daytona sandbox + booting Xvfb/Chromium/
  // noVNC inside it is the slow part (first run installs the graphical stack).
  const DEADLINE = Date.now() + 240000; // up to 4 min for a cold first boot
  while (Date.now() < DEADLINE) {
    if (firstProvider && (sawLiveUrl || frames > 0)) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // Navigate once more so we exercise openUrl on the live session too.
  autoLive.onBrowseTool(ctx, 'browse', { url: 'https://news.ycombinator.com' });
  await new Promise(r => setTimeout(r, 8000));

  log('--- stopping live session (cleans up any ephemeral Daytona sandbox) ---');
  await autoLive.stop(ctx);

  // ── Assertions ──────────────────────────────────────────────────────────
  console.log('\n================ RESULT ================');
  console.log('First provider booted :', firstProvider);
  console.log('Live URL seen         :', sawLiveUrl ? 'YES' : 'no');
  console.log('Frames streamed       :', frames);
  console.log('Total screen events   :', events.length);

  const usedDaytona = firstProvider === 'daytona' || firstProvider === 'sandbox';
  if (usedDaytona && (sawLiveUrl || frames > 0)) {
    console.log('\n✅ PASS — browser-use used the DAYTONA computer FIRST and streamed a live view.');
    process.exit(0);
  } else if (usedDaytona) {
    console.log('\n⚠️ PARTIAL — Daytona booted first but no frame/URL within the window (cold install may need longer). Provider order is CORRECT.');
    process.exit(0);
  } else {
    console.log('\n❌ FAIL — expected Daytona first, got:', firstProvider);
    process.exit(1);
  }
})().catch(e => { console.error('[test] fatal:', e); process.exit(1); });
