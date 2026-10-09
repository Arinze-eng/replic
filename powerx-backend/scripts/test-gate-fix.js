// Standalone test for the agentGraph persistence-gate routing fix.
// Reproduces the live bug: model tries to `finish` immediately, the
// persistence gate pushes back with NO pending action. The OLD graph routed
// to `tools` and crashed on `state.pendingAction.action` (null). The FIX
// routes back to `agent` (or executes a real tool) and the run completes.
const { runGraphLoop } = require('../services/agentGraph');

// Force the gate to be cheap so the test is fast & deterministic.
process.env.AGENT_MIN_STEPS = '1';
process.env.AGENT_REQUIRE_SKILL = '0';
process.env.AGENT_MAX_NUDGES = '2';

let brainCalls = 0;
async function brain(_sys, _conv) {
  brainCalls++;
  // 1st call: try to finish immediately -> gate pushes back (no tool action).
  if (brainCalls === 1) {
    return JSON.stringify({ action: 'finish', thought: 'trivial', args: { message: '4' } });
  }
  // 2nd call: do a real tool step (satisfies MIN_STEPS).
  if (brainCalls === 2) {
    return JSON.stringify({ action: 'web_search', thought: 'verify', args: { query: '2+2' } });
  }
  // 3rd call: finish for real.
  return JSON.stringify({ action: 'finish', thought: 'done', args: { message: '2 + 2 = 4' } });
}

const parseAction = (raw) => {
  try {
    const s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    return JSON.parse(s.slice(a, b + 1));
  } catch { return null; }
};

async function executeTool(name, args) {
  return `[tool ${name}] ok ${JSON.stringify(args)}`;
}

(async () => {
  const ctx = { step: 0 };
  const steps = [];
  try {
    const res = await runGraphLoop({
      conversation: [{ role: 'user', text: 'TASK: what is 2+2?' }],
      brain,
      systemPrompt: 'SYS',
      parseAction,
      executeTool,
      ctx,
      onStep: (n) => steps.push(n),
      maxSteps: 20,
    });
    console.log('RESULT finalMessage =', JSON.stringify(res.finalMessage));
    console.log('brainCalls =', brainCalls, 'steps logged =', steps.length);
    if (res.finalMessage && res.finalMessage.includes('4')) {
      console.log('✅ PASS — graph completed without the null-action crash.');
      process.exit(0);
    } else {
      console.log('❌ FAIL — no final message.');
      process.exit(1);
    }
  } catch (e) {
    console.log('❌ FAIL — threw:', e.message);
    process.exit(1);
  }
})();
