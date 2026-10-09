// ── WhatsApp Online Tracker service (Baileys) ──────────────────────────────
// Links a real WhatsApp account via PAIRING CODE (no QR needed), then
// subscribes to the presence of tracked numbers and logs every
// online/offline transition. Auth creds are persisted in Supabase so the
// session survives Render restarts / cold-starts.
//
// IMPORTANT (Render free plan): the dyno sleeps after ~15 min idle, which
// closes the socket. On wake we auto-reconnect using the persisted creds and
// resubscribe to all active tracked numbers. For true 24/7 tracking a paid
// always-on instance (or a dedicated worker) is required.

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
  jidDecode,
  isLidUser,
  isJidGroup,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const db = require('../db');
let telegram = null;
try { telegram = require('./telegram'); } catch (e) { telegram = null; }

const logger = pino({ level: 'silent' });

// In-memory live state: userId -> { sock, status, presenceCache, lastEvents[], store }
const sessions = new Map();

const SESS_ROOT = path.join(__dirname, '..', 'wa_auth');
if (!fs.existsSync(SESS_ROOT)) fs.mkdirSync(SESS_ROOT, { recursive: true });

function nowMs() { return Date.now(); }
function jidFromPhone(phone) {
  const clean = String(phone).replace(/[^0-9]/g, '');
  return clean + '@s.whatsapp.net';
}
// Raw user part of a jid (digits before @, stripping any :device suffix).
function userPart(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
function phoneFromJid(jid) {
  return userPart(jid);
}
function isLidJid(jid) {
  const s = String(jid || '');
  return s.endsWith('@lid');
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔑 LID ↔ PHONE resolution
//
// Modern WhatsApp identifies many contacts/chats by a "LID" (a privacy-preserving
// linked-id) like `12727777727@lid` INSTEAD of the real phone-number jid
// `2348193737737@s.whatsapp.net`. If we naively read the digits off a @lid jid we
// get a bogus number (the source of the "+12727777727 instead of +2348193737737"
// bug). WhatsApp gives us the authoritative mapping through:
//   • Contact objects:        { id: '<phone>@s.whatsapp.net', lid: '<lid>@lid' }
//   • 'chats.phoneNumberShare': { lid: '<lid>@lid', jid: '<phone>@s.whatsapp.net' }
// We persist both directions per session so any @lid jid can be resolved back to
// the real phone jid before it is ever displayed or recorded.
// ─────────────────────────────────────────────────────────────────────────────
function ensureLidMaps(s) {
  if (!s.lidToPn) s.lidToPn = new Map(); // lidUserPart  -> phoneUserPart
  if (!s.pnToLid) s.pnToLid = new Map(); // phoneUserPart -> lidUserPart
}

// Record a LID <-> phone-number pairing (accepts full jids or bare user parts).
function rememberLidMapping(s, lidJid, pnJid) {
  if (!s || !lidJid || !pnJid) return;
  ensureLidMaps(s);
  const lid = userPart(lidJid);
  const pn = userPart(pnJid);
  if (!lid || !pn || lid === pn) return;
  s.lidToPn.set(lid, pn);
  s.pnToLid.set(pn, lid);
}

// Resolve ANY 1:1 jid to its real phone-number jid. Groups/status/broadcast are
// returned unchanged. If a @lid jid has no known mapping yet we keep it as-is so
// nothing breaks, but we never invent a wrong number.
function resolveRealJid(s, jid) {
  if (!jid) return jid;
  const str = String(jid);
  if (str.endsWith('@g.us') || str === 'status@broadcast' || str.endsWith('@broadcast') || str.endsWith('@newsletter')) {
    return str;
  }
  if (isLidJid(str)) {
    ensureLidMaps(s);
    const pn = s.lidToPn.get(userPart(str));
    if (pn) return pn + '@s.whatsapp.net';
    return str; // unknown mapping → leave untouched (don't fabricate a number)
  }
  // already a phone jid → normalise to the canonical s.whatsapp.net form
  return userPart(str) + '@s.whatsapp.net';
}

// The display phone for a 1:1 jid (resolves LID → real number). Returns digits.
function displayPhone(s, jid) {
  const real = resolveRealJid(s, jid);
  if (isLidJid(real)) return null; // unresolved LID → no trustworthy number
  return userPart(real);
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔎 ACTIVE LID resolution (the real fix for "wrong / foreign-looking numbers")
//
// The passive maps above only fill in when WhatsApp happens to push a contact
// object or a phoneNumberShare event — which on a revived/cold session often
// NEVER arrives, leaving every @lid jid showing its raw (bogus) digits that
// look like a random US/Canada number. WhatsApp exposes an AUTHORITATIVE lookup
// via the USync `onWhatsApp()` query: given a phone it returns the matching lid,
// and given a lid we can round-trip it. We use it to actively populate the map
// the moment we need to display/track a jid, and cache the result so we only
// ask once. Fully best-effort — never throws into the caller.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveJidActive(s, jid) {
  try {
    if (!s || !s.sock || s.status !== 'connected' || !jid) return resolveRealJid(s, jid);
    const str = String(jid);
    if (str.endsWith('@g.us') || str.endsWith('@broadcast') || str.endsWith('@newsletter') || str === 'status@broadcast') return str;
    ensureLidMaps(s);
    // Already mapped? done.
    if (isLidJid(str)) {
      if (s.lidToPn.get(userPart(str))) return resolveRealJid(s, str);
    } else {
      // a phone jid is always trustworthy; make sure we also know its lid
      const pn = userPart(str);
      if (!s.pnToLid.get(pn) && typeof s.sock.onWhatsApp === 'function') {
        try {
          const res = await s.sock.onWhatsApp(pn + '@s.whatsapp.net');
          const hit = Array.isArray(res) ? res[0] : null;
          if (hit && hit.lid) rememberLidMapping(s, hit.lid, pn + '@s.whatsapp.net');
        } catch (e) {}
      }
      return pn + '@s.whatsapp.net';
    }
    // Unmapped LID → ask WhatsApp. onWhatsApp accepts a lid and echoes the real
    // jid in `.jid` when it can resolve it.
    if (typeof s.sock.onWhatsApp === 'function') {
      try {
        const res = await s.sock.onWhatsApp(str);
        const hit = Array.isArray(res) ? res[0] : null;
        if (hit && hit.jid && !isLidJid(hit.jid)) {
          rememberLidMapping(s, str, hit.jid);
          if (s.userId) scheduleStoreSave(s.userId);
          return userPart(hit.jid) + '@s.whatsapp.net';
        }
      } catch (e) {}
    }
    // Last resort: the signal repository keeps a lid↔pn store in newer Baileys.
    try {
      const repo = s.sock.signalRepository;
      const getPn = repo && (repo.lidMapping?.getPNForLID || repo.getPNForLID);
      if (getPn) {
        const pnJid = await getPn.call(repo.lidMapping || repo, str);
        if (pnJid && !isLidJid(pnJid)) {
          rememberLidMapping(s, str, pnJid);
          if (s.userId) scheduleStoreSave(s.userId);
          return userPart(pnJid) + '@s.whatsapp.net';
        }
      }
    } catch (e) {}
    return resolveRealJid(s, jid);
  } catch (e) { return resolveRealJid(s, jid); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 💬 WHATSAPP WEB — lightweight in-memory store
//
// Baileys 6.7 removed makeInMemoryStore, so we keep a tiny per-user store built
// from the socket's history + live events. It holds:
//   • chats:    jid -> { id, name, conversationTimestamp, unreadCount }
//   • messages: jid -> [ proto.IWebMessageInfo, ... ]  (chronological, capped)
//   • contacts: jid -> { id, name, notify }
// This powers the WhatsApp-Web-style chat UI (list chats, open a chat, send).
// ─────────────────────────────────────────────────────────────────────────────
const STORE_MAX_MSGS = 80;        // per-chat message cap (keep memory bounded)
const STORE_MAX_CHATS = 400;

function ensureStore(s) {
  if (!s.store) s.store = { chats: new Map(), messages: new Map(), contacts: new Map() };
  ensureLidMaps(s);
  return s.store;
}

// ─────────────────────────────────────────────────────────────────────────────
// 💾 STORE PERSISTENCE
//
// The chat store is in-memory only, so on a Render cold-start (free dyno sleeps
// after ~15 min) the chat list comes back EMPTY until brand-new messages arrive
// — which is exactly the "WhatsApp Web doesn't load chats" bug. To fix it we
// snapshot the store to a file inside the per-user auth dir. That dir is already
// mirrored to Supabase by loadAuthState().persist(), so the chat list now
// survives restarts and is restored the moment the session is revived.
//
// The snapshot file is named with a leading "__" so useMultiFileAuthState()
// never mistakes it for a Baileys credential/key file.
// ─────────────────────────────────────────────────────────────────────────────
const STORE_FILE = '__wastore.json';

function storePath(userId) {
  return path.join(SESS_ROOT, userId, STORE_FILE);
}

// Serialise the store (Maps → plain objects), keeping only what the UI needs so
// the snapshot stays small enough to round-trip through the DB.
function serializeStore(s) {
  if (!s || !s.store) return null;
  const st = s.store;
  const chats = {};
  for (const [jid, c] of st.chats) chats[jid] = c;
  const messages = {};
  for (const [jid, arr] of st.messages) {
    // cap per-chat messages in the snapshot to keep size bounded
    messages[jid] = arr.slice(-STORE_MAX_MSGS);
  }
  const contacts = {};
  for (const [jid, c] of st.contacts) contacts[jid] = c;
  const lidToPn = {};
  if (s.lidToPn) for (const [k, v] of s.lidToPn) lidToPn[k] = v;
  const pnToLid = {};
  if (s.pnToLid) for (const [k, v] of s.pnToLid) pnToLid[k] = v;
  return { v: 1, chats, messages, contacts, lidToPn, pnToLid, savedAt: Date.now() };
}

// Hydrate the store from a previously-saved snapshot (plain objects → Maps).
function hydrateStore(s, snap) {
  if (!snap || typeof snap !== 'object') return;
  ensureStore(s);
  try {
    for (const [k, v] of Object.entries(snap.lidToPn || {})) s.lidToPn.set(k, v);
    for (const [k, v] of Object.entries(snap.pnToLid || {})) s.pnToLid.set(k, v);
    for (const [jid, c] of Object.entries(snap.chats || {})) {
      if (jid && !isStatusJid(jid)) s.store.chats.set(jid, c);
    }
    for (const [jid, arr] of Object.entries(snap.messages || {})) {
      if (jid && Array.isArray(arr)) s.store.messages.set(jid, arr);
    }
    for (const [jid, c] of Object.entries(snap.contacts || {})) {
      if (jid) s.store.contacts.set(jid, c);
    }
  } catch (e) { /* never break revive on a bad snapshot */ }
}

// Restore the store from disk for a user (called when a session is (re)started).
function loadStoreFromDisk(s, userId) {
  try {
    const p = storePath(userId);
    if (fs.existsSync(p)) {
      const snap = JSON.parse(fs.readFileSync(p, 'utf-8'));
      hydrateStore(s, snap);
    }
  } catch (e) { /* ignore corrupt snapshot */ }
}

// Throttled save of the store to disk + DB (via the wrapped saveCreds/persist).
function scheduleStoreSave(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  if (s._storeSaveTimer) return; // already queued
  s._storeSaveTimer = setTimeout(async () => {
    s._storeSaveTimer = null;
    try {
      const snap = serializeStore(s);
      if (!snap) return;
      const dir = path.join(SESS_ROOT, userId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(storePath(userId), JSON.stringify(snap));
      // Mirror the whole auth dir (incl. the store file) to the DB so it
      // survives a cold start. persistCreds is attached in startSession().
      if (typeof s.persistCreds === 'function') await s.persistCreds();
    } catch (e) { /* best-effort */ }
  }, 4000); // coalesce bursts of events into one write every ~4s
}

function contactName(s, jid) {
  const st = ensureStore(s);
  // try both the given jid and its resolved real jid
  const real = resolveRealJid(s, jid);
  for (const key of [jid, real]) {
    const c = st.contacts.get(key);
    if (c && (c.name || c.notify)) return c.name || c.notify;
    const ch = st.chats.get(key);
    if (ch && ch.name) return ch.name;
  }
  return null;
}

function isGroupJid(jid) { return String(jid).endsWith('@g.us'); }
function isStatusJid(jid) { return String(jid) === 'status@broadcast'; }

function upsertChat(s, jid, fields = {}) {
  if (!jid || isStatusJid(jid)) return;
  const st = ensureStore(s);
  // Always key chats by the resolved REAL jid so a contact that arrives as a
  // @lid jid lands in the same record as its phone-number jid (no duplicate /
  // wrong-number chat rows).
  jid = resolveRealJid(s, jid);
  const prev = st.chats.get(jid) || { id: jid };
  st.chats.set(jid, { ...prev, ...fields, id: jid });
  // trim if we somehow exceed the cap
  if (st.chats.size > STORE_MAX_CHATS) {
    const oldest = [...st.chats.entries()].sort(
      (a, b) => (a[1].conversationTimestamp || 0) - (b[1].conversationTimestamp || 0)
    )[0];
    if (oldest) st.chats.delete(oldest[0]);
  }
}

// Merge a chat stored under an unresolved @lid jid into its real phone jid once
// the LID→phone mapping becomes known. Moves messages + chat metadata so the UI
// shows ONE chat with the correct number (no duplicate / foreign-looking row).
function remapChatJid(s, fromJid, toJid) {
  if (!s || !s.store || !fromJid || !toJid || fromJid === toJid) return;
  const st = s.store;
  const fromMsgs = st.messages.get(fromJid) || [];
  if (fromMsgs.length) {
    const toMsgs = st.messages.get(toJid) || [];
    const seen = new Set(toMsgs.map(m => m.key?.id));
    for (const m of fromMsgs) { if (!seen.has(m.key?.id)) toMsgs.push(m); }
    toMsgs.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
    if (toMsgs.length > STORE_MAX_MSGS) toMsgs.splice(0, toMsgs.length - STORE_MAX_MSGS);
    st.messages.set(toJid, toMsgs);
  }
  st.messages.delete(fromJid);
  const fromChat = st.chats.get(fromJid);
  const toChat = st.chats.get(toJid) || { id: toJid };
  if (fromChat) {
    st.chats.set(toJid, {
      ...fromChat, ...toChat, id: toJid,
      conversationTimestamp: Math.max(fromChat.conversationTimestamp || 0, toChat.conversationTimestamp || 0),
      unreadCount: (fromChat.unreadCount || 0) || (toChat.unreadCount || 0),
    });
  }
  st.chats.delete(fromJid);
}

function pushMessage(s, msg, { toFront = false } = {}) {
  const rawJid = msg?.key?.remoteJid;
  if (!rawJid || isStatusJid(rawJid)) return;
  const st = ensureStore(s);
  // Canonicalise the chat jid (LID → real phone jid) so history + live messages
  // for the same person are stored under one key.
  const jid = resolveRealJid(s, rawJid);
  let arr = st.messages.get(jid);
  if (!arr) { arr = []; st.messages.set(jid, arr); }
  const id = msg.key?.id;
  // de-dupe by message id
  if (id && arr.some(m => m.key?.id === id)) {
    // update existing (e.g. status/edit)
    const i = arr.findIndex(m => m.key?.id === id);
    arr[i] = { ...arr[i], ...msg };
  } else if (toFront) {
    arr.unshift(msg);
  } else {
    arr.push(msg);
  }
  // keep chronological by messageTimestamp, cap length
  arr.sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
  if (arr.length > STORE_MAX_MSGS) arr.splice(0, arr.length - STORE_MAX_MSGS);
  // bump chat ordering + name
  const ts = Number(msg.messageTimestamp || Math.floor(Date.now() / 1000));
  const ch = st.chats.get(jid) || { id: jid };
  const patch = { conversationTimestamp: Math.max(ts, ch.conversationTimestamp || 0) };
  if (!ch.name && msg.pushName && !msg.key?.fromMe) patch.name = msg.pushName;
  upsertChat(s, jid, patch);
  // Persist after any message change (covers sends/replies/forwards that call
  // pushMessage directly outside the socket event handlers).
  if (s.userId) scheduleStoreSave(s.userId);
}

// Extract a plain-text preview + type from a Baileys message node.
// `s` (optional) is the session, used to resolve quoted-reply context, reactions
// and LID participant numbers for richer WhatsApp-Web-style rendering.
function describeMessage(m, s = null) {
  // Unwrap ephemeral / view-once / device-sent wrappers so we read real content.
  let content = m.message || {};
  let viewOnce = false;
  if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) { content = content.viewOnceMessage.message; viewOnce = true; }
  if (content.viewOnceMessageV2?.message) { content = content.viewOnceMessageV2.message; viewOnce = true; }
  if (content.viewOnceMessageV2Extension?.message) { content = content.viewOnceMessageV2Extension.message; viewOnce = true; }
  if (content.documentWithCaptionMessage?.message) content = content.documentWithCaptionMessage.message;
  // some clients flag viewOnce directly on the media node
  if (!viewOnce) viewOnce = !!(content.imageMessage?.viewOnce || content.videoMessage?.viewOnce || content.audioMessage?.viewOnce);

  const type = getContentType(content) || Object.keys(content)[0] || '';
  let text = '';
  let mediaType = null;
  let extra = {};
  switch (type) {
    case 'conversation': text = content.conversation || ''; break;
    case 'extendedTextMessage': text = content.extendedTextMessage?.text || ''; break;
    case 'imageMessage': text = content.imageMessage?.caption || ''; mediaType = 'image'; break;
    case 'videoMessage':
      text = content.videoMessage?.caption || '';
      mediaType = content.videoMessage?.gifPlayback ? 'gif' : 'video';
      break;
    case 'audioMessage':
      text = '';
      mediaType = 'audio';
      extra.ptt = !!content.audioMessage?.ptt;          // voice note vs audio file
      extra.seconds = content.audioMessage?.seconds || 0;
      break;
    case 'documentMessage': text = content.documentMessage?.fileName || 'Document'; mediaType = 'document'; break;
    case 'stickerMessage': text = ''; mediaType = 'sticker'; break;
    case 'locationMessage':
      text = '📍 Location';
      extra.lat = content.locationMessage?.degreesLatitude;
      extra.lng = content.locationMessage?.degreesLongitude;
      break;
    case 'liveLocationMessage': text = '📍 Live location'; break;
    case 'contactMessage':
      text = '👤 ' + (content.contactMessage?.displayName || 'Contact');
      extra.vcard = content.contactMessage?.vcard || null;
      break;
    case 'contactsArrayMessage': text = '👤 Contacts'; break;
    case 'reactionMessage': text = content.reactionMessage?.text || '👍'; break;
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      text = '📊 ' + (content[type]?.name || 'Poll'); break;
    case 'protocolMessage': return null; // system/revoke/edit envelope — skip
    default: text = ''; break;
  }

  // Quoted / reply context (so the UI can render the "replying to" snippet).
  let quoted = null;
  const ctx = content[type]?.contextInfo || content.extendedTextMessage?.contextInfo;
  if (ctx?.quotedMessage) {
    const qd = describeMessage({ message: ctx.quotedMessage, key: { id: ctx.stanzaId, participant: ctx.participant } }, s);
    if (qd) {
      quoted = {
        id: ctx.stanzaId || null,
        text: qd.text || (qd.mediaType ? '[' + qd.mediaType + ']' : ''),
        mediaType: qd.mediaType || null,
        author: s ? (contactName(s, ctx.participant) || displayPhone(s, ctx.participant)) : null,
      };
    }
  }
  const mentions = ctx?.mentionedJid || [];
  const isForwarded = !!(ctx?.isForwarded || (ctx?.forwardingScore > 0));

  // Reactions attached to this message (Baileys stores them on .reactions).
  const reactions = Array.isArray(m.reactions)
    ? m.reactions.filter(r => r?.text).map(r => ({ emoji: r.text, fromMe: !!r.key?.fromMe }))
    : [];

  return {
    id: m.key?.id,
    fromMe: !!m.key?.fromMe,
    participant: m.key?.participant || null,
    participantPhone: (s && m.key?.participant) ? displayPhone(s, m.key.participant) : null,
    pushName: m.pushName || null,
    timestamp: Number(m.messageTimestamp || 0) * 1000,
    type,
    mediaType,
    text,
    hasMedia: !!mediaType,
    viewOnce,
    quoted,
    isForwarded,
    mentions,
    reactions,
    status: m.status || null,    // 1=pending 2=server 3=delivered 4=read 5=played
    ...extra,
  };
}

// ── Auth state: load creds from Supabase into a local folder, then use
//    useMultiFileAuthState, and mirror creds.json back to Supabase on save.
async function loadAuthState(userId) {
  const dir = path.join(SESS_ROOT, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Restore persisted creds (if any) from DB → local files
  try {
    const sess = await db.getWaSession(userId);
    if (sess && sess.creds) {
      const files = typeof sess.creds === 'string' ? JSON.parse(sess.creds) : sess.creds;
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
      }
    }
  } catch (e) { console.error('WA loadAuth restore error:', e.message); }

  const { state, saveCreds } = await useMultiFileAuthState(dir);

  // Wrap saveCreds to also persist the whole folder to DB
  const persist = async () => {
    try {
      await saveCreds();
      const files = {};
      for (const f of fs.readdirSync(dir)) {
        files[f] = fs.readFileSync(path.join(dir, f), 'utf-8');
      }
      await db.upsertWaSession(userId, { creds: files, updated_at: db.nowISO() });
    } catch (e) { console.error('WA persist creds error:', e.message); }
  };

  return { state, saveCreds: persist, dir };
}

function pushEvent(userId, evt) {
  const s = sessions.get(userId);
  if (!s) return;
  s.eventSeq = (s.eventSeq || 0) + 1;
  s.lastEvents.unshift({ id: s.eventSeq, ...evt, time: new Date().toISOString() });
  if (s.lastEvents.length > 100) s.lastEvents.pop();
}

// ── Record a presence transition (only on change) ──
async function recordPresence(userId, phone, status) {
  const s = sessions.get(userId);
  if (!s) return;
  const prev = s.presenceCache.get(phone);
  if (prev === status) return; // no change → skip
  s.presenceCache.set(phone, status);

  pushEvent(userId, { phone, status });
  try {
    const tracked = await db.getWaTrackedByPhone(userId, phone);
    if (tracked) {
      await db.saveWaPresenceLog({ user_id: userId, tracked_id: tracked.id, phone, status, ts: nowMs() });
      const upd = { last_status: status, last_status_at: db.nowISO() };
      if (status === 'online') upd.last_seen_at = db.nowISO();
      await db.updateWaTracked(tracked.id, upd);
    }
    // Push the online/offline alert to the user's Telegram chat
    if (telegram && telegram.enabled()) {
      const name = (tracked && tracked.nickname) ? tracked.nickname : ('+' + phone);
      const emoji = status === 'online' ? '🟢' : '⚪';
      const verb = status === 'online' ? 'is now <b>ONLINE</b>' : 'went <b>offline</b>';
      telegram.notifyUser(userId, `${emoji} ${name} ${verb}`).catch(() => {});
    }
  } catch (e) { console.error('WA recordPresence error:', e.message); }
}

// ── Subscribe to all active tracked numbers for a user ──
// We do TWO things per number, which is what makes online detection work even
// when the target has "Last Seen" hidden:
//   1) presenceSubscribe(jid)  — opens the live presence feed for that contact.
//      WhatsApp's "Last Seen = Nobody" only hides the *timestamp*; the live
//      `available` / `unavailable` presence push is still delivered to a
//      subscribed device. (Only the separate "Online = Nobody" setting can
//      suppress it — nothing client-side can bypass that.)
//   2) A tiny self-presence ping (sendPresenceUpdate) keeps our own socket in
//      the "active" state so the server keeps streaming presence to us.
//      We immediately revert to invisible so we never announce ourselves.
async function subscribeAllTracked(userId) {
  const s = sessions.get(userId);
  if (!s || !s.sock || s.status !== 'connected') return;
  try {
    const tracked = await db.getWaTracked(userId);
    for (const t of tracked) {
      if (!t.is_active) continue;
      const jid = t.jid || jidFromPhone(t.phone);
      try { await s.sock.presenceSubscribe(jid); } catch (e) {}
    }
  } catch (e) { console.error('WA subscribeAll error:', e.message); }
}

// ── Presence keep-alive ──────────────────────────────────────────────────
// WhatsApp silently expires presence subscriptions after a while, and a hidden
// "Last Seen" makes the feed go quiet between transitions — so a target can
// come online and we'd miss the `available` push if our subscription lapsed.
// This loop re-arms every subscription on a short interval, guaranteeing we
// receive the next online event. It is fully self-contained and wrapped so it
// can never crash the socket or leak errors to the user.
// 🔧 STABILITY FIX: the old 20s loop toggled our own presence
// available→unavailable every 20 seconds. On the linked account that made the
// "last seen / online" status flap constantly (it fired far too often) and put
// needless load on the socket. Re-subscribing to a contact's presence does NOT
// require us to announce ourselves as "available" first — presenceSubscribe
// alone keeps the feed flowing. So we (a) run the loop on a calmer 60s cadence
// and (b) only nudge our own presence occasionally, then immediately revert,
// instead of every single cycle.
const KEEPALIVE_MS = 60 * 1000; // re-subscribe every 60s while connected (was 20s — too chatty)

async function presenceKeepAlive(userId) {
  const s = sessions.get(userId);
  if (!s || !s.sock || s.status !== 'connected') return;
  try {
    // Primary job: re-arm presence subscriptions so we keep receiving the
    // tracked contacts' online/offline pushes. This alone is enough to keep
    // the feed alive and does NOT change our own visible status.
    await subscribeAllTracked(userId);
    // Only every ~5 minutes give the socket a *brief* "available" nudge to keep
    // the server streaming presence, then immediately revert to invisible. This
    // stops the constant last-seen flapping while still preventing the feed from
    // going fully quiet on accounts that hide Last Seen.
    s._keepAliveTick = (s._keepAliveTick || 0) + 1;
    if (s._keepAliveTick % 5 === 0) {
      try { await s.sock.sendPresenceUpdate('available'); } catch (e) {}
      try { await s.sock.sendPresenceUpdate('unavailable'); } catch (e) {}
    }
  } catch (e) { /* silent — never break the session */ }
}

function startKeepAlive(userId) {
  const s = sessions.get(userId);
  if (!s) return;
  if (s.keepAliveTimer) return; // already running
  s.keepAliveTimer = setInterval(() => {
    presenceKeepAlive(userId).catch(() => {});
  }, KEEPALIVE_MS);
}

function stopKeepAlive(userId) {
  const s = sessions.get(userId);
  if (s && s.keepAliveTimer) {
    clearInterval(s.keepAliveTimer);
    s.keepAliveTimer = null;
  }
}

// ── Core: start (or restart) a socket for a user ──
async function startSession(userId, { phoneNumber = null } = {}) {
  // Reuse a live connecting/connected session
  const existing = sessions.get(userId);
  if (existing && existing.sock && (existing.status === 'connected' || existing.status === 'connecting')) {
    return existing;
  }
  // Single-flight guard: if a start is already in progress for this user, don't
  // spawn a SECOND socket on the same creds — two live sockets sharing one
  // WhatsApp identity endlessly kick each other off (stream error 440
  // "connectionReplaced"), which is why history never syncs and chats stay
  // empty. Return the in-flight session instead of racing it.
  if (existing && existing._starting) {
    return existing;
  }
  if (existing) existing._starting = true;

  // Tear down any lingering previous socket before opening a new one so we
  // never leave two sockets fighting over the same session.
  if (existing && existing.sock) {
    try { existing.sock.ev.removeAllListeners(); } catch (e) {}
    try { existing.sock.end(new Error('replacing socket')); } catch (e) {}
    existing.sock = null;
  }


  const { state, saveCreds } = await loadAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();

  // Pairing-code linking requires identifying as a phone-capable browser.
  // Browsers.macOS('Safari') is the most reliable identity for the
  // "Link with phone number" flow on current WhatsApp servers.
  const usePairingCode = !!(phoneNumber && !state.creds.registered);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.macOS('Safari'),
    // 🩹 STABILITY (Baileys 6.7.23): explicit keep-alive + generous timeouts so
    // a half-dead WebSocket on Render's free dyno is detected and reconnected
    // quickly instead of silently going quiet (the "tracker stops updating after
    // a while" symptom). 25s here (vs the bot's 20s) keeps presence flowing.
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 25000,
    retryRequestDelayMs: 350,
    // Pull the full chat history on link/connect so the WhatsApp-Web UI has
    // chats to show (the previous `false` is the main reason the list came up
    // empty). Combined with shouldSyncHistoryMessage below, Baileys streams the
    // recent chats/messages via 'messaging-history.set' which we store.
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    markOnlineOnConnect: false, // stay invisible — don't announce our own presence
    generateHighQualityLinkPreview: false,
    // getMessage lets Baileys resend/decrypt from our store when needed.
    getMessage: async (key) => {
      try {
        const cur = sessions.get(userId);
        if (cur && cur.store) {
          const arr = cur.store.messages.get(resolveRealJid(cur, key.remoteJid)) || [];
          const m = arr.find(x => x.key?.id === key.id);
          if (m) return m.message || undefined;
        }
      } catch (e) {}
      return undefined;
    },
  });

  const s = existing || { lastEvents: [], eventSeq: 0 };
  s.sock = sock;
  s.userId = userId; // used by scheduleStoreSave() from inside pushMessage()
  s._starting = true; // an active start is in progress (cleared on open/close)
  s.status = 'connecting';
  s.presenceCache = s.presenceCache || new Map();
  s.pairingCode = s.pairingCode || null;
  s.lastError = null;
  // Safety: never let the single-flight lock get stuck if a connection event
  // never arrives (e.g. the socket silently stalls). Auto-clear after 45s so a
  // later revive can retry.
  if (s._startGuard) clearTimeout(s._startGuard);
  s._startGuard = setTimeout(() => { if (s) s._starting = false; }, 45000);
  // Expose the DB-mirroring creds persister so the store-saver can flush the
  // whole auth dir (incl. the chat snapshot) to Supabase on a throttle.
  s.persistCreds = saveCreds;
  sessions.set(userId, s);


  // Bring back any chat list we snapshotted before the last restart so the UI
  // shows chats immediately on revive — even before history re-syncs.
  ensureStore(s);
  loadStoreFromDisk(s, userId);

  await db.upsertWaSession(userId, { user_id: userId, status: 'connecting', updated_at: db.nowISO() });


  // ── Request a pairing code (only when not yet registered) ──
  // Baileys 6.7+: requestPairingCode MUST be called only AFTER the socket has
  // produced its first connection ref (the `qr` field on a 'connection.update'
  // event). Calling it on a blind setTimeout — before that ref exists — makes
  // WhatsApp hand back a code that is NOT actually registered for the
  // "Link with phone number" flow: the code displays, but entering it on the
  // phone does nothing and NO link-device notification fires. That was the
  // regression after the Baileys 6.6→6.7 upgrade.
  //
  // Fix: arm a one-shot requester that fires the instant the first ref arrives
  // (handled in the 'connection.update' listener below via s._firePairing).
  // A long fallback timer only kicks in if the ref never shows up, so we still
  // degrade gracefully instead of hanging forever.
  if (usePairingCode) {
    const clean = String(phoneNumber).replace(/[^0-9]/g, '');
    s.pairingPhone = clean;
    s._pairRequested = false; // becomes true once a code request is in flight

    const requestCode = async (attempt = 1) => {
      // Stop if we already linked, already produced a code, or this socket
      // was replaced by a newer start.
      if (s.sock !== sock) return;
      if (s.pairingCode || s.status === 'connected') return;
      s._pairRequested = true;
      try {
        const code = await sock.requestPairingCode(clean);
        if (s.sock !== sock) return; // socket swapped mid-await
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        s.pairingCode = pretty;
        s.status = 'pairing';
        await db.upsertWaSession(userId, { status: 'pairing', pairing_code: pretty, phone: clean, updated_at: db.nowISO() });
        pushEvent(userId, { type: 'pairing', code: pretty });
        console.log(`WA pairing code for ${clean}: ${pretty}`);
      } catch (e) {
        console.error(`WA requestPairingCode attempt ${attempt} error:`, e.message);
        s._pairRequested = false; // allow a retry to re-arm
        if (attempt < 5) {
          setTimeout(() => requestCode(attempt + 1), 2500);
        } else {
          s.status = 'error';
          s.lastError = e.message;
          await db.upsertWaSession(userId, { status: 'error', updated_at: db.nowISO() }).catch(() => {});
        }
      }
    };

    // Primary trigger: the 'connection.update' handler calls this the moment
    // the first connection ref (qr) is emitted — that is the only point at
    // which WhatsApp will register the code for the link-device flow.
    s._firePairing = () => {
      if (s._pairRequested || s.pairingCode || s.status === 'connected') return;
      requestCode(1);
    };

    // Fallback safety net: if no ref event arrives within ~8s (rare network
    // stalls), try anyway so the user is never left without a code.
    setTimeout(() => { if (!s._pairRequested) s._firePairing(); }, 8000);
  }

  sock.ev.on('creds.update', saveCreds);

  // ── 💬 WhatsApp Web store sync ──────────────────────────────────────────
  // Build/maintain the per-user chat+message store from Baileys events so the
  // WhatsApp-Web-style UI can list chats, show history, and stream new messages.
  ensureStore(s);

  // Helper: record a contact, capturing its LID↔phone mapping when present.
  const ingestContact = (c) => {
    if (!c?.id) return;
    if (c.lid) rememberLidMapping(s, c.lid, c.id);
    // store under the canonical real jid
    const key = resolveRealJid(s, c.id);
    const prev = s.store.contacts.get(key) || { id: key };
    s.store.contacts.set(key, {
      id: key,
      lid: c.lid || prev.lid || null,
      name: c.name ?? prev.name ?? null,
      notify: c.notify ?? prev.notify ?? null,
    });
  };

  // Authoritative LID → phone mapping pushed by the server.
  sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
    try { rememberLidMapping(s, lid, jid); } catch (e) {}
  });

  // Initial history sync (fired once after connect with recent chats/messages).
  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
    try {
      for (const c of contacts) ingestContact(c);
      for (const c of chats) {
        if (c?.id) upsertChat(s, c.id, {
          name: c.name || undefined,
          conversationTimestamp: Number(c.conversationTimestamp || 0),
          unreadCount: c.unreadCount || 0,
        });
      }
      for (const m of messages) { if (m?.message) pushMessage(s, m); }
      scheduleStoreSave(userId); // snapshot the freshly-synced chat list
    } catch (e) { /* never break the socket */ }
  });

  sock.ev.on('chats.upsert', (chats) => {
    try { for (const c of chats) if (c?.id) upsertChat(s, c.id, { name: c.name || undefined, conversationTimestamp: Number(c.conversationTimestamp || 0), unreadCount: c.unreadCount || 0 }); scheduleStoreSave(userId); } catch (e) {}
  });
  sock.ev.on('chats.update', (updates) => {
    try { for (const c of updates) if (c?.id) upsertChat(s, c.id, { conversationTimestamp: c.conversationTimestamp ? Number(c.conversationTimestamp) : undefined, unreadCount: c.unreadCount }); scheduleStoreSave(userId); } catch (e) {}
  });
  sock.ev.on('contacts.upsert', (contacts) => {
    try { for (const c of contacts) ingestContact(c); scheduleStoreSave(userId); } catch (e) {}
  });
  sock.ev.on('contacts.update', (updates) => {
    try { for (const c of updates) ingestContact(c); scheduleStoreSave(userId); } catch (e) {}
  });

  // Live incoming/outgoing messages.
  sock.ev.on('messages.upsert', ({ messages = [], type }) => {
    try {
      for (const m of messages) {
        if (!m?.message) continue;
        const rawJid = m.key?.remoteJid;
        if (!rawJid || isStatusJid(rawJid)) continue;
        pushMessage(s, m);
        let jid = resolveRealJid(s, rawJid); // canonical chat key
        // If the chat is still an unresolved @lid, actively resolve it so the
        // contact shows its REAL phone number (not a bogus foreign-looking one).
        // When the mapping arrives we re-key the chat/messages onto the real jid.
        if (isLidJid(jid)) {
          resolveJidActive(s, rawJid).then(real => {
            if (real && !isLidJid(real) && real !== jid) { remapChatJid(s, jid, real); scheduleStoreSave(userId); }
          }).catch(() => {});
        }
        // One-time history bootstrap for ALREADY-LINKED sessions: the full chat
        // list only arrives via the initial history sync on a fresh pairing, so
        // a session linked before this fix starts with an empty list. The first
        // real message gives us a valid anchor key — use it to ask the phone for
        // a big batch of history, which WhatsApp returns as messaging-history.set
        // (syncType ON_DEMAND) and repopulates the chat list.
        if (!s._historyBootstrapped && typeof s.sock?.fetchMessageHistory === 'function') {
          s._historyBootstrapped = true;
          s.sock.fetchMessageHistory(50, m.key, Number(m.messageTimestamp || 0)).catch(() => {});
          setTimeout(() => scheduleStoreSave(userId), 7000);
        }
        // Notify the dashboard's event feed (used by the WA Web UI to refresh).
        if (type === 'notify' && !m.key?.fromMe) {
          const d = describeMessage(m);
          const fromLabel = m.pushName || displayPhone(s, rawJid) || phoneFromJid(rawJid);
          pushEvent(userId, { type: 'message', jid, preview: (d?.text || '[media]').slice(0, 80), from: fromLabel });
          // bump unread
          const ch = s.store.chats.get(jid);
          upsertChat(s, jid, { unreadCount: (ch?.unreadCount || 0) + 1 });
        }
      }
      scheduleStoreSave(userId); // persist new messages so they survive restarts
    } catch (e) { /* swallow */ }
  });


  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── Pairing trigger ──────────────────────────────────────────────────
    // The first time WhatsApp emits a connection ref (`qr`) the socket is
    // ready to register a pairing code for the "Link with phone number" flow.
    // This is the ONLY moment that produces a code WhatsApp will actually
    // honour (and that fires the link-device notification on the user's
    // phone). Fire the one-shot requester armed above.
    if (qr && usePairingCode && typeof s._firePairing === 'function') {
      s._firePairing();
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.pairingCode = null;
      s._starting = false;        // start finished
      s._reconnects = 0;          // healthy connection → reset backoff
      s._conflicts = 0;
      const myPhone = sock.user?.id ? phoneFromJid(sock.user.id) : null;
      await db.upsertWaSession(userId, {
        status: 'connected', pairing_code: null,
        phone: myPhone || undefined,
        last_connected_at: db.nowISO(), updated_at: db.nowISO()
      });
      pushEvent(userId, { type: 'connected', phone: myPhone });
      // Notify Telegram that linking succeeded — the website now unlocks tracking
      if (telegram && telegram.enabled()) {
        telegram.notifyUser(userId,
          `🎉 <b>WhatsApp linked successfully!</b>${myPhone ? ('\n📱 ' + myPhone) : ''}\n\n` +
          `You can now go back to the website and add numbers to track. I’ll alert you here whenever a tracked number goes online or offline. 🟢`
        ).catch(() => {});
      }
      // Resubscribe to everything we track
      await subscribeAllTracked(userId);
      // Start the presence keep-alive so we keep getting online events even
      // when a tracked number has "Last Seen" hidden.
      startKeepAlive(userId);
      // Backfill the chat list if history sync was sparse (common on a revive
      // with already-registered creds). We ask WhatsApp for older history off
      // the most-recent messages we know about, then snapshot the result.
      backfillChats(userId).catch(() => {});
      scheduleStoreSave(userId);
    } else if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : (lastDisconnect?.error?.output?.statusCode || 0);
      const loggedOut = code === DisconnectReason.loggedOut;
      const restartRequired = code === DisconnectReason.restartRequired; // 515 — normal right after pairing
      const connReplaced = code === DisconnectReason.connectionReplaced || code === 440; // 440 — another socket took over
      s.status = loggedOut ? 'disconnected' : 'reconnecting';
      s._starting = false;        // this start attempt has ended
      stopKeepAlive(userId); // pause keep-alive while disconnected
      await db.upsertWaSession(userId, { status: s.status, updated_at: db.nowISO() });
      pushEvent(userId, { type: 'disconnected', loggedOut, code });

      if (loggedOut) {
        // Session invalidated — clear creds so user can re-link
        try {
          const dir = path.join(SESS_ROOT, userId);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          await db.upsertWaSession(userId, { creds: null, status: 'disconnected', updated_at: db.nowISO() });
        } catch (e) {}
        sessions.delete(userId);
      } else if (connReplaced) {
        // 440 connectionReplaced: ANOTHER socket is using these creds (e.g. a
        // duplicate revive, or the user opened WhatsApp Web elsewhere). If we
        // instantly reconnect we just kick that socket off and it kicks us back
        // — an endless flap that prevents history sync (the "chats won't load"
        // bug). Back off with a growing delay and give up after several tries so
        // only ONE socket survives and history can finally complete.
        s._conflicts = (s._conflicts || 0) + 1;
        if (s._conflicts <= 3) {
          const delay = Math.min(8000 * s._conflicts, 30000);
          setTimeout(() => { startSession(userId).catch(() => {}); }, delay);
        } else {
          // Repeatedly replaced → stand down. The surviving socket keeps the
          // session alive; a later getStatus()/revive will re-establish if it
          // truly drops. This stops the fight loop.
          console.log(`WA ${userId}: standing down after ${s._conflicts} connectionReplaced (440) events`);
          stopKeepAlive(userId);
        }
      } else {
        // Transient drop (incl. 515 restartRequired after a successful pair):
        // reconnect with a light backoff so the freshly-registered creds come
        // online without hammering on repeated failures.
        s._reconnects = (s._reconnects || 0) + 1;
        const delay = restartRequired ? 1000 : Math.min(4000 * s._reconnects, 20000);
        setTimeout(() => { startSession(userId).catch(() => {}); }, delay);
      }
    }
  });

  // ── Presence events: the heart of the tracker ──
  sock.ev.on('presence.update', async ({ id, presences }) => {
    if (!presences) return;
    // The contact id may arrive as a @lid jid — resolve to the real phone so
    // presence is recorded under the SAME number the user is tracking. If the
    // mapping isn't known yet, actively resolve it (best-effort) so a tracked
    // Nigerian number never gets logged under a bogus foreign-looking one.
    let phone = displayPhone(s, id);
    if (!phone) {
      try { const real = await resolveJidActive(s, id); phone = isLidJid(real) ? phoneFromJid(id) : userPart(real); }
      catch (e) { phone = phoneFromJid(id); }
    }
    // Live presence/typing hint for the open WhatsApp-Web chat header.
    try {
      const realJid = resolveRealJid(s, id);
      const states = Object.values(presences).map(p => p?.lastKnownPresence).filter(Boolean);
      const composing = states.includes('composing') || states.includes('recording');
      const available = states.includes('available') || composing;
      s.presenceLive = s.presenceLive || new Map();
      s.presenceLive.set(realJid, { online: available, typing: composing, at: Date.now() });
    } catch (e) {}
    // presences is keyed by participant jid; for 1:1 it's the contact itself
    for (const participant of Object.keys(presences)) {
      const p = presences[participant];
      const lastKnown = p?.lastKnownPresence; // 'available' | 'unavailable' | 'composing' | ...
      if (!lastKnown) continue;
      const isOnline = lastKnown === 'available' || lastKnown === 'composing' || lastKnown === 'recording';
      await recordPresence(userId, phone, isOnline ? 'online' : 'offline');
    }
  });

  // ── 📞 Incoming call detection + log ──────────────────────────────────────
  // Baileys is a protocol library with NO media/WebRTC stack, so it can NOT
  // place or answer real WhatsApp voice/video calls. What it CAN do reliably is
  // observe the call signalling: we receive a 'call' event for every incoming
  // call (offer/ringing/timeout/reject/accept/terminate). We log these into the
  // per-user call history, surface them to the UI, optionally auto-reject, and
  // let the user reject from the web UI. This is the honest, working subset.
  s.calls = s.calls || [];
  sock.ev.on('call', async (calls) => {
    try {
      for (const c of calls) {
        const fromJid = c.from || c.chatId;
        let phone = displayPhone(s, fromJid);
        if (!phone) { try { const r = await resolveJidActive(s, fromJid); phone = isLidJid(r) ? phoneFromJid(fromJid) : userPart(r); } catch (e) { phone = phoneFromJid(fromJid); } }
        const name = contactName(s, fromJid) || ('+' + phone);
        const entry = {
          id: c.id, from: fromJid, phone, name,
          isVideo: !!c.isVideo, isGroup: !!c.isGroup,
          status: c.status, at: (c.date ? new Date(c.date).getTime() : Date.now()),
        };
        // de-dupe by call id, keep latest status
        const i = s.calls.findIndex(x => x.id === c.id);
        if (i >= 0) s.calls[i] = { ...s.calls[i], ...entry }; else s.calls.unshift(entry);
        if (s.calls.length > 60) s.calls.length = 60;
        // surface only the meaningful "offer" (incoming ringing) to the event feed
        if (c.status === 'offer') {
          pushEvent(userId, { type: 'call', phone, name, isVideo: !!c.isVideo, callId: c.id });
          if (telegram && telegram.enabled()) {
            telegram.notifyUser(userId, `📞 Incoming ${c.isVideo ? 'video ' : ''}call from <b>${name}</b>`).catch(() => {});
          }
          // Auto-reject incoming calls when the user enabled it (privacy/DND).
          if (s.autoRejectCalls && typeof s.sock.rejectCall === 'function') {
            try { await s.sock.rejectCall(c.id, fromJid); } catch (e) {}
          }
        }
      }
    } catch (e) { /* never break the socket */ }
  });

  return s;
}

