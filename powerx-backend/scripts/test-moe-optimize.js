// E2E test for the MoE OPTIMIZATION (v2):
//   1. sandboxPool selection contract: 'auto' cascades HopX→Runloop→Daytona;
//      a specific SANDBOX_BACKEND returns ONLY that backend; none-healthy → [].
//   2. needsWeb() routing: live/URL/search tasks are flagged, static ones aren't.
//   3. extractWebTargets(): pulls a URL and/or a search query from the question.
//   4. AUTO-ACQUIRE + cross-verify: debate() with NO explicit sandbox transparently
//      grabs one from the pool, both experts run code on it one-at-a-time, and
//      convergence requires matching REAL sandbox output.
//   5. SHARED WEB EVIDENCE: a browsing task fetches ONE snapshot and feeds the
//      SAME text to BOTH experts (verified by inspecting the prompts they receive).
//
// Brains, sandbox pool and browser are mocked so the test is deterministic and
// offline — it verifies ORCHESTRATION, not model quality.

function section(t) { console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70)); }
function assert(cond, msg) { if (!cond) { console.error('  ❌ ' + msg); process.exitCode = 1; } else { console.log('  ✅ ' + msg); } }

// ── 1. sandboxPool selection contract (mock the three backends) ──
section('1) sandboxPool backend selection contract');

function mockBackend(name, healthy) {
  return {
    enabled: () => healthy,
    enabledAsync: async () => healthy,
    async getOrCreateSessionSandbox() { return { id: `${name}-sbx`, reused: false }; },
    async exec(id, cmd) { return { result: `[${name}] ran` }; },
  };
}
// Install mocks for hopx/runloop/daytona BEFORE loading sandboxPool.
function loadPoolWith({ hopx, runloop, daytona }, backendEnv) {
  for (const [mod, exp] of [['hopx', hopx], ['runloop', runloop], ['daytona', daytona]]) {
    const p = require.resolve(`../services/${mod}`);
    require.cache[p] = { id: p, loaded: true, exports: exp };
  }
  // db has no setting → falls back to env.
  const dbp = require.resolve('../db');
  require.cache[dbp] = { id: dbp, loaded: true, exports: { async getSetting() { return null; } } };
  delete require.cache[require.resolve('../services/sandboxPool')];
  if (backendEnv === undefined) delete process.env.SANDBOX_BACKEND; else process.env.SANDBOX_BACKEND = backendEnv;
  return require('../services/sandboxPool');
}

(async () => {
  // auto → all healthy → first in ORDER among the healthy ones wins.
  // Current ORDER is [codesandbox, novita, tensorlake, runloop, daytona, hopx, githubactions];
  // this test only mocks hopx/runloop/daytona, so Runloop (earliest of the three) wins.
  let pool = loadPoolWith({ hopx: mockBackend('hopx', true), runloop: mockBackend('runloop', true), daytona: mockBackend('daytona', true) }, 'auto');
  let casc = await pool.cascade();
  assert(casc.length === 3 && casc[0].name === 'runloop', `auto cascade order = [${casc.map(c => c.name)}] (Runloop first among healthy)`);
  let h = await pool.acquire('s1');
  assert(h && h.backend === 'runloop', `acquire() picked Runloop (got ${h && h.backend})`);

  // auto → Runloop down → Daytona wins (next in ORDER)
  pool = loadPoolWith({ hopx: mockBackend('hopx', true), runloop: mockBackend('runloop', false), daytona: mockBackend('daytona', true) }, 'auto');
  h = await pool.acquire('s2');
  assert(h && h.backend === 'daytona', `Runloop down → fell back to Daytona (got ${h && h.backend})`);

  // specific backend → ONLY that one (no cross-fallback)
  pool = loadPoolWith({ hopx: mockBackend('hopx', true), runloop: mockBackend('runloop', true), daytona: mockBackend('daytona', true) }, 'daytona');
  casc = await pool.cascade();
  assert(casc.length === 1 && casc[0].name === 'daytona', `SANDBOX_BACKEND=daytona → only [daytona] (got [${casc.map(c => c.name)}])`);

  // all down → acquire returns null (NO fake sandbox)
  pool = loadPoolWith({ hopx: mockBackend('hopx', false), runloop: mockBackend('runloop', false), daytona: mockBackend('daytona', false) }, 'auto');
  h = await pool.acquire('s3');
  assert(h === null, 'all backends down → acquire() returns null (never a fake OK)');

  // run() language wrapping
  pool = loadPoolWith({ hopx: mockBackend('hopx', true), runloop: mockBackend('runloop', true), daytona: mockBackend('daytona', true) }, 'auto');
  assert(pool.detectLang('print(1)') === 'python', 'detectLang(print) = python');
  assert(pool.detectLang('console.log(1)') === 'node', 'detectLang(console.log) = node');
  assert(pool.detectLang('ls -la') === 'shell', 'detectLang(ls) = shell');

  // ── 2 & 3. needsWeb routing + target extraction (real debate exports) ──
  section('2+3) needsWeb() routing + extractWebTargets()');
  // Load debate with mocked deps so requiring it is safe & offline.
  installBrainAndPoolMocks();
  const debate = require('../services/debate');
  const WEB_CASES = [
    ['What is the latest Bitcoin price right now?', true],
    ['Summarize https://example.com/article', true],
    ['Search the web for the 2026 World Cup host', true],
    ['Write a Python function for bubble sort', false],
    ['Explain how TCP works', false],
  ];
  for (const [q, want] of WEB_CASES) {
    const got = debate.needsWeb(q, debate.detectDomain(q));
    assert(got === want, `needsWeb(${JSON.stringify(q.slice(0, 40))}…) = ${got} (want ${want})`);
  }
  const t = debate.extractWebTargets('Please summarize https://news.example.com/x and tell me more');
  assert(t.url === 'https://news.example.com/x', `extractWebTargets URL = ${t.url}`);
  assert(t.query.length > 0 && !/https?:/.test(t.query), 'extractWebTargets query strips the URL');

  // ── 4. AUTO-ACQUIRE + cross-verify with NO explicit sandbox ──
  section('4) auto-acquire sandbox + terminal cross-verification');
  delete require.cache[require.resolve('../services/debate')];
  const order = installBrainAndPoolMocks();
  const debate2 = require('../services/debate');
  const res = await debate2.debate('Write a Python function and run it to compute 17*23', {
    maxRounds: 2, unify: false, // no explicit sandbox → must auto-acquire
  });
  assert(res.needsSandbox === true, 'task flagged terminal-verified');
  assert(res.sandboxBackend === 'pool-mock', `auto-acquired a sandbox from the pool (backend=${res.sandboxBackend})`);
  assert(order.filter(o => o === 'sandbox.exec').length >= 2, 'BOTH experts ran code on the auto-acquired sandbox');
  assert(res.converged === true, 'converged on matching real sandbox output');

  // ── 5. SHARED WEB EVIDENCE feeds BOTH experts the SAME snapshot ──
  section('5) shared web evidence injected into both experts');
  delete require.cache[require.resolve('../services/debate')];
  const seenPrompts = installBrainAndPoolMocks({ captureWeb: true });
  const debate3 = require('../services/debate');
  await debate3.debate('What is the latest news about AI at https://example.com/ai', {
    maxRounds: 2, unify: false,
  });
  const withEvidence = seenPrompts.prompts.filter(p => p.includes('SHARED WEB EVIDENCE')).length;
  assert(withEvidence >= 2, `both experts received the shared web snapshot (${withEvidence} prompts carried it)`);

  section('OVERALL');
  console.log(process.exitCode ? '❌ SOME CHECKS FAILED' : '✅ ALL MoE-OPT CHECKS PASSED');
})().catch(e => { console.error('FATAL', e); process.exit(1); });

