// ─────────────────────────────────────────────────────────────────────────────
// scripts/test-capy-thread-migration.js
//
// HEAVY END-TO-END test for the FAST PER-TASK MIGRATION mode
// (CAPY_ALWAYS_MIGRATE=1, the new default):
//
//   • EVERY task spins a BRAND-NEW Capy thread (no waiting on a stuck thread),
//   • the new thread is SEEDED with the last N turns (carry-over memory) so it
//     STILL REMEMBERS the conversation,
//   • a freshly created thread starts its run immediately → FAST replies,
//   • FILES are harvested + DELIVERED from the new thread.
//
// Covered scenarios (each run end-to-end):
//   RUN A — TEXT CHAT: 3 turns, each on a NEW thread, memory carried over.
//   RUN B — DOCUMENT FILE: ask for a .docx, assert the file is DELIVERED, then
//           a follow-up that still remembers the file context.
//
// Everything is mocked offline (node-fetch + db) but exercises the REAL
// services/capy.js code paths (runForSession → _migrateToFreshThread →
// submit → _pollUntilDone → harvestFiles → downloadFile).
// ─────────────────────────────────────────────────────────────────────────────
const assert = require('assert');
const path = require('path');

// ── Mode + speed knobs ───────────────────────────────────────────────────────
process.env.CAPY_ALWAYS_MIGRATE = '1';        // the behaviour under test
process.env.CAPY_API_KEY = 'capy_test_key';
process.env.CAPY_API_URL = 'https://capy.test/api/v1';
process.env.CAPY_POLL_INTERVAL_MS = '20';     // poll fast
process.env.CAPY_POLL_CEILING_MS = '8000';
process.env.CAPY_CREATE_TIMEOUT_MS = '2000';
process.env.CAPY_HTTP_TIMEOUT_MS = '2000';
process.env.CAPY_DOWNLOAD_TIMEOUT_MS = '2000';
process.env.CAPY_HISTORY_TURNS = '3';

// ── In-memory app_settings KV + db.js Capy helpers (re-impl, same semantics) ─
const kv = new Map();
function nowISO() { return new Date().toISOString(); }
const TP = 'capy_thread:', HP = 'capy_hist:';
const HMAX = parseInt(process.env.CAPY_HISTORY_TURNS, 10);
async function getSetting(k) { return kv.has(k) ? kv.get(k) : null; }
async function setSetting(k, v) { kv.set(k, v == null ? '' : String(v)); return true; }
async function getCapyThread(sk) {
  const raw = await getSetting(TP + sk); if (!raw) return null;
  try { const o = JSON.parse(raw); return o && o.threadId ? String(o.threadId) : null; } catch (_) { return String(raw).trim() || null; }
}
async function setCapyThread(sk, t) { if (!sk || !t) return false; await setSetting(TP + sk, JSON.stringify({ threadId: String(t), updatedAt: nowISO() })); return true; }
async function clearCapyThread(sk) { await setSetting(TP + sk, ''); return true; }
async function getCapyHistory(sk) {
  const raw = await getSetting(HP + sk); if (!raw) return [];
  try { const o = JSON.parse(raw); return (o && Array.isArray(o.turns)) ? o.turns.filter(t => t && (t.q || t.a)) : []; } catch (_) { return []; }
}
async function appendCapyHistory(sk, q, a) {
  const turns = await getCapyHistory(sk);
  const clip = s => String(s == null ? '' : s).slice(0, 4000);
  turns.push({ q: clip(q), a: clip(a), at: nowISO() });
  await setSetting(HP + sk, JSON.stringify({ turns: turns.slice(-HMAX), updatedAt: nowISO() }));
  return true;
}
async function clearCapyHistory(sk) { await setSetting(HP + sk, ''); return true; }
const mockDb = { getSetting, setSetting, getCapyThread, setCapyThread, clearCapyThread, getCapyHistory, appendCapyHistory, clearCapyHistory };
const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// ── Mock Capy server + a mock file host (0x0.st-style direct link) ───────────
const threads = {};
let seq = 0;
let nowMs = Date.now();
function ts() { return new Date(nowMs).toISOString(); }
function newThread() { const id = 'th_' + (++seq); threads[id] = { id, runState: 'running', status: 'active', messages: [] }; return threads[id]; }
function finish(t, reply) { t.messages.push({ id: 'a_' + t.messages.length, source: 'assistant', content: reply, createdAt: ts() }); t.runState = 'ready'; t.status = 'idle'; }