// ── Public API ──

async function linkAccount(userId, phoneNumber) {
  const s = await startSession(userId, { phoneNumber });
  // wait up to ~18s for the pairing code to be generated (new servers can be slow)
  for (let i = 0; i < 30; i++) {
    if (s.pairingCode) return { status: 'pairing', pairing_code: s.pairingCode };
    if (s.status === 'connected') return { status: 'connected' };
    if (s.status === 'error') return { status: 'error', error: s.lastError };
    await new Promise(r => setTimeout(r, 600));
  }
  return { status: s.status, pairing_code: s.pairingCode || null };
}

async function getStatus(userId) {
  const s = sessions.get(userId);
  if (s) {
    return { status: s.status, pairing_code: s.pairingCode || null, phone: s.sock?.user?.id ? phoneFromJid(s.sock.user.id) : null };
  }
  const sess = await db.getWaSession(userId);
  if (sess && sess.creds && sess.status !== 'disconnected') {
    // We have persisted creds but no live socket (e.g. after a cold start) → revive
    startSession(userId).catch(() => {});
    return { status: 'connecting', pairing_code: null, phone: sess.phone || null, reviving: true };
  }
  return { status: sess?.status || 'disconnected', pairing_code: null, phone: sess?.phone || null };
}

async function ensureLive(userId) {
  const s = sessions.get(userId);
  if (s && s.status === 'connected') return true;
  const sess = await db.getWaSession(userId);
  if (sess && sess.creds) { startSession(userId).catch(() => {}); return false; }
  return false;
}

