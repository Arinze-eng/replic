'use strict';

// Upstash Box adapter — full Debian Linux with shell, filesystem, git, network,
// pause/resume and configurable 2/4/8-core sizing. It implements the same
// backend contract as the existing CodeSandbox/Novita/Daytona adapters.

let db = null;
try { db = require('../db'); } catch (_) {}

const WORKDIR = process.env.UPSTASH_BOX_WORKDIR || '/workspace/home/work';
const SIZE = ['small', 'medium', 'large'].includes(String(process.env.UPSTASH_BOX_SIZE || '').toLowerCase())
  ? String(process.env.UPSTASH_BOX_SIZE).toLowerCase() : 'large';
const RUNTIME = process.env.UPSTASH_BOX_RUNTIME || 'node';
const SESSION_PREFIX = 'upstash_box_session:';
const KEY_TTL = 15000;
let _keyCache = { value: undefined, ts: 0 };
let _sdkPromise = null;
const _boxes = new Map();

function envKey() {
  return String(process.env.UPSTASH_BOX_API_KEY || process.env.UPSTASH_API_KEY || '').trim();
}
function getApiKeySync() {
  if (_keyCache.value !== undefined && Date.now() - _keyCache.ts < KEY_TTL) return _keyCache.value || envKey();
  return envKey();
}
async function getApiKey() {
  if (_keyCache.value !== undefined && Date.now() - _keyCache.ts < KEY_TTL) return _keyCache.value || envKey();
  let runtime = '';
  try {
    const v = db && db.getSetting ? await db.getSetting('upstash_box_api_key') : '';
    if (v && String(v).trim()) runtime = String(v).trim();
  } catch (_) {}
  _keyCache = { value: runtime, ts: Date.now() };
  return runtime || envKey();
}
function invalidateKeyCache() {
  _keyCache = { value: undefined, ts: 0 };
  _boxes.clear();
}
function enabled() {
  if (db && db.getSetting && Date.now() - _keyCache.ts >= KEY_TTL) getApiKey().catch(() => {});
  return !!getApiKeySync() || !!_keyCache.value;
}
async function enabledAsync() { return !!(await getApiKey()); }

async function sdk() {
  if (!_sdkPromise) _sdkPromise = import('@upstash/box');
  const mod = await _sdkPromise;
  if (!mod.Box) throw new Error('@upstash/box missing Box export');
  return mod;
}
async function boxHandle(id, { resume = true } = {}) {
  if (_boxes.has(String(id))) return _boxes.get(String(id));
  const key = await getApiKey();
  if (!key) throw new Error('UPSTASH_BOX_API_KEY not set');
  const { Box } = await sdk();
  const box = await Box.get(String(id), { apiKey: key, timeout: 600000 });
  if (resume) {
    const state = await box.getStatus().catch(() => ({ status: '' }));
    if (/paused|stopped|suspended/i.test(state.status || '')) await box.resume();
  }
  _boxes.set(String(id), box);
  return box;
}

function settingKey(sessionKey) { return SESSION_PREFIX + String(sessionKey); }
async function getSessionSandboxId(sessionKey) {
  if (!db || !db.getSetting || !sessionKey) return null;
  try { const v = await db.getSetting(settingKey(sessionKey)); return v && String(v).trim() || null; } catch (_) { return null; }
}
async function writeSessionId(sessionKey, id) {
  if (!db || !db.setSetting || !sessionKey) return;
  try { await db.setSetting(settingKey(sessionKey), id || ''); } catch (_) {}
}

async function createSandbox({ envVars = {}, labels = {} } = {}) {
  const key = await getApiKey();
  if (!key) throw new Error('UPSTASH_BOX_API_KEY not set');
  const { Box } = await sdk();
  const tag = labels && (labels.session || labels.chat || labels.user);
  const safeTag = String(tag || 'wormgpt').replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 20) || 'wormgpt';
  const box = await Box.create({
    apiKey: key,
    runtime: RUNTIME,
    size: SIZE,
    keepAlive: false,
    labels: ['wormgpt', safeTag].filter((v, i, a) => a.indexOf(v) === i),
    env: envVars,
    networkPolicy: { mode: 'allow-all' },
    timeout: 600000,
  });
  _boxes.set(String(box.id), box);
  const init = await box.exec.command(`mkdir -p ${shquote(WORKDIR)} && printf READY`);
  if (init.exitCode !== 0) throw new Error(init.stderr || init.result || 'Upstash Box initialization failed');
  return box.id;
}
async function deleteSandbox(id) {
  if (!id) return;
  try { const box = await boxHandle(id, { resume: false }); await box.delete(); } catch (_) {}
  _boxes.delete(String(id));
}
async function getSandboxState(id) {
  if (!id || !(await getApiKey())) return null;
  try { const box = await boxHandle(id, { resume: false }); return (await box.getStatus()).status || null; } catch (_) { return null; }
}
async function startSandbox(id) {
  try {
    const box = await boxHandle(id, { resume: false });
    const state = await box.getStatus().catch(() => ({ status: '' }));
    if (!/running|ready/i.test(state.status || '')) await box.resume();
    const probe = await box.exec.command('printf READY');
    return probe.exitCode === 0 && /READY/.test(probe.stdout || probe.result || '');
  } catch (_) { _boxes.delete(String(id)); return false; }
}
async function pauseSandbox(id) {
  try { const box = await boxHandle(id, { resume: false }); await box.pause(); _boxes.delete(String(id)); return true; } catch (_) { return false; }
}
const suspendSandbox = pauseSandbox;

