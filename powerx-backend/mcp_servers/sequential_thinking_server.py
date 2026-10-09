"""
Sequential Thinking MCP Server (Free, No API Key, No Dependencies)
Dynamic and reflective problem-solving through structured thought sequences.
Helps AI break complex problems into clear, trackable steps.
Requires: pip install mcp
"""

import asyncio
import json
from datetime import datetime
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

server = Server("sequential-thinking-mcp")

# In-memory store for active thought sequences
_sequences: dict[str, dict] = {}


def _new_id() -> str:
    import uuid
    return str(uuid.uuid4())[:8]


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="think_step",
            description=(
                "Add a single thought step to a reasoning sequence. "
                "Use this to break down a complex problem one step at a time. "
                "Returns the current state of the sequence."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "thought": {
                        "type": "string",
                        "description": "The current thought or reasoning step",
                    },
                    "sequence_id": {
                        "type": "string",
                        "description": "ID of an existing sequence to continue (omit to start new)",
                    },
                    "step_type": {
                        "type": "string",
                        "description": "Type of step: observe, analyze, hypothesize, verify, conclude, revise",
                        "enum": ["observe", "analyze", "hypothesize", "verify", "conclude", "revise"],
                        "default": "analyze",
                    },
                    "is_revision": {
                        "type": "boolean",
                        "description": "True if this step revises a previous thought",
                        "default": False,
                    },
                    "revises_step": {
                        "type": "integer",
                        "description": "Which step number is being revised (1-indexed)",
                    },
                },
                "required": ["thought"],
            },
        ),
        Tool(
            name="think_sequence",
            description=(
                "Submit an entire reasoning sequence at once as a list of thoughts. "
                "Useful when you want to plan out all steps together."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "problem": {
                        "type": "string",
                        "description": "The problem or question being reasoned about",
                    },
                    "thoughts": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Ordered list of reasoning steps",
                    },
                },
                "required": ["problem", "thoughts"],
            },
        ),
        Tool(
            name="get_sequence",
            description="Retrieve the full thought sequence by ID",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence_id": {"type": "string", "description": "Sequence ID to retrieve"}
                },
                "required": ["sequence_id"],
            },
        ),
        Tool(
            name="list_sequences",
            description="List all active thought sequences",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="conclude_sequence",
            description="Mark a thought sequence as complete and provide a final conclusion",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence_id": {"type": "string"},
                    "conclusion": {
                        "type": "string",
                        "description": "The final conclusion or answer reached",
                    },
                },
                "required": ["sequence_id", "conclusion"],
            },
        ),
        Tool(
            name="branch_sequence",
            description="Create a new branch from an existing sequence to explore an alternative path",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence_id": {"type": "string", "description": "Source sequence to branch from"},
                    "from_step": {
                        "type": "integer",
                        "description": "Step number to branch from (1-indexed)",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Why this alternative branch is being explored",
                    },
                },
                "required": ["sequence_id", "from_step", "reason"],
            },
        ),
        Tool(
            name="clear_sequence",
            description="Delete a thought sequence from memory",
            inputSchema={
                "type": "object",
                "properties": {
                    "sequence_id": {"type": "string"}
                },
                "required": ["sequence_id"],
            },
        ),
    ]


