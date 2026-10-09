'use strict';

const assert = require('assert');
const db = require('../db');
const pool = require('../services/sandboxPool');
const tunnel = require('../services/cloudflareTunnel');

(async () => {
  const saved = new Map();
  const originalGet = db.getSetting;
  const originalSet = db.setSetting;
  const originalNovita = pool.BACKENDS.novita;
  const calls = [];

  db.getSetting = async key => saved.get(key) || '';
  db.setSetting = async (key, value) => { saved.set(key, value); };
  pool.BACKENDS.novita = {
    enabled: () => true,
    getOrCreateSessionSandbox: async (sessionKey, options) => {
      calls.push(['acquire', sessionKey, options]);
      return { id: 'sandbox-test-1', reused: false };
    },
    exec: async (_id, command) => {
      calls.push(['exec', command]);
      if (command.includes('/tmp/powerx_cf_probe')) return { exitCode: 0, output: 'VERIFIED\n' };
      if (command.includes('TUNNEL_URL=')) return { exitCode: 0, output: 'TUNNEL_URL=https://unit-test.trycloudflare.com\nLOCAL_PORT=8888\n' };
      return { exitCode: 0, output: '' };
    },
    pauseSandbox: async id => { calls.push(['pause', id]); return true; },
  };

  try {
    assert.strictEqual(tunnel.isStartCommand('/cloudflare'), true);
    assert.strictEqual(tunnel.isStartCommand('/startcloudflare@my_bot novita'), true);
    assert.strictEqual(tunnel.isStopCommand('/stopcloudflare'), true);
    assert.strictEqual(tunnel.commandProvider('/cloudflare upstash'), 'upstashbox');
    assert.strictEqual(tunnel.commandProvider('/cloudflare'), '');
    assert.throws(() => tunnel.commandProvider('/cloudflare unknown'), /Unsupported provider/);
    assert.strictEqual(tunnel.parseUrl('x https://one.trycloudflare.com y https://two.trycloudflare.com'), 'https://two.trycloudflare.com');

    const script = tunnel._private.installAndStartScript({
      port: 8888, wsPort: 8080, username: 'px_test', password: 'strong-secret', pathSecret: 'path-secret',
    });
    assert.match(script, /Listen 127\.0\.0\.1/);
    assert.match(script, /BasicAuth px_test strong-secret/);
    assert.match(script, /ConnectPort 443/);
    assert.match(script, /ConnectPort 80/);
    assert.match(script, /--restrict-to "127\.0\.0\.1:8888"/);
    assert.match(script, /--restrict-http-upgrade-path-prefix 'path-secret'/);
    assert.match(script, /cloudflared.*--url "http:\/\/127\.0\.0\.1:8080"/s);
    assert.doesNotMatch(script, /Listen 0\.0\.0\.0/);

    const started = await tunnel.start('tg:test-chat', { provider: 'novita' });
    assert.strictEqual(started.verified, true);
    assert.strictEqual(started.url, 'https://unit-test.trycloudflare.com');
    assert.strictEqual(started.wssUrl, 'wss://unit-test.trycloudflare.com');
    assert.strictEqual(started.publicPort, 443);
    assert.strictEqual(started.clientPort, 18888);
    assert.match(started.username, /^px_[a-f0-9]{10}$/);
    assert.ok(started.password.length >= 20);
    assert.ok(started.pathSecret.length >= 30);

    const client = tunnel.clientCommand(started);
    assert.match(client, /^wstunnel client /);
    assert.ok(client.includes(started.pathSecret));
    assert.ok(client.includes(started.wssUrl));
    assert.ok(client.includes('127.0.0.1:18888:127.0.0.1:8888'));

    const persisted = JSON.parse(saved.get('cloudflare_tunnel:tg:test-chat'));
    assert.strictEqual(persisted.sandboxId, 'sandbox-test-1');
    assert.strictEqual(persisted.verifiedAt, started.verifiedAt);
    assert.strictEqual(persisted.username, undefined);
    assert.strictEqual(persisted.password, undefined);
    assert.strictEqual(persisted.pathSecret, undefined);
    assert.ok(calls.some(c => c[0] === 'exec' && c[1].includes('https://example.com/')));

    const stopped = await tunnel.stop('tg:test-chat');
    assert.deepStrictEqual(stopped, { stopped: true, slept: true, provider: 'novita' });
    assert.ok(calls.some(c => c[0] === 'exec' && c[1].includes('wstunnel-server')));
    assert.ok(calls.some(c => c[0] === 'pause' && c[1] === 'sandbox-test-1'));
    assert.strictEqual(saved.get('cloudflare_tunnel:tg:test-chat'), '');

    const stoppedAgain = await tunnel.stop('tg:test-chat');
    assert.deepStrictEqual(stoppedAgain, { stopped: false, slept: false });

    console.log('PASS cloudflare tunnel lifecycle, auth, verification, and sleep controls');
  } finally {
    db.getSetting = originalGet;
    db.setSetting = originalSet;
    pool.BACKENDS.novita = originalNovita;
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
