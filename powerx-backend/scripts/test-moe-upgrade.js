// E2E test for the UPGRADED Mixture-of-Experts engine:
//   1. needsSandbox() correctly routes terminal-verified tasks.
//   2. SEQUENTIAL ("one at a time") mode: experts solve/run ONE AFTER THE OTHER,
//      so sandbox executions are strictly ordered (Gemini then GPT, per round).
//   3. On a terminal task the experts' REAL sandbox outputs must AGREE before
//      they are allowed to unite (argue-until-perfect).
//   4. Anti-flicker: exactly ONE consolidated round_summary message per round.
//
// The brains (Gemini gateway + HotBot) are mocked so the test is deterministic,
// offline and fast — it verifies ORCHESTRATION, not model quality. A separate
// live test (test-debate-e2e.js) exercises the real brains.

const path = require('path');

function section(t) { console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70)); }
function assert(cond, msg) { if (!cond) { console.error('  ❌ ' + msg); process.exitCode = 1; } else { console.log('  ✅ ' + msg); } }

// ── 1. needsSandbox() routing (uses the real exported fn) ──
const debateSvc = require('../services/debate');

section('1) needsSandbox() task routing');
const SANDBOX_CASES = [
  ['Write a Python function that returns the nth Fibonacci number and run it for n=20', true],
  ['What is 1234 * 5678?', true],
  ['Compute the average speed: 240 km in 3h then 180 km in 2h', true],
  ['Write a one-paragraph essay about the French Revolution', false],
  ['Give me motivational quotes about success', false],
];
for (const [q, want] of SANDBOX_CASES) {
  const got = debateSvc.needsSandbox(q, debateSvc.detectDomain(q));
  assert(got === want, `needsSandbox(${JSON.stringify(q.slice(0, 42))}…) = ${got} (want ${want})`);
}

// ── 2 & 3. SEQUENTIAL ordering + sandbox-output agreement (mocked brains) ──
// We hijack require cache so debate.js's `gemini` / `hotbotReal` / `daytona`
// deps are deterministic mocks. Must be done BEFORE debate.js is first loaded,
// so we clear it from cache and re-require with the mocks installed.
section('2+3) SEQUENTIAL one-at-a-time + terminal-output convergence');

const order = [];                 // records the exact execution order
const RUN_BLOCK = '```run\nprint(391)\n```';

// Mock gemini gateway.
require.cache[require.resolve('../services/gemini')] = {
  id: require.resolve('../services/gemini'),
  loaded: true,
  exports: {
    BASE_URL: 'http://mock', ENDPOINT: '/x', AUTH_TOKEN: 'mock', SYSTEM_PROMPT: 'mock',
    async ask() { order.push('gemini.think'); return { _mock: true }; },
    extractText() { return `Working...\n${RUN_BLOCK}\nFINAL ANSWER: 391`; },
  },
};
// Mock HotBot real backend.
require.cache[require.resolve('../services/hotbotReal')] = {
  id: require.resolve('../services/hotbotReal'),
  loaded: true,
  exports: {
    DEFAULT_CHAT_MODEL: 'mock-gpt',
    async chat() { order.push('gpt.think'); return `Checked it.\n${RUN_BLOCK}\nFINAL ANSWER: 391`; },
    async listModels() { return []; },
  },
};
// Mock the UNIFIED sandbox pool so "running code" is deterministic and ordered.
// (debate.js now verifies via services/sandboxPool, not daytona directly.)
require.cache[require.resolve('../services/sandboxPool')] = {
  id: require.resolve('../services/sandboxPool'),
  loaded: true,
  exports: {
    async acquire() { return { id: 'mock-sbx', backend: 'mock', label: 'Mock', reused: false, mod: {} }; },
    async run(handle, code) {
      order.push('sandbox.exec');
      return { code, output: '391\n', ok: true, lang: 'python', backend: 'mock' }; // both experts get the SAME real output
    },
    async status() { return { hopx: false, runloop: false, daytona: true, local: true }; },
    detectLang() { return 'python'; },
    labelOf(n) { return n; },
    BACKENDS: {}, ORDER: ['hopx', 'runloop', 'daytona'],
  },
};
// Also mock browserless so needsWeb tasks don't hit the network in tests.
require.cache[require.resolve('../services/browserless')] = {
  id: require.resolve('../services/browserless'),
  loaded: true,
  exports: {
    async browseUrl() { return { text: '' }; },
    async webSearchViaBrowserless() { return ''; },
    isAvailable() { return false; },
  },
};

// Force a clean reload of debate.js with the mocks in place.
delete require.cache[require.resolve('../services/debate')];
const debateMocked = require('../services/debate');

(async () => {
  const events = [];
  const res = await debateMocked.debate(
    'Write a Python function and run it to compute 17*23',
    {
      maxRounds: 2,
      sandbox: { id: 'mock-sbx' },
      unify: false,                       // skip unify call (mock returns run-block text)
      onEvent: (ev) => events.push(ev),
    }
  );

  // needsSandbox must have been detected for a code/compute task.
  assert(res.needsSandbox === true, 'engine flagged the task as terminal-verified (needsSandbox=true)');
  assert(res.sequential === true, 'engine ran in SEQUENTIAL (one-at-a-time) mode by default');

  // ORDER must be: gemini.think → sandbox.exec → gpt.think → sandbox.exec ...
  // i.e. NEVER two .think in a row before a sandbox.exec (proves one-at-a-time).
  console.log('  exec order:', order.join(' → '));
  let oneAtATime = true;
  for (let i = 0; i < order.length - 1; i++) {
    if (order[i] === 'gemini.think' && order[i + 1] === 'gpt.think') oneAtATime = false;
  }
  assert(oneAtATime, 'experts acted ONE AT A TIME (no back-to-back thinking before a sandbox run)');
  assert(order.filter(o => o === 'sandbox.exec').length >= 2, 'BOTH experts ran code in the sandbox (one after the other)');

  // Since both experts returned the SAME real sandbox output (391) AND the same
  // FINAL ANSWER, the terminal-aware convergence must report agreement.
  assert(res.converged === true, 'experts CONVERGED (prose + identical real sandbox output)');

  // Anti-flicker: exactly one round_summary per engine round.
  const summaries = events.filter(e => e.type === 'round_summary').length;
  assert(summaries === res.rounds.length, `exactly ONE round_summary per round (got ${summaries} for ${res.rounds.length} rounds) — no flicker`);

  section('OVERALL');
  console.log(process.exitCode ? '❌ SOME CHECKS FAILED' : '✅ ALL UPGRADE CHECKS PASSED');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
