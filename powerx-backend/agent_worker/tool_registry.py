#!/usr/bin/env python3
"""
tool_registry.py — Enterprise Sandbox Tool Registry (CodeBanana-style).

Each tool is a self-contained Python module under agent_worker/tools/ with a
JSON manifest (tool.json) and an executable entry point. The registry:

  • Discovers tools at startup (walk agent_worker/tools/ for tool.json files)
  • Validates the manifest (name, version, entry, permissions, arguments schema)
  • Provides a unified `run_tool(name, args)` dispatcher that sandboxes the
    tool's execution (timeout, cwd, env, output cap)
  • Supports dependency injection: each tool gets a context object with
    read_file, write_file, read_db, exec_shell, glob, grep, etc.

Permissions system (mirrors the reference screenshots):
  fs.read      — read files from the work dir
  fs.write     — write files to the work dir
  http.fetch   — make outbound HTTP requests
  shell.exec   — execute arbitrary shell commands
  net.listen   — bind/listen on ports (for webshell)
  db.query     — run SQL queries against the app database
  git.ops      — git clone/push operations
  cron.schedule— schedule recurring tasks
  agent.runTool— call other tools

Usage:
    from tool_registry import get_registry
    registry = get_registry(tools_dir="/path/to/tools")
    result = registry.run_tool("glob", {"pattern": "**/*.py"})
"""

import os
import sys
import json
import time
import shutil
import base64
import signal
import textwrap
import subprocess
import traceback
import threading
import fnmatch
import re
import hashlib
from pathlib import Path
from datetime import datetime

# ── Default paths ─────────────────────────────────────────────────────────────
DEFAULT_TOOLS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools")
WORK_DIR = os.environ.get("AGENT_WORK", "/home/daytona/work")

# ── ───────────────────────────────────────────────────────────────────────────
# Tool Manifest Schema
# ── ───────────────────────────────────────────────────────────────────────────
"""
A tool.json manifest looks like:
{
    "name": "glob",
    "version": "1.0.0",
    "description": "Find files matching a glob pattern in the work directory",
    "entry": "glob_tool.py",
    "permissions": ["fs.read"],
    "timeout": 30,
    "arguments": [
        {
            "name": "pattern",
            "type": "string",
            "description": "Glob pattern (e.g. **/*.py, src/**/*.ts)",
            "required": true
        },
        {
            "name": "base_dir",
            "type": "string",
            "description": "Base directory (default: work dir)",
            "required": false
        }
    ],
    "output": {
        "type": "array",
        "description": "List of matching file paths relative to base_dir"
    }
}
"""