async function subscribePhone(userId, phone) {
  const s = sessions.get(userId);
  if (s && s.sock && s.status === 'connected') {
    const jid = jidFromPhone(phone);
    // Active probe: nudge our own presence to "available" so WhatsApp opens the
    // live presence feed for this contact, subscribe, then go invisible again.
    // We repeat it a few times over ~6s because a brand-new subscription can
    // take a moment to start streaming (especially when Last Seen is hidden),
    // which is what makes a freshly-added number report its status right away.
    const probe = async () => {
      try {
        await s.sock.sendPresenceUpdate('available');
        await s.sock.presenceSubscribe(jid);
        await s.sock.sendPresenceUpdate('unavailable');
      } catch (e) {}
    };
    await probe();
    setTimeout(() => probe().catch(() => {}), 2000);
    setTimeout(() => probe().catch(() => {}), 6000);
  }
}

async function logout(userId) {
  stopKeepAlive(userId);
  const s = sessions.get(userId);
  if (s && s.sock) { try { await s.sock.logout(); } catch (e) {} }
  try {
    const dir = path.join(SESS_ROOT, userId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
  await db.upsertWaSession(userId, { creds: null, status: 'disconnected', pairing_code: null, updated_at: db.nowISO() });
  sessions.delete(userId);
}

function getEvents(userId, sinceId = 0) {
  const s = sessions.get(userId);
  if (!s) return [];
  return s.lastEvents.filter(e => e.id > sinceId).slice(0, 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// 💬 WHATSAPP WEB — public API (chats / messages / send)
// All of these operate on the SAME authenticated socket used by the tracker.
// ─────────────────────────────────────────────────────────────────────────────

function _liveSock(userId) {
  const s = sessions.get(userId);
  if (!s || !s.sock || s.status !== 'connected') return null;
  return s;
}

// List chats (most-recent first) with a last-message preview + display name.
// We build the list from the chats map, but ALSO fold in any jid that has
// messages or is a known contact — so the UI never shows an empty list just
// because a 'chats.set' event was sparse on this connection.
function listChats(userId, { limit = 100 } = {}) {
  const s = sessions.get(userId);
  if (!s || !s.store) return [];
  const st = s.store;

  // Seed from explicit chat records.
  const map = new Map();
  for (const c of st.chats.values()) {
    if (c.id && !isStatusJid(c.id)) map.set(c.id, { ...c });
  }
  // Fold in any chat that has messages but no chat record yet.
  for (const [jid, arr] of st.messages) {
    if (!jid || isStatusJid(jid) || map.has(jid) || !arr.length) continue;
    const last = arr[arr.length - 1];
    map.set(jid, { id: jid, conversationTimestamp: Number(last?.messageTimestamp || 0), unreadCount: 0 });
  }

  const chats = [...map.values()]
    .filter(c => c.id && !isStatusJid(c.id))
    .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
    .slice(0, limit);
  return chats.map(c => {
    const msgs = st.messages.get(c.id) || [];
    const last = msgs[msgs.length - 1];
    const d = last ? describeMessage(last, s) : null;
    const phone = isGroupJid(c.id) ? null : (displayPhone(s, c.id) || phoneFromJid(c.id));
    return {
      jid: c.id,
      name: contactName(s, c.id) || (isGroupJid(c.id) ? (c.name || 'Group') : ('+' + phone)),
      phone,
      isGroup: isGroupJid(c.id),
      pinned: !!c.pinned,
      muted: !!c.muted,
      timestamp: (c.conversationTimestamp || 0) * 1000,
      unread: c.unreadCount || 0,
      lastMessage: d ? (d.fromMe ? 'You: ' : '') + (d.text || (d.mediaType ? '[' + d.mediaType + ']' : '')) : '',
      lastFromMe: d ? d.fromMe : false,
    };
  });
}

// Get the message history for one chat (chronological).
function getChatMessages(userId, jid, { limit = 60 } = {}) {
  const s = sessions.get(userId);
  if (!s || !s.store) return [];
  const realJid = resolveRealJid(s, jid);
  const arr = s.store.messages.get(realJid) || [];
  return arr.slice(-limit).map(m => describeMessage(m, s)).filter(Boolean);
}

// ── Backfill the chat list after connect ─────────────────────────────────
// On a revive (creds already registered) WhatsApp often sends little/no
// history, leaving the chat list empty. This asks the main device for more
// history off the most-recent messages we have, which makes WhatsApp stream
// 'messaging-history.set' batches that repopulate the list. Fully best-effort.
async function backfillChats(userId) {
  const s = _liveSock(userId);
  if (!s || !s.store) return false;
  try {
    if (typeof s.sock.fetchMessageHistory !== 'function') return false;
    // Find the newest message overall to anchor the on-demand history request.
    let anchor = null;
    for (const arr of s.store.messages.values()) {
      const m = arr[arr.length - 1];
      if (m && (!anchor || Number(m.messageTimestamp || 0) > Number(anchor.messageTimestamp || 0))) anchor = m;
    }
    if (anchor && anchor.key) {
      await s.sock.fetchMessageHistory(50, anchor.key, Number(anchor.messageTimestamp || 0));
      // Snapshot a little later once batches have arrived.
      setTimeout(() => scheduleStoreSave(userId), 6000);
      return true;
    }
  } catch (e) { /* best-effort */ }
  return false;
}

// Ensure we have *some* history for a chat — Baileys fetchMessageHistory pulls
// older messages on demand. Best-effort; returns immediately if not supported.
async function loadOlderMessages(userId, jid) {
  const s = _liveSock(userId);
  if (!s) return false;
  try {
    const realJid = resolveRealJid(s, jid);
    const arr = s.store.messages.get(realJid) || [];
    const oldest = arr[0];
    if (oldest && typeof s.sock.fetchMessageHistory === 'function') {
      await s.sock.fetchMessageHistory(25, oldest.key, Number(oldest.messageTimestamp || 0));
      setTimeout(() => scheduleStoreSave(userId), 4000);
      return true;
    }
  } catch (e) { /* best-effort */ }
  return false;
}


// Resolve a target (jid or phone) to the jid we actually send to. For known LID
// contacts we prefer the real phone jid; groups/unknowns pass through.
function _sendJid(s, target) {
  if (String(target).includes('@')) return resolveRealJid(s, target);
  return jidFromPhone(target);
}

// Look up a stored message by id within a chat (for reply / react / forward).
function _findMsg(s, jid, msgId) {
  const realJid = resolveRealJid(s, jid);
  const arr = s.store.messages.get(realJid) || [];
  return arr.find(x => x.key?.id === msgId) || null;
}

// Send a text message to a chat (jid or phone). Optional quotedId for replies +
// mentions array (jids) for @-mentions.
async function sendChatMessage(userId, target, text, { quotedId = null, mentions = null } = {}) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const jid = _sendJid(s, target);
  const opts = {};
  if (quotedId) { const q = _findMsg(s, jid, quotedId); if (q) opts.quoted = q; }
  const payload = { text: String(text) };
  if (Array.isArray(mentions) && mentions.length) payload.mentions = mentions;
  const sent = await s.sock.sendMessage(jid, payload, opts);
  if (sent) pushMessage(s, sent);
  return sent ? describeMessage(sent, s) : null;
}

// Send media (image / video / audio / document / sticker) from a Buffer.
async function sendChatMedia(userId, target, { buffer, mime, filename, caption = '', kind = 'document', ptt = false, quotedId = null }) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const jid = _sendJid(s, target);
  let payload;
  switch (kind) {
    case 'image': payload = { image: buffer, caption: caption || undefined, mimetype: mime }; break;
    case 'video': payload = { video: buffer, caption: caption || undefined, mimetype: mime }; break;
    case 'audio': payload = { audio: buffer, mimetype: mime || 'audio/mp4', ptt: !!ptt }; break;
    case 'sticker': payload = { sticker: buffer }; break;
    default: payload = { document: buffer, mimetype: mime || 'application/octet-stream', fileName: filename || 'file' }; break;
  }
  const opts = {};
  if (quotedId) { const q = _findMsg(s, jid, quotedId); if (q) opts.quoted = q; }
  const sent = await s.sock.sendMessage(jid, payload, opts);
  if (sent) pushMessage(s, sent);
  return sent ? describeMessage(sent, s) : null;
}

// React to a message with an emoji (empty string removes the reaction).
async function reactToMessage(userId, jid, msgId, emoji) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const m = _findMsg(s, jid, msgId);
  if (!m) throw new Error('Message not found');
  await s.sock.sendMessage(resolveRealJid(s, jid), { react: { text: emoji || '', key: m.key } });
  // reflect locally
  m.reactions = (m.reactions || []).filter(r => !r.key?.fromMe);
  if (emoji) m.reactions.push({ text: emoji, key: { fromMe: true } });
  return true;
}

// Delete a message. scope 'me' = delete for me only; 'everyone' = revoke for all.
async function deleteMessage(userId, jid, msgId, scope = 'everyone') {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const realJid = resolveRealJid(s, jid);
  const m = _findMsg(s, jid, msgId);
  if (!m) throw new Error('Message not found');
  if (scope === 'everyone') {
    await s.sock.sendMessage(realJid, { delete: m.key });
  } else {
    try { await s.sock.chatModify({ clear: { messages: [{ id: m.key.id, fromMe: m.key.fromMe, timestamp: Number(m.messageTimestamp || 0) }] } }, realJid); } catch (e) {}
  }
  // remove locally
  const arr = s.store.messages.get(realJid) || [];
  const i = arr.findIndex(x => x.key?.id === msgId);
  if (i >= 0) arr.splice(i, 1);
  return true;
}

// Edit a previously-sent text message.
async function editMessage(userId, jid, msgId, newText) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const realJid = resolveRealJid(s, jid);
  const m = _findMsg(s, jid, msgId);
  if (!m) throw new Error('Message not found');
  if (!m.key?.fromMe) throw new Error('You can only edit your own messages');
  const sent = await s.sock.sendMessage(realJid, { text: String(newText), edit: m.key });
  // reflect locally
  if (m.message?.conversation !== undefined) m.message.conversation = String(newText);
  else if (m.message?.extendedTextMessage) m.message.extendedTextMessage.text = String(newText);
  else m.message = { conversation: String(newText) };
  m.edited = true;
  return sent ? describeMessage(m, s) : null;
}