// What the next created thread should answer with (set per-turn by the test).
let NEXT_REPLY = 'DONE: ok';

const fetchPath = require.resolve('node-fetch');
function resp(status, obj, isBuffer) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (isBuffer && /content-type/i.test(h)) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : null },
    async text() { return isBuffer ? '' : JSON.stringify(obj); },
    async json() { return obj; },
    async arrayBuffer() { return isBuffer ? obj : Buffer.from(''); },
    body: null,
  };
}
const mockFetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();

  // ── Mock FILE HOST: serve the "document" bytes for delivery ────────────────
  if (u.hostname === '0x0.test') {
    // A tiny valid-ish DOCX zip header so harvestFiles accepts the bytes.
    const buf = Buffer.from('PK\x03\x04FAKE-DOCX-BYTES-FOR-TEST-DELIVERY', 'binary');
    return resp(200, buf, true);
  }

  const p = u.pathname.replace(/^\/api\/v1/, '');

  if (p === '/threads' && method === 'POST') {
    const body = JSON.parse(opts.body || '{}');
    const t = newThread();
    t.messages.push({ id: 'u_0', source: 'user', content: body.prompt || '', createdAt: ts() });
    t._reply = NEXT_REPLY;
    t._finishAt = nowMs + 60;
    return resp(200, { id: t.id, runState: 'running', status: 'active' });
  }
  let m = p.match(/^\/threads\/([^/]+)$/);
  if (m && method === 'GET') {
    const t = threads[m[1]]; if (!t) return resp(404, { error: { message: 'not found' } });
    if (t._finishAt && nowMs >= t._finishAt && t.runState !== 'ready') finish(t, t._reply);
    return resp(200, { id: t.id, runState: t.runState, status: t.status });
  }
  m = p.match(/^\/threads\/([^/]+)\/messages$/);
  if (m && method === 'GET') {
    const t = threads[m[1]]; if (!t) return resp(404, { error: { message: 'not found' } });
    return resp(200, { items: t.messages.slice() });
  }
  return resp(404, { error: { message: 'unhandled ' + method + ' ' + p } });
};
require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: mockFetch };

const clock = setInterval(() => { nowMs += 50; }, 10);
const capy = require('../services/capy.js');

// ─────────────────────────────────────────────────────────────────────────────
async function reset() { kv.clear(); for (const k of Object.keys(threads)) delete threads[k]; seq = 0; }

function seededUserMsg(threadId) { return (threads[threadId].messages.find(x => x.source === 'user') || {}).content || ''; }

async function runTextChat(label) {
  console.log('\n===== ' + label + ' (TEXT CHAT, every task → new thread + carry-over) =====');
  await reset();
  const SK = 'web:text-user';
  const steps = []; const onStep = s => steps.push(s);

  // Turn 1
  NEXT_REPLY = 'DONE: 2 plus 2 is 4.';
  const r1 = await capy.runForSession({ message: 'What is 2+2?', sessionKey: SK }, { onStep });
  assert(/DONE/.test(r1.reply), 'turn1 reply: ' + r1.reply);
  const t1 = await getCapyThread(SK); assert(t1, 'turn1 stores a thread');
  assert.strictEqual((await getCapyHistory(SK)).length, 1, 'turn1 → history 1');
  console.log('✓ Turn 1 on NEW thread ' + t1 + ' (history=1)');

  // Turn 2 — must be a DIFFERENT (new) thread, seeded with turn 1.
  NEXT_REPLY = 'DONE: that times ten is 40.';
  const r2 = await capy.runForSession({ message: 'Multiply that by 10', sessionKey: SK }, { onStep });
  assert(/DONE/.test(r2.reply), 'turn2 reply');
  const t2 = await getCapyThread(SK);
  assert(t2 && t2 !== t1, 'turn2 must use a NEW thread (got ' + t2 + ' vs ' + t1 + ')');
  const seed2 = seededUserMsg(t2);
  assert(/CONVERSATION CONTEXT/.test(seed2), 'turn2 thread must be seeded with carry-over');
  assert(/What is 2\+2\?/.test(seed2), 'turn2 seed must contain turn1 question (memory)');
  assert(/Multiply that by 10/.test(seed2), 'turn2 seed must contain the NEW request');
  assert.strictEqual((await getCapyHistory(SK)).length, 2, 'turn2 → history 2');
  console.log('✓ Turn 2 on NEW thread ' + t2 + ', remembered turn 1 (history=2)');

  // Turn 3 — again new thread, seeded with the last turns (cap 3).
  NEXT_REPLY = 'DONE: yes, 40 is even.';
  const r3 = await capy.runForSession({ message: 'Is that number even?', sessionKey: SK }, { onStep });
  assert(/DONE/.test(r3.reply), 'turn3 reply');
  const t3 = await getCapyThread(SK);
  assert(t3 && t3 !== t2, 'turn3 must use a NEW thread');
  const seed3 = seededUserMsg(t3);
  assert(/Multiply that by 10/.test(seed3), 'turn3 seed must remember the latest prior turn');
  assert((await getCapyHistory(SK)).length === 3, 'turn3 → history capped at 3');
  assert(steps.some(s => /carrying your last/i.test(s)), 'a carry-over step message should appear');
  console.log('✓ Turn 3 on NEW thread ' + t3 + ', carry-over capped at 3');
  console.log('PASS: ' + label);
}

