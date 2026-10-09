// Quick self-test for the hardened Capy-first fallback (no network / no Capy key).
// Verifies: when Capy is NOT the head (pass-through) and the in-house engine
// throws or returns nothing, runAgentCapyFirst STILL returns a deliverable
// result object instead of throwing — so a bot task always "finishes".
const path = require('path');
const acf = require(path.join(__dirname, '..', 'services', 'agentCapyFirst.js'));

(async () => {
  let failures = 0;
  const ok = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failures++; };

  // Capy is not configured in this test env → shouldUseCapy() should be false,
  // so runAgentCapyFirst is a pass-through to fallbackRun.

  // 1) fallback THROWS → must NOT throw, must return a deliverable message.
  const r1 = await acf.runAgentCapyFirst(
    { task: 'do something', source: 'telegram', onStep: () => {} },
    async () => { throw new Error('engine boom'); },
  );
  ok('throwing fallback → returns object', r1 && typeof r1 === 'object');
  ok('throwing fallback → has message', !!(r1 && String(r1.message || '').trim()));
  ok('throwing fallback → brain=agent-error', r1 && r1.brain === 'agent-error');

  // 2) fallback returns EMPTY → must still return a deliverable message.
  const r2 = await acf.runAgentCapyFirst(
    { task: 'do something', source: 'telegram', onStep: () => {} },
    async () => ({ message: '', files: [] }),
  );
  ok('empty fallback → has message', !!(r2 && String(r2.message || '').trim()));

  // 3) fallback returns a REAL answer → must pass it through unchanged.
  const r3 = await acf.runAgentCapyFirst(
    { task: 'do something', source: 'whatsapp', onStep: () => {} },
    async () => ({ message: 'real answer', files: [{ path: '/x', name: 'x.txt' }], brain: 'DeepSeek', steps: 3 }),
  );
  ok('real fallback → message preserved', r3 && r3.message === 'real answer');
  ok('real fallback → files preserved', r3 && Array.isArray(r3.files) && r3.files.length === 1);
  ok('real fallback → brain preserved', r3 && r3.brain === 'DeepSeek');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