// Forward a message to another chat (jid or phone).
async function forwardMessage(userId, fromJid, msgId, toTarget) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const m = _findMsg(s, fromJid, msgId);
  if (!m) throw new Error('Message not found');
  const dest = _sendJid(s, toTarget);
  const sent = await s.sock.sendMessage(dest, { forward: m });
  if (sent) pushMessage(s, sent);
  return sent ? describeMessage(sent, s) : null;
}

// Send our own typing / recording / paused presence into a chat.
async function sendTyping(userId, jid, state = 'composing') {
  const s = _liveSock(userId);
  if (!s) return false;
  try { await s.sock.sendPresenceUpdate(state, resolveRealJid(s, jid)); return true; } catch (e) { return false; }
}

// Pin / unpin / mute / archive a chat (best-effort; reflected locally too).
async function modifyChat(userId, jid, action, value = true) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const realJid = resolveRealJid(s, jid);
  try {
    if (action === 'pin') { await s.sock.chatModify({ pin: !!value }, realJid); upsertChat(s, realJid, { pinned: !!value }); }
    else if (action === 'mute') { await s.sock.chatModify({ mute: value ? 8 * 60 * 60 * 1000 : null }, realJid); upsertChat(s, realJid, { muted: !!value }); }
    else if (action === 'archive') { await s.sock.chatModify({ archive: !!value, lastMessages: (s.store.messages.get(realJid) || []).slice(-1) }, realJid); }
  } catch (e) { throw new Error(e.message); }
  return true;
}

