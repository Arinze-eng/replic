// ─────────────────────────────────────────────────────────────────────────────
// test-scheduler-e2e.js — offline E2E for the agent scheduler + time-box parser.
//
// Verifies (no network / no sandbox required):
//   • parseDuration correctly extracts / clamps / rejects time-box requests
//   • parseSchedule extracts absolute fire times ("in N", "at 6pm", "tomorrow")
//   • add / list / cancelOne / cancelAll CRUD works and is per-chat isolated
//   • the multi-runner ticker dispatches a due task to the OWNING runner only
//     (Telegram numeric id vs WhatsApp jid), fires exactly once, and removes it
//
// Run:  node scripts/test-scheduler-e2e.js
// Uses an in-memory db stub so it never touches Supabase.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// Keep the offline dispatch portion fast and deterministic. Must be set before
// agentScheduler is required because its ticker interval is resolved at load.
process.env.AGENT_SCHEDULER_TICK_MS = '100';

// In-memory settings store so agentScheduler persists without Supabase.
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

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('⏱️  parseDuration');
  ok('"use 5 minutes" → 300000', s.parseDuration('use 5 minutes to research AI') === 300000);
  ok('"think for 10 min" → 600000', s.parseDuration('think for 10 min') === 600000);
  ok('"half an hour" → 1800000', s.parseDuration('spend half an hour on it') === 1800000);
  ok('"2 hours" clamps to 30 min', s.parseDuration('work for 2 hours') === 30 * 60 * 1000);
  ok('explicit research duration activates', s.parseDuration('use 20min to research and solve that') === 20 * 60 * 1000);
  ok('non-directive text → 0', s.parseDuration('a report about 5 minutes of exercise') === 0);
  ok('ordinary math question does not activate', s.parseDuration('A train travels for 30 minutes at 60 km/h. How far does it go?') === 0);
  ok('math word problem with solve verb does not activate', s.parseDuration('Solve this: Ada spent 20 minutes on question 3 and 10 minutes on question 4. What is the total?') === 0);
  ok('generic duration phrase does not activate', s.parseDuration('For 20 minutes, a pump fills 3 litres per minute. Calculate the volume.') === 0);

  console.log('⏰ parseSchedule');
  const inMin = s.parseSchedule('in 30 minutes, summarize the news');
  ok('"in 30 minutes" parses to a future time', inMin && inMin.fireAt > Date.now() + 29 * 60 * 1000);
  const at6 = s.parseSchedule('post the report at 6pm');
  ok('"at 6pm" parses', at6 && at6.fireAt > Date.now());
  const tmr = s.parseSchedule('email me tomorrow at 9am');
  ok('"tomorrow at 9am" is >12h out', tmr && tmr.fireAt > Date.now() + 12 * 60 * 60 * 1000);
  ok('non-time task → null', s.parseSchedule('write a poem about the sea') === null);

  console.log('🗂️  CRUD (per-chat isolation)');
  // reset store
  for (const k of Object.keys(_store)) delete _store[k];
  await s.add('12345', 'task A', Date.now() + 60000);
  await s.add('12345', 'task B', Date.now() + 120000);
  await s.add('999@s.whatsapp.net', 'wa task', Date.now() + 60000);
  const tgList = await s.list('12345');
  ok('chat 12345 has 2 schedules', tgList.length === 2);
  ok('sorted by fireAt', tgList[0].fireAt <= tgList[1].fireAt);
  const waList = await s.list('999@s.whatsapp.net');
  ok('wa chat isolated (1 schedule)', waList.length === 1);
  const removedOne = await s.cancelOne('12345', tgList[0].id);
  ok('cancelOne removes exactly 1', removedOne === 1 && (await s.list('12345')).length === 1);
  const removedAll = await s.cancelAll('12345');
  ok('cancelAll clears the rest', removedAll === 1 && (await s.list('12345')).length === 0);
  ok('other chat untouched by cancelAll', (await s.list('999@s.whatsapp.net')).length === 1);

  console.log('🎯 multi-runner dispatch (fires once, to the owning runner)');
  for (const k of Object.keys(_store)) delete _store[k];
  const fired = { tg: [], wa: [] };
  // Telegram runner: owns numeric ids
  s.start(async ({ chatId, task }) => {
    if (String(chatId).includes('@')) return false;
    fired.tg.push({ chatId, task });
    return true;
  });
  // WhatsApp runner: owns jids
  s.start(async ({ chatId, task }) => {
    if (!String(chatId).includes('@')) return false;
    fired.wa.push({ chatId, task });
    return true;
  });
  // Schedule two tasks due immediately (1ms in the future).
  await s.add('55555', 'tg-due', Date.now() + 5);
  await s.add('777@s.whatsapp.net', 'wa-due', Date.now() + 5);
  // Wait past the ticker interval (env-overridable) + a margin.
  await sleep(1200);
  ok('telegram task fired on telegram runner only', fired.tg.length === 1 && fired.tg[0].task === 'tg-due');
  ok('whatsapp task fired on whatsapp runner only', fired.wa.length === 1 && fired.wa[0].task === 'wa-due');
  ok('due tasks removed after firing', (await s.list('55555')).length === 0 && (await s.list('777@s.whatsapp.net')).length === 0);
  // No double-fire on the next tick.
  await sleep(1200);
  ok('no double-fire', fired.tg.length === 1 && fired.wa.length === 1);

  console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ SOME FAILED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
