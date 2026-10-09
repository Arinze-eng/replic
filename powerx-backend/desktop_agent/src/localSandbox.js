// ─────────────────────────────────────────────────────────────────────────────
// localSandbox.js — LOCAL Alpine Linux "owns-the-computer" sandbox backend.
//
// This is a DROP-IN sandbox backend that exposes the EXACT SAME interface shape
// as daytona.js / novitaSandbox.js / codesandbox.js / runloop.js / hopx.js, so
// services/sandboxAgent.js + services/agentEngine.js can use it with NO other
// changes. The crucial difference: there is NO cloud provider. The "sandbox" is
// a REAL Alpine Linux userland that runs on the SAME machine as this Node
// process (the Windows/Linux desktop app, or a self-hosted Linux server).
//
// Why: the desktop (.exe / .deb) build must NOT use Daytona / Novita / any cloud
// sandbox. It must run heavy coding, bug-fixing and analysis in a LOCAL Alpine
// Linux sandbox on the user's own computer — with full root / sudo and a rich
// preinstalled coding toolchain (bash, coreutils, grep, sed, awk, sqlite, git,
// python3, node, build tools, curl, jq, …). The AI LLM FUSION brain
// (hotbot/Gemini/racers) is UNCHANGED — the in-sandbox agent worker (agent.py)
// still calls BACK to the host bridge for the brain + host-only tools, exactly
// like the cloud backends. Only WHERE the shell runs changes: locally, not in
// the cloud.
//
// Isolation strategy (auto-selected, best-effort, most-isolated-first):
//   1. `docker` / `podman`  → run a persistent `alpine` container as the box
//      (real container isolation, full root inside, `apk` package manager).
//   2. WSL Alpine (Windows) → `wsl -d alpine` (a real Alpine distro).
//   3. `proot` + Alpine mini-rootfs → an unprivileged user-space chroot with a
//      full Alpine userland and fake-root (`sudo`/`apk` work inside).
//   4. `chroot` (root only) → a real chroot into the Alpine rootfs.
//   5. Bare fallback → run directly in a scoped work dir on the host shell
//      (still local; used only when nothing above is available so the agent is
//      never dead — it degrades to "the host IS the box").
//
// Everything is provisioned ONCE and cached under a per-user data dir so repeat
// runs are instant. State (which session maps to which box) is persisted so a
// chat keeps the SAME box across turns (files/state persist), matching the
// cloud backends' getOrCreateSessionSandbox contract.
//
// Interface (identical to the cloud backends):
//   enabled, enabledAsync, WORKDIR, home,
//   createSandbox, deleteSandbox,
//   getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
//   getOrCreateSessionSandbox, endSession, getSessionSandboxId,
//   exec, uploadFile, downloadFile, listFiles,
//   getApiKey, invalidateKeyCache, testKey,
//   dockerSetup, dockerRun
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

let db = null;
try { db = require('../db'); } catch (_) { /* db optional */ }

// ── Constants ────────────────────────────────────────────────────────────────
// Inside the Alpine box the agent's home is /root (real root inside a container/
// chroot/proot), and the working dir is /root/work — so WORK = home + "/work"
// lines up with the sandboxAgent path math exactly like the other backends.
const HOME = '/root';
const WORKDIR = `${HOME}/work`;

// Alpine mini-rootfs (used by the proot / chroot strategies). x86_64 + aarch64
// covered; the version is pinned but overridable via env.
const ALPINE_VERSION = (process.env.LOCAL_SANDBOX_ALPINE_VERSION || '3.20').trim();
const ALPINE_PATCH = (process.env.LOCAL_SANDBOX_ALPINE_PATCH || '3.20.3').trim();
function alpineArch() {
  const a = os.arch();
  if (a === 'arm64' || a === 'aarch64') return 'aarch64';
  if (a === 'x64' || a === 'x86_64') return 'x86_64';
  // Alpine also ships armv7/armhf/x86; default to x86_64 for anything else.
  return 'x86_64';
}
function alpineRootfsUrl() {
  const arch = alpineArch();
  const base = process.env.LOCAL_SANDBOX_ALPINE_MIRROR
    || `https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/${arch}`;
  return `${base.replace(/\/+$/, '')}/alpine-minirootfs-${ALPINE_PATCH}-${arch}.tar.gz`;
}

// The container image used by the docker/podman strategy.
const ALPINE_IMAGE = (process.env.LOCAL_SANDBOX_ALPINE_IMAGE || `alpine:${ALPINE_VERSION}`).trim();