// Current live presence (online / typing) for a chat header.
function getChatPresence(userId, jid) {
  const s = sessions.get(userId);
  if (!s || !s.presenceLive) return { online: false, typing: false };
  const real = resolveRealJid(s, jid);
  const p = s.presenceLive.get(real);
  if (!p) return { online: false, typing: false };
  // presence is fresh for ~60s
  const fresh = (Date.now() - (p.at || 0)) < 60000;
  return { online: fresh && p.online, typing: fresh && p.typing };
}

// Mark a chat as read (clear unread + send read receipts).
async function markChatRead(userId, jid) {
  const s = _liveSock(userId);
  if (s) {
    const realJid = resolveRealJid(s, jid);
    upsertChat(s, realJid, { unreadCount: 0 });
    try {
      const arr = s.store.messages.get(realJid) || [];
      const keys = arr.filter(m => !m.key?.fromMe).slice(-15).map(m => m.key);
      if (keys.length) await s.sock.readMessages(keys);
    } catch (e) {}
  }
  return true;
}

// Download media for a stored message and return { buffer, mime, filename }.
async function getMessageMedia(userId, jid, msgId) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const m = _findMsg(s, jid, msgId);
  if (!m) throw new Error('Message not found');
  const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: s.sock.updateMediaMessage });
  // unwrap to read the real media node
  let content = m.message || {};
  if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
  const type = getContentType(content);
  const node = content[type] || {};
  const mime = node.mimetype || 'application/octet-stream';
  const filename = node.fileName || (msgId + '.' + (mime.split('/')[1] || 'bin'));
  return { buffer, mime, filename };
}

