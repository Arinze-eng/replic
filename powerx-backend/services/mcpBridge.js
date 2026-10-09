// ─────────────────────────────────────────────────────────────────────────────
// services/mcpBridge.js — Model Context Protocol (MCP) stdio client + session pool
//
// Wires the bundled local MCP servers (mcp_servers/*.py) into the WormGPT agent
// as first-class HOST tools, so the LLM can SEE and USE them. Implements the MCP
// JSON-RPC 2.0 handshake over stdio (initialize → notifications/initialized →
// tools/list → tools/call) with ZERO extra npm dependencies — just Node's
// built-in child_process. Sessions are POOLED and reused across calls (per the
// mcp-tool-integration skill: one live subprocess per server, reused for every
// tool call) so we never pay the spawn cost twice and never leak processes.
//
// PRIORITY SERVERS (the ones the user asked to wire FIRST so the LLM sees them):
//   • sequential-thinking  → think_step / think_sequence / get_sequence / …
//   • filesystem           → read_file / write_file / list_directory / …
// Bonus servers also exposed via the generic mcp_call tool: git, github, fetch,
// websearch, sqlite.
//
// Everything is best-effort and resilient: a missing python / mcp lib / server
// crash becomes a recoverable text observation, never a hard crash of the agent.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Where the bundled python MCP servers live (repo-root/mcp_servers).
const MCP_DIR = path.join(__dirname, '..', 'mcp_servers');

// Which python interpreter to launch the stdio servers with.
const PYTHON_BIN = process.env.MCP_PYTHON || process.env.PYTHON_BIN || 'python3';

// Resolve the workspace root the MCP filesystem server is restricted to. The
// server is denied any access to the host project tree, including the backend
// source code, .env files, and database credentials. The root lives under the
// system temp dir unless explicitly overridden; it is created on demand and
// exists only for the lifetime of the agent's task.
function _forbiddenRoots() {
  const roots = [];
  const project = path.resolve(__dirname, '..');
  try { roots.push(fs.realpathSync.native(project)); } catch (_) { roots.push(project); }
  return roots;
}

function _defaultMcpRoot() {
  const tmp = require('os').tmpdir();
  const root = path.join(tmp, `agent-mcp-root-${process.pid}`);
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return root;
}

function _resolveDefaultRoot() {
  const explicit = (process.env.MCP_FS_ROOT || '').trim();
  if (explicit) {
    const candidate = path.resolve(explicit);
    const forbidden = _forbiddenRoots();
    const real = (() => { try { return fs.realpathSync.native(candidate); } catch (_) { return candidate; } })();
    for (const bad of forbidden) {
      if (real === bad || real.startsWith(bad + path.sep)) {
        // eslint-disable-next-line no-console
        console.warn(`[mcpBridge] MCP_FS_ROOT points to a forbidden host directory (${real}); falling back to a temp workspace to prevent agent access to internal files.`);
        return _defaultMcpRoot();
      }
    }
    try { fs.mkdirSync(real, { recursive: true }); } catch (_) {}
    return real;
  }
  return _defaultMcpRoot();
}

const DEFAULT_MCP_FS_ROOT = _resolveDefaultRoot();

// Registry of the servers we ship. `key` is the stable id the agent uses; the
// priority flag marks the two the user explicitly wants surfaced as dedicated
// top-level tools (sequential_thinking + mcp_filesystem).
const SERVERS = {
  'sequential-thinking': { file: 'sequential_thinking_server.py', priority: true,
    label: 'Sequential Thinking', desc: 'structured step-by-step reasoning sequences' },
  filesystem: {
    file: 'filesystem_server.py',
    priority: true,
    label: 'Filesystem',
    desc: 'read / write / list / move / copy / delete files & directories inside the agent workspace only',
    cwd: DEFAULT_MCP_FS_ROOT,
  },
  git: { file: 'git_server.py', label: 'Git', desc: 'git status/log/diff/branch/commit/clone operations' },
  github: { file: 'github_server.py', label: 'GitHub', desc: 'GitHub repo / issue / PR operations' },
  fetch: { file: 'fetch_server.py', label: 'Fetch', desc: 'HTTP fetch of a URL → text' },
  websearch: { file: 'websearch_server.py', label: 'Web Search', desc: 'keyless web search' },
  sqlite: { file: 'sqlite_server.py', label: 'SQLite', desc: 'query a local SQLite database' },
};

// ── Session pool ────────────────────────────────────────────────────────────
// One live MCP session per server key, reused for every tool call in the
// process lifetime. Each session keeps the python subprocess alive, holds the
// pending JSON-RPC request map, and buffers stdout for newline-delimited frames.
const _pool = new Map(); // key -> Session

const MCP_AVAILABLE = (() => {
  try { return fs.existsSync(MCP_DIR); } catch (_) { return false; }
})();

