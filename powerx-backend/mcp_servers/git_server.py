"""
Git MCP Server (Free, No API Key)
Read, search, and manipulate local Git repositories.
Requires: pip install mcp gitpython
"""

import asyncio
import os
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("git-mcp")


def get_repo(path: str):
    from git import Repo
    return Repo(path, search_parent_directories=True)


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="git_status",
            description="Show the working tree status of a repo",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string", "description": "Path to the git repo"}
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_log",
            description="Show recent commit history",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "max_count": {"type": "integer", "default": 10, "description": "Number of commits to show"},
                    "branch": {"type": "string", "description": "Branch name (default: current)"},
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_diff",
            description="Show changes between commits or working tree",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "staged": {"type": "boolean", "default": False, "description": "Show staged changes"},
                    "commit": {"type": "string", "description": "Specific commit hash to diff against"},
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_branches",
            description="List all branches in the repo",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "all": {"type": "boolean", "default": False, "description": "Include remote branches"},
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_checkout",
            description="Switch to a branch or create a new one",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "branch": {"type": "string", "description": "Branch name to checkout"},
                    "create": {"type": "boolean", "default": False, "description": "Create the branch if it doesn't exist"},
                },
                "required": ["repo_path", "branch"],
            },
        ),
        Tool(
            name="git_add",
            description="Stage files for commit",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "files": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of file paths to stage. Use ['.'] for all.",
                    },
                },
                "required": ["repo_path", "files"],
            },
        ),
        Tool(
            name="git_commit",
            description="Commit staged changes",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "message": {"type": "string", "description": "Commit message"},
                    "author_name": {"type": "string", "description": "Author name (optional)"},
                    "author_email": {"type": "string", "description": "Author email (optional)"},
                },
                "required": ["repo_path", "message"],
            },
        ),
        Tool(
            name="git_show",
            description="Show details of a specific commit",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "commit": {"type": "string", "description": "Commit hash (default: HEAD)"},
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_search_commits",
            description="Search commit messages for a keyword",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "keyword": {"type": "string", "description": "Keyword to search for"},
                    "max_count": {"type": "integer", "default": 20},
                },
                "required": ["repo_path", "keyword"],
            },
        ),
        Tool(
            name="git_stash",
            description="Stash or pop uncommitted changes",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string"},
                    "action": {
                        "type": "string",
                        "description": "Action: 'save' or 'pop'",
                        "enum": ["save", "pop"],
                    },
                    "message": {"type": "string", "description": "Stash message (for save)"},
                },
                "required": ["repo_path", "action"],
            },
        ),
        Tool(
            name="git_init",
            description="Initialize a new git repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "repo_path": {"type": "string", "description": "Directory to initialize as a git repo"}
                },
                "required": ["repo_path"],
            },
        ),
        Tool(
            name="git_clone",
            description="Clone a remote repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Repository URL to clone"},
                    "destination": {"type": "string", "description": "Local path to clone into"},
                },
                "required": ["url", "destination"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "git_status":
            repo = get_repo(arguments["repo_path"])
            lines = [f"Branch: {repo.active_branch.name}", ""]
            if repo.is_dirty(untracked_files=True):
                if repo.index.diff(None):
                    lines.append("📝 Modified (unstaged):")
                    for item in repo.index.diff(None):
                        lines.append(f"  M  {item.a_path}")
                if repo.index.diff("HEAD"):
                    lines.append("✅ Staged:")
                    for item in repo.index.diff("HEAD"):
                        lines.append(f"  A  {item.a_path}")
                if repo.untracked_files:
                    lines.append("❓ Untracked:")
                    for f in repo.untracked_files:
                        lines.append(f"  ?  {f}")
            else:
                lines.append("✅ Clean — nothing to commit.")
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "git_log":
            repo = get_repo(arguments["repo_path"])
            max_count = arguments.get("max_count", 10)
            branch = arguments.get("branch", repo.active_branch.name)
            lines = []
            for commit in repo.iter_commits(branch, max_count=max_count):
                lines.append(
                    f"🔸 {commit.hexsha[:8]}  {commit.committed_datetime.strftime('%Y-%m-%d %H:%M')}\n"
                    f"   Author: {commit.author.name}\n"
                    f"   {commit.message.strip()}\n"
                )
            return [TextContent(type="text", text="\n".join(lines) or "No commits found.")]

        elif name == "git_diff":
            repo = get_repo(arguments["repo_path"])
            if arguments.get("commit"):
                diff = repo.git.diff(arguments["commit"])
            elif arguments.get("staged"):
                diff = repo.git.diff("--cached")
            else:
                diff = repo.git.diff()
            return [TextContent(type="text", text=diff or "(no differences)")]

        elif name == "git_branches":
            repo = get_repo(arguments["repo_path"])
            current = repo.active_branch.name
            lines = []
            for branch in repo.branches:
                marker = "▶" if branch.name == current else " "
                lines.append(f"{marker} {branch.name}")
            if arguments.get("all"):
                for ref in repo.remotes:
                    for remote_branch in ref.refs:
                        lines.append(f"  {remote_branch.name}")
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "git_checkout":
            repo = get_repo(arguments["repo_path"])
            branch = arguments["branch"]
            if arguments.get("create"):
                new_branch = repo.create_head(branch)
                new_branch.checkout()
                return [TextContent(type="text", text=f"✅ Created and switched to branch '{branch}'")]
            else:
                repo.git.checkout(branch)
                return [TextContent(type="text", text=f"✅ Switched to branch '{branch}'")]

        elif name == "git_add":
            repo = get_repo(arguments["repo_path"])
            repo.index.add(arguments["files"])
            return [TextContent(type="text", text=f"✅ Staged: {', '.join(arguments['files'])}")]

        elif name == "git_commit":
            from git import Actor
            repo = get_repo(arguments["repo_path"])
            kwargs = {}
            if arguments.get("author_name") and arguments.get("author_email"):
                kwargs["author"] = Actor(arguments["author_name"], arguments["author_email"])
            commit = repo.index.commit(arguments["message"], **kwargs)
            return [TextContent(type="text", text=f"✅ Committed {commit.hexsha[:8]}: {arguments['message']}")]

        elif name == "git_show":
            repo = get_repo(arguments["repo_path"])
            ref = arguments.get("commit", "HEAD")
            commit = repo.commit(ref)
            info = (
                f"Commit:  {commit.hexsha}\n"
                f"Author:  {commit.author.name} <{commit.author.email}>\n"
                f"Date:    {commit.committed_datetime}\n"
                f"Message: {commit.message.strip()}\n\n"
                f"Files changed:\n"
            )
            for item in commit.stats.files:
                info += f"  {item}\n"
            return [TextContent(type="text", text=info)]

        elif name == "git_search_commits":
            repo = get_repo(arguments["repo_path"])
            keyword = arguments["keyword"].lower()
            max_count = arguments.get("max_count", 20)
            matches = []
            for commit in repo.iter_commits(max_count=max_count * 10):
                if keyword in commit.message.lower():
                    matches.append(
                        f"🔸 {commit.hexsha[:8]}  {commit.committed_datetime.strftime('%Y-%m-%d')}\n"
                        f"   {commit.message.strip()}\n"
                    )
                if len(matches) >= max_count:
                    break
            return [TextContent(type="text", text="\n".join(matches) or f"No commits found matching '{keyword}'.")]

        elif name == "git_stash":
            repo = get_repo(arguments["repo_path"])
            if arguments["action"] == "save":
                msg = arguments.get("message", "")
                repo.git.stash("save", msg) if msg else repo.git.stash()
                return [TextContent(type="text", text="✅ Changes stashed.")]
            else:
                repo.git.stash("pop")
                return [TextContent(type="text", text="✅ Stash popped.")]

        elif name == "git_init":
            from git import Repo
            path = arguments["repo_path"]
            os.makedirs(path, exist_ok=True)
            Repo.init(path)
            return [TextContent(type="text", text=f"✅ Initialized empty Git repository in {path}")]

        elif name == "git_clone":
            from git import Repo
            Repo.clone_from(arguments["url"], arguments["destination"])
            return [TextContent(type="text", text=f"✅ Cloned into {arguments['destination']}")]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
