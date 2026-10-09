'use strict';
const assert = require('assert');
const qualityGate = require('../services/qualityGate');
const runtime = require('../services/agentRuntimeConfig');
const adaptation = require('../services/userAdaptation');
const { runGraphLoop } = require('../services/agentGraph');

function action(name, args = {}) { return JSON.stringify({ thought: 'test', action: name, args }); }

async function testDefaults() {
  assert.equal(runtime.DEFAULTS.agent_max_steps, 270);
  assert.equal(runtime.DEFAULTS.agent_max_iterations, 270);
  assert.equal(runtime.DEFAULTS.agent_max_tool_steps, 270);
  assert.equal(runtime.HARD_MAX, 1000);
  assert.equal(runtime.clamp(999999, 60), 1000);
  assert.equal(runtime.clamp(0, 60), 1);
}

async function testGlobalRuntimeSetting() {
  const db = require('../db');
  const original = db.getSetting;
  db.getSetting = async (key) => key === 'agent_max_steps' ? '7' : null;
  try {
    const resolved = await runtime.resolve();
    assert.deepStrictEqual(resolved, { maxSteps: 7, maxIterations: 7, maxToolSteps: 7 });
  } finally {
    db.getSetting = original;
  }
}

async function testResolvedBudgetStopsHostLoop() {
  const db = require('../db');
  const original = db.getSetting;
  db.getSetting = async (key) => key === 'agent_max_steps' ? '2' : null;
  try {
    const budget = await runtime.resolve();
    let calls = 0;
    let runs = 0;
    const result = await runGraphLoop({
      conversation: [{ role: 'user', text: 'bounded task' }],
      brain: async () => action('bash', { command: `echo ${calls++}` }),
      systemPrompt: 'test', parseAction: JSON.parse,
      executeTool: async () => { runs++; return '[exit 0]'; }, ctx: {}, taskText: 'bounded task',
      maxIterations: budget.maxIterations, maxSteps: budget.maxToolSteps,
    });
    assert.equal(calls, 2, 'the DB setting must cap model turns for the task');
    assert.equal(runs, 2, 'the same DB setting must cap tool actions for the task');
    assert.match(result.finalMessage, /budget reached/i);
  } finally {
    db.getSetting = original;
  }
}

async function testGraphDefenseInDepth() {
  assert.equal(require('../services/agentGraph').clampBudget(5000), 1000);
  assert.equal(require('../services/agentGraph').clampBudget(0), 1);
}

function testQualityGate() {
  const task = 'Fix the repository bug';
  const inventory = { tool: 'inspect_codebase', args: { path: '.' }, result: 'CODEBASE_INVENTORY_COMPLETE files=12 hashed_full_files=12' };
  const read = { tool: 'read_file', args: { path: 'a.js' }, result: 'FILE_READ' };
  const edit = { tool: 'edit_file', args: { path: 'a.js' }, result: 'FILE_WRITTEN' };
  const fake = { tool: 'bash', args: { command: 'echo looks good' }, result: '[exit 0]\nlooks good' };
  const test = { tool: 'bash', args: { command: 'npm test' }, result: '[exit 0]\n12 tests passed' };
  assert.match(qualityGate.evaluate(task, [read, edit, test], 'done'), /codebase grounding/i);
  assert.match(qualityGate.evaluate(task, [inventory, read, edit], 'done'), /post-change test/i);
  assert.match(qualityGate.evaluate(task, [inventory, read, edit, fake], 'done'), /post-change test/i);
  assert.equal(qualityGate.evaluate(task, [inventory, read, edit, test], 'done'), null);
  assert.match(qualityGate.evaluate('Fix vulnerability in this repo', [inventory, read, edit, test], 'done'), /security scan/i);
  const audit = { tool: 'bash', args: { command: 'npm audit' }, result: '[exit 0]\nfound 0 vulnerabilities' };
  assert.equal(qualityGate.evaluate('Fix vulnerability in this repo', [inventory, read, edit, test, audit], 'done'), null);
  const db = { tool: 'database', args: { operation: 'query' }, result: 'DATABASE_QUERY_VERIFIED' };
  assert.match(qualityGate.evaluate('Build a full-stack app from scratch with auth and database', [db, edit, test], 'done'), /integration\/E2E\/smoke/i);
  const e2e = { tool: 'bash', args: { command: 'npm run test:e2e' }, result: '[exit 0]\nfrontend -> API -> auth -> database passed' };
  assert.equal(qualityGate.evaluate('Build a full-stack app from scratch with auth and database', [db, edit, test, e2e], 'done'), null);

  const dartTask = 'Fix the Flutter Dart app';
  assert.match(qualityGate.evaluate(dartTask, [read, edit, test], 'done'), /analyzer run/i);
  const dartAnalyze = { tool: 'bash', args: { command: 'flutter analyze' }, result: '[exit 0]\nNo issues found!' };
  assert.equal(qualityGate.evaluate(dartTask, [read, edit, dartAnalyze], 'done'), null);
  const dartFailure = { tool: 'bash', args: { command: 'dart analyze' }, result: '[exit 1]\nerror - Expected a declaration' };
  assert.match(qualityGate.evaluate(dartTask, [read, edit, dartFailure], 'done'), /post-change test|analyzer run/i);

  const migrationTask = 'Implement and verify a database migration';
  const dbInspect = { tool: 'database', args: { operation: 'inspect' }, result: 'DATABASE_SCHEMA_INSPECTED' };
  assert.match(qualityGate.evaluate(migrationTask, [dbInspect, read, edit, test], 'done'), /migration or schema verification/i);
  const migration = { tool: 'bash', args: { command: 'npm run migration:test' }, result: '[exit 0]\nmigration and rollback compatibility passed' };
  const migrationE2e = { tool: 'bash', args: { command: 'npm run test:integration' }, result: '[exit 0]\napplication and migrated database integration passed' };
  assert.equal(qualityGate.evaluate(migrationTask, [dbInspect, read, edit, migration, migrationE2e], 'done'), null);
}

