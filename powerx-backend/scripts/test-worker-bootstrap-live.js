#!/usr/bin/env node
'use strict';

// Deploys the exact production worker bundle to a real provider, verifies all
// registry tools are discoverable, corrupts the durable marker intentionally,
// and proves the next ensure pass repairs the sandbox rather than trusting it.
const provider = String(process.argv[2] || process.env.LIVE_CODING_PROVIDER || '').toLowerCase();
const providers = {
  novita: require('../services/novitaSandbox'),
  daytona: require('../services/daytona'),
  upstash: require('../services/upstashBox'),
  upstashbox: require('../services/upstashBox'),
};
const mod = providers[provider];
if (!mod) throw new Error('provider must be novita, daytona, or upstash');
const sandboxAgent = require('../services/sandboxAgent');

(async () => {
  const auth = await mod.testKey();
  if (!auth.ok) throw new Error(auth.message || `${provider} authentication failed`);
  const reusableId = String(process.env.WORKER_SANDBOX_ID || '').trim();
  const id = reusableId || await mod.createSandbox({ labels: { purpose: `worker-bootstrap-${provider}` } });
  const ownsSandbox = !reusableId;
  if (reusableId && !(await mod.startSandbox(id))) throw new Error(`could not resume reusable ${provider} sandbox`);
  const home = provider.startsWith('daytona') ? '/home/daytona' : provider.startsWith('upstash') ? '/workspace/home' : '/home/user';
  const paths = sandboxAgent.__test__.pathsFor(home);
  const expected = sandboxAgent.__test__.expectedToolManifests;
  try {
    await mod.exec(id, `rm -f '${paths.WORKER_DIR}/.version'; rm -rf '${paths.WORKER_DIR}/tools'`, { cwd: null, timeout: 60 });
    await sandboxAgent.__test__.ensureWorker(mod, id, paths, s => console.log('[step]', s));
    const first = await mod.exec(id, `cd '${paths.WORKER_DIR}' && python3 - <<'PY'\nimport sys\nsys.path.insert(0,'.')\nfrom tool_registry import ToolRegistry\nr=ToolRegistry(tools_dir='tools', work_dir='${paths.WORK}')\nr.discover(); print('COUNT=%d' % len(r.list_tools()))\nprint('NAMES=' + ','.join(sorted(x.name for x in r.list_tools())))\nPY`, { cwd: null, timeout: 90 });
    if (first.exitCode !== 0 || !new RegExp(`COUNT=${expected}(?:\\s|$)`).test(first.output || '')) throw new Error(`initial deployment failed: ${String(first.output || '').slice(-1000)}`);
    for (const required of ['bash','coding','database','documents','edit','gitclone','glob','grep','http','read','sandbox','sql','write']) {
      if (!new RegExp(`(?:^|,)${required}(?:,|$)`).test((first.output.match(/NAMES=(.*)/) || [,''])[1])) throw new Error(`missing registry tool: ${required}`);
    }

    // Simulate an interrupted historical deployment: marker remains but tools
    // are incomplete. The production probe must detect and repair it.
    await mod.exec(id, `rm -f '${paths.WORKER_DIR}/tools/read/tool.json'`, { cwd: null, timeout: 30 });
    await sandboxAgent.__test__.ensureWorker(mod, id, paths, s => console.log('[repair]', s));
    const repaired = await mod.exec(id, `test -f '${paths.WORKER_DIR}/tools/read/tool.json' && test "$(find '${paths.WORKER_DIR}/tools' -name tool.json -type f | wc -l)" -eq ${expected} && echo REPAIR_OK`, { cwd: null, timeout: 60 });
    if (!/REPAIR_OK/.test(repaired.output || '')) throw new Error(`self-repair failed: ${String(repaired.output || '').slice(-1000)}`);
    console.log(`WORKER_BOOTSTRAP_OK provider=${provider} tools=${expected}`);
  } finally {
    await mod.exec(id, `pkill -9 -f 'agent.py' 2>/dev/null || true`, { cwd: null, timeout: 30 }).catch(() => {});
    if (ownsSandbox) await mod.deleteSandbox(id).catch(() => {});
    else if (typeof mod.pauseSandbox === 'function') await mod.pauseSandbox(id).catch(() => {});
  }
})().catch(e => { console.error('❌', e.message); process.exit(1); });
