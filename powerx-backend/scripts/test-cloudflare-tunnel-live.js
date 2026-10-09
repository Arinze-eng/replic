'use strict';

// Live test: provisions each requested provider, installs the proxy/tunnel stack,
// obtains a real trycloudflare URL, traverses it over WebSocket, fetches an HTTPS
// page through the authenticated proxy, stops all processes, then suspends the
// sandbox. Run with LIVE_CLOUDFLARE_PROVIDERS=novita,upstashbox,runloop,tensorlake.

const tunnel = require('../services/cloudflareTunnel');

function providers() {
  const raw = process.env.LIVE_CLOUDFLARE_PROVIDERS || '';
  return raw.split(',').map(tunnel.cleanProvider).filter(Boolean);
}

(async () => {
  const names = providers();
  if (!names.length) {
    console.log('SKIP: set LIVE_CLOUDFLARE_PROVIDERS to run live sandbox tests');
    return;
  }

  const results = [];
  for (const provider of names) {
    const sessionKey = `live:cloudflare:${provider}:${Date.now()}`;
    const startedAt = Date.now();
    let started = null;
    try {
      started = await tunnel.start(sessionKey, { provider });
      if (!started.verified || !/^wss:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(started.wssUrl)) {
        throw new Error('provider returned an unverified or malformed tunnel');
      }
      const stopped = await tunnel.stop(sessionKey);
      if (!stopped.stopped) throw new Error('stop lifecycle did not find the active tunnel');
      results.push({ provider, ok: true, slept: stopped.slept, durationSec: Math.round((Date.now() - startedAt) / 1000) });
      console.log(`PASS ${provider}: external HTTPS proxy traversal verified; stopped=${stopped.stopped}; slept=${stopped.slept}`);
    } catch (error) {
      if (started) await tunnel.stop(sessionKey).catch(() => {});
      results.push({ provider, ok: false, error: error.message, durationSec: Math.round((Date.now() - startedAt) / 1000) });
      console.error(`FAIL ${provider}: ${error.message}`);
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(JSON.stringify({ results, passed: results.length - failed.length, total: results.length }, null, 2));
  if (failed.length) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