function testAdaptation() {
  const signals = adaptation.inferSignals('Do not ask questions. Fix this Flutter repo, test it, and deploy safely without breaking production.');
  assert(signals.preferences.includes('autonomous'));
  assert(signals.preferences.includes('test_first'));
  assert(signals.preferences.includes('production_safe'));
  assert(signals.taskTypes.includes('coding'));
  assert(signals.taskTypes.includes('deployment'));
  const ctx = adaptation.context({ interactions: 3, preferences: { autonomous: 2, test_first: 3 }, taskTypes: { coding: 3 } });
  assert.match(ctx, /avoid non-blocking questions/i);
  assert.match(ctx, /executable validation/i);
  assert.match(ctx, /predictions, not facts/i);
}

async function testIterationBudget() {
  let calls = 0;
  const result = await runGraphLoop({
    conversation: [{ role: 'user', text: 'simple task' }],
    brain: async () => { calls++; return 'not finished'; },
    systemPrompt: 'test', parseAction: () => null,
    executeTool: async () => 'unused', ctx: {}, taskText: 'simple task',
    maxIterations: 3, maxSteps: 60, thinkUntilMs: Date.now() + 60000,
  });
  assert.equal(calls, 3);
  assert.match(result.finalMessage, /Iteration budget reached/);
}

async function testToolBudget() {
  let calls = 0, runs = 0;
  const result = await runGraphLoop({
    conversation: [{ role: 'user', text: 'simple task' }],
    brain: async () => action('bash', { command: `echo ${calls++}` }),
    systemPrompt: 'test', parseAction: JSON.parse,
    executeTool: async () => { runs++; return '[exit 0]'; }, ctx: {}, taskText: 'simple task',
    maxIterations: 20, maxSteps: 2,
  });
  assert.equal(runs, 2);
  assert.match(result.finalMessage, /Tool-step budget reached/);
}

async function testCycleGuard() {
  let calls = 0, runs = 0;
  const result = await runGraphLoop({
    conversation: [{ role: 'user', text: 'simple task' }],
    brain: async () => {
      calls++;
      if (calls >= 6) return action('finish', { message: 'done' });
      return action('bash', { command: calls % 2 ? 'echo A' : 'echo B' });
    },
    systemPrompt: 'test', parseAction: JSON.parse,
    executeTool: async () => { runs++; return '[exit 0]\nsame'; }, ctx: {}, taskText: 'simple task',
    maxIterations: 10, maxSteps: 10,
  });
  assert.equal(result.finalMessage, 'done');
  assert(runs < 5, 'cycle guard should prevent repeated execution');
}

(async () => {
  await testDefaults();
  await testGlobalRuntimeSetting();
  await testResolvedBudgetStopsHostLoop();
  await testGraphDefenseInDepth();
  testQualityGate();
  testAdaptation();
  await testIterationBudget();
  await testToolBudget();
  await testCycleGuard();
  console.log('✅ coding autonomy controls: all tests passed');
})().catch(err => { console.error(err); process.exit(1); });