async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  const existing = sessionKey ? await getSessionSandboxId(sessionKey) : null;
  if (existing) {
    const state = await getSandboxState(existing);
    if (state && !/deleted|error|failed/i.test(state)) {
      if (await startSandbox(existing)) return { id: existing, reused: true };
    }
  }
  const id = await createSandbox({ envVars, labels: { ...labels, session: sessionKey || labels.session } });
  if (sessionKey) await writeSessionId(sessionKey, id);
  return { id, reused: false };
}
async function endSession(sessionKey) {
  const id = await getSessionSandboxId(sessionKey);
  if (id) await deleteSandbox(id);
  await writeSessionId(sessionKey, '');
}

async function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  const box = await boxHandle(id);
  const wrapped = cwd ? `mkdir -p ${shquote(cwd)} && cd ${shquote(cwd)} && ${command}` : String(command);
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Upstash Box command timed out after ${timeout}s`)), Math.max(1, timeout) * 1000);
    if (timer.unref) timer.unref();
  });
  const run = await Promise.race([box.exec.command(wrapped), timeoutPromise]).finally(() => clearTimeout(timer));
  return {
    exitCode: Number.isInteger(run.exitCode) ? run.exitCode : (/failed/i.test(run.status || '') ? 1 : 0),
    output: [run.stdout, run.stderr].filter(Boolean).join('\n') || String(run.result || ''),
    stdout: run.stdout || '',
    stderr: run.stderr || '',
  };
}
function relativePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (s === '/workspace/home') return '.';
  if (s.startsWith('/workspace/home/')) return s.slice('/workspace/home/'.length);
  return s.replace(/^\/+/, '');
}
async function uploadFile(id, destPath, buffer) {
  const box = await boxHandle(id);
  const rel = relativePath(destPath);
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
  if (parent && parent !== '.') await box.exec.command(`mkdir -p ${shquote('/workspace/home/' + parent)}`);
  await box.files.write({ path: rel, content: Buffer.from(buffer).toString('base64'), encoding: 'base64' });
  return true;
}
async function downloadFile(id, srcPath) {
  const box = await boxHandle(id);
  const b64 = await box.files.read(relativePath(srcPath), { encoding: 'base64' });
  return Buffer.from(String(b64), 'base64');
}
async function listFiles(id, dir = WORKDIR) {
  const box = await boxHandle(id);
  const entries = await box.files.list(relativePath(dir));
  return (entries || []).map(e => ({
    name: e.name,
    size: Number(e.size) || 0,
    isDir: !!e.is_dir,
    modTime: Date.parse(e.mod_time || '') || 0,
  }));
}

async function testKey(overrideKey) {
  const key = String(overrideKey || await getApiKey() || '').trim();
  if (!key) return { ok: false, status: 0, message: 'No Upstash Box API key configured.' };
  const started = Date.now();
  try {
    const { Box } = await sdk();
    const boxes = await Box.list({ apiKey: key });
    return { ok: true, status: 200, ms: Date.now() - started, message: `✅ Working — Upstash Box API authenticated (${boxes.length} box(es) listed).` };
  } catch (e) {
    const msg = String(e && e.message || e);
    return { ok: false, status: e && e.statusCode || 0, message: /401|403|unauthor|invalid/i.test(msg) ? '❌ Invalid or unauthorized Upstash Box API key.' : `❌ Upstash Box error: ${msg.slice(0, 180)}` };
  }
}

async function dockerSetup(id, { onStep } = {}) {
  if (onStep) onStep('🐳 setting up container tooling in Upstash Box…');
  const r = await exec(id, 'command -v docker >/dev/null || (sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq podman); command -v docker >/dev/null || sudo ln -sf "$(command -v podman)" /usr/local/bin/docker; docker --version', { cwd: null, timeout: 300 });
  return { ok: r.exitCode === 0, version: (r.output.match(/(?:Docker|podman) version[^\n]*/i) || [''])[0], log: r.output.slice(-2000) };
}
async function dockerRun(id, dockerArgs, { timeout = 300 } = {}) { return exec(id, `docker ${dockerArgs}`, { cwd: null, timeout }); }
function shquote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

module.exports = {
  enabled, enabledAsync, WORKDIR,
  createSandbox, deleteSandbox, getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
};
