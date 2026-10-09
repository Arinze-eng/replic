// Full end-to-end test of the desktop LOCAL sandbox pipeline (bare strategy):
//   localHost.runLocalTask -> localSandbox (bare) -> agent.py worker ->
//   file bridge -> our stub "server" brain endpoint -> deliverables.
process.env.LOCAL_SANDBOX = '1';
process.env.LOCAL_SANDBOX_STRATEGY = 'bare';
process.env.LOCAL_SANDBOX_DATA_DIR = '/tmp/lsb_full';

const http = require('http');
const path = require('path');
const REPO = '/data/coda/dr4awfq4/ws/28256e05-5dd0-4a5a-bc61-81f35890c6ad/work/powerx';
// Use the desktop bundle copies (they require ./localSandbox + agent_worker/agent.py)
const localHost = require(path.join(REPO, 'desktop_agent/src/localHost.js'));

// Stub server: /api/desktop/brain returns scripted actions; /api/desktop/tool
// returns a stub; /api/desktop/task-log just 200s.
let brainStep = 0;
const scripted = [
  JSON.stringify({ action: 'write_file', thought: 'create the file', args: { filename: 'result.txt', content: 'LOCAL SANDBOX WORKS 🍌' } }),
  JSON.stringify({ action: 'run_code', thought: 'verify', args: { language: 'shell', code: 'cat result.txt' } }),
  JSON.stringify({ action: 'finish', args: { message: 'Done — created result.txt in the LOCAL Alpine sandbox.' } }),
];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/desktop/brain') {
      const text = scripted[Math.min(brainStep, scripted.length - 1)]; brainStep++;
      return res.end(JSON.stringify({ text, credits: 999 }));
    }
    if (req.url === '/api/desktop/tool') {
      return res.end(JSON.stringify({ result: '(stub host tool)' }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = 'http://127.0.0.1:' + port;
  console.log('stub server on', baseUrl);
  const steps = [];
  try {
    const out = await localHost.runLocalTask({
      task: 'Create result.txt with a success message and verify it.',
      history: [],
      files: [],
      sessionKey: 'e2e-full',
      baseUrl,
      token: 'faketoken',
      clientId: 'testclient',
      systemPrompt: 'You are a test agent. Respond only with JSON actions.',
      onEvent: (ev, payload) => {
        if (ev === 'step' && payload && payload.note) steps.push(payload.note);
        if (ev === 'done') console.log('DONE EVENT:', JSON.stringify({ message: payload.message, files: (payload.files || []).map(f => f.name), steps: payload.steps }));
        if (ev === 'error') console.log('ERROR EVENT:', payload.error);
      },
    });
    console.log('RESULT:', JSON.stringify({ ok: out.ok, message: out.message, files: (out.files || []).map(f => ({ name: f.name, size: f.size })) }));
    const dec = (out.files || [])[0] && out.files[0].b64 ? Buffer.from(out.files[0].b64, 'base64').toString() : null;
    console.log('DELIVERED CONTENT:', JSON.stringify(dec));
    console.log('STEPS SEEN:', steps.length);
  } catch (e) {
    console.error('TEST ERR', e);
  } finally {
    server.close();
    process.exit(0);
  }
});
