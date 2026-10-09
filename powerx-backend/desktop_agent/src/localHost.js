// ─────────────────────────────────────────────────────────────────────────────
// localHost.js — DESKTOP LOCAL ALPINE SANDBOX HOST (Windows .exe / Linux .deb).
//
// This is the piece that makes the desktop app run heavy coding tasks in a
// LOCAL Alpine Linux sandbox on the USER'S OWN MACHINE — NOT in a cloud sandbox
// (no Daytona / Novita / CodeSandbox / etc.). The AI LLM FUSION brain
// (hotbot/Gemini/racers) and all host-only tools STILL come from the server, so
// the intelligence is unchanged — only the shell/computer is local.
//
// How it works (mirrors services/sandboxAgent.js, but self-contained + local):
//   1. Provision a persistent LOCAL Alpine box for this session via
//      ./localSandbox.js (docker/podman/wsl/proot/chroot/bare — auto-selected),
//      with full root/sudo and a preinstalled coding toolchain.
//   2. Upload the bundled agent.py worker into the box and start it (FILE bridge
//      mode — no sandbox egress needed).
//   3. Drop the task into the worker inbox.
//   4. POLL the box: service the file-bridge (the worker drops brain()/host_tool
//      requests as .req files) by forwarding them to the SERVER over HTTPS with
//      the user's JWT (/api/desktop/brain, /api/desktop/tool). Stream status +
//      live-terminal lines back to the UI. Download deliverables when done.
//
// Because the worker runs LOCALLY, the shell, file writes, package installs,
// builds, bug-fixing and analysis all happen on the user's computer with full
// root — exactly what was asked. Credits are still metered server-side per
// brain call.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const localSandbox = require('./localSandbox');

