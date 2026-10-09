'use strict';

const assert = require('assert');
const agent = require('../services/agentEngine');

async function exercise(label, bot, id) {
  const t = bot.__test__;
  assert(t && t.activeRuns && t.busy && typeof t.stopCurrentTask === 'function', `${label}: stop test hooks`);

  const originalStop = agent.stopAgent;
  const scopes = [];
  agent.stopAgent = async scope => { scopes.push(scope); return true; };
  try {
    const controller = new AbortController();
    t.busy.set(id, Date.now());
    t.activeRuns.set(id, controller);

    const result = await t.stopCurrentTask(id);
    assert.equal(result.wasBusy, true, `${label}: active task detected`);
    assert.equal(result.aborted, true, `${label}: local execution aborted`);
    assert.equal(controller.signal.aborted, true, `${label}: AbortSignal fired`);
    assert.equal(t.isBusy(id), true, `${label}: lock remains until the running promise exits`);
    assert.equal(scopes.length, 1, `${label}: sandbox stop requested once`);

    // Simulate the runTask finally block. A new task is accepted only after the
    // cancelled execution has actually unwound, preventing overlapping work.
    t.activeRuns.delete(id);
    t.busy.delete(id);
    t.busy.delete('__ttl__:' + id);
    assert.equal(t.isBusy(id), false, `${label}: chat unlocks after cancellation settles`);
  } finally {
    agent.stopAgent = originalStop;
    t.activeRuns.delete(id);
    t.busy.delete(id);
    t.busy.delete('__ttl__:' + id);
  }
}

async function exactSandboxRouting() {
  const sandboxAgent = require('../services/sandboxAgent');
  const t = sandboxAgent.__test__;
  const calls = [];
  const fake = { exec: async (id, cmd) => { calls.push({ id, cmd }); return { exitCode: 0, output: '' }; } };
  t.ACTIVE_TASKS.set('tg:exact-route', {
    backend: 'daytona', mod: fake, id: 'actual-fallback-box', work: '/work', outbox: '/work/.agent_outbox', taskId: 'task-7',
  });
  try {
    const stopped = await sandboxAgent.requestStop('tg:exact-route');
    assert.equal(stopped, true, 'active sandbox accepted stop');
    assert.equal(calls.length, 1, 'stop sent exactly once');
    assert.equal(calls[0].id, 'actual-fallback-box', 'stop targets exact active fallback sandbox');
    assert.match(calls[0].cmd, /\.agent_stop/);
    assert.match(calls[0].cmd, /task-7\.stop/);
  } finally {
    sandboxAgent.clearActiveTask('tg:exact-route');
  }
}

(async () => {
  await exercise('Telegram', require('../services/wormgptBot'), '10001');
  await exercise('WhatsApp', require('../services/whatsappBot'), '2348012345678@s.whatsapp.net');
  await exactSandboxRouting();
  console.log('✅ stop command: Telegram, WhatsApp, and exact sandbox routing passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
