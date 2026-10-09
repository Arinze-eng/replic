// preload.js — secure bridge between the sandboxed renderer and the main process.
// Exposes a minimal, explicit `window.wormgpt` API. No Node globals leak to the
// page (contextIsolation is on, nodeIntegration is off).

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wormgpt', {
  // session / config
  getSession: () => ipcRenderer.invoke('session:get'),
  setBaseUrl: (url) => ipcRenderer.invoke('config:setBaseUrl', url),

  // 🖥️ local Alpine sandbox controls
  getLocalMode: () => ipcRenderer.invoke('local:get'),
  setLocalMode: (enabled) => ipcRenderer.invoke('local:set', enabled),
  probeLocal: () => ipcRenderer.invoke('local:probe'),

  // auth
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  signup: (email, password, username) => ipcRenderer.invoke('auth:signup', { email, password, username }),
  me: () => ipcRenderer.invoke('auth:me'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // files
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  saveFile: (file) => ipcRenderer.invoke('files:save', { file }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // agent run (streaming)
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  abortAgent: (runId) => ipcRenderer.invoke('agent:abort', { runId }),
  onAgentEvent: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },

  // history
  listHistory: () => ipcRenderer.invoke('history:list'),
  saveHistory: (entry) => ipcRenderer.invoke('history:save', entry),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  getJob: (jobId) => ipcRenderer.invoke('history:job', { jobId }),
});
