"""
GitHub MCP Server (Public Repos — No API key required)
Uses the GitHub REST API v3 for public data access.
Optionally set GITHUB_TOKEN env var for higher rate limits (5000 req/hr vs 60).
"""

import asyncio
import os
import json
import urllib.request
import urllib.parse
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("github-mcp")

GITHUB_API = "https://api.github.com"


def github_get(endpoint: str, params: dict = None) -> dict | list:
    url = f"{GITHUB_API}{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "mcp-github-server/1.0")

    token = os.environ.get("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="search_repositories",
            description="Search public GitHub repositories",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "sort": {
                        "type": "string",
                        "description": "Sort by: stars, forks, updated (default: stars)",
                        "default": "stars",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Max results (default: 5)",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="get_repository",
            description="Get details about a specific GitHub repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "owner": {"type": "string", "description": "Repository owner/org"},
                    "repo": {"type": "string", "description": "Repository name"},
                },
                "required": ["owner", "repo"],
            },
        ),
        Tool(
            name="list_repo_files",
            description="List files in a GitHub repository directory",
            inputSchema={
                "type": "object",
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "path": {
                        "type": "string",
                        "description": "Directory path (default: root)",
                        "default": "",
                    },
                },
                "required": ["owner", "repo"],
            },
        ),
        Tool(
            name="read_file",
            description="Read a file from a public GitHub repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "path": {"type": "string", "description": "File path in repo"},
                },
                "required": ["owner", "repo", "path"],
            },
        ),
        Tool(
            name="list_issues",
            description="List open issues in a public GitHub repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "state": {
                        "type": "string",
                        "description": "open, closed, or all (default: open)",
                        "default": "open",
                    },
                    "max_results": {"type": "integer", "default": 10},
                },
                "required": ["owner", "repo"],
            },
        ),
        Tool(
            name="list_releases",
            description="List releases for a public GitHub repository",
            inputSchema={
                "type": "object",
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "max_results": {"type": "integer", "default": 5},
                },
                "required": ["owner", "repo"],
            },
        ),
        Tool(
            name="get_user",
            description="Get a GitHub user's public profile",
            inputSchema={
                "type": "object",
                "properties": {
                    "username": {"type": "string", "description": "GitHub username"}
                },
                "required": ["username"],
            },
        ),
        Tool(
            name="list_user_repos",
            description="List public repositories for a GitHub user",
            inputSchema={
                "type": "object",
                "properties": {
                    "username": {"type": "string"},
                    "sort": {"type": "string", "default": "updated"},
                    "max_results": {"type": "integer", "default": 10},
                },
                "required": ["username"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "search_repositories":
            data = github_get(
                "/search/repositories",
                {
                    "q": arguments["query"],
                    "sort": arguments.get("sort", "stars"),
                    "per_page": arguments.get("max_results", 5),
                },
            )
            items = data.get("items", [])
            lines = [f"Found {data.get('total_count', 0)} repositories:\n"]
            for r in items:
                lines.append(
                    f"⭐ {r['stargazers_count']:,}  {r['full_name']}\n"
                    f"   {r.get('description', 'No description')}\n"
                    f"   {r['html_url']}\n"
                    f"   Language: {r.get('language', 'N/A')} | Forks: {r.get('forks_count', 0)}\n"
                )
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "get_repository":
            r = github_get(f"/repos/{arguments['owner']}/{arguments['repo']}")
            info = (
                f"📦 {r['full_name']}\n"
                f"Description: {r.get('description', 'N/A')}\n"
                f"Stars: {r['stargazers_count']:,} | Forks: {r['forks_count']:,} | Watchers: {r['watchers_count']:,}\n"
                f"Language: {r.get('language', 'N/A')}\n"
                f"Open Issues: {r['open_issues_count']}\n"
                f"Default Branch: {r['default_branch']}\n"
                f"License: {r['license']['name'] if r.get('license') else 'None'}\n"
                f"URL: {r['html_url']}\n"
                f"Created: {r['created_at']} | Updated: {r['updated_at']}\n"
            )
            return [TextContent(type="text", text=info)]

        elif name == "list_repo_files":
            path = arguments.get("path", "")
            data = github_get(
                f"/repos/{arguments['owner']}/{arguments['repo']}/contents/{path}"
            )
            if isinstance(data, dict):
                data = [data]
            lines = []
            for item in data:
                icon = "📁" if item["type"] == "dir" else "📄"
                lines.append(f"{icon} {item['name']}  ({item.get('size', 0)} bytes)")
            return [TextContent(type="text", text="\n".join(lines) or "(empty)")]

        elif name == "read_file":
            import base64
            data = github_get(
                f"/repos/{arguments['owner']}/{arguments['repo']}/contents/{arguments['path']}"
            )
            content = base64.b64decode(data["content"]).decode("utf-8")
            return [TextContent(type="text", text=content)]

        elif name == "list_issues":
            data = github_get(
                f"/repos/{arguments['owner']}/{arguments['repo']}/issues",
                {
                    "state": arguments.get("state", "open"),
                    "per_page": arguments.get("max_results", 10),
                },
            )
            lines = []
            for issue in data:
                lines.append(
                    f"#{issue['number']} [{issue['state'].upper()}] {issue['title']}\n"
                    f"   By: {issue['user']['login']} | Comments: {issue['comments']}\n"
                    f"   {issue['html_url']}\n"
                )
            return [TextContent(type="text", text="\n".join(lines) or "No issues found.")]

        elif name == "list_releases":
            data = github_get(
                f"/repos/{arguments['owner']}/{arguments['repo']}/releases",
                {"per_page": arguments.get("max_results", 5)},
            )
            lines = []
            for rel in data:
                lines.append(
                    f"🏷️ {rel['tag_name']} — {rel.get('name', '')}\n"
                    f"   Published: {rel['published_at']}\n"
                    f"   {rel['html_url']}\n"
                )
            return [TextContent(type="text", text="\n".join(lines) or "No releases found.")]

        elif name == "get_user":
            u = github_get(f"/users/{arguments['username']}")
            info = (
                f"👤 {u['login']} ({u.get('name', 'N/A')})\n"
                f"Bio: {u.get('bio', 'N/A')}\n"
                f"Public Repos: {u['public_repos']} | Followers: {u['followers']} | Following: {u['following']}\n"
                f"Location: {u.get('location', 'N/A')}\n"
                f"URL: {u['html_url']}\n"
            )
            return [TextContent(type="text", text=info)]

        elif name == "list_user_repos":
            data = github_get(
                f"/users/{arguments['username']}/repos",
                {
                    "sort": arguments.get("sort", "updated"),
                    "per_page": arguments.get("max_results", 10),
                },
            )
            lines = []
            for r in data:
                lines.append(
                    f"⭐ {r['stargazers_count']:,}  {r['name']}\n"
                    f"   {r.get('description', 'No description')}\n"
                    f"   Language: {r.get('language', 'N/A')} | {r['html_url']}\n"
                )
            return [TextContent(type="text", text="\n".join(lines) or "No repos found.")]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