// The rich coding toolchain preinstalled inside EVERY local Alpine box so heavy
// coding / bug-fixing / analysis works out of the box (no wait on first use).
// apk package names — installed once per box, then cached.
const APK_TOOLCHAIN = [
  // core shell + text tooling the agent leans on constantly
  'bash', 'coreutils', 'grep', 'sed', 'gawk', 'findutils', 'diffutils', 'less',
  'file', 'which', 'tar', 'gzip', 'xz', 'zip', 'unzip', 'p7zip',
  // networking / fetch
  'curl', 'wget', 'openssl', 'ca-certificates', 'jq', 'git', 'openssh-client',
  'bind-tools', 'nmap', 'netcat-openbsd', 'socat',
  // databases
  'sqlite', 'sqlite-dev',
  // languages + build tools for HEAVY coding
  'python3', 'py3-pip', 'python3-dev',
  'nodejs', 'npm',
  'build-base', 'make', 'cmake', 'pkgconf', 'gcc', 'g++', 'musl-dev', 'linux-headers',
  'go', 'rust', 'cargo',
  // handy extras
  'shadow', 'sudo', 'procps', 'htop', 'nano', 'vim', 'tree', 'man-db',
].join(' ');

// Data dir where the Alpine rootfs + per-box state live. Overridable so the
// desktop app can point it at Electron's userData path.
function dataDir() {
  const d = (process.env.LOCAL_SANDBOX_DATA_DIR || '').trim()
    || path.join(os.homedir() || os.tmpdir(), '.wormgpt-sandbox');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function boxesDir() { const d = path.join(dataDir(), 'boxes'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; }
function rootfsDir() { return path.join(dataDir(), 'alpine-rootfs'); }
function stateFile() { return path.join(dataDir(), 'sessions.json'); }

// ── Command discovery (which isolation strategy is available) ────────────────
function _which(bin) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
    if (r.status === 0 && (r.stdout || '').trim()) return (r.stdout || '').trim().split(/\r?\n/)[0];
  } catch (_) {}
  return null;
}
let _hasCache = null;
function _capabilities() {
  if (_hasCache) return _hasCache;
  const isWin = process.platform === 'win32';
  const caps = {
    docker: !!_which('docker'),
    podman: !!_which('podman'),
    proot: !!_which('proot'),
    wsl: false,
    chroot: !isWin && (process.getuid ? process.getuid() === 0 : false) && !!_which('chroot'),
    isRoot: process.getuid ? process.getuid() === 0 : false,
    isWin,
  };
  if (isWin) {
    // Detect WSL + an Alpine distro registered inside it.
    if (_which('wsl')) {
      try {
        // `wsl -l -q` lists installed distros (UTF-16 on some builds).
        const r = spawnSync('wsl', ['-l', '-q'], { encoding: 'utf8' });
        const out = (r.stdout || '').replace(/\u0000/g, '');
        if (/alpine/i.test(out)) caps.wsl = true;
      } catch (_) {}
    }
  }
  _hasCache = caps;
  return caps;
}
// Force a re-probe (used by testKey / after a bootstrap that installs a runtime).
function _resetCaps() { _hasCache = null; }

// Choose the best available strategy: 'docker' | 'podman' | 'wsl' | 'proot' |
// 'chroot' | 'bare'. Admin/env can pin one via LOCAL_SANDBOX_STRATEGY.
function _pickStrategy() {
  const forced = (process.env.LOCAL_SANDBOX_STRATEGY || '').trim().toLowerCase();
  const caps = _capabilities();
  if (forced && ['docker', 'podman', 'wsl', 'proot', 'chroot', 'bare'].includes(forced)) {
    return forced;
  }
  if (caps.docker) return 'docker';
  if (caps.podman) return 'podman';
  if (caps.wsl) return 'wsl';
  if (caps.proot) return 'proot';
  if (caps.chroot) return 'chroot';
  return 'bare';
}

// ── enabled() — the local sandbox is available whenever we're running on a real
// host that can execute shell commands. It's OPT-IN via env/DB so a cloud Render
// deploy (which SHOULD keep using the cloud sandboxes) never accidentally tries
// to run a local box. The desktop app sets LOCAL_SANDBOX=1.
function _flagOn(v) { return ['1', 'on', 'true', 'yes'].includes(String(v || '').trim().toLowerCase()); }
function _flagOff(v) { return ['0', 'off', 'false', 'no'].includes(String(v || '').trim().toLowerCase()); }

