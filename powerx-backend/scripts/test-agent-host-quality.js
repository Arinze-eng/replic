'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runGraphLoop } = require('../services/agentGraph');
const enterpriseTools = require('../services/enterpriseTools');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'powerx-host-quality-'));
  const db = path.join(tmp, 'results.sqlite3');
  execFileSync('python3', ['-c', [
    'import sqlite3,sys',
    'c=sqlite3.connect(sys.argv[1])',
    "c.executescript(\"CREATE TABLE results(student TEXT, score INTEGER); INSERT INTO results VALUES ('Ada', 91);\")",
    'c.commit();c.close()',
  ].join(';'), db]);

  const ctx = { workdir: tmp, fsx: { kind: 'local', workdir: tmp }, step: 0 };
  const discovery = await enterpriseTools.toolDatabase({ action: 'discover' }, ctx);
  assert(discovery.includes('DATABASE_DISCOVERY_COMPLETE'));
  const wrong = await enterpriseTools.toolDatabase({ db: 'missing.db', sql: 'SELECT * FROM results' }, ctx);
  assert(wrong.includes('WRONG_DATABASE_PATH_BLOCKED'));
  assert(!fs.existsSync(path.join(tmp, 'missing.db')));
  const found = await enterpriseTools.toolDatabase({ db: 'results.sqlite3', sql: "SELECT * FROM results WHERE lower(student)=lower('ada')" }, ctx);
  assert(found.includes('DATABASE_QUERY_VERIFIED'));
  assert(found.includes('91'));

  const scripted = [
    { action: 'finish', args: { message: 'No record found' } },
    { action: 'database', args: { action: 'discover' } },
    { action: 'database', args: { db: 'results.sqlite3', sql: "SELECT * FROM results WHERE lower(student)=lower('ada')" } },
    { action: 'finish', args: { message: 'Ada scored 91.' } },
  ];
  const brain = async () => JSON.stringify(scripted.shift());
  const result = await runGraphLoop({
    conversation: [{ role: 'user', text: 'TASK: search the database for Ada student result' }],
    brain,
    systemPrompt: 'test',
    parseAction: JSON.parse,
    executeTool: async (name, args) => {
      assert.strictEqual(name, 'database');
      return enterpriseTools.toolDatabase(args, ctx);
    },
    ctx,
    taskText: 'search the database for Ada student result',
    maxSteps: 10,
  });
  assert.strictEqual(result.finalMessage, 'Ada scored 91.');
  assert.strictEqual(scripted.length, 0, 'premature finish must be corrected before tools run');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('EVIDENCE:TEST_PASSED host graph database/correctness gate');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