class Session {
  constructor(key, file) {
    this.key = key;
    this.file = file;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve,reject,timer}
    this.ready = null;        // Promise resolved after initialize handshake
    this.tools = null;        // cached tools/list result
    this.dead = false;
  }

  _spawn() {
    const serverPath = path.join(MCP_DIR, this.file);
    if (!fs.existsSync(serverPath)) {
      throw new Error(`MCP server file not found: ${this.file}`);
    }
    const meta = SERVERS[this.key] || {};
    const proc = spawn(PYTHON_BIN, [serverPath], {
      cwd: meta.cwd || path.join(MCP_DIR, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // Restrict the filesystem server to its declared workspace. The server
        // honours MCP_FS_ROOT when set; we pass it explicitly so the spawned
        // subprocess cannot fall back to the wider host filesystem.
        MCP_FS_ROOT: meta.cwd || DEFAULT_MCP_FS_ROOT,
        MCP_FS_STRICT: '1',
      },
    });
    this.proc = proc;
    proc.stdout.on('data', (d) => this._onData(d));
    proc.stderr.on('data', () => { /* MCP servers log to stderr; ignore for protocol */ });
    proc.on('exit', () => { this._fail(new Error(`MCP server "${this.key}" exited`)); });
    proc.on('error', (e) => { this._fail(e); });
  }

  _fail(err) {
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch (_) {}
    }
    this.pending.clear();
    if (_pool.get(this.key) === this) _pool.delete(this.key);
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; } // skip non-JSON log lines
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  _send(obj) {
    if (!this.proc || this.dead) throw new Error(`MCP session "${this.key}" not alive`);
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP "${this.key}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: '2.0', id, method, params: params || {} }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  _notify(method, params) {
    try { this._send({ jsonrpc: '2.0', method, params: params || {} }); } catch (_) {}
  }

  // Lazy: spawn + MCP initialize handshake, once, cached as `this.ready`.
  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this._spawn();
      await this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wormgpt-agent', version: '1.0.0' },
      }, 30000);
      this._notify('notifications/initialized', {});
      return true;
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async listTools() {
    await this.init();
    if (this.tools) return this.tools;
    const res = await this._request('tools/list', {}, 30000);
    this.tools = (res && res.tools) || [];
    return this.tools;
  }

  async callTool(toolName, args, timeoutMs) {
    await this.init();
    const res = await this._request('tools/call',
      { name: toolName, arguments: args || {} }, timeoutMs || 120000);
    // MCP returns { content: [{type:'text', text:'...'}], isError? }
    const parts = (res && res.content) || [];
    const text = parts.map((p) => (p && (p.text != null ? p.text : JSON.stringify(p)))).join('\n');
    return { text: text || '(no content)', isError: !!(res && res.isError) };
  }
}

function _getSession(key) {
  const meta = SERVERS[key];
  if (!meta) throw new Error(`Unknown MCP server "${key}". Valid: ${Object.keys(SERVERS).join(', ')}`);
  let s = _pool.get(key);
  if (!s || s.dead) { s = new Session(key, meta.file); _pool.set(key, s); }
  return s;
}

// ── Public API ────────────────────────────────────────────────────────────

// List the tools advertised by ONE server (discovery — never assume tool names).
async function listTools(serverKey) {
  const s = _getSession(serverKey);
  return s.listTools();
}

// Call a tool on a server. Resilient: any failure → recoverable text, not a throw.
async function call(serverKey, toolName, args, timeoutMs) {
  if (!MCP_AVAILABLE) {
    return `[mcp:${serverKey}] MCP servers directory missing on host — cannot call ${toolName}.`;
  }
  try {
    const s = _getSession(serverKey);
    const { text, isError } = await s.callTool(toolName, args, timeoutMs);
    const head = `[mcp:${serverKey}.${toolName}]${isError ? ' (tool error)' : ''}`;
    return `${head}\n${text}`;
  } catch (e) {
    return `[mcp:${serverKey}.${toolName}] failed: ${e.message}. ` +
      `This is an observation, not the end — fix the args, try a different MCP tool, ` +
      `or fall back to a built-in tool (run_code / read_file / write_file).`;
  }
}

// Human-readable catalog of every server's advertised tools (best-effort).
// Used by the agent's mcp_call discovery and for diagnostics.
async function catalog() {
  const out = {};
  for (const key of Object.keys(SERVERS)) {
    try {
      const tools = await listTools(key);
      out[key] = { label: SERVERS[key].label, ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description || '' })) };
    } catch (e) {
      out[key] = { label: SERVERS[key].label, ok: false, error: e.message, tools: [] };
    }
  }
  return out;
}

// Tear down every pooled session (used on shutdown / tests).
function shutdownAll() {
  for (const [, s] of _pool) { try { s.proc && s.proc.kill(); } catch (_) {} }
  _pool.clear();
}

module.exports = {
  SERVERS, MCP_AVAILABLE, MCP_DIR, DEFAULT_MCP_FS_ROOT,
  listTools, call, catalog, shutdownAll,
};
