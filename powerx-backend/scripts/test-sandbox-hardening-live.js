#!/usr/bin/env node
'use strict';

// Live regression for the exact hardening added to the in-sandbox worker:
// complete repository inventory, verified install ladders, and prompt /stop of
// a child process that emits no output. Runs on Novita, Daytona, or Upstash.
const fs = require('fs');
const path = require('path');
const provider = String(process.argv[2] || process.env.LIVE_CODING_PROVIDER || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  daytona: require('../services/daytona'),
  upstash: require('../services/upstashBox'),
  upstashbox: require('../services/upstashBox'),
};
const mod = providers[provider];
if (!mod) throw new Error('provider must be novita, daytona, or upstash');

const workerDir = path.join(__dirname, '..', 'agent_worker');
const harness = String.raw`
import json, os, sys, tempfile, threading, time
sys.path.insert(0, os.environ['WORKER_DIR'])
import agent

def check(cond, msg):
    if not cond: raise AssertionError(msg)
    print('PASS', msg)

repo = os.path.join(agent.WORK, 'fixture-repo')
os.makedirs(os.path.join(repo, 'src'), exist_ok=True)
open(os.path.join(repo, 'package.json'), 'w').write('{"name":"fixture"}\n')
open(os.path.join(repo, 'src', 'index.js'), 'w').write("const x=require('./x'); console.log(x);\n")
open(os.path.join(repo, 'src', 'x.js'), 'w').write('module.exports=42;\n')
r = agent.tool_inspect_codebase({'path':'fixture-repo'})
check('CODEBASE_INVENTORY_COMPLETE' in r and 'files=3' in r, 'full codebase inventory')
m = json.load(open(os.path.join(agent.WORK, '.agent_codebase_map.json')))
check(len(m['files']) == 3 and all(x.get('sha256') for x in m['files']), 'every source file hashed')

for name, kind in [('jq','apt'), ('requests','pip'), ('semver','npm')]:
    r = agent.tool_install({'name':name, 'kind':kind})
    check('INSTALL_VERIFIED' in r, 'verified install '+kind+':'+name)

agent._TERMINAL['task_id'] = 'live-silent-stop'
agent.clear_stop_flag('live-silent-stop')
def stopper():
    time.sleep(.5)
    open(agent._task_stop_flag('live-silent-stop'), 'w').write('stop\n')
threading.Thread(target=stopper, daemon=True).start()
started=time.time(); r=agent.run_shell('sleep 30', timeout=40); elapsed=time.time()-started
check('stopped by user' in r.lower() and elapsed < 4, 'silent process cancellation')
agent.clear_stop_flag('live-silent-stop')
print('SANDBOX_HARDENING_OK provider=' + os.environ.get('PROVIDER','unknown'))
`;

(async () => {
  const auth = await mod.testKey();
  if (!auth.ok) throw new Error(auth.message || `${provider} authentication failed`);
  const reusableId = String(process.env.HARDENING_SANDBOX_ID || '').trim();
  const id = reusableId || await mod.createSandbox({ labels: { purpose: `hardening-${provider}` } });
  const ownsSandbox = !reusableId;
  if (reusableId && !(await mod.startSandbox(id))) throw new Error(`could not resume reusable ${provider} sandbox`);
  const root = mod.WORKDIR;
  const remoteWorker = `${root}/hardening-worker`;
  try {
    await mod.exec(id, `mkdir -p '${remoteWorker}' '${root}/hardening-work'`, { cwd: root, timeout: 60 });
    for (const name of ['agent.py', 'quality_gate.py', 'database_intelligence.py', 'latex_render.py', 'tool_registry.py']) {
      await mod.uploadFile(id, `${remoteWorker}/${name}`, fs.readFileSync(path.join(workerDir, name)), name);
    }
    const toolsDir = path.join(workerDir, 'tools');
    // Only the registry metadata/runtime is needed for import; this test calls
    // the new native worker tools directly.
    await mod.uploadFile(id, `${root}/hardening-harness.py`, Buffer.from(harness), 'hardening-harness.py');
    const cmd = `AGENT_WORK='${root}/hardening-work' WORKER_DIR='${remoteWorker}' PROVIDER='${provider}' python3 '${root}/hardening-harness.py'`;
    const r = await mod.exec(id, cmd, { cwd: root, timeout: 1200 });
    if (r.exitCode !== 0 || !/SANDBOX_HARDENING_OK/.test(String(r.output || ''))) {
      throw new Error(`exit ${r.exitCode}: ${String(r.output || '').slice(-6000)}`);
    }
    console.log(String(r.output || '').slice(-6000));
    console.log(`✅ ${provider}: codebase grounding, apt/pip/npm verification, and silent /stop passed`);
  } finally {
    if (ownsSandbox) await mod.deleteSandbox(id).catch(() => {});
    else if (typeof mod.pauseSandbox === 'function') await mod.pauseSandbox(id).catch(() => {});
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