function enabled() {
  // Env hard switch (used by the desktop app).
  if (_flagOn(process.env.LOCAL_SANDBOX)) return true;
  if (_flagOff(process.env.LOCAL_SANDBOX)) return false;
  // DB runtime setting (admin-overridable on a self-hosted server).
  if (db && db.getSettingSync) {
    try { const v = db.getSettingSync('local_sandbox_enabled'); if (_flagOn(v)) return true; if (_flagOff(v)) return false; } catch (_) {}
  }
  return false; // default OFF — cloud deploys keep the cloud sandboxes
}
async function enabledAsync() {
  if (_flagOn(process.env.LOCAL_SANDBOX)) return true;
  if (_flagOff(process.env.LOCAL_SANDBOX)) return false;
  if (db && db.getSetting) {
    try { const v = await db.getSetting('local_sandbox_enabled'); if (_flagOn(v)) return true; if (_flagOff(v)) return false; } catch (_) {}
  }
  return false;
}

// These exist only for interface parity with the cloud backends (no API key
// needed for a local box).
async function getApiKey() { return 'local'; }
function invalidateKeyCache() {}

// ── Session → box mapping (persisted to disk so it survives restarts) ─────────
function _readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function _writeState(st) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2)); } catch (_) {}
}
function _sessionMap() { const s = _readState(); return s.sessions || {}; }
function _setSessionId(sessionKey, id) {
  const s = _readState(); s.sessions = s.sessions || {};
  if (id) s.sessions[String(sessionKey)] = id; else delete s.sessions[String(sessionKey)];
  _writeState(s);
}
function _boxMeta(id) { const s = _readState(); return (s.boxes && s.boxes[id]) || null; }
function _setBoxMeta(id, meta) {
  const s = _readState(); s.boxes = s.boxes || {};
  if (meta) s.boxes[id] = { ...(s.boxes[id] || {}), ...meta }; else delete s.boxes[id];
  _writeState(s);
}