// The bundled agent worker source. In a packaged Electron app the file lives
// next to this module (copied by electron-builder via the files glob).
function readWorkerSources() {
  const names = ['agent.py', 'latex_render.py', 'database_intelligence.py', 'quality_gate.py'];
  const roots = [path.join(__dirname, 'agent_worker'), path.join(process.resourcesPath || __dirname, 'agent_worker')];
  for (const root of roots) {
    try {
      const sources = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
      return sources;
    } catch (_) {}
  }
  throw new Error('bundled agent_worker runtime modules not found in the desktop app');
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── Ensure the worker is installed + running in the local box ────────────────
async function ensureWorker(id, onStep) {
  const P = localSandbox.boxPaths(id);
  const sources = readWorkerSources();
  const hash = crypto.createHash('sha1').update(Object.values(sources).join('\u0000')).digest('hex').slice(0, 12);

  await localSandbox.exec(id, `mkdir -p ${shq(P.WORKER_DIR)} ${shq(P.INBOX)} ${shq(P.OUTBOX)} ${shq(P.BRIDGE_DIR)}`, { timeout: 30 });
  const probe = await localSandbox.exec(
    id,
    `cat ${shq(P.WORKER_DIR + '/.version')} 2>/dev/null; echo '::'; pgrep -f 'agent.py' >/dev/null 2>&1 && echo RUNNING || echo DEAD`,
    { timeout: 30 }
  ).catch(() => ({ output: '' }));
  const out = probe.output || '';
  const versionOk = out.includes(hash);
  const running = /RUNNING/.test(out);
  if (versionOk && running) return P;

  if (!versionOk) {
    if (onStep) onStep('🧠 installing the local agent worker runtime…');
    for (const [name, source] of Object.entries(sources)) {
      await localSandbox.uploadFile(id, `${P.WORKER_DIR}/${name}`, Buffer.from(source, 'utf8'), name);
    }
    await localSandbox.exec(id, `printf %s ${shq(hash)} > ${shq(P.WORKER_DIR + '/.version')}`, { timeout: 20 });
    if (running) await localSandbox.exec(id, `pkill -f 'agent.py' 2>/dev/null; sleep 1; true`, { timeout: 20 }).catch(() => {});
  }

  if (onStep) onStep('🖥️ starting the agent worker inside your LOCAL Alpine sandbox…');
  // Ensure python3 exists (the toolchain install adds it; fall back to apk on
  // isolated strategies — bare mode relies on the host python3).
  if (!P.bare) {
    await localSandbox.exec(id, `command -v python3 >/dev/null 2>&1 || (apk add --no-cache python3 >/dev/null 2>&1 || true)`, { timeout: 120 }).catch(() => {});
  }
  // In bare mode the worker runs as a RAW host process, so it must be launched
  // with the REAL host paths (it can't see the virtual /root remap). In isolated
  // strategies the logical /root paths are literal.
  const wWork = P.bare ? P.realWork : P.WORK;
  const wDir = P.bare ? P.realWorkerDir : P.WORKER_DIR;
  const env =
    `AGENT_WORK=${shq(wWork)} ` +
    `AGENT_BRIDGE_MODE=file ` +
    `AGENT_SANDBOX_ID=${shq(id)} ` +
    `AGENT_MAX_STEPS=300`;
  const launch = `${env} nohup python3 ${shq(wDir + '/agent.py')} > ${shq(wDir + '/worker.log')} 2>&1 </dev/null &`;
  if (P.bare) {
    // Launch directly on the host (no /root remap) so the worker's own paths
    // are the real host dirs and it can read/write them.
    const { spawn } = require('child_process');
    try {
      const child = spawn('/bin/sh', ['-lc', `cd ${shq(wDir)} && (setsid sh -c ${shq(launch)} 2>/dev/null || sh -c ${shq(launch)})`], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) { /* fall through to probe */ }
  } else {
    await localSandbox.exec(id, `cd ${shq(wDir)} && (setsid sh -c ${shq(launch)} 2>/dev/null || sh -c ${shq(launch)}) ; echo started`, { timeout: 30 });
  }
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const c = await localSandbox.exec(id, `pgrep -f 'agent.py' >/dev/null 2>&1 && echo UP || echo NO`, { timeout: 15 }).catch(() => ({ output: 'NO' }));
    if (/UP/.test(c.output || '')) return P;
  }
  const log = await localSandbox.exec(id, `tail -n 20 ${shq(P.WORKER_DIR + '/worker.log')} 2>/dev/null`, { timeout: 15 }).catch(() => ({ output: '' }));
  throw new Error('local worker did not start: ' + ((log && log.output) || 'no log').slice(0, 300));
}

// ── Server proxy for the fusion brain + host tools (JWT-authenticated) ───────
function serverPost(baseUrl, token, clientId, pathname, body, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(baseUrl.replace(/\/+$/, '') + pathname); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body || {}));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      'X-Client-Platform': 'desktop',
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (clientId) headers['X-Client-Id'] = clientId;
    const req = lib.request(u, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('server request timed out')));
    req.write(payload);
    req.end();
  });
}

// Service ready .req bridge files ONCE: forward each to the server, write .resp.
async function serviceBridgeOnce(id, P, { baseUrl, token, clientId, onStep, onCredits }) {
  const ls = await localSandbox.exec(id, `ls -1 ${P.BRIDGE_DIR}/*.req 2>/dev/null | head -20`, { timeout: 15 }).catch(() => ({ output: '' }));
  const paths = (ls.output || '').split('\n').map(s => s.trim()).filter(p => p && p.endsWith('.req'));
  if (!paths.length) return 0;
  let handled = 0;
  for (const reqPath of paths) {
    let payload = null;
    try {
      const buf = await localSandbox.downloadFile(id, reqPath);
      payload = JSON.parse(buf.toString('utf8'));
    } catch (_) { continue; }

    let out;
    try {
      if (payload.op === 'brain') {
        const r = await serverPost(baseUrl, token, clientId, '/api/desktop/brain', { system: payload.system, messages: payload.messages || [] });
        if (r.status === 200 && r.data && typeof r.data.text === 'string') {
          out = { text: r.data.text };
          if (onCredits && r.data.credits !== undefined) onCredits(r.data.credits);
        } else if (r.status === 402) {
          out = { error: (r.data && r.data.error) || 'Out of credits' };
        } else {
          out = { error: (r.data && r.data.error) || ('brain HTTP ' + r.status) };
        }
      } else if (payload.op === 'tool') {
        const r = await serverPost(baseUrl, token, clientId, '/api/desktop/tool', { tool: payload.tool, args: payload.args || {} }, 600000);
        out = (r.status === 200 && r.data) ? r.data : { error: (r.data && r.data.error) || ('tool HTTP ' + r.status) };
      } else {
        out = { error: 'unknown op' };
      }
    } catch (e) {
      out = { error: (e && e.message) || 'bridge service error' };
    }

    const base = reqPath.replace(/\.req$/, '');
    try {
      await localSandbox.uploadFile(id, `${base}.resp.tmp`, Buffer.from(JSON.stringify(out), 'utf8'), 'resp.json');
      await localSandbox.exec(id, `mv ${base}.resp.tmp ${base}.resp && rm -f ${reqPath}`, { timeout: 15 });
      handled++;
    } catch (e) {
      if (onStep) onStep('⚠️ bridge write-back failed: ' + e.message);
    }
  }
  return handled;
}