// Live presence/typing for a chat (for the header "online / typing…" hint).
async function subscribeChatPresence(userId, jid) {
  const s = _liveSock(userId);
  if (s) { try { await s.sock.presenceSubscribe(resolveRealJid(s, jid)); } catch (e) {} }
}

// ─────────────────────────────────────────────────────────────────────────────
// 👤 CONTACT PROFILE — photo, about/status, last seen + shared media gallery
// Powers the "tap the contact in the chat → see their info" panel.
// ─────────────────────────────────────────────────────────────────────────────
async function getContactProfile(userId, jid) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  // Resolve to the REAL phone jid first so we never show a foreign-looking LID.
  let realJid = resolveRealJid(s, jid);
  if (isLidJid(realJid)) { try { realJid = await resolveJidActive(s, jid); } catch (e) {} }
  const isGroup = isGroupJid(realJid);
  const phone = isGroup ? null : (displayPhone(s, realJid) || phoneFromJid(realJid));
  const name = contactName(s, realJid) || (isGroup ? 'Group' : ('+' + phone));

  let picture = null, about = null, aboutAt = null, business = null, isBlocked = false;
  try { picture = await s.sock.profilePictureUrl(realJid, 'image').catch(() => null); } catch (e) {}
  try {
    const st = await s.sock.fetchStatus(realJid).catch(() => null);
    const row = Array.isArray(st) ? st[0] : st;
    const status = row?.status || row;
    if (status) { about = status.status || status.setAt ? (status.status || null) : (typeof status === 'string' ? status : null); aboutAt = status.setAt ? new Date(status.setAt).getTime() : null; }
  } catch (e) {}
  try { if (!isGroup) { const b = await s.sock.getBusinessProfile(realJid).catch(() => null); if (b) business = { description: b.description || null, category: (b.categories && b.categories[0]?.name) || null, email: b.email || null, website: (b.website && b.website[0]) || null }; } } catch (e) {}
  try { const bl = await s.sock.fetchBlocklist().catch(() => []); isBlocked = Array.isArray(bl) && bl.some(b => userPart(b) === userPart(realJid)); } catch (e) {}

  // Last seen — from the tracker log if this number is tracked, else from live
  // presence we've observed. WhatsApp hides the *timestamp* when "Last Seen" is
  // private, so this is best-effort.
  let lastSeen = null, online = false;
  try {
    const live = s.presenceLive && s.presenceLive.get(realJid);
    if (live && (Date.now() - (live.at || 0)) < 60000) online = !!live.online;
    if (phone) {
      const tracked = await db.getWaTrackedByPhone(userId, phone).catch(() => null);
      if (tracked && tracked.last_seen_at) lastSeen = new Date(String(tracked.last_seen_at).replace(' ', 'T') + (String(tracked.last_seen_at).includes('Z') ? '' : 'Z')).getTime();
    }
  } catch (e) {}

  // Shared media / docs / links built from the stored message history.
  const arr = (s.store.messages.get(realJid) || []);
  const media = [], docs = [], links = [];
  const linkRe = /(https?:\/\/[^\s]+)/i;
  for (const m of arr) {
    const d = describeMessage(m, s);
    if (!d) continue;
    if (d.mediaType === 'image' || d.mediaType === 'video' || d.mediaType === 'gif') {
      media.push({ id: d.id, type: d.mediaType, timestamp: d.timestamp });
    } else if (d.mediaType === 'document') {
      docs.push({ id: d.id, name: d.text || 'Document', timestamp: d.timestamp });
    }
    if (d.text) { const mm = d.text.match(linkRe); if (mm) links.push({ id: d.id, url: mm[1], timestamp: d.timestamp }); }
  }
  media.reverse(); docs.reverse(); links.reverse();

  return {
    jid: realJid, name, phone, isGroup, picture, about, aboutAt, business, isBlocked,
    lastSeen, online,
    media: media.slice(0, 60), docs: docs.slice(0, 40), links: links.slice(0, 40),
    counts: { media: media.length, docs: docs.length, links: links.length },
  };
}

