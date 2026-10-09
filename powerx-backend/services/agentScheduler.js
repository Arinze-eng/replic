// ─────────────────────────────────────────────────────────────────────────────
// agentScheduler.js — SCHEDULED + TIME-BOXED tasks for the WormGPT Agent.
//
// Two capabilities the product asked for:
//
//   1. ⏰ SCHEDULE A TASK FOR A PARTICULAR TIME.
//      "do X at 6pm", "run this tomorrow 9am", "in 30 minutes" — we parse the
//      time out of the user's message, store the task, and a single interval
//      ticker fires it (via a caller-supplied runner) when its time arrives.
//      Schedules survive a redeploy because they are persisted in Supabase
//      app_settings (db.getSetting/setSetting) under a single JSON key.
//
//   2. ⏱️ TIME-BOX ("use N minutes to think").
//      parseDuration() extracts a requested working duration so the caller can
//      pass min_duration_ms / think_until_ms into the engine and the agent
//      keeps producing NEW work until the time is up (agent.py handles this).
//
// Design goals:
//   • Zero new infra: one setInterval + one Supabase JSON key.
//   • Best-effort & crash-safe: every store/read is guarded; a bad row never
//     kills the ticker.
//   • Per-chat cancellation: /cancelall wipes a chat's pending schedules.
//   • Idempotent firing: a schedule is marked fired (removed) before the runner
//     is invoked so a slow runner can't double-fire on the next tick.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

let db = null;
try { db = require('../db'); } catch (_) { db = null; }

const KEY = 'agent_scheduled_tasks';
const TZ_KEY = 'agent_chat_timezones';     // { "<chatId>": <offsetMinutes>, ... }
const TICK_MS = parseInt(process.env.AGENT_SCHEDULER_TICK_MS || '20000', 10); // 20s
const MAX_PER_CHAT = parseInt(process.env.AGENT_SCHEDULER_MAX_PER_CHAT || '25', 10);

// ── ⏰ DEFAULT TIMEZONE ───────────────────────────────────────────────────────
// The product runs on Render in UTC, but users live in UTC+1 (WAT / Lagos).
// So EVERY clock-time schedule ("at 6pm", "tomorrow 9am") is interpreted in
// UTC+1 by DEFAULT — one hour ahead of raw UTC — unless the user overrides the
// timezone for their chat. Override with env AGENT_DEFAULT_TZ_OFFSET_MIN.
const DEFAULT_TZ_OFFSET_MIN = parseInt(process.env.AGENT_DEFAULT_TZ_OFFSET_MIN || '60', 10); // +60 = UTC+1

let _timer = null;
let _runners = [];         // array of async ({ chatId, task, scheduleId }) => bool|void
let _ticking = false;
// In-memory mirror so we work even if Supabase is briefly unreachable.
let _cache = null;
let _tzCache = null;       // { chatId: offsetMinutes }

function _uid() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── PER-CHAT TIMEZONE STORE ──────────────────────────────────────────────────
async function _loadTz() {
  if (_tzCache) return _tzCache;
  let map = {};
  try {
    if (db && db.getSetting) {
      const raw = await db.getSetting(TZ_KEY);
      if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') map = p; }
    }
  } catch (_) { map = {}; }
  _tzCache = map;
  return _tzCache;
}
async function _saveTz(map) {
  _tzCache = map && typeof map === 'object' ? map : {};
  try { if (db && db.setSetting) await db.setSetting(TZ_KEY, JSON.stringify(_tzCache)); } catch (_) {}
}

// Return this chat's offset (minutes east of UTC). Falls back to the UTC+1 default.
async function getChatOffsetMin(chatId) {
  if (chatId == null) return DEFAULT_TZ_OFFSET_MIN;
  const map = await _loadTz();
  const v = map[String(chatId)];
  return Number.isFinite(v) ? v : DEFAULT_TZ_OFFSET_MIN;
}