// Installs deterministic mocks for gemini, hotbotReal, sandboxPool and
// browserless, then clears debate.js from cache so it picks them up. Returns the
// recorded `order` array (or a { prompts } capture when captureWeb=true).
function installBrainAndPoolMocks(opts = {}) {
  const order = [];
  const capture = { prompts: [] };
  const RUN_BLOCK = '```run\nprint(391)\n```';

  const gp = require.resolve('../services/gemini');
  require.cache[gp] = { id: gp, loaded: true, exports: {
    BASE_URL: 'http://mock', ENDPOINT: '/x', AUTH_TOKEN: 'mock', SYSTEM_PROMPT: 'mock',
    async ask(prompt) { order.push('gemini.think'); capture.prompts.push(String(prompt)); return { _mock: true }; },
    extractText() { return `Working...\n${RUN_BLOCK}\nFINAL ANSWER: 391`; },
  } };

  const hp = require.resolve('../services/hotbotReal');
  require.cache[hp] = { id: hp, loaded: true, exports: {
    DEFAULT_CHAT_MODEL: 'mock-gpt',
    async chat(messages) {
      order.push('gpt.think');
      const txt = Array.isArray(messages) && messages[0] ? messages[0].content : '';
      capture.prompts.push(String(txt));
      return `Checked it.\n${RUN_BLOCK}\nFINAL ANSWER: 391`;
    },
    async listModels() { return []; },
  } };

  const sp = require.resolve('../services/sandboxPool');
  require.cache[sp] = { id: sp, loaded: true, exports: {
    async acquire() { return { id: 'm', backend: 'pool-mock', label: 'Pool', reused: false, mod: {} }; },
    async run(handle, code) { order.push('sandbox.exec'); return { code, output: '391\n', ok: true, lang: 'python', backend: 'pool-mock' }; },
    async status() { return { hopx: false, runloop: false, daytona: false, local: true }; },
    async cascade() { return []; },
    detectLang() { return 'python'; },
    labelOf(n) { return n; },
    BACKENDS: {}, ORDER: ['hopx', 'runloop', 'daytona'],
  } };

  const bp = require.resolve('../services/browserless');
  require.cache[bp] = { id: bp, loaded: true, exports: {
    async browseUrl() { return { text: 'MOCK PAGE CONTENT about AI news 2026.' }; },
    async webSearchViaBrowserless() { return 'MOCK SEARCH RESULTS'; },
    isAvailable() { return true; },
  } };

  delete require.cache[require.resolve('../services/debate')];
  return opts.captureWeb ? capture : order;
}
