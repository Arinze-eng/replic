// scripts/test-sandbox-agent.js
// End-to-end structural test for the in-sandbox agent worker (agent.py).
//
// It does NOT require the real LLM brain or the Render bridge. Instead it:
//   1. provisions a real Daytona sandbox (uses DAYTONA_API_KEY / DAYTONA_ORG_ID),
//   2. installs + starts agent.py via the SAME ensureWorker() the host uses,
//   3. runs a MOCK bridge INSIDE the sandbox (a tiny python http server on
//      127.0.0.1) that feeds the worker a scripted action sequence:
//         plan → run_code (writes a file) → finish,
//   4. submits a task to the inbox and polls the outbox,
//   5. asserts the worker produced the expected file + final message.
//
// This proves the worker lifecycle, the inbox/outbox protocol, local tool
// execution (run_code) and deliverable collection all work on a real sandbox.
//
// Run:  DAYTONA_API_KEY=... DAYTONA_ORG_ID=... node scripts/test-sandbox-agent.js

const crypto = require('crypto');
const daytona = require('../services/daytona');

const WORK = '/home/daytona/work';
const INBOX = `${WORK}/.agent_inbox`;
const OUTBOX = `${WORK}/.agent_outbox`;
const WORKER_DIR = '/home/daytona/agent';

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

async function writeB64(id, dest, content) {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  const CHUNK = 60000;
  await daytona.exec(id, `: > ${dest}.b64`, { timeout: 30 });
  for (let i = 0; i < b64.length; i += CHUNK) {
    await daytona.exec(id, `printf %s ${shq(b64.slice(i, i + CHUNK))} >> ${dest}.b64`, { timeout: 60 });
  }
  await daytona.exec(id, `base64 -d ${dest}.b64 > ${dest} && rm -f ${dest}.b64`, { timeout: 30 });
}

// A mock bridge that scripts the brain and echoes tool ops to local execution.
// The worker hits it at AGENT_BRIDGE_URL; it returns brain actions in order and
// for op:"tool" returns an empty result (this test only uses local tools, which
// the worker runs itself — host tools are not exercised here).
const MOCK_BRIDGE = `
import json, http.server, socketserver

STEPS = [
  {"thought":"plan","action":"plan","args":{"steps":["write a file","finish"]}},
  {"thought":"write a marker file","action":"run_code","args":{"language":"python","code":"open('proof.txt','w').write('agent-owns-the-computer OK\\\\n'); print('wrote proof.txt')"}},
  {"thought":"done","action":"finish","args":{"message":"DONE — created proof.txt inside the sandbox."}},
]
i = {"n": 0}

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        ln = int(self.headers.get('Content-Length','0'))
        body = json.loads(self.rfile.read(ln) or b'{}')
        if body.get('op') == 'brain':
            step = STEPS[min(i["n"], len(STEPS)-1)]
            i["n"] += 1
            out = {"text": json.dumps(step)}
        else:
            out = {"result": "[mock host tool ok]", "files": []}
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(data)

with socketserver.TCPServer(("127.0.0.1", 8765), H) as s:
    s.serve_forever()
`;