// ── 📞 Calls: history + reject ─────────────────────────────────────────────
function getCallHistory(userId) {
  const s = sessions.get(userId);
  if (!s || !s.calls) return [];
  return s.calls.slice(0, 60);
}
async function rejectCall(userId, callId, fromJid) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  if (typeof s.sock.rejectCall !== 'function') throw new Error('Call rejection not supported');
  await s.sock.rejectCall(callId, resolveRealJid(s, fromJid));
  const i = s.calls.findIndex(x => x.id === callId);
  if (i >= 0) s.calls[i].status = 'reject';
  return true;
}
function setAutoRejectCalls(userId, enabled) {
  const s = sessions.get(userId);
  if (s) s.autoRejectCalls = !!enabled;
  return !!enabled;
}

// ── 🔒 Privacy settings + block/unblock ───────────────────────────────────
async function getPrivacySettings(userId) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  let settings = {};
  try { settings = await s.sock.fetchPrivacySettings(true) || {}; } catch (e) {}
  let blocklist = [];
  try {
    const bl = await s.sock.fetchBlocklist().catch(() => []);
    blocklist = (bl || []).map(j => ({ jid: j, phone: displayPhone(s, j) || phoneFromJid(j), name: contactName(s, j) || ('+' + (displayPhone(s, j) || phoneFromJid(j))) }));
  } catch (e) {}
  return { settings, blocklist, autoRejectCalls: !!s.autoRejectCalls };
}

