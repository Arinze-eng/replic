// Test: per-chat serial queue ensures a FILE followed by a TEXT instruction
// (sent back-to-back) are handled IN ORDER, so the text handler sees the
// buffered file and fuses them into ONE task — instead of racing and treating
// them as two separate tasks (the reported bug).
//
// This mirrors the exact queue mechanism added to services/wormgptBot.js and
// services/whatsappBot.js.

'use strict';

// ── Replica of the per-chat serial queue added to both bots ──────────────────
const _chatQueues = new Map();
function makeHandleUpdate(dispatch) {
  return function handleUpdate(chatId, payload) {
    if (!chatId) return dispatch(chatId, payload).catch(() => {});
    const prev = _chatQueues.get(chatId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => dispatch(chatId, payload));
    _chatQueues.set(chatId, next);
    next.catch(() => {}).finally(() => {
      if (_chatQueues.get(chatId) === next) _chatQueues.delete(chatId);
    });
    return next;
  };
}

// ── Simulated bot state (mirrors the pending buffer + fuse logic) ────────────
const pending = new Map();          // chatId -> { files: [] }
const runTasks = [];                // records every runTask(chatId, task, files)

function bufferAttachment(chatId, file) {
  let p = pending.get(chatId);
  if (!p) { p = { files: [] }; pending.set(chatId, p); }
  p.files.push(file);
}
function takePending(chatId) {
  const p = pending.get(chatId);
  if (!p) return [];
  pending.delete(chatId);
  return p.files;
}
function runTask(chatId, task, files) {
  runTasks.push({ chatId, task, files: files.map(f => f.name) });
}

// A file handler that DOWNLOADS (slow async) before buffering — this async gap
// is exactly what caused the race in the original concurrent dispatch.
async function handleDocument(chatId, file) {
  await new Promise(r => setTimeout(r, 40)); // simulate slow download
  bufferAttachment(chatId, file);
}
// A text handler that fuses any buffered file(s) with the instruction.
async function handleMessage(chatId, text) {
  const buffered = takePending(chatId);
  if (buffered.length) {
    runTask(chatId, text, buffered); // FUSED task
  } else {
    runTask(chatId, text, []);       // standalone task (the bug outcome)
  }
}

async function dispatch(chatId, payload) {
  if (payload.type === 'document') return handleDocument(chatId, payload.file);
  return handleMessage(chatId, payload.text);
}

// ── Test 1: WITHOUT the queue (concurrent dispatch) → BUG reproduces ─────────
async function testConcurrentReproducesBug() {
  runTasks.length = 0; pending.clear(); _chatQueues.clear();
  // Fire both without awaiting (old behaviour)
  dispatch('chatA', { type: 'document', file: { name: 'report.pdf' } }).catch(() => {});
  dispatch('chatA', { type: 'text', text: 'summarize this' }).catch(() => {});
  await new Promise(r => setTimeout(r, 120));
  const fused = runTasks.find(t => t.task === 'summarize this');
  const buggy = fused && fused.files.length === 0;
  console.log(`  [concurrent] runTasks=${JSON.stringify(runTasks)}`);
  if (!buggy) throw new Error('Expected the concurrent path to reproduce the bug (text treated separately)');
  console.log('  ✅ Confirmed: concurrent dispatch treats file + text as SEPARATE (the bug).');
}

// ── Test 2: WITH the queue → file + text FUSED into one task ─────────────────
async function testSerialFusesFileAndText() {
  runTasks.length = 0; pending.clear(); _chatQueues.clear();
  const handleUpdate = makeHandleUpdate(dispatch);
  // File first, then instruction — back to back (same as a real user).
  handleUpdate('chatA', { type: 'document', file: { name: 'report.pdf' } });
  const p = handleUpdate('chatA', { type: 'text', text: 'summarize this' });
  await p;
  console.log(`  [serial] runTasks=${JSON.stringify(runTasks)}`);
  if (runTasks.length !== 1) throw new Error(`Expected exactly 1 fused task, got ${runTasks.length}`);
  const t = runTasks[0];
  if (t.task !== 'summarize this' || t.files.length !== 1 || t.files[0] !== 'report.pdf') {
    throw new Error('File and text were NOT fused into one task');
  }
  console.log('  ✅ File + text fused into ONE task: ' + JSON.stringify(t));
}

// ── Test 3: different chats still run in parallel (not blocked by each other) ─
async function testChatsAreIndependent() {
  runTasks.length = 0; pending.clear(); _chatQueues.clear();
  const handleUpdate = makeHandleUpdate(dispatch);
  handleUpdate('chatA', { type: 'document', file: { name: 'a.pdf' } });
  const pa = handleUpdate('chatA', { type: 'text', text: 'do A' });
  handleUpdate('chatB', { type: 'document', file: { name: 'b.pdf' } });
  const pb = handleUpdate('chatB', { type: 'text', text: 'do B' });
  await Promise.all([pa, pb]);
  const a = runTasks.find(t => t.task === 'do A');
  const b = runTasks.find(t => t.task === 'do B');
  if (!a || a.files[0] !== 'a.pdf') throw new Error('chatA did not fuse correctly');
  if (!b || b.files[0] !== 'b.pdf') throw new Error('chatB did not fuse correctly');
  console.log('  ✅ Both chats fused their own file+text independently.');
}

(async () => {
  console.log('Test 1 — concurrent dispatch reproduces the bug:');
  await testConcurrentReproducesBug();
  console.log('Test 2 — serial queue fuses file + text:');
  await testSerialFusesFileAndText();
  console.log('Test 3 — chats stay independent:');
  await testChatsAreIndependent();
  console.log('\n🎉 ALL TESTS PASSED — the fix fuses file + text into one task.');
  process.exit(0);
})().catch(e => { console.error('❌ TEST FAILED:', e.message); process.exit(1); });
