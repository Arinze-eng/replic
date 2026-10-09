"""
Web Search MCP Server
Uses DuckDuckGo — 100% free, no API key required.
Install: pip install duckduckgo-search
"""

import asyncio
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("websearch-mcp")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="search_web",
            description="Search the web using DuckDuckGo (free, no API key needed)",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "max_results": {
                        "type": "integer",
                        "description": "Max results to return (default: 5)",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="search_news",
            description="Search recent news articles using DuckDuckGo",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "News search query"},
                    "max_results": {
                        "type": "integer",
                        "description": "Max results to return (default: 5)",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="search_images",
            description="Search images using DuckDuckGo",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Image search query"},
                    "max_results": {
                        "type": "integer",
                        "description": "Max results to return (default: 5)",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="instant_answer",
            description="Get a DuckDuckGo instant answer for a query",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Query for instant answer"}
                },
                "required": ["query"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        from duckduckgo_search import DDGS

        ddgs = DDGS()

        if name == "search_web":
            query = arguments["query"]
            max_results = arguments.get("max_results", 5)
            results = list(ddgs.text(query, max_results=max_results))
            if not results:
                return [TextContent(type="text", text="No results found.")]
            output = []
            for i, r in enumerate(results, 1):
                output.append(
                    f"[{i}] {r.get('title', 'No title')}\n"
                    f"    URL: {r.get('href', 'N/A')}\n"
                    f"    {r.get('body', '')}\n"
                )
            return [TextContent(type="text", text="\n".join(output))]

        elif name == "search_news":
            query = arguments["query"]
            max_results = arguments.get("max_results", 5)
            results = list(ddgs.news(query, max_results=max_results))
            if not results:
                return [TextContent(type="text", text="No news found.")]
            output = []
            for i, r in enumerate(results, 1):
                output.append(
                    f"[{i}] {r.get('title', 'No title')}\n"
                    f"    Source: {r.get('source', 'N/A')} | Date: {r.get('date', 'N/A')}\n"
                    f"    URL: {r.get('url', 'N/A')}\n"
                    f"    {r.get('body', '')}\n"
                )
            return [TextContent(type="text", text="\n".join(output))]

        elif name == "search_images":
            query = arguments["query"]
            max_results = arguments.get("max_results", 5)
            results = list(ddgs.images(query, max_results=max_results))
            if not results:
                return [TextContent(type="text", text="No images found.")]
            output = []
            for i, r in enumerate(results, 1):
                output.append(
                    f"[{i}] {r.get('title', 'No title')}\n"
                    f"    Image URL: {r.get('image', 'N/A')}\n"
                    f"    Source: {r.get('url', 'N/A')}\n"
                )
            return [TextContent(type="text", text="\n".join(output))]

        elif name == "instant_answer":
            query = arguments["query"]
            results = ddgs.answers(query)
            answers = list(results)
            if not answers:
                return [TextContent(type="text", text="No instant answer found.")]
            a = answers[0]
            return [
                TextContent(
                    type="text",
                    text=f"Answer: {a.get('text', 'N/A')}\nURL: {a.get('url', 'N/A')}",
                )
            ]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except ImportError:
        return [
            TextContent(
                type="text",
                text="❌ Missing dependency. Run: pip install duckduckgo-search",
            )
        ]
    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
