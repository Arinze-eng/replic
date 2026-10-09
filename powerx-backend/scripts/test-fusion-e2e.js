// scripts/test-fusion-e2e.js — verify FUSION (Mixture-of-Agents) quality.
// Runs chatWithMeta() in default FUSION mode against the live keyless brains
// (HotBot.com GPT-5 + Gemini gateway + keyless text brains) and prints which
// brain(s) produced the answer plus the answer itself, so we can eyeball the
// Claude-Opus-class quality before deploying.
//
// It also asserts (lightweight) correctness signals so a regression is loud:
//   • each test ships a non-trivial answer
//   • hard questions go through the verify pass (brain tag contains "+verify")
//   • known-answer questions contain the correct value
const hotbot = require('../services/hotbot');

const SYS = 'You are a brilliant, rigorous expert assistant. Think carefully and give complete, accurate, well-structured answers.';

const TESTS = [
  {
    name: 'Tricky reasoning (cognitive-reflection)',
    q: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Show the algebra and explain why the intuitive answer is wrong.',
    hard: true,
    mustInclude: ['0.05'],
  },
  {
    name: 'Multi-step word problem',
    q: 'A train leaves City A at 9:00 AM travelling at 60 km/h toward City B, 300 km away. Another train leaves City B at 9:30 AM travelling at 90 km/h toward City A on the same track. At what clock time do they meet, and how far from City A? Show your work.',
    hard: true,
    // They meet at t = 345/150 = 2.3 h after 9:00 → 11:18 AM, 138 km from A.
    mustIncludeAny: ['11:18', '138'],
  },
  {
    name: 'Explanation quality (code + concept)',
    q: 'Explain the difference between processes and threads, then give a short Python example that shows why CPU-bound work does not speed up with threads due to the GIL, and how multiprocessing fixes it.',
    hard: true,
    mustIncludeAny: ['multiprocessing', 'GIL'],
  },
  {
    name: 'Logic puzzle (date reasoning)',
    q: 'Today is Wednesday. What day of the week will it be 100 days from now? Show the modular-arithmetic reasoning.',
    hard: true,
    // 100 mod 7 = 2 → Wednesday + 2 = Friday
    mustIncludeAny: ['Friday'],
  },
  {
    name: 'Trivial chat (fast path, no verify)',
    q: 'Say hello in one short sentence.',
    hard: false,
  },
];

function ok(s) { return '\x1b[32m' + s + '\x1b[0m'; }
function bad(s) { return '\x1b[31m' + s + '\x1b[0m'; }

(async () => {
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    const t0 = Date.now();
    try {
      const { reply, brain } = await hotbot.chatWithMeta([
        { role: 'system', content: SYS },
        { role: 'user', content: t.q },
      ]);
      const ms = Date.now() - t0;
      const checks = [];

      if (!reply || reply.trim().length < (t.hard ? 40 : 2)) {
        checks.push(bad('FAIL: answer too short'));
      } else {
        checks.push(ok('ok: non-empty answer'));
      }
      if (t.mustInclude) {
        for (const needle of t.mustInclude) {
          checks.push(reply.includes(needle) ? ok(`ok: contains "${needle}"`) : bad(`FAIL: missing "${needle}"`));
        }
      }
      if (t.mustIncludeAny) {
        const hit = t.mustIncludeAny.some(n => reply.toLowerCase().includes(n.toLowerCase()));
        checks.push(hit ? ok(`ok: contains one of [${t.mustIncludeAny.join(', ')}]`) : bad(`FAIL: none of [${t.mustIncludeAny.join(', ')}]`));
      }
      // Verify-pass signal (best-effort: only when fusion synthesised at all).
      if (t.hard && /^fusion\[/.test(brain)) {
        checks.push(/\+verify/.test(brain) ? ok('ok: verify pass ran') : '\x1b[33mwarn: no +verify tag (maybe single-candidate)\x1b[0m');
      }

      const failed = checks.some(c => c.includes('FAIL'));
      if (failed) fail++; else pass++;

      console.log('\n\n══════════════════════════════════════════════════════════');
      console.log(`TEST: ${t.name}`);
      console.log(`BRAIN: ${brain}   (${ms} ms,  ${reply.length} chars)`);
      console.log('CHECKS: ' + checks.join('  |  '));
      console.log('──────────────────────────────────────────────────────────');
      console.log(reply.slice(0, 1800));
    } catch (e) {
      fail++;
      console.log(`\nTEST: ${t.name}  → ${bad('FAILED')}: ${e.message}`);
    }
  }
  console.log(`\n\nDONE.  ${ok(pass + ' passed')},  ${fail ? bad(fail + ' failed') : '0 failed'}.`);
  process.exit(fail ? 1 : 0);
})();