// ── Alpine rootfs bootstrap (for proot / chroot strategies) ──────────────────
// Download + extract the Alpine mini-rootfs ONCE, then install the toolchain
// inside it. Cached by a sentinel so repeat calls are instant.
let _rootfsReady = false;
async function _ensureRootfs(onStep) {
  if (_rootfsReady) return rootfsDir();
  const dir = rootfsDir();
  const sentinel = path.join(dir, '.toolchain_ready');
  if (fs.existsSync(sentinel)) { _rootfsReady = true; return dir; }

  fs.mkdirSync(dir, { recursive: true });
  const tarPath = path.join(dataDir(), `alpine-minirootfs.tar.gz`);

  // 1) Download the rootfs tarball if the dir looks empty.
  const looksExtracted = fs.existsSync(path.join(dir, 'bin')) && fs.existsSync(path.join(dir, 'etc'));
  if (!looksExtracted) {
    if (onStep) onStep('📦 downloading Alpine Linux mini-rootfs (first run only)…');
    await _download(alpineRootfsUrl(), tarPath);
    if (onStep) onStep('📦 extracting Alpine rootfs…');
    // Extract with tar (available on all target hosts; on Windows this runs the
    // bundled/git tar or the proot path is not used).
    const r = spawnSync('tar', ['-xzf', tarPath, '-C', dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('failed to extract Alpine rootfs: ' + ((r.stderr || '') + (r.stdout || '')).slice(0, 300));
    try { fs.unlinkSync(tarPath); } catch (_) {}
  }

  // 2) DNS + repos so apk can fetch, then install the coding toolchain INSIDE
  //    the rootfs using the SAME strategy we'll run boxes with.
  try { fs.writeFileSync(path.join(dir, 'etc', 'resolv.conf'), 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n'); } catch (_) {}

  if (onStep) onStep('🧰 installing coding toolchain into the Alpine sandbox (bash, python3, node, git, sqlite, build tools…)…');
  const install = `set -e; apk update; apk add --no-cache ${APK_TOOLCHAIN} 2>&1 | tail -3 || apk add --no-cache ${APK_TOOLCHAIN.split(' ').slice(0, 30).join(' ')}; ` +
    // pip helpers commonly needed for heavy coding
    `python3 -m pip install --break-system-packages -q requests rich 2>/dev/null || true; ` +
    `touch /.toolchain_ready; echo TOOLCHAIN_OK`;
  const out = await _rootfsExec(dir, install, 900);
  if (!/TOOLCHAIN_OK/.test(out)) {
    // Don't hard-fail: a partial toolchain still lets the agent self-install
    // more via apk on demand. Mark ready so we don't loop.
    if (onStep) onStep('⚠️ toolchain install finished with warnings — the sandbox is usable; missing tools auto-install on demand.');
  }
  try { fs.writeFileSync(sentinel, new Date().toISOString()); } catch (_) {}
  _rootfsReady = true;
  return dir;
}

// Run a command INSIDE the shared rootfs (used only during bootstrap) via the
// best chroot-like mechanism available.
function _rootfsExec(dir, cmd, timeoutSec) {
  return new Promise((resolve) => {
    const caps = _capabilities();
    let bin, args;
    if (caps.proot) {
      bin = 'proot';
      args = ['-0', '-r', dir, '-b', '/proc', '-b', '/sys', '-b', '/dev', '-w', '/', '/bin/sh', '-c', cmd];
    } else if (caps.isRoot && caps.chroot) {
      bin = 'chroot';
      args = [dir, '/bin/sh', '-c', cmd];
    } else {
      // No chroot mechanism → run against the host shell scoped to the dir. This
      // only happens on the 'bare' fallback where the rootfs isn't really used.
      return resolve('');
    }
    let out = '';
    let done = false;
    const p = spawn(bin, args, { encoding: 'utf8' });
    const to = setTimeout(() => { if (!done) { try { p.kill('SIGKILL'); } catch (_) {} } }, Math.max(5, timeoutSec) * 1000);
    p.stdout && p.stdout.on('data', d => out += d.toString());
    p.stderr && p.stderr.on('data', d => out += d.toString());
    p.on('close', () => { done = true; clearTimeout(to); resolve(out); });
    p.on('error', () => { done = true; clearTimeout(to); resolve(out); });
  });
}

// Tiny dependency-free downloader (follows redirects).
function _download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        return resolve(_download(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('download timed out')));
  });
}

// ── Box lifecycle ────────────────────────────────────────────────────────────
// A "box" is one Alpine sandbox instance. Its id encodes the strategy so exec/
// file ops know how to reach it. Metadata (per-box work dir on the host, the
// container name, etc.) is persisted in the state file.

function _newBoxId(strategy) {
  return `local-${strategy}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// Create + start a fresh box. Returns its id.
async function createSandbox({ envVars = {}, labels = {} } = {}) {
  const strategy = _pickStrategy();
  const id = _newBoxId(strategy);
  const hostWork = path.join(boxesDir(), id);
  fs.mkdirSync(hostWork, { recursive: true });

  if (strategy === 'docker' || strategy === 'podman') {
    // Pull once (best-effort) then run a long-lived container that just sleeps;
    // we exec into it. Mount nothing — the container's own FS is the box's disk
    // (persists while the container exists). Full root inside, `apk` works.
    const engine = strategy;
    try { execSync(`${engine} pull ${ALPINE_IMAGE}`, { stdio: 'ignore', timeout: 180000 }); } catch (_) {}
    const cname = 'wormgpt_' + id.replace(/[^a-z0-9_]/gi, '');
    // --privileged gives full root + lets the agent install/run anything (docker
    // requires root inside for some tasks); on podman rootless it's ignored but
    // harmless. We keep it alive with a sleep loop.
    const runArgs = [
      'run', '-d', '--name', cname,
      '--hostname', 'wormgpt-sandbox',
      '-w', WORKDIR,
    ];
    // Best-effort privilege for heavy tasks; fall back without it if it fails.
    const privArgs = ['--privileged'];
    const runCmd = [ALPINE_IMAGE, '/bin/sh', '-c', `mkdir -p ${WORKDIR}; while true; do sleep 3600; done`];
    let started = false;
    for (const extra of [privArgs, []]) {
      const r = spawnSync(engine, [...runArgs, ...extra, ...runCmd], { encoding: 'utf8' });
      if (r.status === 0) { started = true; break; }
    }
    if (!started) throw new Error(`${engine} could not start the Alpine sandbox container`);
    _setBoxMeta(id, { strategy, engine, cname, hostWork, state: 'running' });
    // Install the toolchain inside the container once (background-ish, bounded).
    await exec(id, `apk update >/dev/null 2>&1; apk add --no-cache ${APK_TOOLCHAIN} >/dev/null 2>&1 || true; command -v bash >/dev/null 2>&1 && echo OK`, { timeout: 900 }).catch(() => {});
    return id;
  }

  if (strategy === 'wsl') {
    // Use a per-box directory inside the Alpine WSL distro's filesystem.
    const boxHome = `/root/wormgpt-boxes/${id}`;
    _setBoxMeta(id, { strategy, boxHome, hostWork, state: 'running' });
    await exec(id, `mkdir -p ${boxHome}/work; apk add --no-cache ${APK_TOOLCHAIN} >/dev/null 2>&1 || true; echo OK`, { timeout: 900 }).catch(() => {});
    return id;
  }

  if (strategy === 'proot' || strategy === 'chroot') {
    // Shared Alpine rootfs, but each box gets its OWN /root/work bind-mounted
    // from a per-box host dir so their files are isolated + persist on the host.
    await _ensureRootfs();
    _setBoxMeta(id, { strategy, rootfs: rootfsDir(), hostWork, state: 'running' });
    await exec(id, `mkdir -p ${WORKDIR}; echo OK`, { timeout: 60 }).catch(() => {});
    return id;
  }

  // bare fallback — the host machine's shell scoped to hostWork acts as the box.
  _setBoxMeta(id, { strategy: 'bare', hostWork, state: 'running' });
  return id;
}

async function deleteSandbox(id) {
  if (!id) return;
  const meta = _boxMeta(id);
  if (!meta) return;
  try {
    if (meta.strategy === 'docker' || meta.strategy === 'podman') {
      spawnSync(meta.engine, ['rm', '-f', meta.cname], { encoding: 'utf8' });
    }
  } catch (_) {}
  try { if (meta.hostWork && fs.existsSync(meta.hostWork)) fs.rmSync(meta.hostWork, { recursive: true, force: true }); } catch (_) {}
  _setBoxMeta(id, null);
}

async function getSandboxState(id) {
  if (!id) return null;
  const meta = _boxMeta(id);
  if (!meta) return null;
  if (meta.strategy === 'docker' || meta.strategy === 'podman') {
    try {
      const r = spawnSync(meta.engine, ['inspect', '-f', '{{.State.Running}}', meta.cname], { encoding: 'utf8' });
      if (r.status !== 0) return null; // container gone
      return /true/i.test(r.stdout || '') ? 'running' : 'stopped';
    } catch (_) { return null; }
  }
  // proot/chroot/wsl/bare boxes are "running" as long as their host dir exists.
  return (meta.hostWork && fs.existsSync(meta.hostWork)) ? 'running' : null;
}

async function startSandbox(id) {
  const meta = _boxMeta(id);
  if (!meta) return false;
  if (meta.strategy === 'docker' || meta.strategy === 'podman') {
    try {
      const r = spawnSync(meta.engine, ['start', meta.cname], { encoding: 'utf8' });
      return r.status === 0;
    } catch (_) { return false; }
  }
  return (meta.hostWork && fs.existsSync(meta.hostWork));
}

async function pauseSandbox(id) {
  const meta = _boxMeta(id);
  if (!meta) return false;
  if (meta.strategy === 'docker' || meta.strategy === 'podman') {
    try { spawnSync(meta.engine, ['stop', meta.cname], { encoding: 'utf8' }); return true; } catch (_) { return false; }
  }
  return true; // nothing to pause for user-space boxes
}
const suspendSandbox = pauseSandbox;

// ── Persistent session helpers (parity with cloud backends) ──────────────────
async function getSessionSandboxId(sessionKey) {
  if (!sessionKey) return null;
  return _sessionMap()[String(sessionKey)] || null;
}

async function getOrCreateSessionSandbox(sessionKey, { envVars = {}, labels = {} } = {}) {
  if (!sessionKey) {
    const id = await createSandbox({ envVars, labels });
    return { id, reused: false };
  }
  const existing = await getSessionSandboxId(sessionKey);
  if (existing) {
    const state = await getSandboxState(existing);
    if (state === 'running') return { id: existing, reused: true };
    if (state === 'stopped') { const ok = await startSandbox(existing); if (ok) return { id: existing, reused: true }; }
    // dead → forget + recreate
    _setSessionId(sessionKey, '');
    _setBoxMeta(existing, null);
  }
  const id = await createSandbox({ envVars, labels });
  _setSessionId(sessionKey, id);
  return { id, reused: false };
}

async function endSession(sessionKey) {
  if (!sessionKey) return;
  const existing = await getSessionSandboxId(sessionKey);
  if (existing) await deleteSandbox(existing);
  _setSessionId(sessionKey, '');
}

// ── The core: run a command inside the box ───────────────────────────────────
// Returns { exitCode, output } (stdout+stderr merged) — the SAME contract the
// cloud backends return, so sandboxAgent/agentEngine are unchanged.
function exec(id, command, { cwd = WORKDIR, timeout = 120 } = {}) {
  return new Promise((resolve) => {
    const meta = _boxMeta(id);
    if (!meta) return resolve({ exitCode: 1, output: '[localSandbox] unknown box id' });

    const wrapped = cwd ? `cd ${_shq(cwd)} 2>/dev/null; ${command}` : command;
    let bin, args, useHostCwd = null;

    if (meta.strategy === 'docker' || meta.strategy === 'podman') {
      bin = meta.engine;
      args = ['exec', '-i', meta.cname, '/bin/sh', '-lc', wrapped];
    } else if (meta.strategy === 'wsl') {
      // Run inside the Alpine WSL distro. Map the box's work dir under boxHome.
      const inner = cwd ? `cd ${_shq(cwd.replace(WORKDIR, meta.boxHome + '/work'))} 2>/dev/null; ${command}` : command;
      bin = 'wsl';
      args = ['-d', 'alpine', '/bin/sh', '-lc', inner];
    } else if (meta.strategy === 'proot') {
      // Fake-root Alpine chroot with the box's host work dir bound at /root/work.
      bin = 'proot';
      args = ['-0', '-r', meta.rootfs,
        '-b', '/proc', '-b', '/sys', '-b', '/dev',
        '-b', `${meta.hostWork}:${WORKDIR}`,
        '-w', HOME, '/bin/sh', '-lc', wrapped];
    } else if (meta.strategy === 'chroot') {
      // Real chroot (root only). Bind the box work dir via mount --bind first.
      try { execSync(`mkdir -p ${_shq(path.join(meta.rootfs, 'root', 'work'))}; mountpoint -q ${_shq(path.join(meta.rootfs, 'root', 'work'))} || mount --bind ${_shq(meta.hostWork)} ${_shq(path.join(meta.rootfs, 'root', 'work'))}`, { stdio: 'ignore' }); } catch (_) {}
      bin = 'chroot';
      args = [meta.rootfs, '/bin/sh', '-lc', wrapped];
    } else {
      // bare — run on the host shell. The box's host dir represents the box
      // HOME (/root), so any /root/* path maps under it (work dir, agent dir,
      // etc.). This keeps the worker (installed at /root/agent) and its work dir
      // (/root/work) on the same consistent host filesystem.
      const mapPath = (abs) => (String(abs).startsWith(HOME)
        ? path.join(meta.hostWork, String(abs).slice(HOME.length).replace(/^\/+/, ''))
        : String(abs));
      const hostCwd = cwd ? mapPath(cwd) : meta.hostWork;
      try { fs.mkdirSync(hostCwd, { recursive: true }); } catch (_) {}
      // Translate absolute /root references inside the command too.
      const cmdMapped = String(command).split(HOME).join(meta.hostWork);
      bin = process.platform === 'win32' ? 'powershell' : '/bin/sh';
      args = process.platform === 'win32'
        ? ['-NoProfile', '-Command', cmdMapped]
        : ['-lc', cmdMapped];
      useHostCwd = hostCwd;
    }

    let out = '';
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd: useHostCwd || undefined });
    } catch (e) {
      return resolve({ exitCode: 1, output: '[localSandbox] spawn error: ' + e.message });
    }
    const to = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch (_) {} out += `\n[timed out after ${timeout}s]`; } }, (Math.max(5, timeout)) * 1000);
    child.stdout && child.stdout.on('data', d => { out += d.toString(); });
    child.stderr && child.stderr.on('data', d => { out += d.toString(); });
    child.on('close', (code) => { done = true; clearTimeout(to); resolve({ exitCode: typeof code === 'number' ? code : 0, output: out.trim() || '(no output)' }); });
    child.on('error', (e) => { done = true; clearTimeout(to); resolve({ exitCode: 1, output: '[localSandbox] ' + e.message }); });
  });
}

function _shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ── File operations (binary-safe) ────────────────────────────────────────────
// We move bytes in/out of the box WITHOUT depending on a remote API: for
// docker/podman we use `cp`; for proot/chroot/wsl/bare the box's work dir is a
// real host directory (or bind-mounted), so we read/write it directly.

function _boxWorkHostPath(meta, destPath) {
  // Map an in-box absolute path to its host location when the box filesystem is
  // a plain host dir (proot/chroot/bare). Returns null otherwise.
  if (!destPath) return null;
  const p = String(destPath);
  if (meta.strategy === 'bare') {
    // Already a real host path under (or equal to) the box dir → use as-is
    // (prevents double-nesting when a shell `ls` handed back a host path).
    if (p.startsWith(meta.hostWork)) return p;
    // In bare mode the box's host dir IS the box's HOME (/root), so /root/work,
    // /root/agent, etc. all map under it. Anything else stages under it too.
    if (p.startsWith(HOME)) return path.join(meta.hostWork, p.slice(HOME.length).replace(/^\/+/, ''));
    return path.join(meta.hostWork, p.replace(/^\/+/, ''));
  }
  // proot/chroot: only /root/work is bound to the host dir.
  if (p.startsWith(WORKDIR)) return path.join(meta.hostWork, p.slice(WORKDIR.length).replace(/^\/+/, ''));
  return null;
}

async function uploadFile(id, destPath, buffer, _filename = 'file') {
  const meta = _boxMeta(id);
  if (!meta) throw new Error('[localSandbox] unknown box id');
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (meta.strategy === 'docker' || meta.strategy === 'podman') {
    // Write to a host temp file then `cp` into the container.
    const tmp = path.join(os.tmpdir(), 'lsb_' + crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(tmp, data);
    const dir = _posixDirname(destPath);
    await exec(id, `mkdir -p ${_shq(dir)}`, { timeout: 30 });
    const r = spawnSync(meta.engine, ['cp', tmp, `${meta.cname}:${destPath}`], { encoding: 'utf8' });
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (r.status !== 0) throw new Error('cp into container failed: ' + (r.stderr || ''));
    return destPath;
  }

  const hostPath = _boxWorkHostPath(meta, destPath);
  if (hostPath) {
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, data);
    return destPath;
  }

  // wsl / non-work paths → base64 pipe into the box.
  const b64 = data.toString('base64');
  const dir = _posixDirname(destPath);
  await exec(id, `mkdir -p ${_shq(dir)}`, { timeout: 30 });
  // chunk to stay within arg limits
  await exec(id, `: > ${_shq(destPath)}.b64`, { timeout: 30 });
  const CHUNK = 60000;
  for (let i = 0; i < b64.length; i += CHUNK) {
    const part = b64.slice(i, i + CHUNK);
    await exec(id, `printf %s ${_shq(part)} >> ${_shq(destPath)}.b64`, { timeout: 60 });
  }
  await exec(id, `base64 -d ${_shq(destPath)}.b64 > ${_shq(destPath)} && rm -f ${_shq(destPath)}.b64`, { timeout: 60 });
  return destPath;
}

async function downloadFile(id, srcPath) {
  const meta = _boxMeta(id);
  if (!meta) throw new Error('[localSandbox] unknown box id');

  if (meta.strategy === 'docker' || meta.strategy === 'podman') {
    const tmp = path.join(os.tmpdir(), 'lsb_' + crypto.randomBytes(6).toString('hex'));
    const r = spawnSync(meta.engine, ['cp', `${meta.cname}:${srcPath}`, tmp], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('cp from container failed: ' + (r.stderr || ''));
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return buf;
  }

  const hostPath = _boxWorkHostPath(meta, srcPath);
  if (hostPath && fs.existsSync(hostPath)) return fs.readFileSync(hostPath);

  // wsl / non-work paths → base64 pipe out of the box.
  const r = await exec(id, `base64 ${_shq(srcPath)} 2>/dev/null`, { timeout: 120 });
  return Buffer.from((r.output || '').replace(/\s+/g, ''), 'base64');
}

async function listFiles(id, dir = WORKDIR) {
  const r = await exec(id, `ls -la --time-style=+%s ${_shq(dir)} 2>/dev/null`, { timeout: 30 });
  const lines = (r.output || '').split('\n').slice(1); // skip "total"
  const out = [];
  for (const ln of lines) {
    const parts = ln.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const perms = parts[0];
    const name = parts.slice(6).join(' ');
    if (!name || name === '.' || name === '..') continue;
    out.push({
      name,
      size: parseInt(parts[4], 10) || 0,
      isDir: perms.startsWith('d'),
      modTime: (parseInt(parts[5], 10) || 0) * 1000,
    });
  }
  return out;
}

function _posixDirname(p) { const s = String(p || ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); }

// ── Docker-in-the-box (parity with cloud backends) ───────────────────────────
// Inside a LOCAL Alpine box the agent can already use the host's docker/podman
// if the box IS a container (docker exec) or run apk-installed podman. We
// install podman inside the box so docker_run works uniformly.
const DIND_SENTINEL = `${HOME}/.dind_ready`;
async function dockerSetup(id, { onStep } = {}) {
  const probe = await exec(id, `test -f ${DIND_SENTINEL} && command -v podman >/dev/null 2>&1 && echo READY || echo MISSING`, { timeout: 30 }).catch(() => null);
  if (probe && /READY/.test(probe.output || '')) {
    const v = await exec(id, 'podman --version 2>/dev/null', { timeout: 20 }).catch(() => null);
    return { ok: true, version: (v && v.output || '').trim(), log: 'already configured' };
  }
  if (onStep) onStep('🐳 setting up podman inside the local Alpine sandbox…');
  const setup = `set +e; apk add --no-cache podman buildah fuse-overlayfs >/dev/null 2>&1; ` +
    `ln -sf /usr/bin/podman /usr/local/bin/docker 2>/dev/null; touch ${DIND_SENTINEL}; podman --version`;
  const r = await exec(id, setup, { timeout: 300 });
  const ok = /podman version/i.test(r.output || '');
  return { ok, version: ((r.output || '').match(/podman version [^\n]+/i) || [''])[0], log: (r.output || '').slice(-1500) };
}

async function dockerRun(id, dockerArgs, { timeout = 280 } = {}) {
  return exec(id, `podman ${dockerArgs} 2>&1 || docker ${dockerArgs} 2>&1`, { timeout });
}

// ── Admin "Test" button (never throws) ───────────────────────────────────────
async function testKey() {
  _resetCaps();
  const strategy = _pickStrategy();
  const caps = _capabilities();
  const detail = Object.entries(caps).filter(([, v]) => v === true).map(([k]) => k).join(', ') || 'none';
  try {
    const { id } = await getOrCreateSessionSandbox('__test__' + Date.now(), {});
    const r = await exec(id, 'echo LOCAL_SANDBOX_OK && uname -a && (cat /etc/alpine-release 2>/dev/null || echo "no alpine-release") && (command -v bash python3 node git sqlite3 2>/dev/null | tr "\\n" " ")', { timeout: 120 });
    await deleteSandbox(id);
    const ok = /LOCAL_SANDBOX_OK/.test(r.output || '');
    return {
      ok,
      status: ok ? 200 : 500,
      message: ok
        ? `✅ Local Alpine sandbox working via "${strategy}" (capabilities: ${detail}).\n${(r.output || '').replace('LOCAL_SANDBOX_OK', '').trim().slice(0, 400)}`
        : `❌ Local sandbox test failed (strategy=${strategy}). Output: ${(r.output || '').slice(0, 300)}`,
    };
  } catch (e) {
    return { ok: false, status: 0, message: `❌ Local sandbox error (strategy=${strategy}): ${e.message}` };
  }
}

// ── Worker path resolution (strategy-aware) ──────────────────────────────────
// The in-sandbox agent worker (agent.py) needs to know WHERE its work dir and
// inbox/outbox/bridge live. For isolated strategies (docker/podman/wsl/proot/
// chroot) those are the normal in-box paths under /root. For the 'bare'
// fallback the worker runs as a raw host process, so its AGENT_WORK must be the
// REAL host directory (there is no /root remap for the worker's own filesystem
// access). boxPaths() returns the correct set for the box's strategy.
function boxPaths(id) {
  const meta = _boxMeta(id) || {};
  // Logical in-box paths (always /root/...). For isolated strategies these are
  // literal. For 'bare' they are VIRTUAL: exec()/uploadFile()/downloadFile()
  // transparently map any /root/* path to the box's host dir, so callers use
  // the SAME /root paths on every strategy. `realWork`/`realWorkerDir` expose
  // the underlying HOST path — needed ONLY to set the bare worker's AGENT_WORK
  // (the worker runs as a raw host process there and can't see the virtual /root).
  const P = {
    strategy: meta.strategy || 'docker',
    bare: meta.strategy === 'bare',
    HOME, WORK: WORKDIR, WORKER_DIR: `${HOME}/agent`,
    INBOX: `${WORKDIR}/.agent_inbox`,
    OUTBOX: `${WORKDIR}/.agent_outbox`,
    BRIDGE_DIR: `${WORKDIR}/.agent_bridge`,
  };
  if (meta.strategy === 'bare' && meta.hostWork) {
    P.realHome = meta.hostWork;
    P.realWork = path.join(meta.hostWork, 'work');
    P.realWorkerDir = path.join(meta.hostWork, 'agent');
    try { fs.mkdirSync(P.realWork, { recursive: true }); fs.mkdirSync(P.realWorkerDir, { recursive: true }); } catch (_) {}
  }
  return P;
}

module.exports = {
  enabled, enabledAsync, WORKDIR, home: HOME,
  createSandbox, deleteSandbox,
  getSandboxState, startSandbox, pauseSandbox, suspendSandbox,
  getOrCreateSessionSandbox, endSession, getSessionSandboxId,
  exec, uploadFile, downloadFile, listFiles,
  getApiKey, invalidateKeyCache, testKey,
  dockerSetup, dockerRun,
  // extras used by the desktop local host / admin
  _pickStrategy, _capabilities, _ensureRootfs, dataDir, boxPaths,
};
