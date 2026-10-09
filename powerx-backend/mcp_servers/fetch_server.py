"""
Fetch / HTTP MCP Server
Make GET, POST, PUT, DELETE HTTP requests. Uses only Python built-ins.
No extra dependencies required.
"""

import asyncio
import json
import urllib.request
import urllib.parse
import urllib.error
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("fetch-mcp")


def make_request(
    method: str,
    url: str,
    headers: dict = None,
    body: str = None,
    timeout: int = 15,
) -> tuple[int, dict, str]:
    req = urllib.request.Request(url, method=method.upper())
    req.add_header("User-Agent", "mcp-fetch-server/1.0")

    if headers:
        for k, v in headers.items():
            req.add_header(k, v)

    data = body.encode("utf-8") if body else None

    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
            status = resp.status
            resp_headers = dict(resp.headers)
            content = resp.read().decode("utf-8", errors="replace")
            return status, resp_headers, content
    except urllib.error.HTTPError as e:
        content = e.read().decode("utf-8", errors="replace")
        return e.code, {}, content


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="fetch_get",
            description="Send an HTTP GET request to a URL",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Target URL"},
                    "headers": {
                        "type": "object",
                        "description": "Optional request headers",
                        "default": {},
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 15)",
                        "default": 15,
                    },
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="fetch_post",
            description="Send an HTTP POST request with a JSON or text body",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "body": {
                        "type": "object",
                        "description": "JSON body to send (will be serialized)",
                    },
                    "body_text": {
                        "type": "string",
                        "description": "Raw text body (use instead of body for non-JSON)",
                    },
                    "headers": {"type": "object", "default": {}},
                    "timeout": {"type": "integer", "default": 15},
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="fetch_put",
            description="Send an HTTP PUT request",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "body": {"type": "object", "description": "JSON body"},
                    "headers": {"type": "object", "default": {}},
                    "timeout": {"type": "integer", "default": 15},
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="fetch_delete",
            description="Send an HTTP DELETE request",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "headers": {"type": "object", "default": {}},
                    "timeout": {"type": "integer", "default": 15},
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="fetch_head",
            description="Send an HTTP HEAD request (returns only headers, no body)",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "headers": {"type": "object", "default": {}},
                },
                "required": ["url"],
            },
        ),
        Tool(
            name="download_file",
            description="Download a file from a URL and save it to disk",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "File URL to download"},
                    "save_path": {
                        "type": "string",
                        "description": "Local path to save the file",
                    },
                    "timeout": {"type": "integer", "default": 30},
                },
                "required": ["url", "save_path"],
            },
        ),
        Tool(
            name="parse_json_api",
            description="Fetch a JSON API endpoint and return parsed, pretty-printed output",
            inputSchema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "JSON API URL"},
                    "headers": {"type": "object", "default": {}},
                    "json_path": {
                        "type": "string",
                        "description": "Optional dot-notation path to extract (e.g. 'data.users')",
                    },
                },
                "required": ["url"],
            },
        ),
    ]


def format_response(status: int, headers: dict, body: str, show_headers: bool = False) -> str:
    lines = [f"Status: {status}"]
    if show_headers:
        for k, v in list(headers.items())[:10]:
            lines.append(f"{k}: {v}")
    lines.append("")

    # Try to pretty-print if JSON
    try:
        parsed = json.loads(body)
        lines.append(json.dumps(parsed, indent=2))
    except Exception:
        lines.append(body[:3000] + ("..." if len(body) > 3000 else ""))

    return "\n".join(lines)


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "fetch_get":
            status, headers, body = make_request(
                "GET",
                arguments["url"],
                headers=arguments.get("headers"),
                timeout=arguments.get("timeout", 15),
            )
            return [TextContent(type="text", text=format_response(status, headers, body))]

        elif name == "fetch_post":
            headers = arguments.get("headers", {})
            if "body" in arguments:
                body_str = json.dumps(arguments["body"])
                headers.setdefault("Content-Type", "application/json")
            else:
                body_str = arguments.get("body_text", "")

            status, resp_headers, resp_body = make_request(
                "POST",
                arguments["url"],
                headers=headers,
                body=body_str,
                timeout=arguments.get("timeout", 15),
            )
            return [TextContent(type="text", text=format_response(status, resp_headers, resp_body))]

        elif name == "fetch_put":
            headers = arguments.get("headers", {})
            body_str = json.dumps(arguments.get("body", {}))
            headers.setdefault("Content-Type", "application/json")
            status, resp_headers, resp_body = make_request(
                "PUT",
                arguments["url"],
                headers=headers,
                body=body_str,
                timeout=arguments.get("timeout", 15),
            )
            return [TextContent(type="text", text=format_response(status, resp_headers, resp_body))]

        elif name == "fetch_delete":
            status, resp_headers, resp_body = make_request(
                "DELETE",
                arguments["url"],
                headers=arguments.get("headers"),
                timeout=arguments.get("timeout", 15),
            )
            return [TextContent(type="text", text=format_response(status, resp_headers, resp_body))]

        elif name == "fetch_head":
            req = urllib.request.Request(arguments["url"], method="HEAD")
            for k, v in (arguments.get("headers") or {}).items():
                req.add_header(k, v)
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    lines = [f"Status: {resp.status}"]
                    for k, v in resp.headers.items():
                        lines.append(f"{k}: {v}")
                    return [TextContent(type="text", text="\n".join(lines))]
            except urllib.error.HTTPError as e:
                return [TextContent(type="text", text=f"Status: {e.code}")]

        elif name == "download_file":
            url = arguments["url"]
            save_path = arguments["save_path"]
            timeout = arguments.get("timeout", 30)
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "mcp-fetch-server/1.0")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
            with open(save_path, "wb") as f:
                f.write(data)
            return [TextContent(type="text", text=f"✅ Downloaded {len(data):,} bytes → {save_path}")]

        elif name == "parse_json_api":
            status, headers, body = make_request(
                "GET",
                arguments["url"],
                headers=arguments.get("headers"),
            )
            parsed = json.loads(body)

            # Navigate dot-notation path if provided
            if "json_path" in arguments and arguments["json_path"]:
                for key in arguments["json_path"].split("."):
                    if isinstance(parsed, dict):
                        parsed = parsed[key]
                    elif isinstance(parsed, list):
                        parsed = parsed[int(key)]

            return [TextContent(type="text", text=json.dumps(parsed, indent=2))]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
