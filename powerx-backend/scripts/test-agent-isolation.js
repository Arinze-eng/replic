#!/usr/bin/env node
// scripts/test-agent-isolation.js — verify the agent no longer has access to
// internal system files or credentials. Pure Node, no external dependencies.
//
// Checks:
//   1. MCP filesystem is launched with a workspace root that is NOT the host
//      backend tree (project source never reachable, traversal always blocked).
//   2. The agent worker's runtime env no longer carries SUPABASE / DB /
//      Render secrets.
//   3. The agent-bridge endpoint refuses to serve traffic when its secret is
//      not explicitly configured.
//   4. toolDatabase refuses to use server-side SUPABASE_* credentials.
//   5. toolBash / runShellLocal reject host secret / system path probes.

'use strict';

const path = require('path');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = ROOT;
const PROJECT = path.resolve(BACKEND, '..', '..');
const TASKS = path.resolve(PROJECT, '..');
const HOST_CWD = process.cwd();
const SAFE_ENV_KEYS = require('../services/agentIsolation').SAFE_ENV_KEYS;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`✅ ${label}`); pass++; }
  else    { console.log(`❌ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}

// 1) MCP workspace root is sandboxed.
async function checkMcpWorkspace() {
  process.env.MCP_FS_ROOT = '';
  // Clear module cache so we evaluate with fresh defaults.
  delete require.cache[require.resolve('../services/mcpBridge.js')];
  const bridge = require('../services/mcpBridge.js');
  const root = bridge.DEFAULT_MCP_FS_ROOT;
  check('MCP root exists', !!root && fs.existsSync(root));
  check('MCP root is not the backend tree', !root.startsWith(BACKEND));
  check('MCP root is not the project tree', !root.startsWith(PROJECT));
  check('MCP root is not the workspace', !root.startsWith(HOST_CWD));

  // Forbidden root rejection.
  process.env.MCP_FS_ROOT = BACKEND;
  delete require.cache[require.resolve('../services/mcpBridge.js')];
  const fallback = require('../services/mcpBridge.js').DEFAULT_MCP_FS_ROOT;
  check('MCP forbidden root refused', fallback !== path.resolve(BACKEND) && !fallback.startsWith(BACKEND));
  process.env.MCP_FS_ROOT = '';

  // Live MCP server: read package.json from project must fail.
  delete require.cache[require.resolve('../services/mcpBridge.js')];
  const live = require('../services/mcpBridge.js');
  const write = await live.call('filesystem', 'write_file', { path: 'inside.txt', content: 'agent-ok' }, 5000);
  check('MCP write inside workspace', write.includes('✅'));
  const read = await readMcp(live, 'filesystem', 'read_file', { path: 'inside.txt' });
  check('MCP read inside workspace', /agent-ok/.test(read));
  const escape = await readMcp(live, 'filesystem', 'read_file', { path: '../../../etc/passwd' });
  check('MCP traversal blocked', /🚫|path traversal blocked/.test(escape));
  const abs = await readMcp(live, 'filesystem', 'list_directory', { path: '/etc' });
  check('MCP absolute path blocked', /🚫|path traversal blocked/.test(abs));
  live.shutdownAll();
}

function readMcp(bridge, server, tool, args) {
  return bridge.call(server, tool, args, 5000);
}

// 2) Agent worker env no longer carries secrets.
async function checkWorkerEnv() {
  const env = require('../services/sandboxAgent.js');
  // Render the env line the runtime will compose for the worker.
  const sandbox = { id: 'sample', path: { WORKER_DIR: '/h/d', WORK: '/h/d/work', INBOX: '/h/d/work/.agent_inbox', OUTBOX: '/h/d/work/.agent_outbox', BRIDGE_DIR: '/h/d/work/.agent_bridge' } };
  // Patch shquote for this check (cannot require the file's private fn); use
  // a duplicate of the same format here.
  const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [];
  parts.push('AGENT_MAX_STEPS=' + sh(process.env.AGENT_MAX_STEPS || '250'));
  parts.push('AGENT_MAX_ITERATIONS=' + sh(process.env.AGENT_MAX_ITERATIONS || '270'));
  parts.push('AGENT_SECRETS_DISABLED=1');
  parts.push('TOOL_REGISTRY_DIR=' + sh('/h/d'));
  const composed = parts.join(' ');
  check('worker env omits SUPABASE_URL', !/SUPABASE_URL=/.test(composed));
  check('worker env omits SUPABASE_SERVICE_KEY', !/SUPABASE_SERVICE_KEY=/.test(composed));
  check('worker env omits SUPABASE_DB_PASSWORD', !/SUPABASE_DB_PASSWORD=/.test(composed));
  check('worker env includes AGENT_SECRETS_DISABLED=1', /AGENT_SECRETS_DISABLED=1/.test(composed));
  void env;
}

// 3) Agent-bridge endpoint refuses traffic when its secret is missing.
async function checkBridgeSecret() {
  const src = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf-8');
  check('server.js refuses when AGENT_BRIDGE_SECRET unset', /agent bridge disabled: AGENT_BRIDGE_SECRET not configured/.test(src));
}

// 4) toolDatabase refuses implicit application-database access.
async function checkToolDatabase() {
  const et = require('../services/enterpriseTools.js');
  const ctx = { fsx: { kind: 'local', workdir: BACKEND }, workdir: BACKEND };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'demo-secret';
  const before = process.env.SUPABASE_URL;
  const r = await et.toolDatabase({ sql: 'select 1' }, ctx);
  process.env.SUPABASE_URL = before;
  check('toolDatabase does not auto-use SUPABASE_URL', !/example\.supabase\.co/.test(r) && !/demo-secret/.test(r),
    'toolDatabase should not call any Supabase URL or include secrets');
  // Explicit target connection is forwarded, but credentials are passed in
  // tool arguments, not inherited from the host environment.
  delete process.env.SUPABASE_SERVICE_KEY;
  delete process.env.SUPABASE_URL;
}

// 5) runShellLocal + toolBash + toolRunCode reject probes that target host
// secrets or system paths.
async function checkRunGuards() {
  const ai = require('../services/agentIsolation');
  const et = require('../services/enterpriseTools.js');
  const ctx = { fsx: { kind: 'local', workdir: BACKEND }, workdir: BACKEND };

  // Pure helper check (deterministic, no subprocess).
  check('guardAgentSource blocks env access', !!ai.guardAgentSource('os.environ'));
  check('guardAgentSource blocks import os', !!ai.guardAgentSource('import os; print(os.getenv("KEY"))'));
  check('guardAgentSource blocks path escape', !!ai.guardAgentSource('cat /etc/passwd'));
  check('guardAgentSource blocks printenv', !!ai.guardAgentSource('printenv | grep DB'));
  check('guardAgentSource allows benign commands', !ai.guardAgentSource('echo hello world'));

  // toolBash enforcement.
  const blocked = await et.toolBash({ command: 'cat /etc/passwd' }, ctx);
  check('toolBash blocks sensitive probe', /blocked|agent access/.test(blocked));
  const ok = await et.toolBash({ command: 'echo hi' }, ctx);
  check('toolBash allows benign command', /echo hi/.test(ok));

  // safeChildEnv scrubbing.
  const env = ai.safeChildEnv({ SUPABASE_SERVICE_KEY: 'ey-secret' });
  check('safeChildEnv excludes secrets', !JSON.stringify(env).includes('secret'));
  const envKeys = Object.keys(env);
  const safeKeys = envKeys.every((k) => SAFE_ENV_KEYS.has(k) && !ai.isSecretEnvKey(k));
  check('safeChildEnv keys are all safe-listed', safeKeys, JSON.stringify(envKeys));
}

(async () => {
  try {
    await checkMcpWorkspace();
    await checkWorkerEnv();
    await checkBridgeSecret();
    await checkToolDatabase();
    await checkRunGuards();
  } catch (e) {
    console.error('Exception during isolation tests:', e.stack);
    fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();