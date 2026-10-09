// ─────────────────────────────────────────────────────────────────────────────
// liveFrameStore.js — in-memory "latest live frame" cache, keyed by jobId.
//
// WHY THIS EXISTS (the real fix for "APK shows ENDED / never loads")
//   The LIVE sandbox screen streams JPEG frames over the SSE `screen` event on
//   /api/agent/run. That works great on desktop browsers, but on MOBILE the SSE
//   event-stream is routinely buffered or cut by Render's proxy + Cloudflare +
//   flaky mobile networks. When that happens the Flutter APK receives ZERO
//   `screen` frames, so its live viewer is stuck on "Connecting…" and then flips
//   straight to "ENDED" when the job finishes — the user never sees the agent's
//   browser.
//
//   This store gives the app a SECOND, proxy-friendly delivery path that does
//   NOT depend on the SSE stream surviving: every `screen` frame the engine
//   emits is ALSO stashed here (keyed by the durable jobId). The app then polls
//   a plain `GET /api/agent/live/:jobId` (exactly like it already polls the job
//   row) and renders whatever the latest frame is — even if SSE is completely
//   dead. Pure HTTP GET sails through every proxy.
//
//   100% ADDITIVE: the SSE path is untouched and still primary on the web. This
//   only ADDS a reliable fallback so the live view works EVERYWHERE.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// jobId -> { frame: <b64 jpeg>, w, h, n, ts, active, started, ended, updatedAt }
const store = new Map();

// Keep memory bounded: drop entries we haven't touched in a while, and cap the
// total number of tracked jobs. A live run updates frequently, so a stale entry
// means the run is long over.
const TTL_MS = 15 * 60 * 1000;     // 15 min since last update → evictable
const MAX_ENTRIES = 200;           // hard cap on concurrent tracked jobs

function prune() {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.updatedAt && now - e.updatedAt > TTL_MS) store.delete(id);
  }
  // If still over the cap, evict the oldest.
  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    const toDrop = store.size - MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) store.delete(sorted[i][0]);
  }
}

function ensure(jobId) {
  let e = store.get(jobId);
  if (!e) {
    e = { frame: null, liveUrl: null, w: 0, h: 0, n: 0, ts: 0, active: false, started: false, ended: false, updatedAt: Date.now() };
    store.set(jobId, e);
  }
  return e;
}

// Feed a single `screen` SSE payload into the store. Mirrors the exact payload
// shapes the engine emits: { event:'start' } | { event:'end' } | { frame, w, h, ts, n }.
function record(jobId, payload) {
  if (!jobId || !payload) return;
  const e = ensure(jobId);
  const evt = String(payload.event || '');
  if (evt === 'start') {
    e.started = true;
    e.active = true;
    e.ended = false;
  } else if (evt === 'liveurl') {
    // The reliable web-VNC live URL (Daytona preview proxy → in-sandbox noVNC).
    // Stored so the polling endpoint can hand it to the mobile APK, which loads
    // it in a WebView for a real, proxy-surviving live desktop.
    if (payload.liveUrl) e.liveUrl = String(payload.liveUrl);
    e.started = true;
    e.active = true;
    e.ended = false;
  } else if (evt === 'end') {
    e.active = false;
    e.ended = true;
  } else if (payload.frame) {
    e.frame = String(payload.frame);
    e.active = true;
    e.started = true;
    e.ended = false;
    if (typeof payload.w === 'number') e.w = payload.w;
    if (typeof payload.h === 'number') e.h = payload.h;
    if (typeof payload.n === 'number') e.n = payload.n;
    e.ts = (typeof payload.ts === 'number') ? payload.ts : Date.now();
  }
  // A liveUrl can also arrive piggy-backed on any payload.
  if (payload.liveUrl && !e.liveUrl) e.liveUrl = String(payload.liveUrl);
  e.updatedAt = Date.now();
  // Cheap, occasional GC.
  if (Math.random() < 0.02) prune();
}

// Read the latest live state for a job (for the polling endpoint).
// `sinceN` lets the client skip re-downloading a frame it already has: if the
// stored frame number is <= sinceN we return state WITHOUT the (large) frame.
function get(jobId, sinceN) {
  const e = store.get(jobId);
  if (!e) return { found: false };
  const out = {
    found: true,
    active: !!e.active,
    started: !!e.started,
    ended: !!e.ended,
    w: e.w, h: e.h, n: e.n, ts: e.ts,
  };
  // The reliable web-VNC live URL — always returned (small) so a polling client
  // can switch to its WebView view the moment it is available.
  if (e.liveUrl) out.liveUrl = e.liveUrl;
  const sn = parseInt(sinceN, 10);
  const haveNewer = !Number.isFinite(sn) || e.n > sn;
  if (e.frame && haveNewer) out.frame = e.frame;
  return out;
}

// Mark a job's live session ended (called when the run finishes).
function end(jobId) {
  const e = store.get(jobId);
  if (e) { e.active = false; e.ended = true; e.updatedAt = Date.now(); }
}

// Drop a job entirely (optional cleanup).
function drop(jobId) { store.delete(jobId); }

module.exports = { record, get, end, drop, prune };
