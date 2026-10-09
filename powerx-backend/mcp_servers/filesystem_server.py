"""Filesystem MCP Server (sandboxed).

Provides tools to read, write, list, delete files and directories inside a
single workspace root. All paths must stay within that root; traversal and
symlink escape are rejected. Environment-derived project roots (database
credentials, internal services) are NEVER available to the server.
"""

import asyncio
import os
import shutil
import sys
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Resolve the workspace root from the MCP_FS_ROOT environment variable; default
# to a per-process scratch directory under /tmp when unset. The agent may only
# act inside this directory tree. The host's backend code is NEVER reachable.
def _default_root():
    import tempfile
    return tempfile.mkdtemp(prefix="mcp-fs-root-")


_initial_root = os.environ.get("MCP_FS_ROOT")
ROOT = os.path.abspath(_initial_root) if _initial_root else _default_root()

# Defensive: if the operator explicitly set MCP_FS_ROOT to the backend source
# tree, refuse to start so the agent cannot reach internal code. Otherwise
# we always fall back to the per-process temp workspace.
_FORBIDDEN_ROOTS = []
try:
    _FORBIDDEN_ROOTS.append(os.path.abspath(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
except Exception:
    pass

def _is_forbidden_root(candidate: str) -> bool:
    real = os.path.realpath(candidate)
    for forbidden in _FORBIDDEN_ROOTS:
        try:
            f_real = os.path.realpath(forbidden)
            if real == f_real or real.startswith(f_real + os.sep):
                return True
        except Exception:
            continue
    return False

if _is_forbidden_root(ROOT):
    import sys as _sys
    print(
        f"[filesystem-mcp] MCP_FS_ROOT points to a forbidden host directory "
        f"({ROOT}); falling back to a temp workspace to prevent agent access "
        "to internal files.",
        file=_sys.stderr,
        flush=True,
    )
    ROOT = _default_root()

server = Server("filesystem-mcp")


def _safe_path(path_str: str) -> Path:
    """Resolve a path under ROOT while rejecting traversal + symlink escape."""
    if not isinstance(path_str, str):
        raise ValueError("path must be a string")
    candidate = os.path.normpath(os.path.join(ROOT, path_str))
    real_root = os.path.realpath(ROOT)
    real_path = os.path.realpath(candidate) if os.path.exists(candidate) else candidate
    if real_path != real_root and not real_path.startswith(real_root + os.sep):
        raise PermissionError(f"path traversal blocked: {path_str}")
    if "\0" in path_str:
        raise ValueError("path contains null byte")
    return Path(candidate)


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="read_file",
            description="Read the contents of a file inside the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative file path"}
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="write_file",
            description="Write content to a file inside the workspace root (creates or overwrites).",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative file path"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        ),
        Tool(
            name="list_directory",
            description="List files and folders in a workspace directory.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative directory path (default: workspace root)",
                        "default": ".",
                    }
                },
            },
        ),
        Tool(
            name="delete_file",
            description="Delete a file inside the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative file path"}
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="create_directory",
            description="Create a directory (including parents) inside the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative directory path"}
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="file_info",
            description="Get metadata about a file or directory inside the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path to inspect"}
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="copy_file",
            description="Copy a file between workspace-relative paths.",
            inputSchema={
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "Source file path"},
                    "destination": {"type": "string", "description": "Destination path"},
                },
                "required": ["source", "destination"],
            },
        ),
        Tool(
            name="move_file",
            description="Move or rename a file inside the workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": "Source file path"},
                    "destination": {"type": "string", "description": "Destination path"},
                },
                "required": ["source", "destination"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "read_file":
            p = _safe_path(arguments["path"])
            content = p.read_text(encoding="utf-8")
            return [TextContent(type="text", text=content)]

        if name == "write_file":
            p = _safe_path(arguments["path"])
            content = arguments["content"]
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            return [TextContent(type="text", text=f"✅ Written to {arguments['path']}")]

        if name == "list_directory":
            p = _safe_path(arguments.get("path", "."))
            entries = sorted(p.iterdir())
            lines = []
            for entry in entries:
                kind = "📁" if entry.is_dir() else "📄"
                lines.append(f"{kind} {entry.name}")
            return [TextContent(type="text", text="\n".join(lines) or "(empty)")]

        if name == "delete_file":
            p = _safe_path(arguments["path"])
            if p.is_dir():
                raise IsADirectoryError(f"{arguments['path']} is a directory")
            p.unlink()
            return [TextContent(type="text", text=f"🗑️ Deleted {arguments['path']}")]

        if name == "create_directory":
            p = _safe_path(arguments["path"])
            p.mkdir(parents=True, exist_ok=True)
            return [TextContent(type="text", text=f"📁 Created directory {arguments['path']}")]

        if name == "file_info":
            p = _safe_path(arguments["path"])
            stat = p.stat()
            info = {
                "name": p.name,
                "type": "directory" if p.is_dir() else "file",
                "size_bytes": stat.st_size,
                "absolute_path": str(p.resolve()),
                "exists": p.exists(),
            }
            text = "\n".join(f"{k}: {v}" for k, v in info.items())
            return [TextContent(type="text", text=text)]

        if name == "copy_file":
            src = _safe_path(arguments["source"])
            dst = _safe_path(arguments["destination"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            return [TextContent(type="text", text=f"✅ Copied to {arguments['destination']}")]

        if name == "move_file":
            src = _safe_path(arguments["source"])
            dst = _safe_path(arguments["destination"])
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(src, dst)
            return [TextContent(type="text", text=f"✅ Moved to {arguments['destination']}")]

        return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]
    except PermissionError as e:
        return [TextContent(type="text", text=f"🚫 path traversal blocked: {e}")]
    except (ValueError, OSError) as e:
        return [TextContent(type="text", text=f"❌ Error: {e}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())