def _format_sequence(seq: dict) -> str:
    lines = [
        f"Sequence ID : {seq['id']}",
        f"Problem     : {seq.get('problem', '(none)')}",
        f"Status      : {seq['status']}",
        f"Created     : {seq['created_at']}",
        f"Steps       : {len(seq['steps'])}",
        "",
    ]
    for i, step in enumerate(seq["steps"], 1):
        prefix = f"[{i}]"
        tag = f"({step['type'].upper()})"
        revision_note = f" ← revises step {step['revises_step']}" if step.get("is_revision") else ""
        lines.append(f"{prefix} {tag}{revision_note}")
        lines.append(f"    {step['thought']}")
        lines.append("")
    if seq.get("conclusion"):
        lines.append(f"✅ CONCLUSION: {seq['conclusion']}")
    return "\n".join(lines)


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    try:
        if name == "think_step":
            seq_id = arguments.get("sequence_id")
            if seq_id and seq_id in _sequences:
                seq = _sequences[seq_id]
            else:
                seq_id = _new_id()
                seq = {
                    "id": seq_id,
                    "problem": "",
                    "status": "active",
                    "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "steps": [],
                    "conclusion": None,
                }
                _sequences[seq_id] = seq

            step = {
                "thought": arguments["thought"],
                "type": arguments.get("step_type", "analyze"),
                "is_revision": arguments.get("is_revision", False),
                "revises_step": arguments.get("revises_step"),
            }
            seq["steps"].append(step)

            summary = (
                f"✅ Step {len(seq['steps'])} added to sequence [{seq_id}]\n\n"
                + _format_sequence(seq)
            )
            return [TextContent(type="text", text=summary)]

        elif name == "think_sequence":
            seq_id = _new_id()
            thoughts = arguments["thoughts"]
            steps = [{"thought": t, "type": "analyze", "is_revision": False, "revises_step": None} for t in thoughts]
            seq = {
                "id": seq_id,
                "problem": arguments["problem"],
                "status": "active",
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "steps": steps,
                "conclusion": None,
            }
            _sequences[seq_id] = seq
            return [TextContent(type="text", text=f"✅ Sequence created with {len(steps)} steps.\n\n" + _format_sequence(seq))]

        elif name == "get_sequence":
            seq_id = arguments["sequence_id"]
            if seq_id not in _sequences:
                return [TextContent(type="text", text=f"❌ Sequence '{seq_id}' not found.")]
            return [TextContent(type="text", text=_format_sequence(_sequences[seq_id]))]

        elif name == "list_sequences":
            if not _sequences:
                return [TextContent(type="text", text="No active sequences.")]
            lines = []
            for seq in _sequences.values():
                status_icon = "✅" if seq["status"] == "concluded" else "🔄"
                lines.append(
                    f"{status_icon} [{seq['id']}] {len(seq['steps'])} steps | "
                    f"{seq['status']} | {seq.get('problem', '(no problem set)')[:60]}"
                )
            return [TextContent(type="text", text="\n".join(lines))]

        elif name == "conclude_sequence":
            seq_id = arguments["sequence_id"]
            if seq_id not in _sequences:
                return [TextContent(type="text", text=f"❌ Sequence '{seq_id}' not found.")]
            _sequences[seq_id]["conclusion"] = arguments["conclusion"]
            _sequences[seq_id]["status"] = "concluded"
            return [TextContent(type="text", text="✅ Sequence concluded.\n\n" + _format_sequence(_sequences[seq_id]))]

        elif name == "branch_sequence":
            seq_id = arguments["sequence_id"]
            if seq_id not in _sequences:
                return [TextContent(type="text", text=f"❌ Sequence '{seq_id}' not found.")]
            original = _sequences[seq_id]
            from_step = arguments["from_step"]
            new_id = _new_id()
            branched_steps = original["steps"][:from_step]
            branched_steps.append({
                "thought": f"[BRANCH] {arguments['reason']}",
                "type": "analyze",
                "is_revision": False,
                "revises_step": None,
            })
            new_seq = {
                "id": new_id,
                "problem": f"Branch of [{seq_id}] from step {from_step}: {arguments['reason']}",
                "status": "active",
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "steps": branched_steps,
                "conclusion": None,
            }
            _sequences[new_id] = new_seq
            return [TextContent(type="text", text=f"✅ Branch created as [{new_id}]\n\n" + _format_sequence(new_seq))]

        elif name == "clear_sequence":
            seq_id = arguments["sequence_id"]
            if seq_id in _sequences:
                del _sequences[seq_id]
                return [TextContent(type="text", text=f"🗑️ Sequence [{seq_id}] deleted.")]
            return [TextContent(type="text", text=f"❌ Sequence '{seq_id}' not found.")]

        else:
            return [TextContent(type="text", text=f"❌ Unknown tool: {name}")]

    except Exception as e:
        return [TextContent(type="text", text=f"❌ Error: {str(e)}")]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