# ── ───────────────────────────────────────────────────────────────────────────
# Tool Context — injected into every tool execution
# ── ───────────────────────────────────────────────────────────────────────────
class ToolContext:
    """
    Context object passed to every tool's run() function.
    Provides safe access to the sandbox environment.
    """

    def __init__(self, work_dir=WORK_DIR, permissions=None, tool_name=None):
        self.work_dir = work_dir
        self.permissions = set(permissions or [])
        self.tool_name = tool_name
        self._db = None
        self._last_result = None

    # ── Permission check ──────────────────────────────────────────────────────
    def require_permission(self, perm):
        if perm not in self.permissions:
            raise PermissionError(
                f"Tool '{self.tool_name}' requires permission '{perm}' "
                f"but only has: {', '.join(sorted(self.permissions))}"
            )

    # ── File operations ───────────────────────────────────────────────────────
    def read_file(self, path):
        """Read a file relative to work_dir. Returns str content."""
        self.require_permission("fs.read")
        abspath = self._resolve(path)
        if not os.path.exists(abspath):
            raise FileNotFoundError(f"File not found: {path}")
        with open(abspath, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

    def read_file_binary(self, path):
        """Read a file as bytes."""
        self.require_permission("fs.read")
        abspath = self._resolve(path)
        if not os.path.exists(abspath):
            raise FileNotFoundError(f"File not found: {path}")
        with open(abspath, "rb") as f:
            return f.read()

    def write_file(self, path, content):
        """Write a file relative to work_dir. content can be str or bytes."""
        self.require_permission("fs.write")
        abspath = self._resolve(path)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        encoding = None if isinstance(content, bytes) else "utf-8"
        with open(abspath, mode, encoding=encoding) as f:
            f.write(content)
        return abspath

    def edit_file(self, path, old_text, new_text, replace_all=False):
        """Find and replace text in a file. Returns (replaced_count, new_content)."""
        self.require_permission("fs.write")
        content = self.read_file(path)
        if replace_all:
            new_content = content.replace(old_text, new_text)
        else:
            new_content = content.replace(old_text, new_text, 1)
        if new_content == content:
            raise ValueError(f"Text not found in {path}")
        count = content.count(old_text)
        self.write_file(path, new_content)
        return count, new_content

    def file_exists(self, path):
        """Check if a file exists relative to work_dir."""
        abspath = self._resolve(path)
        return os.path.isfile(abspath)

    def list_dir(self, path="."):
        """List directory contents relative to work_dir."""
        abspath = self._resolve(path)
        if not os.path.isdir(abspath):
            raise NotADirectoryError(f"Not a directory: {path}")
        entries = []
        for name in os.listdir(abspath):
            full = os.path.join(abspath, name)
            entries.append({
                "name": name,
                "type": "dir" if os.path.isdir(full) else "file",
                "size": os.path.getsize(full) if os.path.isfile(full) else 0,
                "mtime": os.path.getmtime(full),
            })
        return entries

    def delete_file(self, path):
        """Delete a file or empty directory."""
        self.require_permission("fs.write")
        abspath = self._resolve(path)
        if os.path.isfile(abspath):
            os.remove(abspath)
        elif os.path.isdir(abspath):
            os.rmdir(abspath)
        else:
            raise FileNotFoundError(f"Not found: {path}")
        return True

    # ── Glob / Grep ───────────────────────────────────────────────────────────
    def glob(self, pattern, base_dir=None):
        """Find files matching a glob pattern."""
        self.require_permission("fs.read")
        base = self._resolve(base_dir or ".")
        if not os.path.isdir(base):
            return []
        matches = []
        for root, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".") or pattern.startswith(".")]
            for f in files:
                rel = os.path.relpath(os.path.join(root, f), base)
                if fnmatch.fnmatch(rel, pattern):
                    matches.append(rel)
        return sorted(matches)

    def grep(self, pattern, glob_pattern="*", max_results=100):
        """Search file contents for a regex pattern."""
        self.require_permission("fs.read")
        files = self.glob(glob_pattern)
        results = []
        re_flags = re.MULTILINE | re.DOTALL
        try:
            compiled = re.compile(pattern, re_flags)
        except re.error as e:
            raise ValueError(f"Invalid regex pattern: {e}")
        for f in files:
            if len(results) >= max_results:
                break
            try:
                content = self.read_file(f)
                for m in compiled.finditer(content):
                    line_num = content[:m.start()].count("\n") + 1
                    start = max(0, m.start() - 40)
                    end = min(len(content), m.end() + 40)
                    context = content[start:end].replace("\n", " ")
                    results.append({
                        "file": f,
                        "line": line_num,
                        "match": m.group(0)[:100],
                        "context": context.strip(),
                    })
                    if len(results) >= max_results:
                        break
            except Exception:
                continue
        return results

    # ── Shell execution ───────────────────────────────────────────────────────
    def exec_shell(self, command, timeout=60, capture_output=True, work_dir=None):
        """Execute a shell command. Returns {stdout, stderr, exit_code}."""
        self.require_permission("shell.exec")
        cwd = self._resolve(work_dir) if work_dir else self.work_dir
        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=cwd,
                capture_output=capture_output,
                text=True,
                timeout=timeout,
                env={**os.environ, "HOME": os.path.expanduser("~")},
            )
            return {
                "stdout": result.stdout or "",
                "stderr": result.stderr or "",
                "exit_code": result.returncode,
            }
        except subprocess.TimeoutExpired:
            return {
                "stdout": "",
                "stderr": f"[timeout] Command exceeded {timeout}s",
                "exit_code": -1,
            }
        except Exception as e:
            return {
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
            }

    # ── Git operations ────────────────────────────────────────────────────────
    def git_clone(self, repo_url, dest_dir=None, branch=None, depth=None):
        """Clone a git repository into the work dir."""
        self.require_permission("git.ops")
        dest = dest_dir or repo_url.split("/")[-1].replace(".git", "")
        target = os.path.join(self.work_dir, dest)
        cmd = f"git clone {repo_url} {dest}"
        if branch:
            cmd += f" --branch {branch}"
        if depth:
            cmd += f" --depth {depth}"
        result = self.exec_shell(cmd, timeout=300)
        sub = self.exec_shell(
            f"cd {dest} && git submodule update --init --recursive 2>/dev/null",
            timeout=120,
        )
        result["submodule"] = sub["stdout"][:200]
        result["dest"] = dest
        return result

    def git_diff(self, path=".", staged=False):
        """Show git diff for files in the work dir."""
        self.require_permission("git.ops")
        cwd = self._resolve(path) if path != "." else self.work_dir
        if not os.path.exists(os.path.join(cwd, ".git")):
            return {"stdout": "(not a git repository)", "stderr": "", "exit_code": 0}
        flag = "--cached" if staged else ""
        result = self.exec_shell(f"git diff {flag} 2>&1", timeout=30, work_dir=cwd)
        return result

    # ── Database ──────────────────────────────────────────────────────────────
    def db_query(self, sql, db_url=None):
        """Execute a SQL query against the database."""
        self.require_permission("db.query")
        if db_url:
            cmd = f'psql "{db_url}" -c {shlex_quote(sql)} -t 2>&1'
        else:
            supabase_url = os.environ.get("SUPABASE_URL", "")
            service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
            if supabase_url and service_key:
                ref_match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
                if ref_match:
                    ref = ref_match.group(1)
                    db_url_full = f"postgresql://postgres:{os.environ.get('SUPABASE_DB_PASSWORD', '')}@db.{ref}.supabase.co:5432/postgres"
                    cmd = f'psql "{db_url_full}" -c {shlex_quote(sql)} -t 2>&1'
                else:
                    cmd = f'echo "Could not parse Supabase URL"'
            else:
                db_path = os.path.join(WORK_DIR, ".agent_data.db")
                cmd = f"sqlite3 {shlex_quote(db_path)} {shlex_quote(sql)} 2>&1"
        return self.exec_shell(cmd, timeout=30)

    # ── HTTP Fetch ────────────────────────────────────────────────────────────
    def http_fetch(self, url, method="GET", headers=None, body=None, timeout=30):
        """Make an HTTP request."""
        self.require_permission("http.fetch")
        import urllib.request
        import urllib.error

        req = urllib.request.Request(url, method=method)
        if headers:
            for k, v in headers.items():
                req.add_header(k, v)
        if body is not None:
            if isinstance(body, str):
                req.data = body.encode("utf-8")
            else:
                req.data = body
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                content = resp.read()
                return {
                    "status": resp.status,
                    "headers": dict(resp.headers),
                    "body": content.decode("utf-8", errors="replace"),
                    "body_bytes": len(content),
                }
        except urllib.error.HTTPError as e:
            return {
                "status": e.code,
                "headers": dict(e.headers),
                "body": e.read().decode("utf-8", errors="replace")[:2000],
                "error": str(e),
            }
        except Exception as e:
            return {"status": 0, "body": "", "error": str(e)}

    def _resolve(self, path):
        """Resolve a path inside work_dir, preventing traversal and symlink escape.

        Absolute paths are accepted only when they already point inside the
        sandbox workspace. This lets callers reuse paths returned by another
        tool without granting access to the worker/runtime or system files.
        """
        raw = os.fspath(path or ".")
        work_real = os.path.realpath(self.work_dir)
        joined = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(work_real, raw))
        try:
            confined = os.path.commonpath([work_real, joined]) == work_real
        except ValueError:
            confined = False
        if not confined:
            raise PermissionError(f"Path traversal blocked: {path}")
        return joined

    def get_work_dir(self):
        return self.work_dir


