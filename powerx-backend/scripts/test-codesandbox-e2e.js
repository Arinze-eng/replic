// Raw end-to-end probe of the CodeSandbox SDK, mirroring EXACTLY what
// services/codesandbox.js does. Prints the real shape of every result so we can
// find where the service's assumptions diverge from the live SDK.
//
// Run: CODESANDBOX_API_KEY=csb_... node scripts/test-codesandbox-e2e.js

const KEY = (process.env.CODESANDBOX_API_KEY || process.env.CSB_API_KEY || '').trim();

function log(...a) { console.log(...a); }
function hr(t) { console.log('\n─────────────────────────', t, '─────────────────────────'); }

(async () => {
  if (!KEY) { console.error('NO KEY'); process.exit(1); }
  log('key prefix:', KEY.slice(0, 10) + '…', 'len', KEY.length);

  const mod = await import('@codesandbox/sdk');
  const CodeSandbox = mod.CodeSandbox;
  hr('1) new CodeSandbox(key)');
  const sdk = new CodeSandbox(KEY);
  log('sdk keys:', Object.keys(sdk));
  log('sdk.sandboxes methods:', sdk.sandboxes ? Object.getOwnPropertyNames(Object.getPrototypeOf(sdk.sandboxes)) : 'NONE');

  hr('2) sdk.sandboxes.create()');
  let sandbox;
  try {
    sandbox = await sdk.sandboxes.create();
    log('create OK. sandbox keys:', Object.keys(sandbox));
    log('sandbox.id:', sandbox.id);
    log('sandbox proto methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(sandbox)));
  } catch (e) {
    console.error('CREATE FAILED:', e && e.message);
    console.error(e && e.stack);
    process.exit(2);
  }
  const id = sandbox.id;

  hr('3) sandbox.connect()');
  let client;
  try {
    client = await sandbox.connect();
    log('connect OK. client keys:', Object.keys(client));
    log('client proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
    log('client.commands:', client.commands ? Object.getOwnPropertyNames(Object.getPrototypeOf(client.commands)) : 'NONE');
    log('client.fs:', client.fs ? Object.getOwnPropertyNames(Object.getPrototypeOf(client.fs)) : 'NONE');
  } catch (e) {
    console.error('CONNECT FAILED:', e && e.message, e && e.stack);
  }

  if (client && client.commands) {
    hr('4) client.commands.run("whoami; id; pwd")');
    try {
      const r = await client.commands.run('whoami; id; pwd');
      log('run return TYPE:', typeof r);
      log('run return VALUE:', JSON.stringify(String(r)).slice(0, 400));
    } catch (e) { console.error('RUN FAILED:', e && e.message); }

    hr('4b) exit-code sentinel test (mirrors service exec())');
    try {
      const wrapped = `{ echo hello; false; }; printf '\\n__CSB_EXIT__%s' "$?"`;
      const r = await client.commands.run(wrapped);
      log('wrapped raw:', JSON.stringify(String(r)));
      const m = String(r).match(/__CSB_EXIT__(\d+)\s*$/);
      log('parsed exit code:', m ? m[1] : 'NOT FOUND');
    } catch (e) { console.error('WRAPPED RUN FAILED:', e && e.message); }
  }

  if (client && client.fs) {
    hr('5) fs write/read round-trip (binary-safe)');
    try {
      const payload = Buffer.from([0, 1, 2, 255, 128, 64, 10, 13, 65, 66]);
      // service uses writeFile(path, Buffer) then readFile(path)
      await client.fs.writeFile('/root/work/_probe.bin', payload);
      log('writeFile OK');
      const back = await client.fs.readFile('/root/work/_probe.bin');
      const bb = Buffer.from(back);
      log('readFile TYPE:', bb.constructor.name, 'len', bb.length, 'equal:', bb.equals(payload));
    } catch (e) { console.error('FS RW FAILED:', e && e.message); }

    hr('5b) fs.readdir shape');
    try {
      const arr = await client.fs.readdir('/root/work');
      log('readdir type:', Array.isArray(arr) ? 'array' : typeof arr, 'len', Array.isArray(arr) ? arr.length : '-');
      log('sample entry:', JSON.stringify(arr && arr[0]));
    } catch (e) { console.error('READDIR FAILED:', e && e.message); }

    hr('5c) fs.writeTextFile');
    try {
      if (client.fs.writeTextFile) { await client.fs.writeTextFile('/root/.wormgpt_env', 'export FOO=bar\n'); log('writeTextFile OK'); }
      else log('NO writeTextFile method');
    } catch (e) { console.error('writeTextFile FAILED:', e && e.message); }

    hr('5d) fs.mkdir recursive');
    try {
      if (client.fs.mkdir) { await client.fs.mkdir('/root/work/subdir', { recursive: true }); log('mkdir OK'); }
      else log('NO mkdir method');
    } catch (e) { console.error('mkdir FAILED:', e && e.message); }
  }

  hr('6) hibernate + resume + reconnect (persistence)');
  try {
    if (sdk.sandboxes.hibernate) { await sdk.sandboxes.hibernate(id); log('hibernate OK'); }
    else log('NO hibernate');
  } catch (e) { console.error('HIBERNATE FAILED:', e && e.message); }
  try {
    if (sdk.sandboxes.resume) {
      const sb2 = await sdk.sandboxes.resume(id);
      log('resume OK, keys:', Object.keys(sb2));
      const c2 = await sb2.connect();
      const chk = await c2.commands.run('cat /root/work/_probe.bin | wc -c');
      log('after resume, probe file size:', JSON.stringify(String(chk)));
    } else log('NO resume');
  } catch (e) { console.error('RESUME FAILED:', e && e.message); }

  hr('7) cleanup: shutdown/hibernate');
  try {
    if (sdk.sandboxes.shutdown) { await sdk.sandboxes.shutdown(id); log('shutdown OK'); }
    else if (sdk.sandboxes.hibernate) { await sdk.sandboxes.hibernate(id); log('hibernate(cleanup) OK'); }
  } catch (e) { console.error('CLEANUP FAILED:', e && e.message); }

  hr('DONE');
  process.exit(0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(9); });
