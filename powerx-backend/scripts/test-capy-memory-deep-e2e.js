// scripts/test-capy-memory-deep-e2e.js
// ─────────────────────────────────────────────────────────────────────────────
// DEEP end-to-end test: run 6 real Capy tasks in a row on ONE session, seeding a
// distinct fact each turn, then a 7th task that must recall a fact from EARLY in
// the conversation — proving Capy "remembers at least 6 tasks and carries them
// over" across the fresh-thread-per-task migration, and answers immediately.
//
// Also verifies agentCapyFirst honours capy_only=1 (no fallback to other brains)
// by pointing it at a bad key so Capy fails, and asserting the returned brain is
// 'capy-only' (NOT the in-house engine).
//
//   CAPY_API_KEY=capy_… node scripts/test-capy-memory-deep-e2e.js
// ─────────────────────────────────────────────────────────────────────────────

process.env.CAPY_API_KEY = process.env.CAPY_API_KEY || 'capy_i9N9c8URbTdnXVpn8lMds8dw6Re4hxAOVNEVdzZeBk0';
process.env.CAPY_HEAD = '1';
process.env.CAPY_ENABLED = '1';
process.env.CAPY_POLL_CEILING_MS = process.env.CAPY_POLL_CEILING_MS || String(5 * 60 * 1000);
process.env.CAPY_POLL_INTERVAL_MS = '5000';
// Make sure at least 6 turns are carried over regardless of the DB setting.
process.env.CAPY_HISTORY_TURNS = process.env.CAPY_HISTORY_TURNS || '6';

const db = require('../db');
const capy = require('../services/capy');
const agentCapyFirst = require('../services/agentCapyFirst');

const SESSION = 'test:deep-e2e:' + Date.now();
let PASS = 0, FAIL = 0;
const ok = (n) => { PASS++; console.log('  ✅ ' + n); };
const bad = (n, e) => { FAIL++; console.log('  ❌ ' + n + (e ? ' — ' + e : '')); };

async function cleanup() {
  try { await db.clearCapyThread(SESSION); } catch (_) {}
  try { await db.clearCapyHistory(SESSION); } catch (_) {}
  try { await db.setSetting('capy_only', '0'); } catch (_) {}
  capy.invalidateCache();
}

// Six memorable facts. We ask Capy to remember each, then recall #2 at the end.
const FACTS = [
  { key: 'city',   val: 'Lagos' },
  { key: 'animal', val: 'octopus' },
  { key: 'number', val: '4271' },
  { key: 'color',  val: 'turquoise' },
  { key: 'fruit',  val: 'mango' },
  { key: 'planet', val: 'Neptune' },
];

async function main() {
  console.log('\n🦫 DEEP CAPY MEMORY (6 tasks) + CAPY-ONLY NO-FALLBACK  E2E');
  console.log('   session:', SESSION, '\n');

  await cleanup();

  // ── PART A: 6 sequential live tasks, each seeds one fact ─────────────────
  console.log('A) Feeding 6 facts across 6 fresh-thread tasks (memory carry-over)');
  for (let i = 0; i < FACTS.length; i++) {
    const f = FACTS[i];
    const start = Date.now();
    const r = await capy.runForSession(
      { message: `Remember: my ${f.key} is ${f.val}. Acknowledge in one short sentence. DELIVERABLES: none`, sessionKey: SESSION },
      { onStep: () => {} },
    );
    const sec = Math.round((Date.now() - start) / 1000);
    if (r && (r.reply || (r.files || []).length)) ok(`turn ${i + 1} (${f.key}=${f.val}) answered in ${sec}s`);
    else bad(`turn ${i + 1} (${f.key}) returned nothing`);
  }

  const hist = await db.getCapyHistory(SESSION);
  if (hist.length >= 6) ok(`carry-over history holds ${hist.length} turns (>= 6)`);
  else bad('carry-over history too short', 'len=' + hist.length);

  // ── PART B: recall an EARLY fact (#2, the animal) — proves deep memory ────
  console.log('\nB) Recall an EARLY fact (turn 2: the animal) after 6 turns');
  const start = Date.now();
  const rr = await capy.runForSession(
    { message: 'Earlier I told you my animal. What animal was it? Reply with just the animal name. DELIVERABLES: none', sessionKey: SESSION },
    { onStep: () => {} },
  );
  const sec = Math.round((Date.now() - start) / 1000);
  const reply = String((rr && rr.reply) || '').toLowerCase();
  if (reply) ok(`recall task answered in ${sec}s`);
  else bad('recall task returned no reply');
  if (reply.includes('octopus')) ok('Capy recalled the EARLY fact (octopus) — deep memory works');
  else bad('Capy did NOT recall the early fact', 'reply=' + reply.slice(0, 160));

  // ── PART C: capy_only=1 → NO fallback to other brains on Capy failure ────
  console.log('\nC) capy_only=1 → agentCapyFirst must NOT fall back to other brains');
  await db.setSetting('capy_only', '1');
  // Force Capy to fail: override BOTH the env key AND the Supabase DB key
  // (the DB setting takes precedence over env, so we must clobber it too).
  const savedDbKey = (await db.getSetting('capy_api_key')) || '';
  const savedKey = process.env.CAPY_API_KEY;
  await db.setSetting('capy_api_key', 'capy_definitely_invalid_key_for_test');
  process.env.CAPY_API_KEY = 'capy_definitely_invalid_key_for_test';
  capy.invalidateCache();
  await new Promise(r => setTimeout(r, 200));

  let fellBackToEngine = false;
  const fakeEngine = async () => { fellBackToEngine = true; return { message: 'IN-HOUSE ENGINE ANSWER', files: [], brain: 'engine' }; };
  const out = await agentCapyFirst.runAgentCapyFirst(
    { task: 'Say hello.', sessionKey: SESSION + ':only', onStep: () => {} },
    fakeEngine,
  );

  if (!fellBackToEngine) ok('capy_only=1: did NOT invoke the in-house engine fallback');
  else bad('capy_only=1: WRONGLY fell back to the in-house engine');
  if (out && out.brain === 'capy-only') ok("returned brain='capy-only' with a clear Capy message");
  else bad('unexpected result in capy-only mode', JSON.stringify(out).slice(0, 160));

  // ── PART D: capy_only=0 → fallback restored (control) ────────────────────
  console.log('\nD) capy_only=0 → fallback to the engine is restored');
  await db.setSetting('capy_only', '0');
  // Keep the bad key in place so Capy still fails → engine must take over.
  capy.invalidateCache();
  await new Promise(r => setTimeout(r, 200));
  let fellBack2 = false;
  const out2 = await agentCapyFirst.runAgentCapyFirst(
    { task: 'Say hi.', sessionKey: SESSION + ':fb', onStep: () => {} },
    async () => { fellBack2 = true; return { message: 'ENGINE', files: [], brain: 'engine' }; },
  );
  if (fellBack2 && out2 && out2.brain === 'engine') ok('capy_only=0: correctly fell back to the in-house engine');
  else bad('capy_only=0: did not fall back as expected', JSON.stringify(out2).slice(0, 120));

  // Restore the real key so the shared account isn't left broken.
  process.env.CAPY_API_KEY = savedKey;
  if (savedDbKey) await db.setSetting('capy_api_key', savedDbKey);
  else await db.setSetting('capy_api_key', '');
  capy.invalidateCache();

  await cleanup();
  console.log(`\n──────────── RESULT: ${PASS} passed, ${FAIL} failed ────────────\n`);
  if (FAIL > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('\n💥 TEST CRASHED:', e && e.stack ? e.stack : e);
  await cleanup();
  process.exit(1);
});
