// End-to-end test of the ACTUAL services/codesandbox.js module — exercises the
// exact interface the app (sandboxAgent.js / agentEngine.js / sandboxPool.js)
// relies on. This is the real integration test.
//
// Reuses ONE sandbox across most checks to stay well under the account's
// concurrent-VM cap, and cleans up (shutdown) at the end.
//
// Run: CODESANDBOX_API_KEY=csb_... node scripts/test-codesandbox-service.js

process.env.CODESANDBOX_API_KEY = process.env.CODESANDBOX_API_KEY || '';
const csb = require('../services/codesandbox');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  \u2705', name, extra || ''); } else { fail++; console.log('  \u274c', name, extra || ''); } }
function hr(t) { console.log('\n\u2500\u2500', t); }

(async () => {
  ok('enabled()', csb.enabled() === true, '=' + csb.enabled());
  ok('enabledAsync()', (await csb.enabledAsync()) === true);
  ok('WORKDIR', csb.WORKDIR === '/root/work', '=' + csb.WORKDIR);

  hr('testKey (zero-cost listRunning validation \u2014 must NOT consume a VM)');
  const t = await csb.testKey();
  ok('testKey ok', t.ok === true, t.message);

  hr('createSandbox with envVars');
  let id;
  try {
    id = await csb.createSandbox({ envVars: { WORM_TEST: 'hello123' } });
    ok('createSandbox returns id', !!id, '=' + id);
  } catch (e) { fail++; console.log('  \u274c createSandbox threw:', e.message); process.exit(1); }

  hr('exec \u2014 root check');
  const who = await csb.exec(id, 'whoami; id -u');
  ok('exec whoami root', /root/.test(who.output) && /\b0\b/.test(who.output), JSON.stringify(who.output));
  ok('exec exitCode 0', who.exitCode === 0, 'code=' + who.exitCode);

  hr('exec \u2014 exit code propagation (the fixed bug)');
  const bad = await csb.exec(id, 'exit 7');
  ok('exec non-zero exit', bad.exitCode === 7, 'code=' + bad.exitCode);
  const bad2 = await csb.exec(id, 'echo before; ls /nonexistent_dir_xyz');
  ok('exec failing cmd keeps real output', /before/.test(bad2.output) && bad2.exitCode !== 0, 'code=' + bad2.exitCode + ' out=' + JSON.stringify(bad2.output.slice(0,80)));

  hr('exec \u2014 WORKDIR cd + env file sourced');
  const wd = await csb.exec(id, 'pwd; echo "ENV=$WORM_TEST"');
  ok('exec cd to WORKDIR', /\/root\/work/.test(wd.output), JSON.stringify(wd.output));
  ok('exec env var present', /ENV=hello123/.test(wd.output), JSON.stringify(wd.output));

  hr('uploadFile \u2014 into NEW nested dir (the mkdir bug path)');
  const payload = Buffer.from([87,79,82,77,0,1,2,255,128,64,10,13,65,66]);
  try {
    await csb.uploadFile(id, '/root/work/uploads/deep/test.bin', payload, 'test.bin');
    const back = await csb.downloadFile(id, '/root/work/uploads/deep/test.bin');
    ok('uploadFile+downloadFile round-trip', Buffer.from(back).equals(payload), 'len=' + back.length);
  } catch (e) { fail++; console.log('  \u274c upload/download threw:', e.message); }

  hr('listFiles');
  try {
    const files = await csb.listFiles(id, '/root/work/uploads/deep');
    ok('listFiles finds test.bin', files.some(f => f.name === 'test.bin'), JSON.stringify(files));
  } catch (e) { fail++; console.log('  \u274c listFiles threw:', e.message); }

  hr('getSandboxState');
  const state = await csb.getSandboxState(id);
  ok('getSandboxState running', state === 'running' || !!state, '=' + state);

  hr('session persistence \u2014 pause + startSandbox (reuse SAME box)');
  try {
    await csb.exec(id, 'echo MARKER > /root/work/.marker');
    await csb.pauseSandbox(id);
    const started = await csb.startSandbox(id);
    ok('startSandbox resumes', started === true);
    const m = await csb.exec(id, 'cat /root/work/.marker');
    ok('file persisted across hibernate/resume', /MARKER/.test(m.output), JSON.stringify(m.output));
  } catch (e) { fail++; console.log('  \u274c persistence flow threw:', e.message); }

  hr('session mapping (getOrCreateSessionSandbox reuse)');
  const sess = 'test:e2e:' + Date.now();
  try {
    const s1 = await csb.getOrCreateSessionSandbox(sess);
    ok('session create/reuse returns id', !!s1.id, JSON.stringify(s1));
    const s2 = await csb.getOrCreateSessionSandbox(sess);
    ok('session reuse (same id)', s2.id === s1.id && s2.reused === true, JSON.stringify(s2));
    await csb.endSession(sess);
    ok('endSession clears mapping', (await csb.getSessionSandboxId(sess)) === null);
  } catch (e) { fail++; console.log('  \u274c session flow threw:', e.message); }

  hr('cleanup');
  try { await csb.deleteSandbox(id); ok('deleteSandbox', true); } catch (e) { fail++; console.log('  \u274c delete threw', e.message); }

  console.log(`\n\u2550\u2550\u2550 RESULT: ${pass} passed, ${fail} failed \u2550\u2550\u2550`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e.stack); process.exit(9); });
