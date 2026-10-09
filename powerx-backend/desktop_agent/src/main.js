// main.js — Electron main process for the WormGPT Desktop Coding Agent.
//
// Responsibilities:
//   • create the app window (secure: contextIsolation on, nodeIntegration off)
//   • persist the session (JWT + user + a stable client id) via electron-store
//   • bridge the renderer <-> AgentClient over IPC (login/signup/run/history/…)
//   • stream SSE agent events to the renderer as they arrive
//   • handle "save file" dialogs for produced artifacts
//
// The renderer is a plain HTML/CSS/JS UI (no framework, no build step) so the
// app stays small and packages cleanly to .exe (NSIS) and .deb.

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Store = require('electron-store');
const { AgentClient, DEFAULT_BASE } = require('./agentClient');

const store = new Store({ name: 'wormgpt-session' });
const client = new AgentClient({ baseUrl: store.get('baseUrl') || DEFAULT_BASE });

// 🖥️ LOCAL ALPINE SANDBOX — the desktop app runs heavy coding tasks in a LOCAL
// Alpine Linux sandbox on THIS machine (no cloud sandbox). Point the sandbox
// data dir at Electron's userData so the rootfs/box state persists per install,
// and mark this process as a desktop client for the local backend. `localHost`
// is loaded lazily (after these env vars are set) so it picks them up.
try {
  process.env.LOCAL_SANDBOX = '1';
  if (!process.env.LOCAL_SANDBOX_DATA_DIR) {
    process.env.LOCAL_SANDBOX_DATA_DIR = path.join(app.getPath('userData'), 'sandbox');
  }
} catch (_) {}
let localHost = null;
function getLocalHost() {
  if (!localHost) localHost = require('./localHost');
  return localHost;
}
// Whether to run tasks in the LOCAL sandbox (default true) or fall back to the
// server's cloud sandbox. User-toggleable + persisted.
function localModeEnabled() {
  const v = store.get('localSandbox');
  return v === undefined ? true : !!v;
}

// Restore a persisted session on boot.
(function restoreSession() {
  let clientId = store.get('clientId');
  if (!clientId) { clientId = crypto.randomUUID(); store.set('clientId', clientId); }
  client.setSession({
    token: store.get('token') || null,
    user: store.get('user') || null,
    clientId,
  });
})();

let win = null;
// Track active runs so the renderer can abort them.
const activeRuns = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0b0e14',
    title: 'WormGPT Coding Agent',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open external links (upgrade page, hosted files) in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: session / config ─────────────────────────────────────────────────────
ipcMain.handle('session:get', () => ({
  baseUrl: client.baseUrl,
  loggedIn: !!client.token,
  user: client.user,
  localSandbox: localModeEnabled(),
}));

// 🖥️ Local sandbox controls.
ipcMain.handle('local:get', () => ({ enabled: localModeEnabled() }));
ipcMain.handle('local:set', (_e, enabled) => {
  store.set('localSandbox', !!enabled);
  return { ok: true, enabled: !!enabled };
});
ipcMain.handle('local:probe', async () => {
  try { return await getLocalHost().probe(); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:setBaseUrl', (_e, url) => {
  client.setBaseUrl(url);
  store.set('baseUrl', client.baseUrl);
  return { ok: true, baseUrl: client.baseUrl };
});

// ── IPC: auth ─────────────────────────────────────────────────────────────────
ipcMain.handle('auth:login', async (_e, { email, password }) => {
  try {
    const r = await client.login({ email, password });
    store.set('token', client.token);
    store.set('user', client.user);
    return { ok: true, user: r.user };
  } catch (e) {
    return { ok: false, error: e.message || 'Login failed.' };
  }
});

ipcMain.handle('auth:signup', async (_e, { email, password, username }) => {
  try {
    const r = await client.signup({ email, password, username });
    store.set('token', client.token);
    store.set('user', client.user);
    return { ok: true, user: r.user };
  } catch (e) {
    return { ok: false, error: e.message || 'Signup failed.' };
  }
});

ipcMain.handle('auth:me', async () => {
  try {
    const r = await client.me();
    if (r.ok) { store.set('user', client.user); }
    else if (r.expired) { store.delete('token'); store.delete('user'); }
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:logout', () => {
  client.logout();
  store.delete('token');
  store.delete('user');
  return { ok: true };
});

// ── IPC: file picker ────────────────────────────────────────────────────────
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Attach files (images, PDF, DOCX, audio, code…)',
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return { ok: true, files: [] };
  const files = r.filePaths.map((p) => ({ name: path.basename(p), path: p }));
  return { ok: true, files };
});

