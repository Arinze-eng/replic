"""
SQLite MCP Server
Full SQLite database access — 100% built-in, no extra dependencies.
"""

import asyncio
import sqlite3
import json
import os
import re
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("sqlite-mcp")


def get_db(path: str, read_only: bool = False) -> sqlite3.Connection:
    """Open SQLite without silently creating a file for read operations."""
    if not path:
        raise ValueError("database path is required")
    resolved = os.path.abspath(path)
    if read_only:
        if not os.path.isfile(resolved):
            raise FileNotFoundError(
                f"database not found: {path}; refusing to create an empty database during a read"
            )
        conn = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
    else:
        os.makedirs(os.path.dirname(resolved) or ".", exist_ok=True)
        conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    return conn


def rows_to_text(cursor: sqlite3.Cursor) -> str:
    rows = cursor.fetchall()
    if not rows:
        return "(no rows returned)"
    cols = [d[0] for d in cursor.description]
    lines = [" | ".join(cols)]
    lines.append("-" * len(lines[0]))
    for row in rows:
        lines.append(" | ".join(str(v) if v is not None else "NULL" for v in row))
    lines.append(f"\n({len(rows)} row{'s' if len(rows) != 1 else ''})")
    return "\n".join(lines)


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="execute_query",
            description="Run any SQL query (SELECT, INSERT, UPDATE, DELETE, CREATE, etc.)",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Path to the .db file"},
                    "sql": {"type": "string", "description": "SQL statement to execute"},
                    "params": {
                        "type": "array",
                        "description": "Optional list of query parameters",
                        "items": {},
                        "default": [],
                    },
                },
                "required": ["database", "sql"],
            },
        ),
        Tool(
            name="list_tables",
            description="List all tables in a SQLite database",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Path to the .db file"}
                },
                "required": ["database"],
            },
        ),
        Tool(
            name="describe_table",
            description="Show the schema/columns of a table",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Path to the .db file"},
                    "table": {"type": "string", "description": "Table name"},
                },
                "required": ["database", "table"],
            },
        ),
        Tool(
            name="create_table",
            description="Create a new table with specified columns",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "Path to the .db file"},
                    "table": {"type": "string", "description": "Table name"},
                    "columns": {
                        "type": "array",
                        "description": "List of column definitions e.g. ['id INTEGER PRIMARY KEY', 'name TEXT']",
                        "items": {"type": "string"},
                    },
                },
                "required": ["database", "table", "columns"],
            },
        ),
        Tool(
            name="insert_row",
            description="Insert a row into a table",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                    "data": {
                        "type": "object",
                        "description": "Key-value pairs of column: value",
                    },
                },
                "required": ["database", "table", "data"],
            },
        ),
        Tool(
            name="select_rows",
            description="Query rows from a table with optional filtering",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                    "where": {
                        "type": "string",
                        "description": "Optional WHERE clause (without the WHERE keyword)",
                    },
                    "limit": {"type": "integer", "default": 50},
                },
                "required": ["database", "table"],
            },
        ),
        Tool(
            name="delete_rows",
            description="Delete rows from a table matching a condition",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                    "where": {
                        "type": "string",
                        "description": "WHERE clause (without WHERE keyword)",
                    },
                },
                "required": ["database", "table", "where"],
            },
        ),
        Tool(
            name="drop_table",
            description="Drop (delete) a table permanently",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                },
                "required": ["database", "table"],
            },
        ),
        Tool(
            name="export_table_json",
            description="Export a table as JSON",
            inputSchema={
                "type": "object",
                "properties": {
                    "database": {"type": "string"},
                    "table": {"type": "string"},
                },
                "required": ["database", "table"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        db_path = arguments.get("database", "")

        if name == "execute_query":
            sql = arguments["sql"]
            read_only = bool(re.match(r"^\s*(select|pragma|with|explain)\b", sql, re.I))
            conn = get_db(db_path, read_only=read_only)
            cur = conn.execute(sql, arguments.get("params", []))
            conn.commit()
            if cur.description:
                result = rows_to_text(cur)
            else:
                result = f"✅ Query OK — {cur.rowcount} row(s) affected."
            conn.close()
            return [TextContent(type="text", text=result)]

        elif name == "list_tables":
            conn = get_db(db_path, read_only=True)
            cur = conn.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
            rows = cur.fetchall()
            conn.close()
            if not rows:
                return [TextContent(type="text", text="(no tables found)")]
            lines = [f"{'📊' if r['type']=='table' else '👁️'} {r['name']}" for r in rows]
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "describe_table":
            conn = get_db(db_path, read_only=True)
            cur = conn.execute(f"PRAGMA table_info({arguments['table']})")
            rows = cur.fetchall()
            conn.close()
            if not rows:
                return [TextContent(type="text", text="Table not found or has no columns.")]
            lines = ["cid | name | type | notnull | default | pk"]
            lines.append("-" * 50)
            for r in rows:
                lines.append(f"{r['cid']} | {r['name']} | {r['type']} | {r['notnull']} | {r['dflt_value']} | {r['pk']}")
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "create_table":
            cols = ", ".join(arguments["columns"])
            sql = f"CREATE TABLE IF NOT EXISTS {arguments['table']} ({cols})"
            conn = get_db(db_path)
            conn.execute(sql)
            conn.commit()
            conn.close()
            return [TextContent(type="text", text=f"✅ Table '{arguments['table']}' created.")]

        elif name == "insert_row":
            data = arguments["data"]
            cols = ", ".join(data.keys())
            placeholders = ", ".join(["?" for _ in data])
            sql = f"INSERT INTO {arguments['table']} ({cols}) VALUES ({placeholders})"
            conn = get_db(db_path)
            cur = conn.execute(sql, list(data.values()))
            conn.commit()
            row_id = cur.lastrowid
            conn.close()
            return [TextContent(type="text", text=f"✅ Inserted row with id={row_id}.")]

        elif name == "select_rows":
            limit = arguments.get("limit", 50)
            sql = f"SELECT * FROM {arguments['table']}"
            if arguments.get("where"):
                sql += f" WHERE {arguments['where']}"
            sql += f" LIMIT {limit}"
            conn = get_db(db_path, read_only=True)
            cur = conn.execute(sql)
            result = rows_to_text(cur)
            conn.close()
            return [TextContent(type="text", text=result)]

        elif name == "delete_rows":
            sql = f"DELETE FROM {arguments['table']} WHERE {arguments['where']}"
            conn = get_db(db_path)
            cur = conn.execute(sql)
            conn.commit()
            count = cur.rowcount
            conn.close()
            return [TextContent(type="text", text=f"🗑️ Deleted {count} row(s).")]

        elif name == "drop_table":
            conn = get_db(db_path)
            conn.execute(f"DROP TABLE IF EXISTS {arguments['table']}")
            conn.commit()
            conn.close()
            return [TextContent(type="text", text=f"🗑️ Table '{arguments['table']}' dropped.")]

        elif name == "export_table_json":
            resolved = os.path.abspath(db_path)
            if not os.path.isfile(resolved):
                raise FileNotFoundError(f"database not found: {db_path}; refusing to create it during export")
            conn = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            cur = conn.execute(f"SELECT * FROM {arguments['table']}")
            rows = [dict(r) for r in cur.fetchall()]
            conn.close()
            return [TextContent(type="text", text=json.dumps(rows, indent=2, default=str))]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