// ── Public: run a task in the LOCAL Alpine sandbox ───────────────────────────
// opts: { task, history, files:[{name,buffer}], sessionKey, baseUrl, token,
//         clientId, systemPrompt, onEvent(ev,payload) }
// onEvent emits: start | step | screen | terminal | done | error  (mirrors the
// server SSE shape so the renderer needs NO changes).
async function runLocalTask(opts) {
  const {
    task, history = [], files = [], sessionKey, baseUrl, token, clientId,
    systemPrompt = '__DEFAULT__', onEvent,
  } = opts;
  const emit = (ev, payload) => { try { onEvent && onEvent(ev, payload); } catch (_) {} };
  const onStep = (note) => emit('step', { note });

  // 0) Fail fast if the local sandbox can't run at all.
  const strategy = localSandbox._pickStrategy();
  onStep(`🖥️ Local Alpine sandbox (${strategy}) — running on YOUR machine, no cloud.`);

  // 1) Provision / reuse the persistent local box.
  const { id, reused } = await localSandbox.getOrCreateSessionSandbox(sessionKey || ('desktop:' + (clientId || 'local')), {});
  emit('step', { note: reused ? '🔁 reusing your local sandbox — your files are still here.' : '🆕 created a fresh local Alpine sandbox.' });

  // 2) Ensure the worker is up. P holds the strategy-aware in-box paths.
  const P = await ensureWorker(id, onStep);

  // 3) Upload attachments into the work dir.
  for (const a of files) {
    try {
      const safe = String(a.name || 'input').replace(/[^\w.\-]/g, '_');
      const buf = a.buffer || (a.path ? fs.readFileSync(a.path) : null);
      if (buf) await localSandbox.uploadFile(id, `${P.WORK}/${safe}`, buf, safe);
    } catch (e) { onStep('⚠️ could not upload ' + (a && a.name) + ': ' + e.message); }
  }

  // 4) Seed conversation + drop the task.
  const conversation = [];
  for (const h of (Array.isArray(history) ? history.slice(-12) : [])) {
    if (h && h.text) conversation.push({ role: (h.role === 'assistant' || h.role === 'model') ? 'model' : 'user', text: String(h.text).slice(0, 4000) });
  }
  const attachLine = files.length
    ? `\n\nATTACHED FILES (already in your working dir): ${files.map(a => a.name).join(', ')}\n\nInspect with list_files / read_file / analyze_image. Never ask the user to re-send.`
    : '';
  conversation.push({ role: 'user', text: `TASK: ${task}${attachLine}` });

  const taskId = 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const payload = { system: systemPrompt, conversation, task };
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  await localSandbox.uploadFile(id, `${P.INBOX}/${taskId}.json.tmp`, payloadBuf, `${taskId}.json`);
  await localSandbox.exec(id, `mv ${P.INBOX}/${taskId}.json.tmp ${P.INBOX}/${taskId}.json`, { timeout: 15 });

  emit('start', { ok: true });
  onStep('🤖 the agent is now working inside your LOCAL sandbox…');

  // Fire-and-forget task-type telemetry so the admin sees the KIND of task.
  serverPost(baseUrl, token, clientId, '/api/desktop/task-log', { task }).catch(() => {});

  // 5) Poll loop: service bridge + stream status/terminal + wait for result.
  const statusPath = `${P.OUTBOX}/${taskId}.status`;
  const terminalPath = `${P.OUTBOX}/${taskId}.terminal`;
  const resultPath = `${P.OUTBOX}/${taskId}.result`;
  const HARD_CEILING_MS = 3 * 60 * 60 * 1000; // 3h
  const started = Date.now();
  let sentLines = 0, sentTermLines = 0, resultJson = null;

  while (Date.now() - started < HARD_CEILING_MS) {
    let serviced = 0;
    try {
      serviced = await serviceBridgeOnce(id, P, {
        baseUrl, token, clientId, onStep,
        onCredits: (c) => emit('step', { note: null, credits: c }),
      });
    } catch (_) {}

    // result?
    const got = await localSandbox.exec(id, `test -f ${resultPath} && cat ${resultPath} || echo __PENDING__`, { timeout: 20 }).catch(() => ({ output: '' }));
    const body = got.output || '';
    if (body && !body.includes('__PENDING__')) {
      try { resultJson = JSON.parse(body.trim()); } catch (_) { resultJson = null; }
      if (resultJson) break;
    }

    // status lines
    const st = await localSandbox.exec(id, `cat ${statusPath} 2>/dev/null`, { timeout: 15 }).catch(() => ({ output: '' }));
    const lines = (st.output || '').split('\n').filter(Boolean);
    if (lines.length > sentLines) {
      for (let i = sentLines; i < lines.length; i++) emit('step', { note: lines[i] });
      sentLines = lines.length;
    }

    // live terminal
    const tt = await localSandbox.exec(id, `cat ${terminalPath} 2>/dev/null`, { timeout: 15 }).catch(() => ({ output: '' }));
    const tlines = (tt.output || '').split('\n');
    const completeCount = tlines.length > 0 ? tlines.length - 1 : 0;
    if (completeCount > sentTermLines) {
      const fresh = tlines.slice(sentTermLines, completeCount).filter(l => l.length);
      if (fresh.length) emit('terminal', { lines: fresh.slice(-40) });
      sentTermLines = completeCount;
    }

    if (serviced === 0) await new Promise(r => setTimeout(r, 1200));
  }

  if (!resultJson) { emit('error', { error: 'Local task timed out after ' + Math.round((Date.now() - started) / 1000) + 's' }); return { ok: false }; }

  // 6) Materialize deliverables + emit inline base64 so the renderer's "Save
  //    file" flow works exactly like the cloud path.
  const outFiles = [];
  for (const f of (resultJson.files || [])) {
    try {
      outFiles.push({ name: String(f.name || 'file'), b64: f.b64, size: f.b64 ? Buffer.byteLength(f.b64, 'base64') : 0 });
    } catch (_) {}
  }

  // Cleanup task markers (keep the box + work files for the session).
  await localSandbox.exec(id, `rm -f ${P.INBOX}/${taskId}.json ${P.OUTBOX}/${taskId}.* 2>/dev/null; true`, { timeout: 15 }).catch(() => {});

  emit('done', { message: resultJson.message || '✅ Task complete.', files: outFiles, steps: resultJson.steps || 0 });
  return { ok: true, message: resultJson.message, files: outFiles, steps: resultJson.steps || 0 };
}

// Quick capability probe for the UI (so it can show "Local Alpine ready" or a
// hint to install docker/WSL).
async function probe() {
  try {
    const caps = localSandbox._capabilities();
    const strategy = localSandbox._pickStrategy();
    return { ok: true, strategy, caps };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { runLocalTask, probe };
