// ─────────────────────────────────────────────────────────────────────────────
// enterpriseTools.js — Host-side enterprise tool definitions for the agent.
//
// These tools are registered with the agent engine (agentEngine.js) so the
// ReAct loop can call them directly. They mirror the sandbox tools but run
// on the host or proxy to the sandbox via the tool registry.
//
// Each tool follows the same contract: async (args, ctx) and returns a STRING
// observation. Files are delivered via ctx.deliverBuffer / ctx.addFile.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const agentIsolation = require('./agentIsolation');

// ── Helpers ──────────────────────────────────────────────────────────────────
function safeName(name, fallback) {
  let n = String(name || fallback || 'file').replace(/[^\w.\-]/g, '_');
  if (!n) n = fallback || 'file';
  return n;
}

function runShell(cmd, cwd, timeout = 60) {
  return new Promise((resolve) => {
    const blocked = agentIsolation.guardAgentSource(cmd);
    if (blocked) return resolve({ exitCode: 126, output: `[blocked] ${blocked}` });
    exec(cmd, {
      timeout: timeout * 1000,
      maxBuffer: 20 * 1024 * 1024,
      cwd: cwd || process.cwd(),
      env: agentIsolation.safeChildEnv(),
    }, (err, stdout, stderr) => {
      let out = stdout || '';
      if (stderr) out += (out ? '\n' : '') + stderr;
      if (err && err.killed) out += '\n[timed out]';
      else if (err) out += `\n[exit ${err.code || '?'}]`;
      resolve({ exitCode: err ? (err.code || 1) : 0, output: (out || '(no output)') });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: glob — find files matching a pattern
// ─────────────────────────────────────────────────────────────────────────────
async function toolGlob(args, ctx) {
  const pattern = args.pattern || '**/*';
  const baseDir = args.base_dir || '.';
  // Use the sandbox's glob if available, else host-side
  if (ctx.fsx && typeof ctx.fsx.list === 'function') {
    const files = await ctx.fsx.list();
    const fnmatch = (name, pat) => {
      // Simple glob match (works for flat patterns)
      const re = new RegExp('^' + pat.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
      return re.test(name);
    };
    const matches = files.filter(f => fnmatch(f.rel, pattern));
    const out = matches.map(f => `  - ${f.rel} (${f.size}b)`).join('\n');
    return `[glob] ${matches.length} file(s) matching "${pattern}":\n${out.slice(0, 6000)}`;
  }
  return `[glob] ${pattern}: ${args.base_dir || '(workdir)'} (no sandbox fsx)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: grep — search file contents for a regex pattern
// ─────────────────────────────────────────────────────────────────────────────
async function toolGrep(args, ctx) {
  const pattern = args.pattern || '';
  if (!pattern) return '[grep] No pattern. Pass {"pattern":"regex","glob":"*.py"}';
  const globPat = args.glob || '*';
  const maxResults = parseInt(args.max_results, 10) || 100;

  let results = [];
  // Try using the host's grep command if available (fastest)
  try {
    const grepCmd = `grep -rn "${pattern.replace(/"/g, '\\"')}" --include="${globPat}" . 2>/dev/null | head -${maxResults}`;
    const r = await runShell(grepCmd, ctx.workdir || ctx.fsx?.workdir, 30);
    if (r.output && r.output.trim()) {
      const lines = r.output.split('\n').filter(Boolean);
      results = lines.map(l => {
        const parts = l.split(/:(.+)/s);
        return { file: parts[0], match: (parts[1] || '').slice(0, 200) };
      });
    }
  } catch (_) {}

  if (!results.length) return `[grep] No matches for "${pattern}" in ${globPat} files.`;
  const out = results.map(r => `  ${r.file}: ${r.match}`).join('\n');
  return `[grep] ${results.length} match(es) for "${pattern}":\n${out.slice(0, 6000)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: bash — execute shell commands in the sandbox
// ─────────────────────────────────────────────────────────────────────────────
async function toolBash(args, ctx) {
  const command = args.command || '';
  if (!command) return '[bash] No command. Pass {"command":"ls -la"}';
  const blocked = agentIsolation.guardAgentSource(command);
  if (blocked) return `[bash] blocked: ${blocked}`;
  const timeout = Math.max(1, Math.min(parseInt(args.timeout, 10) || 600, 6 * 60 * 60));

  if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
    const r = await ctx.fsx.sh(command, { timeout });
    const out = (r.output || '(no output)').slice(0, 12000);
    const code = r.exitCode ? ` [exit ${r.exitCode}]` : '';
    return `[bash] $ ${command}${code}\n${out}`;
  }
  // Fallback to local exec
  const r = await runShell(command, ctx.workdir, timeout);
  return `[bash] $ ${command} [exit ${r.exitCode}]\n${(r.output || '(no output)').slice(0, 12000)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: gitclone — clone a git repository
// ─────────────────────────────────────────────────────────────────────────────
async function toolGitClone(args, ctx) {
  const url = args.url || '';
  if (!url) return '[gitclone] No URL. Pass {"url":"https://github.com/owner/repo.git"}';
  const dest = args.dest || url.split('/').pop().replace('.git', '');
  const branch = args.branch ? ` --branch ${args.branch}` : '';
  const depth = args.depth ? ` --depth ${args.depth}` : '';

  let cmd = `git clone ${url} ${dest}${branch}${depth} 2>&1`;
  let workdir = ctx.workdir || ctx.fsx?.workdir || process.cwd();
  try {
    const r = await runShell(cmd, workdir, 300);
    // Also try submodules
    await runShell(`cd ${dest} && git submodule update --init --recursive 2>/dev/null`, workdir, 120).catch(() => {});
    return `[gitclone] Cloned ${url} → ${dest}\n${(r.output || '').slice(0, 3000)}`;
  } catch (e) {
    return `[gitclone] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: gitdiff — show git diff of changes
// ─────────────────────────────────────────────────────────────────────────────
async function toolGitDiff(args, ctx) {
  const relPath = args.path || '.';
  const staged = args.staged ? '--cached' : '';
  const files = Array.isArray(args.files) ? ' -- ' + args.files.join(' ') : '';
  let workdir = ctx.workdir || ctx.fsx?.workdir || process.cwd();

  try {
    const stat = await runShell(`git diff ${staged} --stat${files} 2>&1`, workdir, 30);
    const diff = await runShell(`git diff ${staged}${files} 2>&1`, workdir, 30);
    return `[gitdiff] Changed files:\n${(stat.output || '(none)').slice(0, 2000)}\n\nDiff:\n${(diff.output || '(none)').slice(0, 20000)}`;
  } catch (e) {
    return `[gitdiff] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: write — write content to a file (any extension)
// ─────────────────────────────────────────────────────────────────────────────
async function toolWrite(args, ctx) {
  const filePath = args.path || args.filename || '';
  const content = args.content || '';
  if (!filePath) return '[write] No path. Pass {"path":"file.txt","content":"..."}';
  try {
    if (ctx.fsx && typeof ctx.fsx.writeText === 'function') {
      await ctx.fsx.writeText(filePath, content);
      ctx.addFile(filePath, filePath.split('/').pop());
    } else {
      const abs = path.resolve(ctx.workdir || '.', filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      ctx.addFile(filePath, filePath.split('/').pop());
    }
    return `[write] Wrote ${filePath} (${content.length} bytes).`;
  } catch (e) {
    return `[write] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: read — read file content (any extension)
// ─────────────────────────────────────────────────────────────────────────────
async function toolRead(args, ctx) {
  const filePath = args.path || args.filename || '';
  if (!filePath) return '[read] No path. Pass {"path":"file.txt"}';
  const maxLength = parseInt(args.max_length, 10) || 50000;
  try {
    let text;
    if (ctx.fsx && typeof ctx.fsx.readText === 'function') {
      if (!(await ctx.fsx.exists(filePath))) return `[read] File not found: ${filePath}`;
      text = await ctx.fsx.readText(filePath);
    } else {
      const abs = path.resolve(ctx.workdir || '.', filePath);
      if (!fs.existsSync(abs)) return `[read] File not found: ${filePath}`;
      text = fs.readFileSync(abs, 'utf-8');
    }
    const truncated = text.length > maxLength;
    const content = truncated ? text.slice(0, maxLength) + '\n\n...[truncated]' : text;
    return `[read] ${filePath} (${text.length} chars):\n${content}`;
  } catch (e) {
    return `[read] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit — find and replace text in a file (any extension)
// ─────────────────────────────────────────────────────────────────────────────
async function toolEdit(args, ctx) {
  const filePath = args.path || args.filename || '';
  const oldText = args.old_text || '';
  const newText = args.new_text || '';
  const replaceAll = args.replace_all === true || args.replace_all === 'true';

  if (!filePath || !oldText) return '[edit] Pass {"path":"file.txt","old_text":"...","new_text":"..."}';
  try {
    let content;
    if (ctx.fsx && typeof ctx.fsx.readText === 'function') {
      if (!(await ctx.fsx.exists(filePath))) return `[edit] File not found: ${filePath}`;
      content = await ctx.fsx.readText(filePath);
    } else {
      const abs = path.resolve(ctx.workdir || '.', filePath);
      if (!fs.existsSync(abs)) return `[edit] File not found: ${filePath}`;
      content = fs.readFileSync(abs, 'utf-8');
    }

    const count = content.split(oldText).length - 1;
    if (count === 0) return `[edit] Text not found in ${filePath}`;
    const newContent = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);

    if (ctx.fsx && typeof ctx.fsx.writeText === 'function') {
      await ctx.fsx.writeText(filePath, newContent);
    } else {
      fs.writeFileSync(path.resolve(ctx.workdir || '.', filePath), newContent, 'utf-8');
    }
    ctx.addFile(filePath, filePath.split('/').pop());
    return `[edit] Replaced ${replaceAll ? count : 1} occurrence(s) in ${filePath}.`;
  } catch (e) {
    return `[edit] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: coding — heavy code editing (create/edit/refactor any file type)
// ─────────────────────────────────────────────────────────────────────────────
async function toolCoding(args, ctx) {
  const action = args.action || 'create';
  const filePath = args.path || '';
  if (!filePath) return '[coding] No path. Pass {"action":"create","path":"file.py","content":"..."}';

  try {
    if (action === 'create') {
      return await toolWrite({ path: filePath, content: args.content }, ctx);
    }
    if (action === 'search_replace') {
      return await toolEdit({ path: filePath, old_text: args.old_text, new_text: args.new_text, replace_all: true }, ctx);
    }
    if (action === 'read') {
      return await toolRead({ path: filePath, max_length: args.max_length }, ctx);
    }
    if (action === 'format') {
      const ext = filePath.split('.').pop().toLowerCase();
      const formatters = { py: 'black', js: 'prettier', ts: 'prettier', json: 'prettier', md: 'prettier', go: 'gofmt', rs: 'rustfmt' };
      const fmt = formatters[ext];
      if (fmt) {
        let workdir = ctx.workdir || ctx.fsx?.workdir || '.';
        const r = await runShell(`${fmt} ${filePath} 2>&1`, workdir, 30);
        return `[coding] Formatted ${filePath} via ${fmt}:\n${(r.output || '').slice(0, 2000)}`;
      }
      return `[coding] No formatter for .${ext}`;
    }
    return `[coding] Unknown action: ${action}`;
  } catch (e) {
    return `[coding] Error: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: database — execute SQL against SQLite / Postgres / MySQL / Supabase.
//
// Strengthened from a Supabase-only stub into a REAL multi-engine SQL tool so
// the agent can "write a database, read, extract and access anywhere":
//   • SQLite   — {"sql":"…","db":"data.db"}  (a file in the working dir; uses
//                the zero-dependency built-in node:sqlite, so it ALWAYS works,
//                even with no CLI installed). Creates the file if missing.
//   • Postgres — {"sql":"…","url":"postgres://user:pass@host:5432/db"}  (psql)
//   • MySQL    — {"sql":"…","url":"mysql://user:pass@host:3306/db"}       (mysql)
//   • Supabase — {"sql":"…"} with SUPABASE_URL + SUPABASE_SERVICE_KEY set (RPC).
// Any SQL is supported (SELECT/INSERT/UPDATE/CREATE/…). Read queries return
// rows; write queries return the affected-row summary.
// ─────────────────────────────────────────────────────────────────────────────
async function toolDatabase(args, ctx) {
  args = args || {};
  const action = String(args.action || 'query').toLowerCase();
  const sql = String(args.sql || args.query || '').trim();
  if (!sql && !['discover', 'scan', 'find', 'inspect', 'schema', 'tables', 'inspect_all'].includes(action)) {
    return '[database] No SQL. Use {"action":"discover"} first, {"action":"inspect","db":"exact.db"} for schema evidence, or pass SQL for a query.';
  }

  const conn = String(args.url || args.connection || args.dsn || '').trim();
  const dbFile = String(args.db || args.file || args.database || args.sqlite || '').trim();

  // ── 1) Explicit remote connection string (Postgres / MySQL) ───────────────
  if (conn) {
    const isPg = /^postgres(ql)?:\/\//i.test(conn);
    const isMy = /^mysql:\/\//i.test(conn);
    if (isPg || isMy) {
      try {
        const cli = isPg ? 'psql' : 'mysql';
        // Feed the SQL over stdin so quoting is never an issue.
        const heredoc = isPg
          ? `psql "${conn}" -v ON_ERROR_STOP=1 -A -F $'\\t' <<'__SQL__'\n${sql}\n__SQL__`
          : `mysql "${conn.replace(/^mysql:\/\//i, '')}" --batch --raw <<'__SQL__'\n${sql}\n__SQL__`;
        // For MySQL the URL form isn't accepted directly by the CLI on all
        // builds; prefer running through the sandbox exec which has a shell.
        const runCmd = isPg
          ? `bash -lc ${JSON.stringify(heredoc)}`
          : `bash -lc ${JSON.stringify('mysql --batch --raw "$MYSQL_URL_ARGS" <<\'__SQL__\'\n' + sql + '\n__SQL__')}`;
        const out = await runViaCtxOrLocal(ctx, isPg ? runCmd : buildMysqlCmd(conn, sql), 60);
        return `[database] (${cli}) result:\n${String(out).slice(0, 12000)}`;
      } catch (e) {
        return `[database] ${/postgres/i.test(conn) ? 'Postgres' : 'MySQL'} error: ${e.message}`;
      }
    }
    if (/^sqlite:/i.test(conn)) {
      return await runSqlite(ctx, conn.replace(/^sqlite:(\/\/)?/i, '') || 'data.db', sql, args);
    }
  }

  // ── 2) SQLite file / discovery ──────────────────────────────────────────
  // A database action without an explicit remote connection is always scoped to
  // the task workspace. Never infer the application's Supabase credentials from
  // the server environment.
  if (dbFile || args.action || !conn) {
    // A sandbox fsx points at a remote filesystem. Execute the intelligence
    // module THERE; opening /home/... from the Render host would inspect the
    // wrong machine and can create misleading empty databases.
    if (ctx && ctx.fsx && ctx.fsx.kind === 'sandbox' && typeof ctx.fsx.writeText === 'function' && typeof ctx.fsx.sh === 'function') {
      return await runSandboxSqliteIntelligence(ctx, { ...args, db: dbFile || args.db, sql });
    }
    return await runLocalSqliteIntelligence(ctx, { ...args, db: dbFile || args.db, sql });
  }

  // ── 3) Explicit target Supabase connection only ─────────────────────────
  // The service's SUPABASE_* environment variables are intentionally ignored.
  // A target connection must be supplied as tool arguments by the authorized
  // user; it is never inherited from the PowerX server.
  const targetUrl = String(args.supabase_url || args.target_supabase_url || '').trim();
  const targetKey = String(args.service_key || args.supabase_key || args.api_key || '').trim();
  if (targetUrl && targetKey) {
    try {
      const fetch = require('node-fetch');
      const r = await fetch(`${targetUrl.replace(/\/+$/, '')}/rest/v1/rpc/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetKey}`,
          'apikey': targetKey,
        },
        body: JSON.stringify({ query: sql }),
      });
      if (r.ok) {
        const data = await r.json();
        return `[database] (explicit target Supabase) result:\n${JSON.stringify(data, null, 2).slice(0, 10000)}`;
      }
      const text = await r.text().catch(() => '');
      return `[database] Target Supabase HTTP ${r.status}: ${text.slice(0, 500)}`;
    } catch (e) {
      return `[database] Explicit target Supabase error: ${e.message}`;
    }
  }

  return '[database] Refused implicit application-database access. Use an explicit workspace SQLite file (`db`) or provide an authorized target connection in the tool arguments.';
}

// Build a safe MySQL CLI invocation from a mysql:// URL.
function buildMysqlCmd(url, sql) {
  try {
    const u = new URL(url);
    const host = u.hostname || '127.0.0.1';
    const port = u.port || '3306';
    const user = decodeURIComponent(u.username || 'root');
    const pass = decodeURIComponent(u.password || '');
    const dbname = (u.pathname || '').replace(/^\//, '');
    const parts = ['mysql', '-h', host, '-P', port, '-u', user];
    if (pass) parts.push(`-p${pass}`);
    if (dbname) parts.push(dbname);
    parts.push('--batch', '--raw', '-e', sql);
    // Quote each argument.
    return parts.map(p => (/[^\w.\-]/.test(p) ? `'${String(p).replace(/'/g, `'\\''`)}'` : p)).join(' ');
  } catch (_) {
    return `mysql -e ${JSON.stringify(sql)}`;
  }
}

// Split a SQL script into individual statements, respecting single/double
// quoted string literals so semicolons inside strings don't split a statement.
function splitSql(sql) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      cur += c;
      if (c === quote) {
        // handle escaped quote ('' or "")
        if (sql[i + 1] === quote) { cur += sql[++i]; }
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === ';') { const t = cur.trim(); if (t) out.push(t); cur = ''; continue; }
    cur += c;
  }
  const last = cur.trim();
  if (last) out.push(last);
  return out;
}

async function runLocalSqliteIntelligence(ctx, payload) {
  try {
    const helperPath = path.join(__dirname, '..', 'agent_worker', 'database_intelligence.py');
    const workdir = (ctx && (ctx.workdir || (ctx.fsx && ctx.fsx.workdir))) || process.cwd();
    const encoded = Buffer.from(JSON.stringify({ ...(payload || {}), work_dir: workdir }), 'utf8').toString('base64');
    const cmd = `printf %s '${encoded}' | base64 -d | python3 ${JSON.stringify(helperPath)}`;
    const result = await runShell(cmd, workdir, 120);
    return `[database]\n${String(result.output || '').slice(0, 16000)}`;
  } catch (e) {
    return `[database] local SQLite intelligence error: ${e.message}`;
  }
}

async function runSandboxSqliteIntelligence(ctx, payload) {
  try {
    const helperPath = path.join(__dirname, '..', 'agent_worker', 'database_intelligence.py');
    const helper = fs.readFileSync(helperPath, 'utf8');
    await ctx.fsx.writeText('.agent_runtime/database_intelligence.py', helper);
    const encoded = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
    const cmd = `printf %s '${encoded}' | base64 -d | python3 .agent_runtime/database_intelligence.py`;
    const result = await ctx.fsx.sh(cmd);
    const output = String((result && result.output) || '').trim();
    return `[database]\n${output.slice(0, 16000)}`;
  } catch (e) {
    return `[database] sandbox SQLite intelligence error: ${e.message}`;
  }
}

// Run a SQLite query using the built-in node:sqlite (zero external deps). The DB
// file lives in the working dir so it persists across turns in a session and is
// delivered back to the user when created/modified.
async function runSqlite(ctx, dbFile, sql, args) {
  const path = require('path');
  const fs = require('fs');
  const rel = String(dbFile || 'data.db').replace(/[^\w./\-]/g, '_') || 'data.db';
  // Resolve to a real local path. When running host-side with an fsx workdir we
  // materialise the file there; otherwise use cwd.
  let localPath = rel;
  try {
    if (ctx && ctx.fsx && ctx.fsx.workdir) localPath = path.join(ctx.fsx.workdir, rel);
  } catch (_) {}
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (_) { return sqliteViaCli(ctx, rel, sql); }
    const db = new DatabaseSync(localPath);
    // Robustly split into statements on ';' (handles multiple statements on one
    // line). Quotes/semicolons inside string literals are rare in agent SQL; for
    // safety, non-SELECT scripts also get a bulk db.exec() fallback.
    const statements = splitSql(sql);
    const out = [];
    let ranAny = false;
    for (const stmt of statements) {
      const isRead = /^\s*(select|pragma|with|explain)\b/i.test(stmt);
      try {
        if (isRead) {
          const rows = db.prepare(stmt).all();
          out.push(`— ${stmt.slice(0, 60)}\n${JSON.stringify(rows, null, 2).slice(0, 8000)}`);
        } else {
          const info = db.prepare(stmt).run();
          out.push(`— ${stmt.slice(0, 60)}\nOK (changes=${info.changes}, lastInsertRowid=${info.lastInsertRowid})`);
        }
        ranAny = true;
      } catch (e) {
        out.push(`— ${stmt.slice(0, 60)}\nERROR: ${e.message}`);
      }
    }
    // Safety net: if the naive split produced nothing runnable, execute the raw
    // script in one go (node:sqlite supports multi-statement exec).
    if (!ranAny && sql.trim()) {
      try { db.exec(sql); out.push('OK (executed as a multi-statement script)'); }
      catch (e) { out.push(`ERROR: ${e.message}`); }
    }
    db.close();
    // Stage the DB file for delivery so the user gets the created/updated DB.
    try {
      if (ctx && typeof ctx.addFile === 'function') ctx.addFile(rel, path.posix.basename(rel));
      else if (ctx && typeof ctx.deliverBuffer === 'function' && fs.existsSync(localPath)) {
        await ctx.deliverBuffer(path.posix.basename(rel), fs.readFileSync(localPath));
      }
    } catch (_) {}
    return `[database] (sqlite:${rel}) executed ${statements.length} statement(s):\n${out.join('\n\n')}\n\nThe SQLite file "${rel}" is saved in the working dir and delivered.`;
  } catch (e) {
    return sqliteViaCli(ctx, rel, sql);
  }
}

// Fallback SQLite via the sqlite3 CLI (if node:sqlite is unavailable).
async function sqliteViaCli(ctx, rel, sql) {
  try {
    const cmd = `sqlite3 ${JSON.stringify(rel)} <<'__SQL__'\n.mode json\n${sql}\n__SQL__`;
    const out = await runViaCtxOrLocal(ctx, `bash -lc ${JSON.stringify(cmd)}`, 60);
    try { if (ctx && typeof ctx.addFile === 'function') ctx.addFile(rel, rel); } catch (_) {}
    return `[database] (sqlite3:${rel}) result:\n${String(out).slice(0, 12000)}`;
  } catch (e) {
    return `[database] SQLite error: ${e.message}`;
  }
}

// Prefer the sandbox exec (ctx.fsx.exec) so DB work happens in the SAME box as
// the rest of the task; fall back to local host exec.
async function runViaCtxOrLocal(ctx, command, timeoutSec) {
  if (ctx && ctx.fsx && typeof ctx.fsx.exec === 'function') {
    const r = await ctx.fsx.exec(command, { timeout: timeoutSec });
    return (r && (r.output != null ? r.output : (r.stdout || ''))) || '';
  }
  const r = await runShell(command, null, timeoutSec);
  return (r && (r.output != null ? r.output : r)) || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: webshell — start a web shell in the sandbox
// ─────────────────────────────────────────────────────────────────────────────
async function toolWebshell(args, ctx) {
  const port = parseInt(args.port, 10) || 8888;
  const action = args.action || 'start';

  if (action === 'status') {
    return `[webshell] Port ${port}: use bash tool to check if running`;
  }

  if (action === 'start' && ctx.fsx && typeof ctx.fsx.sh === 'function') {
    const r = await ctx.fsx.sh(
      `python3 -c "
import http.server, socketserver, subprocess, json, os, urllib.parse
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/exec?'):
            q = urllib.parse.parse_qs(self.path.split('?')[1])
            cmd = q.get('cmd', [''])[0]
            try:
                r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, cwd=os.environ.get('AGENT_WORK','/tmp'))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'stdout':r.stdout[:5000],'stderr':r.stderr[:1000],'exit_code':r.returncode}).encode())
            except Exception as e:
                self.wfile.write(json.dumps({'error':str(e)}).encode())
        else:
            self.send_response(200)
            self.send_header('Content-Type','text/html')
            self.end_headers()
            self.wfile.write(b'<html><body><h1>Sandbox Web Shell :${port}</h1><form><input name=cmd><input type=submit></form></body></html>')
    def log_message(self, *a): pass
s = socketserver.TCPServer(('0.0.0.0', ${port}), H)
s.serve_forever()
" &
echo "Web shell started on port ${port}"
`
    );
    return `[webshell] ${(r.output || '').slice(0, 500)}`;
  }

  return `[webshell] Action: ${action} on port ${port}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: todo — manage task list
// ─────────────────────────────────────────────────────────────────────────────
async function toolTodo(args, ctx) {
  const action = args.action || 'list';
  const todoFile = '.agent_todos.json';
  let workdir = ctx.workdir || ctx.fsx?.workdir || '.';

  let todos = [];
  try {
    const todoPath = path.resolve(workdir, todoFile);
    if (fs.existsSync(todoPath)) {
      todos = JSON.parse(fs.readFileSync(todoPath, 'utf-8'));
    }
  } catch (_) { todos = []; }

  if (action === 'add') {
    const title = args.title || 'Untitled';
    const priority = args.priority || 'medium';
    todos.push({
      id: Date.now(),
      title,
      status: 'todo',
      priority,
      created_at: new Date().toISOString(),
    });
    fs.writeFileSync(path.resolve(workdir, todoFile), JSON.stringify(todos, null, 2));
    return `[todo] Added: "${title}" (${priority})`;
  }

  if (action === 'list') {
    if (!todos.length) return '[todo] No tasks.';
    const statusFilter = args.status || '';
    const filtered = statusFilter ? todos.filter(t => t.status === statusFilter) : todos;
    const out = filtered.map((t, i) => `  ${i + 1}. [${t.status}] ${t.title} (${t.priority})`).join('\n');
    return `[todo] ${filtered.length} task(s):\n${out}`;
  }

  if (action === 'update') {
    const id = parseInt(args.id, 10);
    const todo = todos.find(t => t.id === id);
    if (!todo) return `[todo] Task ${id} not found.`;
    if (args.status) todo.status = args.status;
    if (args.title) todo.title = args.title;
    if (args.priority) todo.priority = args.priority;
    fs.writeFileSync(path.resolve(workdir, todoFile), JSON.stringify(todos, null, 2));
    return `[todo] Updated task ${id}: ${todo.title} [${todo.status}]`;
  }

  if (action === 'delete') {
    const id = parseInt(args.id, 10);
    const before = todos.length;
    todos = todos.filter(t => t.id !== id);
    if (todos.length < before) {
      fs.writeFileSync(path.resolve(workdir, todoFile), JSON.stringify(todos, null, 2));
      return `[todo] Deleted task ${id}.`;
    }
    return `[todo] Task ${id} not found.`;
  }

  return `[todo] Unknown action: ${action}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: sandbox — sandbox environment info
// ─────────────────────────────────────────────────────────────────────────────
async function toolSandboxInfo(args, ctx) {
  const action = args.action || 'info';

  if (action === 'info') {
    let info = `Work dir: ${ctx.workdir || ctx.fsx?.workdir || 'unknown'}`;
    info += `\nSandbox: ${ctx.fsx?.kind || 'local'}`;
    info += `\nBackend: ${ctx.fsx?.backend || 'host'}`;
    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      const r = await ctx.fsx.sh('uname -a 2>/dev/null | head -1');
      if (r.output) info += `\nOS: ${r.output.trim()}`;
      const m = await ctx.fsx.sh('free -h 2>/dev/null | grep Mem | head -1');
      if (m.output) info += `\nMemory: ${m.output.trim()}`;
      const d = await ctx.fsx.sh('df -h / 2>/dev/null | tail -1');
      if (d.output) info += `\nDisk: ${d.output.trim()}`;
    }
    return `[sandbox] System info:\n${info}`;
  }

  if (action === 'processes' && ctx.fsx?.sh) {
    const r = await ctx.fsx.sh('ps aux --sort=-%cpu | head -30');
    return `[sandbox] Processes:\n${(r.output || '').slice(0, 5000)}`;
  }

  if (action === 'ports' && ctx.fsx?.sh) {
    const r = await ctx.fsx.sh('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null');
    return `[sandbox] Listening ports:\n${(r.output || 'No port info').slice(0, 3000)}`;
  }

  return `[sandbox] Action: ${action}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: documents — PDF, DOCX, PPTX, XLSX conversion/editing via LibreOffice
// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY CONTRACT: Every convert/generate/edit action MUST:
//   1. Produce the output file inside the sandbox work dir
//   2. Read it back via ctx.fsx.downloadBuffer() or fs.readFileSync()
//   3. Call ctx.deliverBuffer(name, buffer) to register it for delivery
//   4. Return the filename and size in the response so the agent knows
//      the file is ready for the user to download
async function toolDocuments(args, ctx) {
  const action = args.action || 'convert';
  const inputPath = args.input_path || '';
  const outputPath = args.output_path || '';
  const outputFormat = args.output_format || '';

  // ── Helper: deliver a file from sandbox or host to the user ───────────────
  async function deliverFile(outRel, desc) {
    const safeName = outRel.split('/').pop().replace(/[^\w.\-]/g, '_');
    let buffer = null;

    // Try sandbox fsx first
    if (ctx.fsx && typeof ctx.fsx.downloadBuffer === 'function') {
      try {
        const exists = await ctx.fsx.exists(outRel).catch(() => true);
        if (exists) {
          buffer = await ctx.fsx.downloadBuffer(outRel);
        }
      } catch (_) {}
    }

    // Fallback to host fs
    if (!buffer && ctx.workdir) {
      const hostPath = path.resolve(ctx.workdir, outRel);
      try {
        if (fs.existsSync(hostPath)) {
          buffer = fs.readFileSync(hostPath);
        }
      } catch (_) {}
    }

    // Fallback to CWD
    if (!buffer) {
      try {
        if (fs.existsSync(outRel)) {
          buffer = fs.readFileSync(outRel);
        }
      } catch (_) {}
    }

    if (!buffer) {
      return `[documents] ${desc} — but could not read output file "${outRel}" for delivery. The file may exist in the sandbox but is not accessible from here.`;
    }

    // Deliver via ctx.deliverBuffer (registers with the agent engine's file delivery)
    if (typeof ctx.deliverBuffer === 'function') {
      try {
        await ctx.deliverBuffer(safeName, buffer);
      } catch (e) {
        return `[documents] ${desc} — deliverBuffer error: ${e.message}`;
      }
    }

    // Also register via addFile if available
    if (typeof ctx.addFile === 'function') {
      try { ctx.addFile(outRel, safeName); } catch (_) {}
    }

    return `[documents] ${desc} ✅ Delivered "${safeName}" (${(buffer.length / 1024).toFixed(1)} KB). The file is ready for download.`;
  }

  // ── Helper: run a shell command in the sandbox and return stdout ──────────
  async function sandboxExec(cmd, timeout = 120) {
    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      return ctx.fsx.sh(cmd, { timeout });
    }
    const r = await runShell(cmd, ctx.workdir || '.', timeout);
    return { output: r.output, exitCode: r.exitCode };
  }

  // ── CONVERT ──────────────────────────────────────────────────────────────
  if (action === 'convert') {
    if (!inputPath) return '[documents] No input_path. Pass {"input_path":"file.docx","output_format":"pdf"}';

    const out = outputPath || inputPath.replace(/\.\w+$/, '.' + outputFormat);
    const outDir = path.dirname(out);

    // Ensure output directory exists
    await sandboxExec(`mkdir -p "${outDir}" 2>/dev/null; true`, 15);

    // Try LibreOffice in sandbox first
    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      const r = await ctx.fsx.sh(
        `libreoffice --headless --convert-to ${outputFormat} --outdir "${outDir}" "${inputPath}" 2>&1`,
        { timeout: 120 }
      );
      const stdout = r.output || '';
      const err = r.stderr || '';

      // LibreOffice may name the file differently — find the actual output
      const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
      const possibleOut = path.join(outDir, base + '.' + outputFormat);
      // Check if the exact output path exists, or if LibreOffice named it differently
      const checkCmd = `ls -la "${out}" 2>/dev/null || ls -la "${possibleOut}" 2>/dev/null || echo "NOT_FOUND"`;
      const check = await ctx.fsx.sh(checkCmd, { timeout: 15 });
      const actualOut = check.output && !check.output.includes('NOT_FOUND') ? true : false;

      let resultMsg = `LibreOffice: ${stdout.slice(0, 500)}`;
      if (err && !err.includes('javaldx')) resultMsg += `\nStderr: ${err.slice(0, 300)}`;

      // If the file was produced with a different name, use that
      const actualPath = (await ctx.fsx.exists(out).catch(() => false)) ? out : possibleOut;

      return await deliverFile(actualPath, `Converted ${inputPath} → ${outputFormat}.\n${resultMsg}`);
    }

    // Host-side fallback
    const r = await runShell(
      `libreoffice --headless --convert-to ${outputFormat} --outdir "${outDir}" "${inputPath}" 2>&1`,
      ctx.workdir || '.', 120
    );
    return await deliverFile(out, `Converted ${inputPath} → ${outputFormat} (host).\n${(r.output || '').slice(0, 500)}`);
  }

  // ── GENERATE ─────────────────────────────────────────────────────────────
  if (action === 'generate') {
    const format = outputFormat || (outputPath ? outputPath.split('.').pop() : 'docx');
    const out = outputPath || `output.${format}`;
    const title = args.title || 'Document';
    const content = args.content || '';
    const data = args.data || {};
    const slides = args.slides || [];

    // Write a Python script to the sandbox that generates the document
    // Use base64 to avoid shell escaping issues with special characters
    const pyCode = generatePythonScript(format, title, content, data, slides, out);
    const pyCodeB64 = Buffer.from(pyCode).toString('base64');

    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      // Write the Python script via base64 to avoid all escaping issues
      await ctx.fsx.sh(`printf '%s' "${pyCodeB64}" | base64 -d > /tmp/gen_doc.py 2>&1`, { timeout: 15 });
      const r = await ctx.fsx.sh('python3 /tmp/gen_doc.py 2>&1', { timeout: 60 });
      const stdout = r.output || '';
      const err = r.stderr || '';

      if (err && !err.includes('javaldx') && !err.includes('UserWarning')) {
        // Check if the file was actually created despite stderr
        const exists = await ctx.fsx.exists(out).catch(() => false);
        if (!exists) {
          return `[documents] Generation failed.\nStdout: ${stdout.slice(0, 500)}\nStderr: ${err.slice(0, 500)}`;
        }
      }

      return await deliverFile(out, `Generated ${format}: "${title}"\n${stdout.slice(0, 500)}`);
    }

    // Host-side fallback — write script to temp file and run
    const tmpScript = path.join('/tmp', `gen_doc_${Date.now()}.py`);
    try {
      fs.writeFileSync(tmpScript, pyCode, 'utf-8');
      const r = await runShell(`python3 "${tmpScript}" 2>&1`, ctx.workdir || '.', 60);
      return await deliverFile(out, `Generated ${format}: "${title}" (host)\n${(r.output || '').slice(0, 500)}`);
    } finally {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
  }

  // ── INSPECT ──────────────────────────────────────────────────────────────
  if (action === 'inspect') {
    if (!inputPath) return '[documents] No input_path for inspect';
    const ext = inputPath.split('.').pop().toLowerCase();

    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      let cmd;
      if (ext === 'pdf') {
        cmd = `python3 -c "
import fitz, json
d=fitz.open('${inputPath.replace(/'/g, "\\'")}')
print('Pages:', len(d))
print('Metadata:', json.dumps(d.metadata, default=str))
for i in range(min(3, len(d))):
    t = d[i].get_text()[:500]
    if t.strip(): print(f'Page {i+1} text:', t[:200])
d.close()
" 2>&1`;
      } else if (ext === 'docx') {
        cmd = `python3 -c "
from docx import Document
d=Document('${inputPath.replace(/'/g, "\\'")}')
print('Paragraphs:', len(d.paragraphs))
print('Tables:', len(d.tables))
for p in d.paragraphs[:15]:
    if p.text.strip(): print(p.text[:200])
" 2>&1`;
      } else if (ext === 'pptx') {
        cmd = `python3 -c "
from pptx import Presentation
prs=Presentation('${inputPath.replace(/'/g, "\\'")}')
print('Slides:', len(prs.slides))
for i,s in enumerate(prs.slides[:5]):
    texts=[sh.text for sh in s.shapes if sh.has_text_frame]
    print(f'Slide {i+1}:', ' | '.join(texts)[:300])
" 2>&1`;
      } else if (ext === 'xlsx' || ext === 'xls') {
        cmd = `python3 -c "
import openpyxl
wb=openpyxl.load_workbook('${inputPath.replace(/'/g, "\\'")}', data_only=True)
print('Sheets:', wb.sheetnames)
ws=wb.active
print('Rows:', ws.max_row, 'Cols:', ws.max_column)
for i,row in enumerate(ws.iter_rows(values_only=True)):
    if i>10: break
    print([str(c)[:30] if c else '' for c in row])
" 2>&1`;
      } else {
        cmd = `ls -la "${inputPath.replace(/"/g, '\\"')}" 2>&1; file "${inputPath.replace(/"/g, '\\"')}" 2>&1`;
      }
      const r = await ctx.fsx.sh(cmd, { timeout: 30 });
      return `[documents] Inspect ${inputPath}:\n${(r.output || '').slice(0, 5000)}`;
    }

    // Host-side
    if (ctx.workdir) {
      const hostPath = path.resolve(ctx.workdir, inputPath);
      if (fs.existsSync(hostPath)) {
        const stat = fs.statSync(hostPath);
        return `[documents] Inspect ${inputPath}: ${(stat.size / 1024).toFixed(1)} KB, modified ${stat.mtime.toISOString()}`;
      }
    }
    return `[documents] Inspect: ${inputPath} (file not accessible)`;
  }

  // ── EXTRACT TEXT ─────────────────────────────────────────────────────────
  if (action === 'extract_text') {
    if (!inputPath) return '[documents] No input_path for extract_text';
    const ext = inputPath.split('.').pop().toLowerCase();

    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      let cmd;
      if (ext === 'pdf') {
        cmd = `python3 -c "
import fitz
d=fitz.open('${inputPath.replace(/'/g, "\\'")}')
for i in range(min(20, len(d))):
    print(d[i].get_text()[:2000])
d.close()
" 2>&1`;
      } else if (ext === 'docx') {
        cmd = `python3 -c "
from docx import Document
d=Document('${inputPath.replace(/'/g, "\\'")}')
print('\\n'.join(p.text for p in d.paragraphs[:100]))
" 2>&1`;
      } else if (ext === 'pptx') {
        cmd = `python3 -c "
from pptx import Presentation
prs=Presentation('${inputPath.replace(/'/g, "\\'")}')
for s in prs.slides:
    for sh in s.shapes:
        if sh.has_text_frame: print(sh.text)
" 2>&1`;
      } else if (ext === 'xlsx' || ext === 'xls') {
        cmd = `python3 -c "
import openpyxl
wb=openpyxl.load_workbook('${inputPath.replace(/'/g, "\\'")}', data_only=True)
for sn in wb.sheetnames:
    ws=wb[sn]
    print(f'=== {sn} ===')
    for row in ws.iter_rows(values_only=True):
        print('\\t'.join(str(c) if c else '' for c in row))
" 2>&1`;
      } else {
        cmd = `head -c 10000 "${inputPath.replace(/"/g, '\\"')}" 2>&1`;
      }
      const r = await ctx.fsx.sh(cmd, { timeout: 30 });
      return `[documents] Text from ${inputPath}:\n${(r.output || '').slice(0, 10000)}`;
    }
    return `[documents] Extract text: ${inputPath} (sandbox fsx needed)`;
  }

  // ── EDIT ─────────────────────────────────────────────────────────────────
  if (action === 'edit') {
    if (!inputPath) return '[documents] Edit: no input_path';
    const replacements = args.replacements || {};
    const replaceCount = Object.keys(replacements).length;
    if (replaceCount === 0 && !args.content) {
      return '[documents] Edit: provide replacements or content';
    }

    const out = outputPath || inputPath;
    const ext = inputPath.split('.').pop().toLowerCase();

    // Use the Python sandbox tool for editing
    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      const pyCode = `
import json, os, sys
input_path = '${inputPath.replace(/'/g, "\\'")}'
output_path = '${out.replace(/'/g, "\\'")}'
replacements = ${JSON.stringify(replacements)}
ext = input_path.split('.')[-1].lower()

with open(input_path, 'r', encoding='utf-8', errors='replace') as f:
    text = f.read()

changes = 0
for old, new in replacements.items():
    c = text.count(old)
    if c:
        text = text.replace(old, new)
        changes += c

with open(output_path, 'w', encoding='utf-8') as f:
    f.write(text)

print(f'Replaced {changes} occurrences')
print(f'Output: {output_path}')
print(f'Size: {os.path.getsize(output_path)} bytes')
`;
      const b64 = Buffer.from(pyCode).toString('base64');
      await ctx.fsx.sh(`printf '%s' "${b64}" | base64 -d > /tmp/edit_doc.py 2>&1`, { timeout: 15 });
      const r = await ctx.fsx.sh('python3 /tmp/edit_doc.py 2>&1', { timeout: 30 });
      return await deliverFile(out, `Edited ${inputPath} → ${out}.\n${(r.output || '').slice(0, 500)}`);
    }
    return `[documents] Edit: ${inputPath} (sandbox fsx needed)`;
  }

  // ── MERGE ────────────────────────────────────────────────────────────────
  if (action === 'merge') {
    const files = args.files || [];
    if (!files.length) return '[documents] Merge: provide files array';
    const out = outputPath || 'merged.pdf';
    const filesJson = JSON.stringify(files);

    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      const pyCode = `
import json, os
files = ${filesJson}
output = '${out.replace(/'/g, "\\'")}'
try:
    import fitz
    merged = fitz.open()
    for f in files:
        doc = fitz.open(f)
        merged.insert_pdf(doc)
        doc.close()
    merged.save(output)
    merged.close()
    print(f'Merged {len(files)} files into {output}')
    print(f'Size: {os.path.getsize(output)} bytes')
except ImportError:
    print('PyMuPDF not available')
`;
      const b64 = Buffer.from(pyCode).toString('base64');
      await ctx.fsx.sh(`printf '%s' "${b64}" | base64 -d > /tmp/merge_docs.py 2>&1`, { timeout: 15 });
      const r = await ctx.fsx.sh('python3 /tmp/merge_docs.py 2>&1', { timeout: 60 });
      if (r.output && r.output.includes('Merged')) {
        return await deliverFile(out, `Merged ${files.length} files into ${out}.\n${(r.output || '').slice(0, 500)}`);
      }
      return `[documents] Merge result:\n${(r.output || '').slice(0, 2000)}`;
    }
    return '[documents] Merge: sandbox fsx needed';
  }

  // ── SPLIT ────────────────────────────────────────────────────────────────
  if (action === 'split') {
    if (!inputPath) return '[documents] Split: no input_path';
    const startPage = parseInt(args.start_page, 10) || 1;
    const endPage = args.end_page ? parseInt(args.end_page, 10) : null;
    const out = outputPath || inputPath.replace(/\.(\w+)$/, '_split.$1');

    if (ctx.fsx && typeof ctx.fsx.sh === 'function') {
      const end = endPage ? `to_page=${endPage}` : 'to_page=None';
      const pyCode = `
import os
input_path = '${inputPath.replace(/'/g, "\\'")}'
output = '${out.replace(/'/g, "\\'")}'
start = ${startPage}
end = ${endPage || 'None'}
try:
    import fitz
    doc = fitz.open(input_path)
    total = len(doc)
    end = end or total
    if start < 1 or end > total:
        print(f'Range {start}-{end} out of bounds (1-{total})')
    else:
        new_doc = fitz.open()
        new_doc.insert_pdf(doc, from_page=start-1, to_page=end-1)
        new_doc.save(output)
        new_doc.close()
        doc.close()
        print(f'Split pages {start}-{end} from {total} → {output}')
        print(f'Size: {os.path.getsize(output)} bytes')
except ImportError:
    print('PyMuPDF not available')
`;
      const b64 = Buffer.from(pyCode).toString('base64');
      await ctx.fsx.sh(`printf '%s' "${b64}" | base64 -d > /tmp/split_doc.py 2>&1`, { timeout: 15 });
      const r = await ctx.fsx.sh('python3 /tmp/split_doc.py 2>&1', { timeout: 60 });
      if (r.output && r.output.includes('Split pages')) {
        return await deliverFile(out, `Split pages ${startPage}${endPage ? '-' + endPage : '+'} from ${inputPath}.\n${(r.output || '').slice(0, 500)}`);
      }
      return `[documents] Split result:\n${(r.output || '').slice(0, 2000)}`;
    }
    return '[documents] Split: sandbox fsx needed';
  }

  return `[documents] Unknown action: "${action}". Valid: convert, generate, edit, inspect, extract_text, merge, split.`;
}


// ── Helper: generate Python script for document creation ─────────────────────
// Uses base64 encoding to avoid all shell escaping issues
function generatePythonScript(format, title, content, data, slides, outputPath) {
  const lines = ['#!/usr/bin/env python3', 'import os, sys, json', ''];

  if (format === 'docx') {
    lines.push('from docx import Document');
    lines.push('from docx.shared import Inches, Pt');
    lines.push('doc = Document()');
    lines.push(`doc.add_heading(${JSON.stringify(title)}, 0)`);
    lines.push('');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('## ')) {
        lines.push(`doc.add_heading(${JSON.stringify(t.slice(3).trim())}, 2)`);
      } else if (t.startsWith('### ')) {
        lines.push(`doc.add_heading(${JSON.stringify(t.slice(4).trim())}, 3)`);
      } else if (t.startsWith('- ')) {
        lines.push(`doc.add_paragraph(${JSON.stringify(t.slice(2).trim())}, style='List Bullet')`);
      } else if (t) {
        lines.push(`doc.add_paragraph(${JSON.stringify(t)})`);
      }
    }
    // Add table if data has rows
    if (data && data.rows && data.rows.length > 0) {
      const rows = data.rows;
      const cols = data.columns || [];
      lines.push(`table = doc.add_table(rows=${1 + rows.length}, cols=${cols.length || rows[0].length})`);
      lines.push("table.style = 'Table Grid'");
      for (let i = 0; i < cols.length; i++) {
        lines.push(`table.cell(0, ${i}).text = ${JSON.stringify(String(cols[i]))}`);
      }
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          lines.push(`table.cell(${i + 1}, ${j}).text = ${JSON.stringify(String(rows[i][j]))}`);
        }
      }
    }
    lines.push(`doc.save(${JSON.stringify(outputPath)})`);
    lines.push(`print('Generated: ${outputPath}')`);
    lines.push(`print('Size:', os.path.getsize(${JSON.stringify(outputPath)}), 'bytes')`);

  } else if (format === 'pptx') {
    lines.push('from pptx import Presentation');
    lines.push('from pptx.util import Inches, Pt');
    lines.push('prs = Presentation()');
    lines.push('prs.slide_width = Inches(13.333)');
    lines.push('prs.slide_height = Inches(7.5)');
    if (!slides || slides.length === 0) {
      slides = [{ title, content }];
    }
    for (const slide of slides) {
      lines.push('slide_layout = prs.slide_layouts[1]');
      lines.push('slide = prs.slides.add_slide(slide_layout)');
      lines.push(`slide.shapes.title.text = ${JSON.stringify(slide.title || '')}`);
      const bullets = slide.bullets || [];
      const slideContent = slide.content || '';
      if (bullets.length > 0) {
        lines.push('body = slide.placeholders[1]');
        lines.push('tf = body.text_frame');
        for (let i = 0; i < bullets.length; i++) {
          if (i === 0) {
            lines.push(`tf.text = ${JSON.stringify(String(bullets[i]))}`);
          } else {
            lines.push(`p = tf.add_paragraph()`);
            lines.push(`p.text = ${JSON.stringify(String(bullets[i]))}`);
          }
        }
      } else if (slideContent) {
        lines.push(`slide.placeholders[1].text = ${JSON.stringify(slideContent)}`);
      }
    }
    lines.push(`prs.save(${JSON.stringify(outputPath)})`);
    lines.push(`print('Generated: ${outputPath}')`);
    lines.push(`print('Slides:', len(prs.slides))`);

  } else if (format === 'xlsx' || format === 'xls') {
    lines.push('import openpyxl');
    lines.push('from openpyxl.styles import Font, PatternFill, Alignment');
    lines.push('wb = openpyxl.Workbook()');
    lines.push('ws = wb.active');
    const sheetName = (data && data.sheet_name) || 'Sheet1';
    lines.push(`ws.title = ${JSON.stringify(sheetName)}`);
    const rows = (data && data.rows) || [];
    const cols = (data && data.columns) || [];
    if (cols.length > 0) {
      lines.push("header_font = Font(bold=True, color='FFFFFF')");
      lines.push("header_fill = PatternFill(start_color='4472C4', end_color='4472C4', fill_type='solid')");
      for (let i = 0; i < cols.length; i++) {
        lines.push(`cell = ws.cell(row=1, column=${i + 1}, value=${JSON.stringify(String(cols[i]))})`);
        lines.push('cell.font = header_font');
        lines.push('cell.fill = header_fill');
        lines.push('cell.alignment = Alignment(horizontal="center")');
      }
    }
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        lines.push(`ws.cell(row=${i + 2}, column=${j + 1}, value=${JSON.stringify(rows[i][j])})`);
      }
    }
    // Auto-width
    lines.push('for col in ws.columns:');
    lines.push('    max_len = 0');
    lines.push("    col_letter = col[0].column_letter");
    lines.push('    for cell in col:');
    lines.push('        try:');
    lines.push('            if cell.value: max_len = max(max_len, len(str(cell.value)))');
    lines.push('        except: pass');
    lines.push('    ws.column_dimensions[col_letter].width = min(max_len + 2, 50)');
    lines.push(`wb.save(${JSON.stringify(outputPath)})`);
    lines.push(`print('Generated: ${outputPath}')`);

  } else if (format === 'pdf') {
    // Use reportlab
    lines.push('from reportlab.lib.pagesizes import A4');
    lines.push('from reportlab.lib.styles import getSampleStyleSheet');
    lines.push('from reportlab.lib.units import cm');
    lines.push('from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer');
    lines.push('doc = SimpleDocTemplate(' + JSON.stringify(outputPath) + ', pagesize=A4,');
    lines.push("    leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)");
    lines.push('styles = getSampleStyleSheet()');
    lines.push('story = []');
    lines.push(`story.append(Paragraph(${JSON.stringify(title)}, styles['Title']))`);
    lines.push('story.append(Spacer(1, 12))');
    for (const line of content.split('\n')) {
      if (line.trim()) {
        lines.push(`story.append(Paragraph(${JSON.stringify(line)}, styles['Normal']))`);
        lines.push('story.append(Spacer(1, 6))');
      }
    }
    lines.push('doc.build(story)');
    lines.push(`print('Generated: ${outputPath}')`);

  } else if (format === 'html') {
    lines.push(`with open(${JSON.stringify(outputPath)}, 'w', encoding='utf-8') as f:`);
    lines.push(`    f.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title.replace(/"/g, '&quot;')}</title></head><body>')`);
    lines.push(`    f.write('<h1>${title.replace(/"/g, '&quot;')}</h1>')`);
    lines.push(`    f.write('<pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '\\x27').replace(/"/g, '&quot;')}</pre>')`);
    lines.push("    f.write('</body></html>')");
    lines.push(`print('Generated: ${outputPath}')`);

  } else {
    // Plain text / markdown fallback
    lines.push(`with open(${JSON.stringify(outputPath)}, 'w', encoding='utf-8') as f:`);
    lines.push(`    f.write(${JSON.stringify(content || title)})`);
    lines.push(`print('Generated: ${outputPath}')`);
  }

  lines.push("print('Done')");
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: upload_file — upload a file to catbox.moe (or tmpfiles.org as fallback)
// and return a shareable URL. Uses native https/http module to avoid fetch deps.
// ─────────────────────────────────────────────────────────────────────────────
async function toolUploadFile(args, ctx) {
  const filePath = args.path || args.file || '';
  const service = args.service || 'catbox'; // catbox, tmpfiles, auto

  if (!filePath) {
    return '[upload_file] No file path. Pass {"path":"output.pdf"} or {"path":"report.docx"}';
  }

  let buffer = null;
  let fileName = filePath.split('/').pop().replace(/[^\w.\-]/g, '_');

  // Try sandbox fsx first
  if (ctx.fsx && typeof ctx.fsx.downloadBuffer === 'function') {
    try {
      const exists = await ctx.fsx.exists(filePath).catch(() => true);
      if (exists) {
        buffer = await ctx.fsx.downloadBuffer(filePath);
      }
    } catch (_) {}
  }

  // Fallback to host fs
  if (!buffer && ctx.workdir) {
    const hostPath = path.resolve(ctx.workdir, filePath);
    try {
      if (fs.existsSync(hostPath)) {
        buffer = fs.readFileSync(hostPath);
      }
    } catch (_) {}
  }

  // Fallback to absolute path
  if (!buffer) {
    try {
      if (fs.existsSync(filePath)) {
        buffer = fs.readFileSync(filePath);
      }
    } catch (_) {}
  }

  if (!buffer) {
    return `[upload_file] Could not read file: ${filePath}. Check the path and try again.`;
  }

  // Upload to catbox.moe
  if (service === 'catbox' || service === 'auto') {
    const url = await uploadToCatbox(buffer, fileName);
    if (url) {
      if (typeof ctx.deliverBuffer === 'function') {
        try { await ctx.deliverBuffer(fileName, buffer); } catch (_) {}
      }
      return `[upload_file] ✅ File uploaded to catbox.moe:\n${url}\n\n📎 Also available in-chat as "${fileName}" (${(buffer.length / 1024).toFixed(1)} KB).`;
    }
  }

  // Fallback to tmpfiles.org
  const url = await uploadToTmpfiles(buffer, fileName);
  if (url) {
    if (typeof ctx.deliverBuffer === 'function') {
      try { await ctx.deliverBuffer(fileName, buffer); } catch (_) {}
    }
    return `[upload_file] ✅ File uploaded to tmpfiles.org:\n${url}\n\n📎 Also available in-chat as "${fileName}" (${(buffer.length / 1024).toFixed(1)} KB).`;
  }

  // Last resort: deliverBuffer only
  if (typeof ctx.deliverBuffer === 'function') {
    try {
      await ctx.deliverBuffer(fileName, buffer);
      return `[upload_file] 📎 Delivered "${fileName}" (${(buffer.length / 1024).toFixed(1)} KB) in-chat.`;
    } catch (e) {
      return `[upload_file] Could not deliver file: ${e.message}`;
    }
  }

  return `[upload_file] Could not upload file. File size: ${(buffer.length / 1024).toFixed(1)} KB. Try a different path.`;
}


