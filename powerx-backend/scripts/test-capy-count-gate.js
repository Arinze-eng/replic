// Unit test: the count-based "new reply" gate in capy.pickAssistantText.
// Verifies the memory fix — a follow-up turn must return the NEW assistant
// message (by COUNT), never echo the previous turn, and report awaitingNew
// (count===0) until the new reply actually arrives.
const assert = require('assert');
const capy = require('../services/capy.js');

// capy doesn't export pickAssistantText directly; we exercise it via the same
// shape pollOnce builds. Re-import the internal by re-evaluating is overkill, so
// we test the observable contract through a tiny re-implementation guard:
// pickAssistantText IS exported? If not, test via a thin reflective require.
const mod = require('module');
// Pull pickAssistantText out by reading the function from the module's closure
// is not possible; instead we assert the public _assistantBaseline + gating
// indirectly by simulating the message list the same way.

// Re-create message lists.
function msg(id, source, content, t) {
  return { id, source, content, createdAt: new Date(t).toISOString() };
}

// We test pickAssistantText by requiring it through a small patched copy: the
// real function is module-private, so we validate the COUNT semantics we rely
// on using the exported helpers we DO have, plus a direct sanity simulation.

// Simulate: baseline had 1 assistant message; after follow-up there are 2.
const T0 = 1700000000000;
const before = { items: [ msg('u1','user','q1',T0), msg('a1','assistant','OLD answer',T0+1000) ] };
const after  = { items: [ msg('u1','user','q1',T0), msg('a1','assistant','OLD answer',T0+1000),
                           msg('u2','user','q2',T0+2000), msg('a2','assistant','NEW answer',T0+3000) ] };

// Access the private function via the source (eval) so we can unit-test it.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'capy.js'), 'utf8');
const m = src.match(/function _msgTs[\s\S]*?\nfunction pickAssistantText[\s\S]*?\n  return \{ final, all, count: sorted\.length, fresh \};\n\}/);
assert(m, 'could not extract pickAssistantText from source');
// eslint-disable-next-line no-eval
const pick = eval('(function(){' + m[0] + '\nreturn pickAssistantText;})()');

// 1) Baseline count = 1 (one OLD assistant), poll BEFORE new reply → awaitingNew.
let r = pick(before, { afterCount: 1, afterTs: T0+1000 });
assert.strictEqual(r.count, 0, 'before new reply: count must be 0 (awaitingNew)');
console.log('✓ before new reply → awaitingNew (count 0)');

// 2) Baseline count = 1, poll AFTER new reply → returns the NEW answer only.
r = pick(after, { afterCount: 1, afterTs: T0+1000 });
assert.strictEqual(r.count, 1, 'after: exactly the 1 new assistant message');
assert.strictEqual(r.final, 'NEW answer', 'after: must return NEW answer, not OLD');
console.log('✓ after new reply → returns NEW answer (not the old one)');

// 3) Count gate must win even if timestamps are equal/ambiguous (clock skew).
const skew = { items: [ msg('a1','assistant','OLD',T0+1000), msg('a2','assistant','NEW',T0+1000) ] };
r = pick(skew, { afterCount: 1, afterTs: T0+1000 });
assert.strictEqual(r.count, 1, 'count gate survives equal timestamps');
assert.strictEqual(r.final, 'NEW', 'count gate returns the extra message under ts skew');
console.log('✓ count gate robust to clock skew (the old ts-only gate failed here)');

// 4) No baseline → returns latest (stateless run path unchanged).
r = pick(after, {});
assert.strictEqual(r.final, 'NEW answer');
console.log('✓ stateless path unchanged');

// 5) CONTENT-CHANGE fallback: count/id/ts unchanged, but the NEWEST assistant
//    message's content changed (Capy streamed the reply INTO the existing slot).
//    This must be accepted so file/text turns don't hang on "picking up your
//    new message" for minutes.
const streamed = { items: [ msg('a1','assistant','UPDATED in-place answer',T0+1000) ] };
r = pick(streamed, { afterCount: 1, afterTs: T0+1000, afterIds: new Set(['a1']), afterLastContent: 'OLD answer' });
assert.strictEqual(r.count, 1, 'content-change: accept the streamed-in-place reply');
assert.strictEqual(r.final, 'UPDATED in-place answer', 'content-change: return the new content');
console.log('✓ content-change fallback accepts streamed-in-place replies');

// 6) Same content + same count → still awaitingNew (must NOT echo old reply).
const same = { items: [ msg('a1','assistant','OLD answer',T0+1000) ] };
r = pick(same, { afterCount: 1, afterTs: T0+1000, afterIds: new Set(['a1']), afterLastContent: 'OLD answer' });
assert.strictEqual(r.count, 0, 'unchanged reply → still awaitingNew (no echo)');
console.log('✓ unchanged reply still gated (no stale echo)');

console.log('\nALL COUNT-GATE TESTS PASSED ✅');
