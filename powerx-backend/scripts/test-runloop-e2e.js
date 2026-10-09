// scripts/test-runloop-e2e.js
// END-TO-END test of the Runloop "owns-the-computer" sandbox backend.
// Exercises the FULL interface agentEngine/sandboxAgent rely on:
//   create → exec → write/read file → upload/download bytes → listFiles
//   → (optional) Docker-in-Docker → suspend/resume → shutdown
//
// Run: RUNLOOP_API_KEY=ak_... node scripts/test-runloop-e2e.js [--docker]
//
// Exit 0 = PASS, non-zero = FAIL.  Always tears down the devbox it created.

const runloop = require('../services/runloop');

const WANT_DOCKER = process.argv.includes('--docker');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  console.log('▶ Runloop E2E — owns-the-computer parity check\n');

  // 0) Key reachable?
  const t = await runloop.testKey();
  ok('API key reachable', t.ok, t.message);
  if (!t.ok) { console.log('\n❌ FAIL — cannot reach Runloop with the configured key.'); process.exit(2); }

  let id;
  try {
    // 1) Create devbox + wait for running + workdir ready.
    console.log('\n[1] creating devbox (this provisions a real Linux box)…');
    const t0 = Date.now();
    id = await runloop.createSandbox({ labels: { test: 'e2e' } });
    ok('createSandbox → running', !!id, `${id} in ${Math.round((Date.now() - t0) / 1000)}s`);

    // 2) Basic exec.
    const who = await runloop.exec(id, 'whoami; uname -m; python3 --version; node --version 2>/dev/null || true');
    ok('exec basic shell', who.exitCode === 0 && /\w/.test(who.output), (who.output || '').trim().replace(/\n/g, ' | '));

    // 3) Write a text file via shell, read it back via downloadFile.
    await runloop.exec(id, `echo 'hello-from-e2e' > ${runloop.WORKDIR}/note.txt`);
    const dl = await runloop.downloadFile(id, `${runloop.WORKDIR}/note.txt`);
    ok('write (shell) + downloadFile', dl.toString('utf-8').trim() === 'hello-from-e2e');

    // 4) uploadFile bytes → read back via exec.
    const blob = Buffer.from('BINARY\x00\x01\x02bytes', 'binary');
    await runloop.uploadFile(id, `${runloop.WORKDIR}/blob.bin`, blob, 'blob.bin');
    const sz = await runloop.exec(id, `wc -c < ${runloop.WORKDIR}/blob.bin`);
    ok('uploadFile bytes', parseInt((sz.output || '0').trim(), 10) === blob.length, `${(sz.output || '').trim()} bytes`);

    // 5) listFiles parses into {name,size,isDir}.
    const files = await runloop.listFiles(id, runloop.WORKDIR);
    const names = files.map(f => f.name);
    ok('listFiles', names.includes('note.txt') && names.includes('blob.bin'), names.join(', '));

    // 6) Run a small python program (mirrors the agent's run_code tool path).
    const py = await runloop.exec(id, `python3 - <<'PY'
nums=[0,1]
for _ in range(8): nums.append(nums[-1]+nums[-2])
print(','.join(map(str,nums)))
PY`);
    ok('run python program', /0,1,1,2,3,5,8,13,21,34/.test(py.output || ''), (py.output || '').trim());

    // 7) Suspend → state → resume → file still there (persistence).
    console.log('\n[7] testing suspend/resume persistence…');
    const sus = await runloop.suspendSandbox(id);
    ok('suspendSandbox', sus === true);
    // give the provider a moment, then resume.
    await new Promise(r => setTimeout(r, 2000));
    const resumed = await runloop.startSandbox(id);
    ok('startSandbox (resume)', resumed === true);
    const after = await runloop.exec(id, `cat ${runloop.WORKDIR}/note.txt`);
    ok('files persisted across suspend/resume', (after.output || '').trim() === 'hello-from-e2e');

    // 8) Docker-in-Docker (optional — slow, pulls packages).
    if (WANT_DOCKER) {
      console.log('\n[8] Docker-in-Docker (installs podman, ~1-3 min)…');
      const setup = await runloop.dockerSetup(id, { onStep: (s) => console.log('     ›', s) });
      ok('dockerSetup', setup.ok, setup.version || setup.log.slice(-120));
      if (setup.ok) {
        const run = await runloop.dockerRun(id, 'run --rm alpine echo container-ok', { timeout: 280 });
        ok('dockerRun alpine', /container-ok/.test(run.output || ''), (run.output || '').trim().slice(-120));
      }
    } else {
      console.log('\n[8] Docker-in-Docker test skipped (pass --docker to enable).');
    }
  } finally {
    if (id) {
      console.log('\n[cleanup] shutting down devbox', id);
      await runloop.deleteSandbox(id).catch(() => {});
    }
  }

  console.log(`\n──────────────\n${pass} passed, ${fail} failed`);
  if (fail === 0) { console.log('✅ RUNLOOP E2E PASS — Runloop fully owns the computer (lifecycle, exec, files, persistence' + (WANT_DOCKER ? ', docker' : '') + ').'); process.exit(0); }
  else { console.log('❌ RUNLOOP E2E FAIL'); process.exit(1); }
})().catch(e => { console.error('❌ test crashed:', e && e.stack || e); process.exit(1); });
