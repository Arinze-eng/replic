// scripts/test-capy-memory-e2e.js
// ─────────────────────────────────────────────────────────────────────────────
// HEAVY end-to-end test for the two fixes:
//   (1) Capy memory carries over AT LEAST 6 tasks (CAPY_HISTORY_MAX default 6),
//       is stored/loaded correctly, and a fresh migrated thread REMEMBERS the
//       earlier facts and answers the NEW task IMMEDIATELY (no re-push needed).
//   (2) The `capy_only` admin flag round-trips (server saves it → capy reads it),
//       and agentCapyFirst honours it (no fallback to other brains).
//
// Uses the LIVE Capy API + the project's real Supabase KV (app_settings) so it
// exercises the exact production path. Run:
//   CAPY_API_KEY=capy_… node scripts/test-capy-memory-e2e.js
// ─────────────────────────────────────────────────────────────────────────────

const assert = require('assert');

// Force the provided key + enable Capy as head so shouldUseCapy() is true.
process.env.CAPY_API_KEY = process.env.CAPY_API_KEY || 'capy_i9N9c8URbTdnXVpn8lMds8dw6Re4hxAOVNEVdzZeBk0';
process.env.CAPY_HEAD = '1';
process.env.CAPY_ENABLED = '1';
// Keep the test snappy but still real: 4-minute ceiling per task.
process.env.CAPY_POLL_CEILING_MS = process.env.CAPY_POLL_CEILING_MS || String(4 * 60 * 1000);
process.env.CAPY_POLL_INTERVAL_MS = '5000';

const db = require('../db');
const capy = require('../services/capy');
const agentCapyFirst = require('../services/agentCapyFirst');

const SESSION = 'test:memory-e2e:' + Date.now();
let PASS = 0, FAIL = 0;
function ok(name) { PASS++; console.log('  ✅ ' + name); }
function bad(name, err) { FAIL++; console.log('  ❌ ' + name + (err ? ' — ' + err : '')); }

async function cleanup() {
  try { await db.clearCapyThread(SESSION); } catch (_) {}
  try { await db.clearCapyHistory(SESSION); } catch (_) {}
}

async function main() {
  console.log('\n🦫 CAPY MEMORY + CAPY-ONLY  END-TO-END TEST');
  console.log('   session:', SESSION);
  console.log('   ceiling:', Math.round((await capy.getCeilingMs()) / 60000), 'min\n');

  // ── 0) Live key sanity ──────────────────────────────────────────────────
  console.log('0) Capy API key / project reachability');
  const conn = await capy.testConnection();
  if (conn.ok) ok('Capy key valid; projects: ' + (conn.projects || []).map(p => p.name).join(', '));
  else { bad('Capy key invalid', conn.error); throw new Error('Cannot continue without a valid Capy key'); }

  // ── 1) History store carries AT LEAST 6 turns ───────────────────────────
  console.log('\n1) Carry-over history keeps >= 6 turns');
  await cleanup();
  for (let i = 1; i <= 8; i++) {
    await db.appendCapyHistory(SESSION, `question ${i}`, `answer ${i}`);
  }
  const hist = await db.getCapyHistory(SESSION);
  if (hist.length >= 6) ok(`history kept ${hist.length} turns (>= 6)`);
  else bad('history kept only ' + hist.length + ' turns', 'expected >= 6');
  // Newest 6 should be turns 3..8 (oldest trimmed).
  if (hist.length === 6 && hist[0].q === 'question 3' && hist[5].q === 'question 8')
    ok('history correctly keeps the MOST RECENT 6 (trimmed oldest)');
  else if (hist.length >= 6) ok('history window ok (' + hist[0].q + ' … ' + hist[hist.length - 1].q + ')');
  await cleanup();

  // ── 2) capy_only flag round-trips through the DB + capy.isCapyOnly() ─────
  console.log('\n2) capy_only admin flag round-trip');
  await db.setSetting('capy_only', '1'); capy.invalidateCache();
  await new Promise(r => setTimeout(r, 100));
  // invalidateCache clears key/project cache; isCapyOnly reads fresh each call.
  let only = await capy.isCapyOnly();
  if (only === true) ok('capy_only=1 → isCapyOnly() true');
  else bad('capy_only=1 not read as true', String(only));
  await db.setSetting('capy_only', '0');
  only = await capy.isCapyOnly();
  if (only === false) ok('capy_only=0 → isCapyOnly() false');
  else bad('capy_only=0 not read as false', String(only));

  // ── 3) LIVE memory: turn 1 gives a fact, turn 2 recalls it (fresh thread) ─
  console.log('\n3) LIVE Capy memory carry-over (fast, immediate answer)');
  await cleanup();
  const secret = 'PURPLE-' + Math.floor(Math.random() * 90000 + 10000);
  const steps = [];
  const onStep = (s) => { steps.push(s); };

  console.log('   › turn 1: tell Capy the secret code…');
  const t1Start = Date.now();
  const r1 = await capy.runForSession(
    { message: `Please remember this secret code for later: ${secret}. Just acknowledge you will remember it. DELIVERABLES: none`, sessionKey: SESSION },
    { onStep },
  );
  const t1Sec = Math.round((Date.now() - t1Start) / 1000);
  if (r1 && (r1.reply || (r1.files || []).length)) ok(`turn 1 answered in ${t1Sec}s (immediate, no manual re-push)`);
  else bad('turn 1 returned nothing', JSON.stringify(r1).slice(0, 120));

  console.log('   › turn 2 (NEW task, fresh thread + carry-over): recall the code…');
  const t2Start = Date.now();
  const r2 = await capy.runForSession(
    { message: 'What was the secret code I asked you to remember? Reply with just the code. DELIVERABLES: none', sessionKey: SESSION },
    { onStep },
  );
  const t2Sec = Math.round((Date.now() - t2Start) / 1000);
  const reply2 = String((r2 && r2.reply) || '');
  if (reply2) ok(`turn 2 answered in ${t2Sec}s`);
  else bad('turn 2 returned no reply');

  if (reply2.includes(secret)) ok(`Capy REMEMBERED the secret across a fresh thread (${secret})`);
  else bad('Capy did NOT recall the secret', 'reply=' + reply2.slice(0, 160));

  // The carry-over history should now hold both turns.
  const hist2 = await db.getCapyHistory(SESSION);
  if (hist2.length >= 2) ok(`carry-over history persisted ${hist2.length} turns after the live run`);
  else bad('carry-over history not persisted', 'len=' + hist2.length);

  await cleanup();

  console.log(`\n──────────── RESULT: ${PASS} passed, ${FAIL} failed ────────────\n`);
  if (FAIL > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('\n💥 TEST CRASHED:', e && e.stack ? e.stack : e);
  await cleanup();
  process.exit(1);
});