// ── IPC: run a coding task (streams events back to the renderer) ──────────────
// 🖥️ When LOCAL sandbox mode is on (default), the task runs in a LOCAL Alpine
// sandbox on THIS machine via localHost — the fusion brain + host tools still
// come from the server (metered), but the shell/computer is local. When local
// mode is off, we fall back to the server's cloud sandbox over SSE.
ipcMain.handle('agent:run', async (e, { runId, task, history, files, mode }) => {
  const send = (ev, payload) => {
    try { e.sender.send('agent:event', { runId, ev, payload }); } catch (_) {}
  };

  if (localModeEnabled()) {
    // Read attachment bytes from disk (renderer only passes {name, path}).
    const attachments = [];
    for (const f of (files || [])) {
      try {
        const buf = f.path ? fs.readFileSync(f.path) : (f.b64 ? Buffer.from(f.b64, 'base64') : null);
        if (buf) attachments.push({ name: f.name || path.basename(f.path || 'file'), buffer: buf });
      } catch (_) {}
    }
    const controller = { aborted: false };
    activeRuns.set(runId, { abort() { controller.aborted = true; } });
    try {
      await getLocalHost().runLocalTask({
        task,
        history: history || [],
        files: attachments,
        sessionKey: 'desktop:' + (client.clientId || 'local'),
        baseUrl: client.baseUrl,
        token: client.token,
        clientId: client.clientId,
        systemPrompt: '__DEFAULT__',
        onEvent: (ev, payload) => {
          if (controller.aborted) return;
          // Map local 'terminal' events into the same step feed the renderer
          // already understands (as a monospace block) so no renderer change is
          // strictly required, while newer renderers can handle 'terminal'.
          if (ev === 'terminal' && payload && Array.isArray(payload.lines)) {
            send('terminal', payload);
            send('step', { note: '🖥️ ' + payload.lines.join('\n').slice(0, 1500) });
            return;
          }
          send(ev, payload);
        },
      });
    } catch (err) {
      send('error', { error: (err && err.message) || 'Local sandbox run failed' });
    } finally {
      activeRuns.delete(runId);
      send('_end', {});
    }
    return { ok: true };
  }

  // Cloud fallback (server SSE).
  const handle = client.runAgent(
    { task, history, files, mode: mode || 'fusion' },
    (ev, payload) => send(ev, payload)
  );
  activeRuns.set(runId, handle);
  try {
    await handle.promise;
  } finally {
    activeRuns.delete(runId);
    send('_end', {});
  }
  return { ok: true };
});

ipcMain.handle('agent:abort', (_e, { runId }) => {
  const h = activeRuns.get(runId);
  if (h) { try { h.abort(); } catch (_) {} activeRuns.delete(runId); }
  return { ok: true };
});

// ── IPC: task history ─────────────────────────────────────────────────────────
ipcMain.handle('history:list', () => {
  const items = store.get('history') || [];
  return { ok: true, items };
});

ipcMain.handle('history:save', (_e, entry) => {
  const items = store.get('history') || [];
  items.unshift(entry);
  // Keep the most recent 100 tasks locally.
  store.set('history', items.slice(0, 100));
  return { ok: true };
});

ipcMain.handle('history:clear', () => {
  store.set('history', []);
  return { ok: true };
});

ipcMain.handle('history:job', async (_e, { jobId }) => {
  try { return await client.getJob(jobId); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: download a produced file ─────────────────────────────────────────────
ipcMain.handle('files:save', async (_e, { file }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save file',
    defaultPath: path.join(app.getPath('downloads'), file.name || 'file'),
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    await client.downloadFile(file, r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return { ok: true };
});
