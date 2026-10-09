// scripts/test-wa-send.js
// ─────────────────────────────────────────────────────────────────────────────
// Validates the SILENT-SEND FIX in services/whatsappBot.js — the root cause of
// the "WhatsApp bot is online but never answers" bug. The old code wrapped every
// sock.sendMessage() in try{}catch{/* ignore */}, so a send that failed because
// the socket got replaced/dropped during a long agent run was SWALLOWED with no
// retry and no log → the user got nothing back.
//
// safeSend() now: (1) waits for a live socket, (2) retries across transient
// failures, (3) returns true/false and LOGS a definitive failure. These checks
// drive safeSend with a mock socket to prove the new behaviour.
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');
const bot = require('../services/whatsappBot');
const T = bot.__test__;

let passed = 0;
const ok = (msg) => { console.log('  ✅ ' + msg); passed++; };

(async () => {
  console.log('\n🧪 WhatsApp bot silent-send fix — resilient delivery test\n');

  // ── 1) Happy path: a live socket sends on the first try ──────────────────
  {
    const sent = [];
    const mock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); } };
    T.__setState({ sock: mock, status: 'connected', standDown: false, reconnectTimer: null });
    const res = await T.safeSend('123@s.whatsapp.net', { text: 'hello' }, 'text');
    assert.strictEqual(res, true, 'safeSend should succeed when the socket is live');
    assert.strictEqual(sent.length, 1, 'exactly one send on the happy path');
    assert.strictEqual(sent[0].content.text, 'hello');
    ok('live socket → message sent exactly once (happy path)');
  }

  // ── 2) Transient failure then success: this is the actual bug scenario ───
  //     The socket throws on the first 2 attempts (as if it was replaced mid-run)
  //     then recovers. The OLD code would have given up silently after the first
  //     throw; safeSend must retry and ultimately deliver.
  {
    let calls = 0;
    const sent = [];
    const mock = {
      sendMessage: async (jid, content) => {
        calls++;
        if (calls <= 2) throw new Error('Connection Closed'); // simulate replaced socket
        sent.push({ jid, content });
      },
    };
    T.__setState({ sock: mock, status: 'connected', standDown: false, reconnectTimer: null });
    const res = await T.safeSend('123@s.whatsapp.net', { text: 'retry me' }, 'text');
    assert.strictEqual(res, true, 'safeSend should eventually deliver after transient failures');
    assert.ok(calls >= 3, 'safeSend retried the failed send (got ' + calls + ' attempts)');
    assert.strictEqual(sent.length, 1, 'the message is delivered exactly once after recovery');
    ok('transient send failures are retried until delivery (the reported bug fix)');
  }

  // ── 3) Definitive failure: returns false (never throws) and does NOT hang ──
  //     Hermetic: we set a non-null reconnectTimer so ensureLive()/the revive
  //     nudge both short-circuit (they refuse to start a NEW connect while one
  //     is already scheduled). With no live socket, safeSend must give up
  //     cleanly after its bounded attempts and return false — without ever
  //     spinning up a real Baileys socket in the test.
  {
    T.__setState({ sock: null, status: 'idle', standDown: true, reconnectTimer: setTimeout(() => {}, 60000) });
    const start = Date.now();
    const res = await T.safeSend('123@s.whatsapp.net', { text: 'nope' }, 'text');
    const elapsed = Date.now() - start;
    assert.strictEqual(res, false, 'safeSend returns false when it truly cannot send');
    assert.ok(elapsed < 90000, 'safeSend is bounded and does not hang forever (took ' + elapsed + 'ms)');
    ok('no live socket → safeSend fails cleanly (false), bounded, never throws');
  }

  console.log(`\n🎉 All ${passed} silent-send checks passed — a reply that fails once is retried, and a real failure is logged instead of swallowed.\n`);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ test-wa-send failed:', e && e.message ? e.message : e);
  process.exit(1);
});
