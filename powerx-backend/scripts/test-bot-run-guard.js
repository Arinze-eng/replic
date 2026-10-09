'use strict';

const assert = require('assert');
const { runWithIdleGuard, BotRunStalledError } = require('../services/botRunGuard');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function testStalledStageAborts() {
  let aborted = false;
  const started = Date.now();
  await assert.rejects(
    runWithIdleGuard(async ({ signal }) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return 'late stopped result';
    }, { idleMs: 45, label: 'test stage' }),
    e => e instanceof BotRunStalledError && e.code === 'BOT_RUN_STALLED'
  );
  assert(aborted, 'stalled provider was not aborted');
  assert(Date.now() - started < 1000, 'stall guard did not fail over promptly');
}

async function testRealProgressKeepsStageAlive() {
  const value = await runWithIdleGuard(async ({ touch }) => {
    for (let i = 0; i < 4; i++) {
      await sleep(25);
      touch();
    }
    return 'done';
  }, { idleMs: 50, label: 'active stage' });
  assert.strictEqual(value, 'done');
}

async function testParentCancellationWins() {
  const parent = new AbortController();
  const p = runWithIdleGuard(async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { stopped: true };
  }, { signal: parent.signal, idleMs: 500 });
  setTimeout(() => parent.abort(), 20);
  assert.deepStrictEqual(await p, { stopped: true });
}

(async () => {
  await testStalledStageAborts();
  await testRealProgressKeepsStageAlive();
  await testParentCancellationWins();
  console.log('✅ bot stalled-run guard tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