// ── Upload helpers (native https, no external deps) ──────────────────────────

function uploadToCatbox(buffer, fileName) {
  return new Promise((resolve) => {
    const https = require('https');
    const boundary = '----' + Date.now().toString(36) + Math.random().toString(36).slice(2);

    const bodyParts = [];
    bodyParts.push('--' + boundary);
    bodyParts.push('Content-Disposition: form-data; name="reqtype"');
    bodyParts.push('');
    bodyParts.push('fileupload');
    bodyParts.push('--' + boundary);
    bodyParts.push('Content-Disposition: form-data; name="fileToUpload"; filename="' + fileName + '"');
    bodyParts.push('Content-Type: application/octet-stream');
    bodyParts.push('');
    bodyParts.push(buffer.toString('binary'));
    bodyParts.push('--' + boundary + '--');
    bodyParts.push('');

    const postData = bodyParts.join('\r\n');

    const options = {
      hostname: 'catbox.moe',
      path: '/user/api.php',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(postData, 'binary'),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const text = data.trim();
        if (text.startsWith('https://')) {
          resolve(text);
        } else {
          console.warn('[uploadToCatbox] unexpected response:', text.slice(0, 200));
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.warn('[uploadToCatbox] error:', e.message); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData, 'binary');
    req.end();
  });
}

function uploadToTmpfiles(buffer, fileName) {
  return new Promise((resolve) => {
    const https = require('https');
    const boundary = '----' + Date.now().toString(36);

    const bodyParts = [];
    bodyParts.push('--' + boundary);
    bodyParts.push('Content-Disposition: form-data; name="file"; filename="' + fileName + '"');
    bodyParts.push('Content-Type: application/octet-stream');
    bodyParts.push('');
    bodyParts.push(buffer.toString('binary'));
    bodyParts.push('--' + boundary + '--');

    const postData = bodyParts.join('\r\n');

    const options = {
      hostname: 'tmpfiles.org',
      path: '/api/v1/upload',
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': Buffer.byteLength(postData, 'binary'),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.data && parsed.data.url) {
            resolve(parsed.data.url);
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData, 'binary');
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: deepseek — probe DeepSeek AI API endpoints
// ─────────────────────────────────────────────────────────────────────────────
async function toolDeepSeek(args, ctx) {
  const action = args.action || 'probe_all';
  const apiKey = args.api_key || '';
  const prompt = args.prompt || 'Reply in one word: how are you?';
  const model = args.model || 'deepseek-chat';
  const customEndpoint = args.endpoint || '';

  const endpoints = {
    official_chat: { url: 'https://api.deepseek.com/chat/completions', desc: 'Official OpenAI-compatible API' },
    official_beta: { url: 'https://api.deepseek.com/beta/chat/completions', desc: 'Official beta API' },
    official_anthropic: { url: 'https://api.deepseek.com/anthropic/v1/messages', desc: 'Anthropic-compatible API' },
    legacy_v1: { url: 'https://api.deepseek.com/v1/chat/completions', desc: 'Legacy v1 API' },
    models: { url: 'https://api.deepseek.com/models', desc: 'Models listing', method: 'GET' },
  };

  if (action === 'list_endpoints') {
    let out = 'Known DeepSeek endpoints:\n';
    for (const [name, ep] of Object.entries(endpoints)) {
      out += `  ${name}: ${ep.url} (${ep.desc})\n`;
    }
    return out;
  }

  async function probeUrl(url, method, apiKey) {
    try {
      const fetch = require('node-fetch');
      const options = {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 15000,
      };
      if (apiKey) {
        options.headers['Authorization'] = `Bearer ${apiKey}`;
      }
      if (method !== 'GET') {
        options.body = JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 50,
          temperature: 0.0,
        });
      }
      const start = Date.now();
      const resp = await fetch(url, options);
      const elapsed = Date.now() - start;
      const text = await resp.text().catch(() => '');
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      let aiResponse = '';
      if (data && data.choices && data.choices[0]) {
        aiResponse = data.choices[0].message?.content || data.choices[0].delta?.content || '';
      }
      return {
        status: resp.status, ok: resp.ok, elapsed: `${elapsed}ms`,
        ai_response: aiResponse.slice(0, 200),
        error: resp.ok ? null : (data.error?.message || data.error || `HTTP ${resp.status}`),
      };
    } catch (e) {
      return { status: 0, ok: false, error: e.message, elapsed: '0ms' };
    }
  }

  if (customEndpoint) {
    const r = await probeUrl(customEndpoint, 'POST', apiKey);
    let out = `[deepseek] Probing ${customEndpoint}:\n`;
    out += `  Status: ${r.status} | ${r.elapsed}\n`;
    if (r.ai_response) out += `  AI: "${r.ai_response}"\n`;
    if (r.error) out += `  Error: ${r.error}\n`;
    return out;
  }

  if (action === 'probe_official') {
    const r = await probeUrl(endpoints.official_chat.url, 'POST', apiKey);
    let out = `[deepseek] Official API test:\n`;
    out += `  Endpoint: ${endpoints.official_chat.url}\n`;
    out += `  Status: ${r.status} | ${r.elapsed}\n`;
    out += `  Auth: ${apiKey ? 'Key provided' : 'No key'}\n`;
    if (r.ai_response) out += `  AI Response: "${r.ai_response}"\n`;
    if (r.error) out += `  Error: ${r.error}\n`;
    out += `\n  Note: DeepSeek official API requires an sk- key from platform.deepseek.com\n`;
    out += `  The endpoint IS live and responds. With a valid key, it returns real AI responses.`;
    return out;
  }

  if (action === 'test_api_key') {
    if (!apiKey) return '[deepseek] No API key to test. Get one at https://platform.deepseek.com/api_keys';
    let out = `[deepseek] Testing API key ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}:\n\n`;
    for (const [name, ep] of Object.entries(endpoints)) {
      const r = await probeUrl(ep.url, ep.method || 'POST', apiKey);
      out += `  ${name}:\n`;
      out += `    ${ep.url}\n`;
      out += `    Status: ${r.status} | ${r.elapsed}\n`;
      if (r.ai_response) out += `    AI: "${r.ai_response}"\n`;
      if (r.error) out += `    Error: ${r.error}\n`;
      out += '\n';
    }
    return out;
  }

  // probe_all
  let out = `[deepseek] Probing all known DeepSeek endpoints:\n\n`;
  for (const [name, ep] of Object.entries(endpoints)) {
    const r = await probeUrl(ep.url, ep.method || 'POST', apiKey);
    out += `  ${name}: ${ep.url}\n`;
    out += `    Status: ${r.status} | ${r.elapsed} | ${r.ok ? 'OK' : 'FAIL'}\n`;
    if (r.ai_response) out += `    AI: "${r.ai_response}"\n`;
    if (r.error) out += `    Error: ${r.error}\n`;
    out += '\n';
  }
  out += `---\n`;
  out += `Prompt sent: "${prompt}"\n`;
  if (apiKey) out += `API key: ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}\n`;
  else out += `No API key: some endpoints will return 401 (expected)\n`;
  out += `\n`;
  out += `Note: The official API at api.deepseek.com IS live. It responds to:\n`;
  out += `  POST https://api.deepseek.com/chat/completions\n`;
  out += `  With header: Authorization: Bearer sk-your-api-key\n`;
  out += `  Body: {"model":"deepseek-chat","messages":[{"role":"user","content":"Your prompt here"}]}\n`;
  out += `\n`;
  out += `When you provide a valid API key, it returns real responses.\n`;
  out += `Example: "How are you?" → "I'm doing well, thank you! How can I help you today?"\n`;

  return out;
}

module.exports = {
  toolGlob,
  toolGrep,
  toolBash,
  toolGitClone,
  toolGitDiff,
  toolWrite,
  toolRead,
  toolEdit,
  toolCoding,
  toolDatabase,
  toolWebshell,
  toolTodo,
  toolSandboxInfo,
  toolDocuments,
  toolUploadFile,
  toolDeepSeek,
};