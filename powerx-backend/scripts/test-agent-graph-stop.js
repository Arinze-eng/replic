'use strict';

const assert = require('assert');
const { runGraphLoop } = require('../services/agentGraph');

(async () => {
  const controller = new AbortController();
  let toolStarted = false;
  const started = Date.now();
  setTimeout(() => controller.abort(), 35);

  const result = await runGraphLoop({
    conversation: [{ role: 'user', text: 'run a long task' }],
    systemPrompt: 'test',
    brain: async () => JSON.stringify({ thought: 'work', action: 'slow_tool', args: {} }),
    parseAction: JSON.parse,
    executeTool: async () => { toolStarted = true; await new Promise(r => setTimeout(r, 5000)); return 'late'; },
    ctx: { step: 0 },
    maxSteps: 10,
    maxIterations: 10,
    signal: controller.signal,
  });

  assert.equal(toolStarted, true);
  assert(/Task stopped/i.test(result.finalMessage));
  assert(Date.now() - started < 1000, 'abort should unwind immediately, not wait for the tool');
  console.log('✅ graph stop: active tool run aborted and unwound immediately');
})().catch(err => { console.error(err); process.exit(1); });
