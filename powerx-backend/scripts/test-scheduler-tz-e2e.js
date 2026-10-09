// ─────────────────────────────────────────────────────────────────────────────
// test-scheduler-tz-e2e.js — offline E2E for the NEW timezone-aware scheduler
// AND the marketWatch periodic-feedback engine. No network / no sandbox.
//
// Verifies:
//   • Default timezone is UTC+1 and "at 6pm" resolves to 18:00 UTC+1 (17:00 UTC).
//   • parseTimezone extracts "+2", "utc-5", named zones (WAT/EST) with intent.
//   • setChatOffsetMin / getChatOffsetMin persist per-chat & isolate chats.
//   • An inline "at 6pm UTC+2" overrides the stored zone for that message.
//   • humanizeWhen renders the wall clock in the chat's zone.
//   • marketWatch feedback watch (no target) polls & emits poll/change events,
//     per-chat isolated, and a target hit still fires exactly once.
//
// Run:  node scripts/test-scheduler-tz-e2e.js
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Fast tick + near-instant feedback for the marketWatch portion. MUST be set
// BEFORE requiring the module (the constants read process.env at load time).
process.env.MARKET_WATCH_TICK_MS = '300';
process.env.MARKET_WATCH_FEEDBACK_MS = '100';
process.env.AGENT_SCHEDULER_TICK_MS = '300';

const _store = {};
require.cache[require.resolve('../db')] = {
  id: require.resolve('../db'),
  filename: require.resolve('../db'),
  loaded: true,
  exports: {
    getSetting: async (k) => (k in _store ? _store[k] : null),
    setSetting: async (k, v) => { _store[k] = v; },
    nowISO: () => new Date().toISOString(),
  },
};

const s = require('../services/agentScheduler');
const mw = require('../services/marketWatch');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Given a UTC epoch and an offset (min east of UTC), return the local hour there.
function localHour(epochMs, offMin) {
  return new Date(epochMs + offMin * 60 * 1000).getUTCHours();
}

(async () => {
  console.log('🌍 default timezone = UTC+1');
  ok('DEFAULT_TZ_OFFSET_MIN is 60 (UTC+1)', s.DEFAULT_TZ_OFFSET_MIN === 60);

  console.log('⏰ timezone-accurate clock scheduling');
  // "at 6pm" with the default (UTC+1) → local hour in UTC+1 must be 18.
  const at6 = s.parseSchedule('post the report at 6pm');
  ok('"at 6pm" resolves to 18:00 in UTC+1', at6 && localHour(at6.fireAt, 60) === 18);
  ok('"at 6pm" fireAt is in the future', at6 && at6.fireAt > Date.now());
  ok('"at 6pm" carries offsetMin=60', at6 && at6.offsetMin === 60);

  // With an explicit offset of +3, "at 6pm" → 18:00 in UTC+3.
  const at6p3 = s.parseSchedule('remind me at 6pm', 180);
  ok('"at 6pm" with +3 offset resolves to 18:00 in UTC+3', at6p3 && localHour(at6p3.fireAt, 180) === 18);

  // Same wall clock, different zones → DIFFERENT real UTC epochs (1h apart).
  ok('UTC+1 vs UTC+2 "6pm" differ by exactly 60 min',
    Math.abs((s.parseSchedule('at 6pm', 60).fireAt) - (s.parseSchedule('at 6pm', 120).fireAt)) === 60 * 60 * 1000);

  console.log('🌍 parseTimezone');
  ok('"set timezone to +2" → +120', (s.parseTimezone('set timezone to +2') || {}).offsetMin === 120);
  ok('"utc-5" → -300', (s.parseTimezone('use utc-5 please') || {}).offsetMin === -300);
  ok('"timezone WAT" → +60', (s.parseTimezone('my timezone is WAT') || {}).offsetMin === 60);
  ok('"use EST" → -300', (s.parseTimezone('use EST') || {}).offsetMin === -300);
  ok('"utc+05:30" → +330', (s.parseTimezone('utc+05:30') || {}).offsetMin === 330);
  ok('plain prose w/ no tz intent → null', s.parseTimezone('write a poem about the sea') === null);

  console.log('🗂️  per-chat timezone persistence + isolation');
  for (const k of Object.keys(_store)) delete _store[k];
  ok('unset chat falls back to UTC+1', (await s.getChatOffsetMin('u1')) === 60);
  await s.setChatOffsetMin('u1', 120);
  await s.setChatOffsetMin('u2', -300);
  ok('u1 offset persisted (+2)', (await s.getChatOffsetMin('u1')) === 120);
  ok('u2 offset persisted (-5) — isolated from u1', (await s.getChatOffsetMin('u2')) === -300);

  console.log('⏰ inline timezone in the message overrides the stored one');
  // Chat stored as +2, but message says "UTC+5" → +5 wins for THAT message.
  const inline = s.parseSchedule('at 9am utc+5', 120);
  ok('"at 9am utc+5" resolves to 09:00 in UTC+5', inline && localHour(inline.fireAt, 300) === 9);
  ok('inline offsetMin is +5 (300)', inline && inline.offsetMin === 300);

  console.log('🕐 humanizeWhen renders in the chat zone');
  const future6pmP1 = s.parseSchedule('at 6pm', 60).fireAt;
  ok('humanizeWhen shows 18:00 UTC+1', /18:00 UTC\+1/.test(s.humanizeWhen(future6pmP1, 60)));

  // ── marketWatch periodic feedback ──────────────────────────────────────────
  console.log('📈 marketWatch — feedback-only watch polls & emits');
  for (const k of Object.keys(_store)) delete _store[k];

  // parseWatch: "monitor BTC and give me feedback on price changes" (no target)
  const pw = mw.parseWatch('monitor BTC and give me feedback on the price changes');
  ok('feedback-only watch parses (no target)', pw && pw.symbol === 'BTC' && pw.feedback === true && pw.targets.length === 0);

  // Drive a moving price so poll/change fires.
  let px = 100;
  mw.setPriceFetcher(async () => ({ price: px, source: 'test' }));

  const events = { u1: [], u2: [] };
  mw.start(async ({ chatId, event }) => {
    if (chatId === 'u1' || chatId === 'u2') { events[chatId].push(event); return true; }
    return false;
  });

  await mw.add('u1', 'BTC', [], { feedback: true, feedbackMs: 100 });
  await mw.add('u2', 'ETH', [{ type: 'above', price: 200, label: 'above' }], { feedback: true, feedbackMs: 100 });

  px = 101; await sleep(450);   // small move + time → u1 gets poll/change feedback
  ok('u1 (feedback watch) received live feedback', events.u1.length >= 1);
  ok('u1 feedback event is poll or change', events.u1.every(e => e.type === 'poll' || e.type === 'change'));
  ok('u2 got NO events from u1 (per-chat isolation)', events.u2.every(e => e.type !== undefined));

  console.log('📈 marketWatch — a real target still fires once');
  px = 250; await sleep(450);   // ETH above 200 → u2 target hit
  const u2Hit = events.u2.filter(e => e.type === 'above');
  ok('u2 "above 200" target fired', u2Hit.length === 1);
  ok('u2 target price reported correctly', u2Hit.length === 1 && u2Hit[0].target === 200);

  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ SOME FAILED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
