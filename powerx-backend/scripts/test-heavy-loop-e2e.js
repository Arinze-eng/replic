'use strict';
// No-mercy INTEGRATION test of the LangGraph loop with heavy-mode wired in.
// Uses a scripted mock brain (no external APIs) to prove:
//   • heavy task → deliberation brief is injected before the first real step
//   • a heavy coding task CANNOT finish until it has explored + implemented +
//     successfully self-tested (finishGuard + qualityGate push back)
//   • once all evidence exists, finish is honored
//   • a LIGHT task finishes immediately with no gate interference

const assert = require('assert');
const { buildAgentGraph } = require('../services/agentGraph');

// A scripted brain: returns the next JSON step from a queue. When it sees the
// heavy deliberation brief in the transcript it records that fact.
function scriptedBrain(steps) {
  let i = 0;
  let sawBrief = false;
  const fn = async (_sys, conversation) => {
    if (conversation.some(m => /HEAVY TASK DETECTED/.test(m.text || ''))) sawBrief = true;
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return typeof step === 'function' ? step(conversation) : step;
  };
  fn.sawBrief = () => sawBrief;
  fn.calls = () => i;
  return fn;
}

const parseAction = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✅', name); }
  catch (e) { fail++; console.log('  ❌', name, '\n     →', e.message); }
}

async function runGraph(brain, taskText, executeTool) {
  const ctx = { step: 0 };
  const app = buildAgentGraph({
    brain, systemPrompt: 'sys', parseAction, executeTool,
    ctx, onStep: () => {}, taskText,
  });
  const conversation = [{ role: 'user', text: `TASK:\n${taskText}` }];
  const out = await app.invoke(
    { conversation, step: 0, done: false, finalMessage: '', pendingAction: null },
    { recursionLimit: 60 },
  );
  return out;
}

async function main() {
  console.log('\n=== INTEGRATION: heavy coding task must earn its finish ===');

  await t('heavy task: brief injected + blocked until explore→implement→test', async () => {
    // Brain tries to finish IMMEDIATELY (lazy). The gate must force it to work.
    const brain = scriptedBrain([
      '{"action":"finish","args":{"message":"done (lazily)"}}',   // 1: premature → blocked (heavy: explore)
      '{"action":"grep","args":{"pattern":"bug"}}',               // 2: explore
      '{"action":"finish","args":{"message":"done"}}',            // 3: blocked (no implement)
      '{"action":"edit","args":{"path":"a.js","old_text":"x","new_text":"y"}}', // 4: implement
      '{"action":"finish","args":{"message":"done"}}',            // 5: blocked (no test)
      '{"action":"run_code","args":{"code":"test"}}',             // 6: self-test OK
      '{"action":"finish","args":{"message":"fixed the crash bug, tests pass"}}', // 7: honored
    ]);
    const exec = async (name) => {
      if (name === 'grep') return '[grep] 3 matches for "bug"';
      if (name === 'edit') return '[edit] Replaced 1 occurrence in a.js';
      if (name === 'run_code') return 'All tests passed. exit 0';
      return 'obs';
    };
    const out = await runGraph(brain, 'debug and fix the crash bug in the payment service across multiple files', exec);
    assert(brain.sawBrief(), 'deliberation brief was NOT injected for heavy task');
    assert(/fixed the crash bug/.test(out.finalMessage), 'did not finish with the real message: ' + out.finalMessage);
    // It must have taken the full scripted path (the lazy finishes were rejected).
    assert(brain.calls() >= 7, 'gate did not push back enough; calls=' + brain.calls());
  });

  await t('light task: finishes immediately, no gate interference', async () => {
    const brain = scriptedBrain([
      '{"action":"finish","args":{"message":"Paris"}}',
    ]);
    const out = await runGraph(brain, 'what is the capital of France?', async () => 'obs');
    assert(!brain.sawBrief(), 'brief should NOT be injected for a light task');
    assert(/Paris/.test(out.finalMessage), 'light task did not finish cleanly: ' + out.finalMessage);
    assert(brain.calls() === 1, 'light task was needlessly gated; calls=' + brain.calls());
  });

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
