// Regression test for the scheduler false-positive bug (#3):
// "two math questions auto-schedules" and similar non-scheduling messages
// must NOT arm a schedule; genuine scheduling requests still must.
'use strict';
const s = require('../services/agentScheduler');

let pass = 0, fail = 0;
function expect(text, shouldSchedule, note) {
  const r = s.parseSchedule(text, 60); // UTC+1
  const scheduled = !!(r && r.fireAt);
  const ok = scheduled === shouldSchedule;
  if (ok) { pass++; }
  else { fail++; }
  console.log(`${ok ? '✅' : '❌'} [${shouldSchedule ? 'SCHED' : 'NO   '}] ${scheduled ? '->scheduled' : '->ignored '} | ${note || ''} | "${text}"`);
}

console.log('\n=== SHOULD NOT SCHEDULE (the bug) ===');
expect('What is 15 at 3 and 20 at 4?', false, 'two math-ish "at"');
expect('Solve 2+2 and 3+3', false, 'arithmetic batch');
expect('what is 12 plus 8', false, 'plus word');
expect('calculate 45 / 9', false, 'division');
expect('look at 3 examples of recursion', false, 'stray "at 3"');
expect('give me 5 tips at once', false, '"at once"');
expect('What is the capital of France? What is 2+2?', false, 'two questions');
expect('explain how HTTP works', false, 'explain, no time');
expect('write a function at line 12', false, 'code-ish "at 12"');
expect('what is 100 divided by 4', false, 'divided by');
expect('who won at 1998 world cup', false, 'stray "at 1998"');

console.log('\n=== SHOULD STILL SCHEDULE (must not regress) ===');
expect('remind me to check XAUUSD at 6pm', true, 'verb + clock am/pm');
expect('run this in 30 minutes', true, 'relative + verb');
expect('in 2 hours', true, 'bare time phrase');
expect('tomorrow at 9am give me a market update', true, 'tomorrow + clock');
expect('at 18:30 send me the report', true, '24h clock + verb');
expect('remind me tonight at 8pm', true, 'tonight + clock');
expect('check the price in 45 minutes', true, 'check verb + relative');
expect('notify me at midnight', true, 'midnight + verb');

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