def shlex_quote(s):
    """Simple shell quoting."""
    return "'" + s.replace("'", "'\\''") + "'"


# ── ───────────────────────────────────────────────────────────────────────────
# Tool Manifest
# ── ───────────────────────────────────────────────────────────────────────────
class ToolManifest:
    """Represents a parsed tool.json manifest."""

    def __init__(self, data, tools_dir):
        self.name = data.get("name", "unnamed")
        self.version = data.get("version", "0.0.0")
        self.description = data.get("description", "")
        self.entry = data.get("entry", "tool.py")
        self.permissions = data.get("permissions", [])
        self.timeout = data.get("timeout", 60)
        self.arguments = data.get("arguments", [])
        self.output = data.get("output", {})
        self.tags = data.get("tags", [])
        self.tools_dir = tools_dir

    @property
    def entry_path(self):
        return os.path.join(self.tools_dir, self.entry)

    def validate(self):
        errors = []
        if not self.name or not re.match(r"^[a-z][a-z0-9_-]*$", self.name):
            errors.append(f"Invalid tool name: '{self.name}'")
        if not self.entry:
            errors.append("No entry script specified")
        if not os.path.isfile(self.entry_path):
            errors.append(f"Entry script not found: {self.entry}")
        valid_perms = {"fs.read", "fs.write", "http.fetch", "shell.exec",
                       "net.listen", "db.query", "git.ops", "cron.schedule",
                       "agent.runTool"}
        for p in self.permissions:
            if p not in valid_perms:
                errors.append(f"Unknown permission: '{p}'")
        for arg in self.arguments:
            if not arg.get("name"):
                errors.append("Argument missing 'name' field")
            arg_type = arg.get("type", "string")
            if arg_type not in ("string", "number", "boolean", "object", "array"):
                errors.append(f"Unknown argument type: '{arg_type}'")
        return errors