(async () => {
  if (!daytona.enabled()) { console.error('❌ Daytona not enabled (set DAYTONA_API_KEY / DAYTONA_ORG_ID).'); process.exit(2); }
  const sessionKey = 'test:' + crypto.randomBytes(3).toString('hex');
  console.log('▶ provisioning sandbox for', sessionKey);
  const { id } = await daytona.getOrCreateSessionSandbox(sessionKey, {});
  console.log('  sandbox id =', id);

  try {
    // 1) prep dirs + start the mock bridge inside the sandbox
    await daytona.exec(id, `mkdir -p ${WORKER_DIR} ${INBOX} ${OUTBOX} ${WORK}`, { timeout: 30 });
    await writeB64(id, `${WORKER_DIR}/mockbridge.py`, MOCK_BRIDGE);
    await daytona.exec(id, `pkill -f mockbridge.py 2>/dev/null; nohup setsid python3 ${WORKER_DIR}/mockbridge.py > ${WORKER_DIR}/mock.log 2>&1 & echo started`, { timeout: 30 });
    await new Promise(r => setTimeout(r, 2000));

    // 2) install + start agent.py (reuse the real ensureWorker via sandboxAgent
    //    internals would require the bridge env; here we start it manually with
    //    the mock bridge URL so the test is hermetic).
    const fs = require('fs');
    const path = require('path');
    const AGENT_PY = fs.readFileSync(path.join(__dirname, '..', 'agent_worker', 'agent.py'), 'utf-8');
    await writeB64(id, `${WORKER_DIR}/agent.py`, AGENT_PY);
    const env = `AGENT_WORK=${shq(WORK)} AGENT_BRIDGE_URL='http://127.0.0.1:8765' AGENT_TOKEN='t' AGENT_SANDBOX_ID=${shq(id)} AGENT_MAX_STEPS='10'`;
    await daytona.exec(id, `pkill -f 'agent.py' 2>/dev/null; cd ${WORKER_DIR} && ${env} nohup setsid python3 agent.py > ${WORKER_DIR}/worker.log 2>&1 & echo started`, { timeout: 30 });

    // wait for worker up
    let up = false;
    for (let k = 0; k < 10; k++) {
      await new Promise(r => setTimeout(r, 1200));
      const c = await daytona.exec(id, `pgrep -f 'agent.py' >/dev/null 2>&1 && echo UP || echo NO`, { timeout: 20 });
      if (/UP/.test(c.output || '')) { up = true; break; }
    }
    if (!up) {
      const log = await daytona.exec(id, `tail -n 30 ${WORKER_DIR}/worker.log`, { timeout: 20 });
      throw new Error('worker did not start. log:\n' + (log.output || ''));
    }
    console.log('✔ worker is running inside the sandbox');

    // 3) submit a task
    const taskId = 't_' + Date.now().toString(36);
    const payload = JSON.stringify({ system: 'TEST', conversation: [{ role: 'user', text: 'TASK: create proof.txt' }] });
    await writeB64(id, `${INBOX}/${taskId}.json.tmp`, payload);
    await daytona.exec(id, `mv ${INBOX}/${taskId}.json.tmp ${INBOX}/${taskId}.json`, { timeout: 20 });
    console.log('✔ task submitted:', taskId);

    // 4) poll for result
    let result = null;
    for (let k = 0; k < 40; k++) {
      await new Promise(r => setTimeout(r, 1500));
      const got = await daytona.exec(id, `test -f ${OUTBOX}/${taskId}.result && cat ${OUTBOX}/${taskId}.result || echo __PENDING__`, { timeout: 30 });
      const body = got.output || '';
      if (body && !body.includes('__PENDING__')) { try { result = JSON.parse(body.trim()); } catch (_) {} if (result) break; }
    }
    if (!result) {
      const log = await daytona.exec(id, `echo '--- worker.log ---'; tail -n 40 ${WORKER_DIR}/worker.log; echo '--- status ---'; cat ${OUTBOX}/${taskId}.status 2>/dev/null`, { timeout: 20 });
      throw new Error('no result. diagnostics:\n' + (log.output || ''));
    }

    console.log('✔ result message:', result.message);
    console.log('  files returned:', (result.files || []).map(f => f.name).join(', ') || '(none)');

    const proof = (result.files || []).find(f => f.name === 'proof.txt');
    const okMsg = /DONE/.test(result.message || '');
    const okFile = !!proof && Buffer.from(proof.b64, 'base64').toString().includes('agent-owns-the-computer OK');
    if (okMsg && okFile) {
      console.log('\n✅ PASS — in-sandbox agent ran the loop, executed run_code locally, and returned the deliverable.');
    } else {
      console.log('\n❌ FAIL — okMsg=' + okMsg + ' okFile=' + okFile);
      process.exitCode = 1;
    }
  } finally {
    console.log('▶ cleaning up sandbox', id);
    await daytona.endSession(sessionKey).catch(() => {});
  }
})().catch(e => { console.error('❌ test error:', e.message); process.exit(1); });