// Persist a chat's timezone offset (minutes east of UTC). Clamped to [-720,840].
async function setChatOffsetMin(chatId, offsetMin) {
  if (chatId == null || !Number.isFinite(offsetMin)) return DEFAULT_TZ_OFFSET_MIN;
  const clamped = Math.max(-720, Math.min(840, Math.round(offsetMin)));
  const map = await _loadTz();
  map[String(chatId)] = clamped;
  await _saveTz(map);
  return clamped;
}

// Named zones → offset minutes. Small, practical set covering the app's users.
const NAMED_TZ = {
  utc: 0, gmt: 0, z: 0,
  wat: 60, cet: 60, bst: 60, wast: 120, cat: 120, eet: 120, sast: 120,
  eat: 180, msk: 180, gst: 240, pkt: 300, ist: 330, npt: 345, bd: 360,
  ict: 420, wib: 420, cst_china: 480, hkt: 480, sgt: 480, awst: 480,
  jst: 540, kst: 540, aest: 600, acst: 570,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360,
  pst: -480, pdt: -420, akst: -540, hst: -600,
};

// Parse a timezone instruction out of free text. Understands:
//   "timezone +2", "tz -5", "utc+3", "utc-05:30", "set timezone to WAT",
//   "gmt+1", "use EST", "my timezone is IST".
// Returns { offsetMin, label } or null when no timezone intent is present.
function parseTimezone(text) {
  const t = String(text || '').toLowerCase();

  // Explicit numeric offset: utc+2, gmt-5, +05:30, tz +3, timezone -4
  let m = t.match(/(?:time ?zone|tz|utc|gmt)\s*(?:to|is|=|:)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const h = parseInt(m[2], 10);
    const mm = m[3] ? parseInt(m[3], 10) : 0;
    if (h >= 0 && h <= 14 && mm >= 0 && mm < 60) {
      const off = sign * (h * 60 + mm);
      return { offsetMin: off, label: `UTC${sign >= 0 ? '+' : '-'}${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}` };
    }
  }

  // Named zone with a clear timezone intent (so a random "ist" in prose is ignored).
  const tzIntent = /\b(time ?zone|tz|utc|gmt)\b/.test(t)
    || /\b(set|use|using|my|change|switch)\b/.test(t);   // "use EST", "my timezone is IST", "switch to WAT"
  const nameM = t.match(/\b(utc|gmt|wat|cat|eat|eet|cet|bst|sast|wast|msk|gst|pkt|ist|npt|ict|wib|hkt|sgt|awst|jst|kst|aest|acst|est|edt|cst|cdt|mst|mdt|pst|pdt|akst|hst)\b/);
  if (nameM && (tzIntent || nameM[1] === 'utc' || nameM[1] === 'gmt')) {
    const key = nameM[1] === 'cst' ? 'cst' : nameM[1];
    if (key in NAMED_TZ) return { offsetMin: NAMED_TZ[key], label: key.toUpperCase() };
  }
  return null;
}

// Pretty label for an offset (e.g. 60 → "UTC+1", -300 → "UTC-5:00").
function offsetLabel(offsetMin) {
  const o = Number.isFinite(offsetMin) ? offsetMin : DEFAULT_TZ_OFFSET_MIN;
  const sign = o < 0 ? '-' : '+';
  const abs = Math.abs(o);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

async function _load() {
  if (_cache) return _cache;
  let list = [];
  try {
    if (db && db.getSetting) {
      const raw = await db.getSetting(KEY);
      if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; }
    }
  } catch (_) { list = []; }
  _cache = list;
  return _cache;
}

async function _save(list) {
  _cache = Array.isArray(list) ? list : [];
  try { if (db && db.setSetting) await db.setSetting(KEY, JSON.stringify(_cache)); } catch (_) {}
}

