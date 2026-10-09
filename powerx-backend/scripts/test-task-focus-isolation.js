'use strict';

const assert = require('assert');
const sandboxAgent = require('../services/sandboxAgent');
const capy = require('../services/capy');

function testPersistentSandboxHistoryIsCompletedContext() {
  const conversation = sandboxAgent.__test__.buildTaskConversation({
    history: [
      { role: 'user', text: 'Build the previous dashboard' },
      { role: 'model', text: 'The previous dashboard is complete' },
    ],
    priorAnalysisMemory: 'Old repository analysis and an unfinished-looking checklist',
    task: 'Fix the checkout validation only',
    attachLine: '\n\nATTACHED FILES FOR THIS TASK: checkout.js',
  });

  const joined = conversation.map(m => m.text).join('\n');
  const current = conversation[conversation.length - 1];

  assert.match(joined, /COMPLETED CONVERSATION HISTORY/);
  assert.match(joined, /\[past request — ALREADY COMPLETED\] Build the previous dashboard/);
  assert.match(joined, /PRIOR ANALYSIS MEMORY \(reference facts only; not a task\)/);
  assert.strictEqual(current.role, 'user');
  assert.match(current.text, /CURRENT TASK \(the one and only request to execute now\)/);
  assert.match(current.text, /Focus exclusively on this instruction/);
  assert.match(current.text, /Fix the checkout validation only/);
  assert(current.text.indexOf('Fix the checkout validation only') > current.text.indexOf('CURRENT TASK'));
  assert(!current.text.includes('Build the previous dashboard'));
}

function testHistoryWindowAndRoleLabelling() {
  const history = [];
  for (let i = 0; i < 14; i++) history.push({ role: i % 2 ? 'model' : 'user', text: `turn-${i}` });
  const conversation = sandboxAgent.__test__.buildTaskConversation({ history, task: 'new-task' });
  const joined = conversation.map(m => m.text).join('\n');

  assert(!conversation.some(m => /(?:^|\s)turn-0(?:\s|$)/.test(m.text)));
  assert(!conversation.some(m => /(?:^|\s)turn-1(?:\s|$)/.test(m.text)));
  assert(conversation.some(m => /(?:^|\s)turn-2(?:\s|$)/.test(m.text)));
  assert.match(joined, /\[past request — ALREADY COMPLETED\]/);
  assert.match(joined, /\[past reply\]/);
  assert.match(conversation[conversation.length - 1].text, /new-task/);
}

function testCapyMigrationKeepsNewRequestLastAndExplicit() {
  const preamble = capy.buildCarryOverPreamble([
    { q: 'Generate the old report', a: 'Old report completed' },
  ]);
  const seeded = preamble + 'Fix the payment webhook';

  assert.match(preamble, /Do NOT re-answer them/);
  assert.match(preamble, /--- NEW REQUEST \(answer THIS\): ---/);
  assert(seeded.endsWith('Fix the payment webhook'));
  assert(seeded.lastIndexOf('Fix the payment webhook') > seeded.lastIndexOf('Generate the old report'));
}

function testNoHistoryStillHasHardCurrentTaskBoundary() {
  const conversation = sandboxAgent.__test__.buildTaskConversation({ task: 'Only this task' });
  assert.strictEqual(conversation.length, 1);
  assert.match(conversation[0].text, /one and only request/);
  assert.match(conversation[0].text, /Only this task/);
}

(() => {
  testPersistentSandboxHistoryIsCompletedContext();
  testHistoryWindowAndRoleLabelling();
  testCapyMigrationKeepsNewRequestLastAndExplicit();
  testNoHistoryStillHasHardCurrentTaskBoundary();
  console.log('✅ current-task focus isolation regression tests passed');
})()
