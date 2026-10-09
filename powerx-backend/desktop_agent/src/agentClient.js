// agentClient.js — the network brain of the WormGPT Desktop Coding Agent.
//
// This is a THIN NATIVE CLIENT to the already-deployed WormGPT backend. ALL the
// heavy lifting (Alpine Linux sandbox, preinstalled tools like bash/sqlite/grep/
// edit/write/requests, on-demand package installs, OCR, PDF/DOCX reading, audio
// transcription, long heavy multi-step coding, "think"/skills, credit draining,
// and the upgrade paywall) is done SERVER-SIDE by the HotBot/Gemini/racers
// FUSION brain running in the in-house sandbox. We just:
//   1. authenticate with the SAME email/password the user made on the website
//   2. POST tasks to /api/agent/run (fusion mode) and stream the SSE reply
//   3. surface steps, the live screen, produced files, and the draining credit
//      balance to the renderer
//   4. read task history from /api/agent/job/:id
//
// Runs in the Electron MAIN process (full Node networking + fs), so SSE, large
// file uploads/downloads, and long-running tasks all work reliably on Windows
// and Linux.

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Base URL of the live backend (Render). Overridable via env for self-hosting.
const DEFAULT_BASE = process.env.WORMGPT_API_BASE || 'https://hackerx-v7-d5s4.onrender.com';

class AgentClient {
  constructor({ baseUrl } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.token = null;
    this.user = null;
    // Stable client id so the server can scope this desktop install's sandbox
    // session (per-user isolation) and dedupe activity.
    this.clientId = null;
  }

  setBaseUrl(u) {
    if (u && String(u).trim()) this.baseUrl = String(u).trim().replace(/\/+$/, '');
  }

  setSession({ token, user, clientId } = {}) {
    if (token !== undefined) this.token = token;
    if (user !== undefined) this.user = user;
    if (clientId) this.clientId = clientId;
  }

  _headers(extra = {}) {
    const h = {
      'X-Client-Platform': 'desktop',
      ...extra,
    };
    if (this.token) h['Authorization'] = 'Bearer ' + this.token;
    if (this.clientId) h['X-Client-Id'] = this.clientId;
    return h;
  }

  _u(pathname) {
    return new URL(this.baseUrl + pathname);
  }