// ── ⏱️ DURATION PARSING ("use 5 minutes", "think for 10 min") ──────────────
// Returns milliseconds only when the user EXPLICITLY instructs the agent to
// spend a duration working. Merely mentioning a duration in a math/problem
// statement must never activate timed thinking. Clamped to [30s, 30min].
function parseDuration(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return 0;

  const durationPart = '(?:half an hour|an hour|\\d+(?:\\.\\d+)?\\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\\s+(?:and\\s+)?\\d+(?:\\.\\d+)?\\s*(?:minutes?|mins?|m|seconds?|secs?|s))?)';
  const workVerb = '(?:think|work|research|investigate|analyse|analyze|solve|study|explore|reason|keep (?:going|thinking|working))';

  // Accepted forms are deliberately imperative and duration-bound:
  //   "use/spend/take 20 minutes to research …"
  //   "think/work/research for 20 minutes …"
  //   "20 minutes to solve/research …"
  // Generic prose such as "a car travels for 30 minutes" does not match.
  const explicit = new RegExp(
    `\\b(?:use|spend|take)\\s+(?:about\\s+|the next\\s+)?${durationPart}\\b|` +
    `\\b${workVerb}\\s+(?:on\\s+[^.!?]{0,80}\\s+)?for\\s+(?:about\\s+)?${durationPart}\\b|` +
    `\\b${durationPart}\\s+to\\s+${workVerb}\\b`,
    'i',
  );
  if (!explicit.test(t)) return 0;

  let ms = 0;
  if (/\bhalf an hour\b/.test(t)) ms = 30 * 60 * 1000;
  if (!ms) {
    let total = 0;
    const hourM = t.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
    const minM = t.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/);
    const secM = t.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/);
    if (/\ban hour\b/.test(t) && !hourM) total += 60 * 60 * 1000;
    if (hourM) total += parseFloat(hourM[1]) * 60 * 60 * 1000;
    if (minM) total += parseFloat(minM[1]) * 60 * 1000;
    if (secM) total += parseFloat(secM[1]) * 1000;
    ms = total;
  }

  if (!ms) return 0;
  return Math.max(30 * 1000, Math.min(30 * 60 * 1000, Math.round(ms)));
}

// ── 🛡️ SCHEDULING INTENT HELPERS (guard rails against false-positive schedules) ─
// The #1 scheduler bug was: any message containing the word "at" plus a 1-2 digit
// number (e.g. two math questions, "look at 3 examples", "solve 5 at once") got
// silently turned into a scheduled task. These helpers make scheduling fire ONLY
// on a genuine, unambiguous scheduling intent.

// Explicit action/scheduling verbs that mean "do something LATER".
const _SCHEDULE_VERBS = /\b(remind|reminder|schedule|scheduled|alarm|alert me|notify me|wake me|ping me|message me|text me|tell me|let me know|run|execute|check|recheck|send|do it|do this|summari[sz]e|analyse|analyze|update me|report|report back|follow ?up|call me|email|post|buy|sell|trade|open (?:a )?trade|close (?:a )?trade|generate|create|make|write|build|fetch|get me|give me)\b/;

function _hasScheduleVerb(t) {
  return _SCHEDULE_VERBS.test(String(t || '').toLowerCase());
}

// A message that is ESSENTIALLY just a time phrase (short, no other content),
// e.g. "in 30 minutes", "tomorrow at 9am". Safe to schedule even without a verb.
function _isBareTimePhrase(t) {
  const s = String(t || '').toLowerCase().trim();
  if (s.length > 40) return false;
  // Strip the recognised time tokens; if almost nothing meaningful is left, it's bare.
  const stripped = s
    .replace(/\b(in|at|by|on|the|next|this|for|to|@)\b/g, ' ')
    .replace(/\b(today|tomorrow|tonight|morning|afternoon|evening|midnight|noon|am|pm)\b/g, ' ')
    .replace(/\b(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks)\b/g, ' ')
    .replace(/[\d:.\s]+/g, ' ')
    .trim();
  return stripped.length <= 3;
}