# ── ───────────────────────────────────────────────────────────────────────────
# Tool Registry
# ── ───────────────────────────────────────────────────────────────────────────
class ToolRegistry:

    def __init__(self, tools_dir=None, work_dir=None):
        self.tools_dir = tools_dir or DEFAULT_TOOLS_DIR
        self.work_dir = work_dir or WORK_DIR
        self._tools = {}
        self._entries = {}
        self._lock = threading.Lock()

    def discover(self):
        """Walk the tools directory and discover all tool manifests."""
        tools_dir = self.tools_dir
        if not os.path.isdir(tools_dir):
            self._log(f"Tools directory not found: {tools_dir}")
            return []

        discovered = []
        for root, dirs, files in os.walk(tools_dir):
            if "tool.json" in files:
                manifest_path = os.path.join(root, "tool.json")
                try:
                    with open(manifest_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (json.JSONDecodeError, IOError) as e:
                    self._log(f"Error parsing {manifest_path}: {e}")
                    continue

                manifest = ToolManifest(data, root)
                errors = manifest.validate()
                if errors:
                    self._log(f"Tool '{manifest.name}' validation errors: {errors}")
                    continue

                with self._lock:
                    self._tools[manifest.name] = manifest
                discovered.append(manifest)
                self._log(f"Discovered tool: {manifest.name} v{manifest.version}")

        self._log(f"Discovered {len(discovered)} tools in {tools_dir}")
        return discovered

    def list_tools(self):
        with self._lock:
            return list(self._tools.values())

    def get_tool(self, name):
        with self._lock:
            return self._tools.get(name)

    def has_tool(self, name):
        with self._lock:
            return name in self._tools

    def run_tool(self, name, args=None, timeout=None):
        """Run a tool by name with the given args."""
        args = args or {}
        manifest = self.get_tool(name)
        if not manifest:
            available = ', '.join(sorted(self._tools.keys()))
            return {
                "success": False,
                "error": f"Tool '{name}' not found. Available: {available}",
                "result": None, "stdout": "", "stderr": "", "duration": 0,
            }

        for arg_def in manifest.arguments:
            if arg_def.get("required") and arg_def["name"] not in args:
                return {
                    "success": False,
                    "error": f"Missing required argument '{arg_def['name']}' for '{name}'",
                    "result": None, "stdout": "", "stderr": "", "duration": 0,
                }

        for arg_def in manifest.arguments:
            aname = arg_def["name"]
            if aname in args:
                atype = arg_def.get("type", "string")
                val = args[aname]
                if atype == "string" and not isinstance(val, str):
                    args[aname] = str(val)
                elif atype == "number" and not isinstance(val, (int, float)):
                    try:
                        args[aname] = float(val)
                    except (ValueError, TypeError):
                        return {"success": False, "error": f"Argument '{aname}' should be a number",
                                "result": None, "stdout": "", "stderr": "", "duration": 0}
                elif atype == "boolean" and not isinstance(val, bool):
                    if isinstance(val, str):
                        args[aname] = val.lower() in ("true", "1", "yes")
                    else:
                        args[aname] = bool(val)

        ctx = ToolContext(work_dir=self.work_dir, permissions=manifest.permissions, tool_name=name)
        start_time = time.time()

        try:
            entry_path = manifest.entry_path
            if not os.path.isfile(entry_path):
                return {"success": False, "error": f"Entry not found: {entry_path}",
                        "result": None, "stdout": "", "stderr": "", "duration": time.time() - start_time}

            import importlib.util
            spec = importlib.util.spec_from_file_location(f"tool_{name}", entry_path)
            if not spec:
                return {"success": False, "error": f"Cannot load {entry_path}",
                        "result": None, "stdout": "", "stderr": "", "duration": time.time() - start_time}
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            if not hasattr(module, "run"):
                return {"success": False,
                        "error": f"Tool '{name}' entry has no 'run(ctx, args)'",
                        "result": None, "stdout": "", "stderr": "", "duration": time.time() - start_time}

            requested_timeout = args.get("timeout") if isinstance(args, dict) else None
            try:
                requested_timeout = int(requested_timeout) if requested_timeout is not None else 0
            except (TypeError, ValueError):
                requested_timeout = 0
            effective_timeout = timeout or max(manifest.timeout, requested_timeout)
            effective_timeout = max(1, min(int(effective_timeout), 6 * 60 * 60))
            holder = {"result": None, "error": None, "traceback": ""}
            def invoke_tool():
                try:
                    holder["result"] = module.run(ctx, args)
                except Exception as exc:
                    holder["error"] = str(exc)
                    holder["traceback"] = traceback.format_exc()
            exec_thread = threading.Thread(target=invoke_tool, daemon=True)
            exec_thread.start()
            exec_thread.join(timeout=effective_timeout)

            if exec_thread.is_alive():
                return {"success": False, "error": f"Tool '{name}' timed out after {effective_timeout}s",
                        "result": None, "stdout": "", "stderr": "", "duration": time.time() - start_time}
            if holder["error"] is not None:
                return {"success": False, "error": f"Tool '{name}' error: {holder['error']}",
                        "result": None, "stdout": "", "stderr": holder["traceback"],
                        "duration": time.time() - start_time}

            result = holder["result"]
            duration = time.time() - start_time
            return {"success": True, "result": result,
                    "stdout": "", "stderr": "", "duration": round(duration, 3), "error": None}

        except Exception as e:
            return {"success": False, "error": f"Tool '{name}' error: {e}",
                    "result": None, "stdout": "", "stderr": traceback.format_exc(),
                    "duration": time.time() - start_time}

    def _log(self, msg):
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[tool_registry {ts}] {msg}", flush=True)


# ── Singleton ─────────────────────────────────────────────────────────────────
_registry = None
_registry_lock = threading.Lock()


def get_registry(tools_dir=None, work_dir=None):
    global _registry
    if _registry is None:
        with _registry_lock:
            if _registry is None:
                _registry = ToolRegistry(tools_dir=tools_dir, work_dir=work_dir)
                _registry.discover()
    return _registry


def reset_registry():
    global _registry
    with _registry_lock:
        _registry = None


if __name__ == "__main__":
    registry = get_registry()
    if len(sys.argv) < 2:
        print("Usage: python tool_registry.py <tool_name> [args_json]")
        print(f"\nAvailable tools ({len(registry.list_tools())}):")
        for t in registry.list_tools():
            perm_str = ", ".join(t.permissions) if t.permissions else "(none)"
            print(f"  {t.name:20s} v{t.version:5s} {t.description[:60]}")
            print(f"  {'':20s} permissions: {perm_str}")
            if t.arguments:
                for a in t.arguments:
                    req = " *" if a.get("required") else "  "
                    print(f"  {'':20s}   {req}{a['name']:20s} ({a.get('type','string')}) {a.get('description','')}")
        sys.exit(0)

    tool_name = sys.argv[1]
    args = {}
    if len(sys.argv) >= 3:
        try:
            args = json.loads(sys.argv[2])
        except json.JSONDecodeError:
            args = {"_raw": sys.argv[2]}

    result = registry.run_tool(tool_name, args)
    print(json.dumps(result, indent=2, default=str))