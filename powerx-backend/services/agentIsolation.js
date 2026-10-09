'use strict';

// Shared least-privilege helpers for agent child processes and workspace tools.
// This module intentionally uses an allowlist: inheriting process.env is unsafe
// because it may contain database, deployment, OAuth, or provider credentials.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'NODE_ENV', 'PYTHONUNBUFFERED',
  'npm_config_cache', 'npm_config_userconfig', 'PIP_DISABLE_PIP_VERSION_CHECK',
]);

const SECRET_ENV_RE = /(?:KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|COOKIE|AUTH|PRIVATE|DATABASE|SUPABASE|RENDER|GITHUB|NUBASE)/i;

function isSecretEnvKey(name) {
  return SECRET_ENV_RE.test(String(name || ''));
}

/**
 * Return an intentionally small environment for untrusted agent commands.
 * `overrides` is restricted to safe names; bridge credentials are never copied.
 */
function safeChildEnv(overrides = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] != null && !isSecretEnvKey(key)) env[key] = String(process.env[key]);
  }
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  if (!env.HOME) env.HOME = os.homedir() || '/tmp';
  if (!env.TMPDIR) env.TMPDIR = os.tmpdir();

  for (const [key, value] of Object.entries(overrides || {})) {
    if (!SAFE_ENV_KEYS.has(key) || isSecretEnvKey(key) || value == null) continue;
    env[key] = String(value);
  }
  return env;
}

function normalizeRelativePath(input) {
  const raw = String(input == null ? '' : input).replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error('absolute or invalid path blocked');
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('path traversal blocked');
  }
  return normalized === '.' ? '' : normalized.replace(/^\.\//, '');
}

/**
 * Resolve a path under a task workspace and reject traversal and symlink escape.
 * The returned path is host-local only; remote sandbox adapters should apply
 * their own lexical root checks before issuing provider file operations.
 */
function resolveWorkspacePath(workspace, input, { allowMissing = true } = {}) {
  const root = path.resolve(String(workspace || ''));
  if (!root) throw new Error('workspace is required');
  const rel = normalizeRelativePath(input);
  const candidate = path.resolve(root, rel || '.');
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error('path traversal blocked');
  }

  let probe = candidate;
  while (probe !== root && !fs.existsSync(probe)) probe = path.dirname(probe);
  const realRoot = fs.realpathSync.native(root);
  const realProbe = fs.realpathSync.native(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new Error('symlink escape blocked');
  }
  if (!allowMissing && !fs.existsSync(candidate)) throw new Error('path not found');
  return { root, rel, abs: candidate };
}

function workspaceFromContext(ctx) {
  const candidate = ctx && ctx.fsx && ctx.fsx.kind === 'local'
    ? ctx.fsx.workdir
    : (ctx && ctx.workdir) || '';
  if (!candidate || !fs.existsSync(candidate)) return '';
  try { return fs.realpathSync.native(candidate); } catch (_) { return path.resolve(candidate); }
}

// Best-effort pre-execution guard for agent-supplied code/commands. The actual
// boundary is the scrubbed child environment plus the isolated sandbox; this
// guard adds a deterministic deny response for common secret/proc/path probes.
const BLOCKED_AGENT_ACCESS = [
  /(?:process\.env|import\s+os|os\.(?:environ|getenv)|getenv\s*\()/i,
  /(?:printenv|\benv\s*(?:$|[|;&]))/i,
  /(?:SUPABASE_|RENDER_API_KEY|GITHUB_DEPLOY_TOKEN|JWT_SECRET|DATABASE_PASSWORD)/i,
  /(?:^|[\s"'``])\/(?:etc|proc|sys|dev|root|home|var|opt|srv|run)(?:[\/\s"'`]|$)/i,
  /(?:\.\.\/|\/\.\.|\\\\\.\.)/,
];

function guardAgentSource(source) {
  const text = String(source || '');
  for (const pattern of BLOCKED_AGENT_ACCESS) {
    if (pattern.test(text)) return 'agent access to host secrets or system paths is blocked; use the exposed workspace tools instead';
  }
  return '';
}

module.exports = {
  SAFE_ENV_KEYS,
  isSecretEnvKey,
  safeChildEnv,
  normalizeRelativePath,
  resolveWorkspacePath,
  workspaceFromContext,
  guardAgentSource,
};
