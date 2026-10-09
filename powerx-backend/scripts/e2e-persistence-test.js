// End-to-end persistence smoke test.
// Verifies that wormgpt_memory saves + reads for multiple scopes AND is
// isolated per user (userA's memory NEVER leaks to userB).
// Run: node scripts/e2e-persistence-test.js
const db = require('../db');

const uidA = 'e2e-test-user-A-' + Date.now();
const uidB = 'e2e-test-user-B-' + Date.now();

async function cleanup() {
  for (const scope of [
    `chat:${uidA}`, `chat:${uidB}`,
    `desktop:${uidA}`, `desktop:${uidB}`,
    `web:${uidA}`, `web:${uidB}`,
  ]) {
    try { await db.clearWormgptMemory(scope); } catch (_) {}
  }
}

function assert(cond, msg) {
  if (!cond) { throw new Error('❌ FAIL: ' + msg); }
  console.log('✅ ' + msg);
}

(async () => {
  console.log('🧪 Persistence E2E — start');
  await cleanup();

  // ── Scenario 1: /api/chat scope (chat:<uid>) ─────────────────────────────
  await db.saveWormgptMemory(`chat:${uidA}`, 'user', 'Hi, my name is Neo and I like SQL.');
  await db.saveWormgptMemory(`chat:${uidA}`, 'assistant', 'Nice to meet you Neo. Noted: SQL fan.');
  await db.saveWormgptMemory(`chat:${uidA}`, 'user', 'What is my name?');
  await db.saveWormgptMemory(`chat:${uidA}`, 'assistant', 'Your name is Neo.');

  const mem1 = await db.getWormgptMemory(`chat:${uidA}`, 12);
  assert(mem1.length === 4, `chat scope returns all 4 messages for userA (got ${mem1.length})`);
  assert(mem1[0].content.includes('Neo'), 'oldest message preserved (chronological order)');
  assert(mem1[3].content.includes('Your name is Neo'), 'latest message at the end');

  // ── Scenario 2: /api/agent/run scope (web:<uid>) ────────────────────────
  await db.saveWormgptMemory(`web:${uidA}`, 'user', 'Build me a login page.');
  await db.saveWormgptMemory(`web:${uidA}`, 'model', 'Done. Deployed to https://example.com/login');
  await db.saveWormgptMemory(`web:${uidA}`, 'user', 'What was the URL again?');

  const mem2 = await db.getWormgptMemory(`web:${uidA}`, 12);
  assert(mem2.length === 3, `web scope returns 3 messages for userA (got ${mem2.length})`);
  assert(mem2.find(m => m.content.includes('example.com/login')), 'agent remembers URL from earlier task');

  // ── Scenario 3: /api/desktop/brain scope (desktop:<uid>) ────────────────
  await db.saveWormgptMemory(`desktop:${uidA}`, 'user', 'Analyze this Python script for bugs.');
  await db.saveWormgptMemory(`desktop:${uidA}`, 'assistant', 'Found 3 bugs: NPE at line 12, race in tick(), leak in loadFile().');
  const mem3 = await db.getWormgptMemory(`desktop:${uidA}`, 12);
  assert(mem3.length === 2, `desktop scope returns 2 messages for userA (got ${mem3.length})`);

  // ── Scenario 4: User isolation ─ userA memory must NOT show up for userB ─
  await db.saveWormgptMemory(`chat:${uidB}`, 'user', 'Different user, different task.');
  const memB = await db.getWormgptMemory(`chat:${uidB}`, 12);
  const memA_again = await db.getWormgptMemory(`chat:${uidA}`, 12);
  assert(memB.length === 1, 'userB sees only their own message');
  assert(!memB[0].content.includes('Neo'), 'userB does NOT see userA content');
  assert(memA_again.length === 4, 'userA memory intact after userB write');

  // ── Scenario 5: Scope isolation for same user ───────────────────────────
  const chatMem = await db.getWormgptMemory(`chat:${uidA}`, 12);
  const webMem  = await db.getWormgptMemory(`web:${uidA}`, 12);
  const dtopMem = await db.getWormgptMemory(`desktop:${uidA}`, 12);
  assert(chatMem.length === 4 && webMem.length === 3 && dtopMem.length === 2,
    `same user, three scopes, three independent histories (${chatMem.length}/${webMem.length}/${dtopMem.length})`);
  assert(!webMem.find(m => m.content.includes('Neo')), 'web scope does NOT leak from chat scope');
  assert(!dtopMem.find(m => m.content.includes('Neo')), 'desktop scope does NOT leak from chat scope');

  // ── Scenario 6: Cap enforcement ─────────────────────────────────────────
  // Write many messages and confirm the read returns at most the cap.
  for (let i = 0; i < 20; i++) {
    await db.saveWormgptMemory(`chat:${uidB}`, 'user', `msg ${i}`);
  }
  const capped = await db.getWormgptMemory(`chat:${uidB}`, 12);
  assert(capped.length === 12, `read cap honoured (got ${capped.length}, expected 12)`);
  assert(capped[capped.length - 1].content === 'msg 19', 'most-recent-first cap keeps latest messages');

  // ── Scenario 7: clearWormgptMemory ──────────────────────────────────────
  await db.clearWormgptMemory(`chat:${uidA}`);
  const cleared = await db.getWormgptMemory(`chat:${uidA}`, 12);
  assert(cleared.length === 0, 'clearWormgptMemory wipes that scope only');
  const webStill = await db.getWormgptMemory(`web:${uidA}`, 12);
  assert(webStill.length === 3, 'other scopes untouched by clear');

  // Cleanup
  await cleanup();
  console.log('\n🎉 All persistence E2E scenarios passed.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