async function updatePrivacy(userId, key, value) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const map = {
    lastseen: 'updateLastSeenPrivacy',
    online: 'updateOnlinePrivacy',
    profile: 'updateProfilePicturePrivacy',
    status: 'updateStatusPrivacy',
    readreceipts: 'updateReadReceiptsPrivacy',
    groupadd: 'updateGroupsAddPrivacy',
    calladd: 'updateCallPrivacy',
  };
  const fn = map[key];
  if (!fn || typeof s.sock[fn] !== 'function') throw new Error('Unsupported privacy setting');
  await s.sock[fn](value);
  return true;
}

async function blockContact(userId, jid, action = 'block') {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  await s.sock.updateBlockStatus(resolveRealJid(s, jid), action === 'unblock' ? 'unblock' : 'block');
  return true;
}

// ── 🪪 Own profile (name / about / photo) ──────────────────────────────────
async function updateOwnProfile(userId, { name = null, about = null } = {}) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  if (name != null && String(name).trim()) await s.sock.updateProfileName(String(name).trim());
  if (about != null) await s.sock.updateProfileStatus(String(about));
  return true;
}
async function updateOwnPicture(userId, buffer) {
  const s = _liveSock(userId);
  if (!s) throw new Error('WhatsApp is not connected');
  const myJid = s.sock.user?.id;
  if (!myJid) throw new Error('No account jid');
  await s.sock.updateProfilePicture(jidNormalizedUser(myJid), buffer);
  return true;
}

// ── On boot: revive all sessions that had persisted creds (best-effort) ──
async function reviveAll() {
  try {
    const list = await db.getActiveWaSessions();
    for (const sess of list) {
      if (sess.creds && sess.status !== 'disconnected') {
        startSession(sess.user_id).catch(() => {});
      }
    }
  } catch (e) { console.error('WA reviveAll error:', e.message); }
}

module.exports = {
  linkAccount, getStatus, ensureLive, subscribePhone, subscribeAllTracked,
  logout, getEvents, reviveAll, jidFromPhone, phoneFromJid,
  // WhatsApp Web
  listChats, getChatMessages, loadOlderMessages, sendChatMessage, sendChatMedia,
  markChatRead, getMessageMedia, subscribeChatPresence,
  // WhatsApp Web — full feature set
  reactToMessage, deleteMessage, editMessage, forwardMessage,
  sendTyping, modifyChat, getChatPresence,
  // Profile / privacy / calls / view-once
  getContactProfile, getCallHistory, rejectCall, setAutoRejectCalls,
  getPrivacySettings, updatePrivacy, blockContact,
  updateOwnProfile, updateOwnPicture,
};