// TRUE when the message clearly is NOT a scheduling request — a computation,
// a general question, code, or free prose with no scheduling verb. When true we
// never arm a schedule, no matter what stray numbers/"at" it contains.
function _looksNonScheduling(text) {
  const original = String(text || '');
  const t = original.toLowerCase().trim();
  if (!t) return true;

  // 1) Arithmetic / math expressions: "2+2", "15 * 3", "solve x^2 = 4", "what is 12/4".
  //    A schedule NEVER contains bare arithmetic operators between numbers.
  if (/\d\s*[+\-*/^=]\s*\d/.test(t)) return true;
  if (/\b(solve|calculate|compute|evaluate|simplify|factor|integrate|differentiate|derivative|equation|expression|plus|minus|times|divided by|multiply|multiplied|sum of|product of|square root|percentage|percent of)\b/.test(t)) return true;

  // 2) Multiple questions in one message (e.g. two math questions) — clearly a
  //    Q&A batch, not a schedule. Two or more "?" or "and"-joined questions.
  const qMarks = (t.match(/\?/g) || []).length;
  if (qMarks >= 2) return true;

  // 3) A single "what/how/why/who/where/which is …" factual question with NO
  //    scheduling verb is a question to answer now, not a schedule.
  if (/^(what|how|why|who|where|which|whats|what's|explain|define|list|give me)\b/.test(t) && !_hasScheduleVerb(t)) {
    // …unless it explicitly asks to be reminded/checked LATER.
    if (!/\b(later|tomorrow|tonight|in \d|at \d|by \d|next (?:week|month|hour|day)|every)\b/.test(t)) return true;
  }

  // 4) Looks like code / a shell command / a URL-heavy message.
  if (/[{};]\s*$/.test(t) || /\b(function|const|let|var|def |class |import |curl |sudo |apt-get|pip install|npm i)\b/.test(t)) return true;

  return false;
}

// ── ⏰ SCHEDULE-TIME PARSING ─────────────────────────────────────────────────
// Extracts an absolute epoch-ms "fire at" time from natural language:
//   "in 30 minutes / in 2 hours", "at 6pm / at 18:30", "tomorrow at 9am",
//   "at 9:00" (today if still ahead, else tomorrow).
//
// ⏰ TIMEZONE-ACCURATE: clock times ("at 6pm", "tomorrow 9am") are interpreted
// in the caller's timezone (offsetMin minutes east of UTC — default UTC+1) so a
// user in Lagos who says "6pm" gets 18:00 THEIR time, not 18:00 server-UTC. An
// inline timezone in the SAME message ("at 6pm UTC+2") overrides the stored one.
// Relative times ("in 30 minutes") are timezone-independent.
//
// Returns { fireAt, cleanTask, offsetMin } where cleanTask strips a leading
// scheduling phrase so the stored task reads naturally, or null when no time.
function parseSchedule(text, offsetMin) {
  const original = String(text || '').trim();
  const t = original.toLowerCase();
  const now = new Date();
  // Resolve the offset: an inline "UTC+X" in this very message wins, else the
  // passed-in per-chat offset, else the UTC+1 default.
  let off = Number.isFinite(offsetMin) ? offsetMin : DEFAULT_TZ_OFFSET_MIN;
  const inlineTz = parseTimezone(original);
  if (inlineTz) off = inlineTz.offsetMin;

  // ── 🛡️ FALSE-POSITIVE GUARD (fixes the "two math questions auto-schedule" bug) ──
  // Scheduling must ONLY trigger on a genuine, unambiguous scheduling intent —
  // never because a math/arithmetic message happens to contain the word "at" or
  // a small number. If this message looks like a computation, a general question,
  // or otherwise carries no scheduling verb, we bail out early and let the agent
  // answer it normally.
  if (_looksNonScheduling(original)) return null;

  // "in N minutes/hours/seconds/days" — a relative delay is unambiguous on its own.
  let m = t.match(/\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2];
    let ms = 0;
    if (/^s|sec/.test(unit)) ms = n * 1000;
    else if (/^m/.test(unit)) ms = n * 60 * 1000;
    else if (/^h/.test(unit)) ms = n * 60 * 60 * 1000;
    else if (/^d/.test(unit)) ms = n * 24 * 60 * 60 * 1000;
    // Only treat "in N minutes" as a schedule when a scheduling/action verb is
    // present ("remind/run/do/check/... in 30 minutes"), OR the whole message is
    // basically just the time phrase. This stops "solve this in 5 steps" or
    // "the reaction finishes in 2 hours" from arming a schedule.
    if (ms > 0 && (_hasScheduleVerb(t) || _isBareTimePhrase(t))) {
      return { fireAt: Date.now() + ms, cleanTask: original, offsetMin: off };
    }
  }

  // "at 6pm", "at 18:30", "tomorrow at 9am", "at 9:00" — the number MUST be bound
  // tightly to a scheduling cue (at / by / @ / tomorrow / today / tonight / a day
  // name), never a stray "at" floating elsewhere in a math or prose sentence.
  m = t.match(/\b(?:(today|tomorrow|tonight)\s+)?(?:at|by|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
    || t.match(/\b(today|tomorrow|tonight)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  // Bare word-times ("midnight" / "noon") carry no digits, so synthesise a match
  // so "notify me at midnight" / "remind me at noon tomorrow" still schedule.
  const wordTime = /\bmidnight\b/.test(t) ? 'midnight' : /\bnoon\b/.test(t) ? 'noon' : null;
  if (!m && wordTime) {
    const dayW = /\btomorrow\b/.test(t) ? 'tomorrow' : /\btoday\b/.test(t) ? 'today' : /\btonight\b/.test(t) ? 'tonight' : undefined;
    m = [wordTime, dayW, wordTime === 'noon' ? '12' : '0', undefined, undefined];
  }
  // "at 6" with NO am/pm and NO minutes is ambiguous (could be "at 6 items"),
  // so it only counts as a clock time when am/pm OR :MM OR a day word is present,
  // OR the message carries an explicit scheduling verb.
  const hasClockCue = /\b(tomorrow|today|tonight|midnight|noon)\b/.test(t)
    || /\b(?:at|by|@)\s*\d{1,2}\s*(?:am|pm)\b/.test(t)
    || /\b(?:at|by|@)\s*\d{1,2}:\d{2}\b/.test(t)
    || (_hasScheduleVerb(t) && /\b(?:at|by|@)\s*\d{1,2}\b/.test(t))
    || /\b(midnight|noon)\b/.test(t);
  if (m && hasClockCue) {
    let hour = parseInt(m[2], 10);
    const min = m[3] ? parseInt(m[3], 10) : 0;
    const ampm = m[4];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (/\bnoon\b/.test(t)) { hour = 12; }
    if (/\bmidnight\b/.test(t)) { hour = 0; }
    if (hour >= 0 && hour <= 23 && min >= 0 && min <= 59) {
      // Build the target time IN THE USER'S TIMEZONE, accurately:
      //   1. take "now" as seen in the user's zone,
      //   2. set the requested clock H:M there,
      //   3. convert that local wall-clock back to a real UTC epoch.
      const nowMs = now.getTime();
      const offMs = off * 60 * 1000;
      // "now" shifted so that getUTC* reads the user's local wall clock.
      const localNow = new Date(nowMs + offMs);
      const localFire = new Date(localNow);
      localFire.setUTCSeconds(0, 0);
      localFire.setUTCHours(hour, min, 0, 0);
      const dayWord = m[1];
      if (dayWord === 'tomorrow') localFire.setUTCDate(localFire.getUTCDate() + 1);
      // Convert the user-local wall clock back to a true UTC epoch.
      let fireMs = localFire.getTime() - offMs;
      // If it's already in the past for "today"/unspecified, roll to tomorrow.
      if (fireMs <= nowMs + 5000 && dayWord !== 'today') {
        fireMs += 24 * 60 * 60 * 1000;
      }
      if (fireMs > nowMs) return { fireAt: fireMs, cleanTask: original, offsetMin: off };
    }
  }
  return null;
}

// ── SCHEDULE CRUD ────────────────────────────────────────────────────────────
async function add(chatId, task, fireAt, extra = {}) {
  const list = await _load();
  const mine = list.filter(s => String(s.chatId) === String(chatId));
  if (mine.length >= MAX_PER_CHAT) {
    throw new Error(`You already have ${mine.length} scheduled tasks (max ${MAX_PER_CHAT}). Send /cancelall or wait for some to run.`);
  }
  const entry = {
    id: _uid(),
    chatId: String(chatId),
    task: String(task || '').slice(0, 4000),
    fireAt: Math.round(fireAt),
    createdAt: Date.now(),
    minDurationMs: extra.minDurationMs || 0,
    // Remember the timezone this was scheduled in so /schedules renders it right.
    offsetMin: Number.isFinite(extra.offsetMin) ? extra.offsetMin : DEFAULT_TZ_OFFSET_MIN,
  };
  list.push(entry);
  await _save(list);
  return entry;
}

async function list(chatId) {
  const all = await _load();
  const mine = all.filter(s => String(s.chatId) === String(chatId));
  mine.sort((a, b) => a.fireAt - b.fireAt);
  return mine;
}

// Cancel ALL scheduled tasks for a chat. Returns the count removed.
async function cancelAll(chatId) {
  const all = await _load();
  const before = all.length;
  const kept = all.filter(s => String(s.chatId) !== String(chatId));
  await _save(kept);
  return before - kept.length;
}

// Cancel one schedule by id (only if it belongs to this chat).
async function cancelOne(chatId, id) {
  const all = await _load();
  const kept = all.filter(s => !(s.id === id && String(s.chatId) === String(chatId)));
  const removed = all.length - kept.length;
  await _save(kept);
  return removed;
}

// ── TICKER ───────────────────────────────────────────────────────────────────
async function _tick() {
  if (_ticking || !_runners.length) return;
  _ticking = true;
  try {
    const all = await _load();
    const now = Date.now();
    const due = all.filter(s => s.fireAt <= now);
    if (due.length) {
      // Remove due entries FIRST (idempotent — never double-fire).
      const remaining = all.filter(s => s.fireAt > now);
      await _save(remaining);
      for (const s of due) {
        const arg = { chatId: s.chatId, task: s.task, scheduleId: s.id, minDurationMs: s.minDurationMs || 0 };
        // Offer the task to each registered runner (Telegram + WhatsApp). A
        // runner returns truthy when it OWNS this chat (routes by id shape); we
        // stop at the first owner. If none claims it, it's silently dropped.
        for (const run of _runners) {
          try {
            const handled = await run(arg);
            if (handled) break;
          } catch (_) { /* a failed run never blocks the others */ }
        }
      }
    }
  } catch (_) { /* never let the ticker die */ }
  finally { _ticking = false; }
}

// Register a runner callback and (idempotently) start the ticker. Multiple
// callers (Telegram + WhatsApp bots) may each register their own runner.
function start(runner) {
  if (typeof runner === 'function' && !_runners.includes(runner)) _runners.push(runner);
  if (_timer) return;
  _timer = setInterval(() => { _tick().catch(() => {}); }, TICK_MS);
  if (_timer.unref) _timer.unref();
  // Fire an immediate catch-up tick (in case tasks were due during a redeploy).
  _tick().catch(() => {});
}

// Render a fire time in a human-friendly way, in the chat's timezone.
// offsetMin (minutes east of UTC) defaults to UTC+1 so the shown clock matches
// how the user asked for it. Shows the local wall clock + the tz label.
function humanizeWhen(fireAt, offsetMin) {
  const ms = fireAt - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  const off = Number.isFinite(offsetMin) ? offsetMin : DEFAULT_TZ_OFFSET_MIN;
  // Render the wall clock as seen in the user's timezone.
  const local = new Date(fireAt + off * 60 * 1000);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const tz = offsetLabel(off);
  if (mins < 60) return `in ${mins} min (${hh}:${mm} ${tz})`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `at ${hh}:${mm} ${tz} (in ${hrs}h${rem ? ' ' + rem + 'm' : ''})`;
}

module.exports = {
  parseDuration,
  parseSchedule,
  parseTimezone,
  getChatOffsetMin,
  setChatOffsetMin,
  offsetLabel,
  DEFAULT_TZ_OFFSET_MIN,
  add,
  list,
  cancelAll,
  cancelOne,
  start,
  humanizeWhen,
};
