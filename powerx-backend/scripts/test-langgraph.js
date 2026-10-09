// scripts/test-langgraph.js — end-to-end test of the LangGraph agent loop.
//
//   1. CONTROL-FLOW test (deterministic, no network): feeds a scripted brain
//      that plans → runs a tool → finishes, and asserts the graph routes
//      agent→tools→agent→END correctly, accumulates observations, and returns
//      the final message + step count.
//
//   2. LIVE test (optional, needs sandbox + brain): runs the real runAgent on a
//      simple multi-step task and prints the result. Skipped if LIVE!=1.
//
// Run:  node scripts/test-langgraph.js          (control-flow only)
//       LIVE=1 node scripts/test-langgraph.js    (control-flow + live agent)

require('dotenv').config();
const assert = require('assert');
const { buildAgentGraph, runGraphLoop } = require('../services/agentGraph');

let failures = 0;
function ok(label) { console.log(`  ✅ ${label}`); }
function bad(label, e) { failures++; console.error(`  ❌ ${label}: ${e && e.message || e}`); }

async function testControlFlow() {
  console.log('\n[1] LangGraph control-flow (scripted brain)');

  // A scripted brain: step 0 → plan, step 1 → run_code, step 2 → finish.
  const scripts = [
    '{"thought":"make a plan","action":"plan","args":{"steps":["a","b"]}}',
    '{"thought":"run something","action":"run_code","args":{"language":"python","code":"print(1+1)"}}',
    '{"thought":"all done","action":"finish","args":{"message":"RESULT=2"}}',
  ];
  let brainCalls = 0;
  const toolCalls = [];
  const brainSawObservations = [];

  const brain = async (_sys, conversation) => {
    // Record how many OBSERVATION turns the brain sees on each call — this
    // proves the graph feeds tool output back into the brain's context.
    brainSawObservations.push(conversation.filter(m => /OBSERVATION/.test(m.text)).length);
    const reply = scripts[brainCalls] || scripts[scripts.length - 1];
    brainCalls++;
    return reply;
  };
  const executeTool = async (name, args) => {
    toolCalls.push(name);
    if (name === 'plan') return 'PLAN_OK';
    if (name === 'run_code') return 'stdout: 2';
    return `ran ${name}`;
  };

  const conversation = [{ role: 'user', text: 'TASK: add 1+1 and finish' }];
  const ctx = { step: 0, onStep: null };

  const res = await runGraphLoop({
    conversation, brain,
    systemPrompt: 'SYS',
    parseAction: (r) => { try { return JSON.parse(r); } catch { return null; } },
    executeTool, ctx,
    onStep: (m) => {}, maxSteps: 80,
  });

  try { assert.strictEqual(res.finalMessage, 'RESULT=2'); ok('final message is the finish() message'); }
  catch (e) { bad('final message', e); }

  try { assert.deepStrictEqual(toolCalls, ['plan', 'run_code']); ok('tools executed in order: plan → run_code'); }
  catch (e) { bad('tool order', e); }

  try { assert.strictEqual(brainCalls, 3); ok('brain invoked exactly 3 times (plan, run_code, finish)'); }
  catch (e) { bad('brain call count', e); }

  // Observation turns must have been fed back so the brain saw tool output:
  // call 0 sees 0 observations, call 1 sees 1, call 2 sees 2 (plan + run_code).
  try {
    assert.deepStrictEqual(brainSawObservations, [0, 1, 2]);
    ok(`observations fed back into the brain's context each step (${JSON.stringify(brainSawObservations)})`);
  } catch (e) { bad('observation feedback', e); }
}

async function testNoActionEndsLoop() {
  console.log('\n[2] Plain answer (no JSON action) ends the loop immediately');
  const brain = async () => 'Here is the plain answer, no tool needed.';
  const ctx = { step: 0 };
  const res = await runGraphLoop({
    conversation: [{ role: 'user', text: 'TASK: say hi' }],
    brain, systemPrompt: 'SYS',
    parseAction: (r) => { try { return JSON.parse(r); } catch { return null; } },
    executeTool: async () => 'should not run', ctx,
    onStep: () => {}, maxSteps: 80,
  });
  try { assert.ok(/plain answer/.test(res.finalMessage)); ok('plain reply returned as final message'); }
  catch (e) { bad('plain reply', e); }
}

async function testBrainError() {
  console.log('\n[3] Brain error is captured as final message (no crash)');
  const brain = async () => { throw new Error('gateway boom'); };
  const ctx = { step: 0 };
  const res = await runGraphLoop({
    conversation: [{ role: 'user', text: 'TASK: x' }],
    brain, systemPrompt: 'SYS',
    parseAction: () => null,
    executeTool: async () => '', ctx,
    onStep: () => {}, maxSteps: 80,
  });
  try { assert.ok(/gateway boom/.test(res.finalMessage)); ok('brain error surfaced gracefully'); }
  catch (e) { bad('brain error handling', e); }
}

async function testLiveAgent() {
  if (process.env.LIVE !== '1') {
    console.log('\n[4] LIVE agent test — SKIPPED (set LIVE=1 to run against the real brain + Daytona).');
    return;
  }
  console.log('\n[4] LIVE agent test — running real runAgent() against Daytona…');
  const { runAgent } = require('../services/agentEngine');
  const steps = [];
  const result = await runAgent({
    task: 'Using the run_code tool, compute the 10th Fibonacci number in Python, write it to a file fib.txt, then finish telling me the value.',
    onStep: (m) => { steps.push(m); console.log('     · ' + m); },
    history: [],
    sessionKey: 'test:langgraph',
  });
  console.log('\n   FINAL MESSAGE:\n   ' + String(result.message).split('\n').join('\n   '));
  console.log(`   STEPS: ${result.steps} | FILES: ${result.files.map(f => f.name).join(', ') || '(none)'}`);
  try { assert.ok(result.message && result.steps >= 1); ok('live agent returned a result'); }
  catch (e) { bad('live agent', e); }
  // cleanup stage dir
  try { require('fs').rmSync(result.workdir, { recursive: true, force: true }); } catch {}
}

(async () => {
  console.log('═══ LangGraph agent loop — end-to-end tests ═══');
  await testControlFlow();
  await testNoActionEndsLoop();
  await testBrainError();
  await testLiveAgent();
  console.log('\n═══════════════════════════════════════════════');
  if (failures) { console.error(`❌ ${failures} test(s) FAILED.`); process.exit(1); }
  console.log('✅ ALL TESTS PASSED.');
})();