async function runDocumentFile(label) {
  console.log('\n===== ' + label + ' (DOCUMENT FILE delivery) =====');
  await reset();
  const SK = 'web:doc-user';
  const steps = []; const onStep = s => steps.push(s);

  // Turn 1 — ask for a Word document; Capy "uploads" it to the mock file host
  // and lists it under DELIVERABLES. runForSession must DOWNLOAD + DELIVER it.
  NEXT_REPLY = [
    "Here is your report.",
    "",
    "DELIVERABLES:",
    "https://0x0.test/report.docx",
  ].join('\n');
  const r1 = await capy.runForSession(
    { message: 'Create a 1-page Word document report and give me the file', sessionKey: SK },
    { onStep }
  );
  assert(/report/i.test(r1.reply), 'doc turn1 reply present: ' + r1.reply);
  assert(Array.isArray(r1.files), 'result must have a files array');
  assert.strictEqual(r1.files.length, 1, 'exactly 1 file must be DELIVERED, got ' + r1.files.length);
  const f = r1.files[0];
  assert(/\.docx$/i.test(f.name), 'delivered file must be a .docx, got ' + f.name);
  assert(Buffer.isBuffer(f.buffer) && f.buffer.length > 0, 'delivered file must have bytes');
  assert(/wordprocessingml|octet-stream|zip/i.test(f.mime || ''), 'docx mime expected, got ' + f.mime);
  console.log('✓ Document DELIVERED: ' + f.name + ' (' + f.buffer.length + ' bytes, ' + f.mime + ')');

  // Turn 2 — follow-up on a NEW thread that still remembers the document task.
  NEXT_REPLY = 'DONE: added a title page. DELIVERABLES: none';
  const t1 = await getCapyThread(SK);
  const r2 = await capy.runForSession({ message: 'Add a title page to that report', sessionKey: SK }, { onStep });
  assert(/DONE/.test(r2.reply), 'doc turn2 reply');
  const t2 = await getCapyThread(SK);
  assert(t2 && t2 !== t1, 'doc turn2 must be a NEW thread');
  const seed2 = seededUserMsg(t2);
  assert(/Word document report/i.test(seed2), 'doc turn2 must remember the document request (carry-over)');
  console.log('✓ Follow-up on NEW thread ' + t2 + ' still remembers the document context');
  console.log('PASS: ' + label);
}

(async () => {
  try {
    // Test 2 times end-to-end, with TEXT chat AND a DOCUMENT file each run.
    await runTextChat('END-TO-END RUN #1');
    await runDocumentFile('END-TO-END RUN #1');
    await runTextChat('END-TO-END RUN #2');
    await runDocumentFile('END-TO-END RUN #2');
    clearInterval(clock);
    console.log('\n🎉 ALL FAST-MIGRATION E2E TESTS PASSED (2/2 runs · text chat + document file delivery).');
    process.exit(0);
  } catch (e) {
    clearInterval(clock);
    console.error('\n❌ TEST FAILED:', e && e.stack || e);
    process.exit(1);
  }
})();
