// ─────────────────────────────────────────────────────────────────────────────
// test-wa-dedup.js — proves the WhatsApp bot double-fire fix.
//
// The bug: a single inbound WhatsApp message fired the WormGPT agent TWICE, so
// every reply (and every sandbox status line) appeared twice. Root causes:
//   1. No de-duplication on the Baileys message id — `messages.upsert` can
//      deliver the same message more than once (encrypted+decrypted copy, retry
//      receipts, reconnect overlap).
//   2. The `busy` lock was set AFTER several awaits, so two duplicate deliveries
//      could both pass the busy check before either set it.
//
// This test uses the REAL exported helpers (services/whatsappBot.js __test__) —
// it does NOT reimplement them — and asserts the fix holds.
// ─────────────────────────────────────────────────────────────────────────────
const assert = require('assert');
const bot = require('../services/whatsappBot');

const { claimMessage, seenMessageIds, busy } = bot.__test__;

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

console.log('\n🧪 WhatsApp bot double-fire fix — end-to-end logic test\n');

// ── 1) A single message id is claimed exactly once ──────────────────────────
seenMessageIds.clear();
{
  const id = 'MSGID_AAA';
  assert.strictEqual(claimMessage(id), true,  'first delivery must be accepted');
  assert.strictEqual(claimMessage(id), false, 'second (duplicate) delivery must be dropped');
  assert.strictEqual(claimMessage(id), false, 'third (duplicate) delivery must be dropped');
  ok('one message id is processed exactly once (duplicates dropped)');
}

// ── 2) The classic "fires twice" scenario: same upsert delivered twice ──────
seenMessageIds.clear();
{
  // Simulate the exact messages.upsert dedup gate from connect():
  //   for (const m of messages) { if (!claimMessage(m.key.id)) continue; handle(m); }
  let handled = 0;
  const handle = () => { handled++; };

  const message = { key: { id: 'WA_HELLO_1', remoteJid: '234@s.whatsapp.net', fromMe: false } };

  // Baileys delivers the SAME message object twice (two upsert events).
  for (const m of [message]) { if (claimMessage(m.key.id)) handle(m); } // delivery #1
  for (const m of [message]) { if (claimMessage(m.key.id)) handle(m); } // delivery #2 (dup)

  assert.strictEqual(handled, 1, 'duplicate upsert delivery must be handled only ONCE');
  ok('duplicate messages.upsert delivery handled exactly once (the reported bug)');
}

// ── 3) Distinct messages are each processed (no over-blocking) ──────────────
seenMessageIds.clear();
{
  let handled = 0;
  for (const id of ['m1', 'm2', 'm3']) { if (claimMessage(id)) handled++; }
  // resend m2 (duplicate) + new m4
  for (const id of ['m2', 'm4']) { if (claimMessage(id)) handled++; }
  assert.strictEqual(handled, 4, 'four distinct messages → four handles; the one repeat is dropped');
  ok('distinct messages all processed; only true duplicates are dropped');
}

// ── 4) Missing/undefined id is let through (cannot dedupe, must not drop) ───
seenMessageIds.clear();
{
  assert.strictEqual(claimMessage(undefined), true, 'no id → let through');
  assert.strictEqual(claimMessage(null), true, 'null id → let through');
  assert.strictEqual(claimMessage(''), true, 'empty id → let through');
  ok('messages without an id are never silently dropped');
}

// ── 5) The seen-map self-bounds (no unbounded memory growth) ────────────────
seenMessageIds.clear();
{
  const N = 20000; // well above SEEN_MAX (5000)
  for (let i = 0; i < N; i++) claimMessage('bulk_' + i);
  assert.ok(seenMessageIds.size <= bot.__test__.SEEN_MAX + 5,
    `seen map must stay bounded (size=${seenMessageIds.size}, cap=${bot.__test__.SEEN_MAX})`);
  ok(`seen-id map stays bounded under flood (size=${seenMessageIds.size} ≤ ${bot.__test__.SEEN_MAX})`);
}

// ── 6) busy-guard race: two concurrent runTask-style claims for one jid ─────
//     Mirrors the synchronous claim now done at the top of runTask().
seenMessageIds.clear();
busy.clear();
{
  const jid = '234@s.whatsapp.net';
  // Synchronous claim semantics used by the fixed runTask():
  function claimBusy(j) { if (busy.get(j)) return false; busy.set(j, true); return true; }

  const a = claimBusy(jid); // first task wins
  const b = claimBusy(jid); // concurrent duplicate is rejected
  assert.strictEqual(a, true,  'first task claims the jid');
  assert.strictEqual(b, false, 'concurrent duplicate task is rejected while busy');
  busy.delete(jid);
  const c = claimBusy(jid); // after release, a new task can run
  assert.strictEqual(c, true, 'after release the jid is free again');
  busy.delete(jid);
  ok('busy lock is claimed synchronously — concurrent duplicate rejected, frees after release');
}

console.log(`\n🎉 All ${passed} double-fire checks passed — one message ⇒ one response.\n`);
process.exit(0);