  // ── Low-level JSON request ────────────────────────────────────────────────
  _requestJson(method, pathname, body, { timeoutMs = 45000 } = {}) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = this._u(pathname); } catch (e) { return reject(e); }
      const lib = u.protocol === 'http:' ? http : https;
      const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
      const headers = this._headers({ Accept: 'application/json' });
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      const req = lib.request(
        u,
        { method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
            resolve({ status: res.statusCode, data, text });
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  async login({ email, password }) {
    const { status, data } = await this._requestJson('POST', '/api/auth/login', {
      email: String(email || '').trim(),
      password: String(password || ''),
    });
    if (status === 200 && data && data.ok && data.token) {
      this.token = String(data.token);
      this.user = data.user || null;
      return { ok: true, token: this.token, user: this.user };
    }
    throw new Error((data && data.error) ? data.error : `Login failed (${status}).`);
  }

  async signup({ email, password, username }) {
    const { status, data } = await this._requestJson('POST', '/api/auth/signup', {
      email: String(email || '').trim(),
      password: String(password || ''),
      username: String(username || '').trim(),
      // Desktop installs get a stable per-machine device id (anti-loot parity
      // with web/APK). This is a random-but-persisted id from the store.
      device_id: this.clientId || crypto.randomUUID(),
    });
    if (status === 200 && data && data.ok && data.token) {
      this.token = String(data.token);
      this.user = data.user || null;
      return { ok: true, token: this.token, user: this.user };
    }
    throw new Error((data && data.error) ? data.error : `Signup failed (${status}).`);
  }

  async me() {
    if (!this.token) return { ok: false };
    const { status, data } = await this._requestJson('GET', '/api/auth/me', null);
    if (status === 401 || status === 403) {
      this.token = null; this.user = null;
      return { ok: false, expired: true };
    }
    if (status === 200 && data && data.user) {
      this.user = data.user;
      return { ok: true, user: data.user };
    }
    return { ok: false };
  }

  logout() {
    this.token = null;
    this.user = null;
  }

  // ── Multipart body builder (for /api/agent/run) ─────────────────────────────
  // Builds a multipart/form-data body with the task, history, and any attached
  // files read from disk. Returns { body: Buffer, contentType: string }.
  _buildMultipart({ task, history, files = [], mode }) {
    const boundary = '----WormGPTDesktop' + crypto.randomBytes(16).toString('hex');
    const parts = [];
    const push = (buf) => parts.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'));

    const field = (name, value) => {
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
      push(String(value));
      push('\r\n');
    };

    field('task', task || '');
    field('history', JSON.stringify(Array.isArray(history) ? history.slice(-10) : []));
    // Fusion / uncensored mode → in-house HotBot/Gemini/racers brain + our own
    // Alpine sandbox (X5 credit rate). This is the requested behaviour.
    field('mode', mode || 'fusion');
    field('client_msg_id', crypto.randomUUID());

    for (const f of files) {
      let buf;
      try { buf = fs.readFileSync(f.path); } catch (_) { continue; }
      const fname = (f.name || path.basename(f.path)).replace(/"/g, '');
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="files"; filename="${fname}"\r\n`);
      push(`Content-Type: application/octet-stream\r\n\r\n`);
      push(buf);
      push('\r\n');
    }

    push(`--${boundary}--\r\n`);
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  // ── Run a coding task (SSE streaming) ───────────────────────────────────────
  // Calls onEvent(eventName, payload) for every SSE event:
  //   start | job | step | screen | done | error
  // Returns a handle with .abort() so the UI can cancel a run. Resolves when
  // the stream ends. Rejects only on a hard connection error.
  runAgent({ task, history = [], files = [], mode = 'fusion' }, onEvent) {
    const emit = (ev, payload) => { try { onEvent && onEvent(ev, payload); } catch (_) {} };
    const { body, contentType } = this._buildMultipart({ task, history, files, mode });

    let u;
    try { u = this._u('/api/agent/run'); } catch (e) { return { promise: Promise.reject(e), abort() {} }; }
    const lib = u.protocol === 'http:' ? http : https;

    const headers = this._headers({
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      Accept: 'text/event-stream',
    });

    let req;
    const promise = new Promise((resolve, reject) => {
      req = lib.request(u, { method: 'POST', headers }, (res) => {
        // A non-2xx before any SSE means a hard error (e.g. 401/500).
        if (res.statusCode && res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let msg = `HTTP ${res.statusCode}`;
            try { const j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (_) { if (text) msg += ': ' + text.slice(0, 200); }
            if (res.statusCode === 401 || res.statusCode === 403) { this.token = null; this.user = null; }
            emit('error', { error: msg, httpStatus: res.statusCode });
            resolve({ ended: true });
          });
          return;
        }

        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) {
            let ev = null, dataLine = null;
            for (const line of p.split('\n')) {
              if (line.startsWith('event:')) ev = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLine = (dataLine == null ? '' : dataLine + '\n') + line.slice(5).trim();
            }
            if (!ev) continue;
            let payload = {};
            try { payload = dataLine ? JSON.parse(dataLine) : {}; } catch (_) { payload = { raw: dataLine }; }
            emit(ev, payload);
          }
        });
        res.on('end', () => { resolve({ ended: true }); });
        res.on('error', (e) => { emit('error', { error: e.message || 'Stream error' }); resolve({ ended: true }); });
      });
      req.on('error', (e) => {
        emit('error', { error: e.message || 'Connection failed' });
        resolve({ ended: true });
      });
      // Long tasks: allow up to 20 min of quiet before we give up (the server
      // sends 15s keep-alive pings, so this only trips on a truly dead socket).
      req.setTimeout(20 * 60 * 1000, () => { /* keep-alive covers this; do not kill */ });
      req.write(body);
      req.end();
    });

    return {
      promise,
      abort() { try { req && req.destroy(); } catch (_) {} },
    };
  }

  // ── Task history ────────────────────────────────────────────────────────────
  // Fetch a single durable job (steps + files + final message).
  async getJob(jobId) {
    const { status, data } = await this._requestJson('GET', '/api/agent/job/' + encodeURIComponent(jobId), null);
    if (status === 200 && data && data.ok) return { ok: true, job: data.job };
    return { ok: false, error: (data && data.error) || `HTTP ${status}` };
  }

  // ── Download a produced file to disk ─────────────────────────────────────────
  // A file object is { name, url?, b64? }. Prefers the durable hosted URL, falls
  // back to inline base64. Writes to destPath. Resolves { ok, path }.
  downloadFile(file, destPath) {
    return new Promise((resolve, reject) => {
      try {
        if (file && file.b64) {
          fs.writeFileSync(destPath, Buffer.from(file.b64, 'base64'));
          return resolve({ ok: true, path: destPath });
        }
        if (file && file.url) {
          const u = new URL(file.url);
          const lib = u.protocol === 'http:' ? http : https;
          const req = lib.get(u, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error('Download failed: HTTP ' + res.statusCode));
            }
            const out = fs.createWriteStream(destPath);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve({ ok: true, path: destPath })));
            out.on('error', reject);
          });
          req.on('error', reject);
          req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
          return;
        }
        reject(new Error('File has no url or inline data.'));
      } catch (e) { reject(e); }
    });
  }
}

module.exports = { AgentClient, DEFAULT_BASE };
