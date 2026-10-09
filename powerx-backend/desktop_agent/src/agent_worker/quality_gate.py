"""Objective, bounded completion checks for the in-sandbox agent."""
from __future__ import annotations

import re

DB_WORDS = re.compile(r"\b(database|sqlite|sql|table|record|student result|query|row)\b", re.I)
CODE_WORDS = re.compile(r"\b(code|coding|repository|repo|bug|fix|implement|build|script|function|api|refactor)\b", re.I)
ARTIFACT_WORDS = re.compile(r"\b(write|create|edit|modify|generate|file|document|report|zip|pdf|docx|xlsx|pptx)\b", re.I)
NEGATIVE_DB_CLAIM = re.compile(r"\b(no (?:record|row|result|data)|not found|does not exist|nothing found)\b", re.I)
SUCCESS_TEST = re.compile(r"(?:EVIDENCE:(?:TEST|BUILD|SYNTAX)_PASSED|\b(?:tests?|build|lint|syntax)\b[^\n]{0,80}\b(?:pass(?:ed)?|success|ok|exit 0)\b)", re.I)


def classify(task: str) -> dict:
    text = task or ""
    return {
        "database": bool(DB_WORDS.search(text)),
        "coding": bool(CODE_WORDS.search(text)),
        "artifact": bool(ARTIFACT_WORDS.search(text)),
    }


def evaluate(task: str, trace: list[dict], attempted_final: str) -> str | None:
    """Return a corrective observation, or None when finish is supported."""
    kinds = classify(task)
    tools = [str(item.get("tool") or "").lower() for item in trace]
    evidence = "\n".join(str(item.get("result") or "") for item in trace[-40:])
    final = attempted_final or ""

    if kinds["database"]:
        used_db = any(tool in {"database", "db", "mcp_call"} for tool in tools)
        if not used_db:
            return "[CORRECTNESS GATE] Database task has no database tool evidence. Discover candidate databases, inspect schemas, and query the exact file before finishing."
        has_rows = "DATABASE_QUERY_VERIFIED" in evidence
        if NEGATIVE_DB_CLAIM.search(final) and not has_rows:
            empty_count = evidence.count("EMPTY_RESULT_REQUIRES_DIAGNOSIS")
            diagnosed = "DATABASE_DISCOVERY_COMPLETE" in evidence and "DATABASE_SCHEMA_INSPECTED" in evidence and empty_count >= 2
            if not diagnosed:
                return (
                    "[CORRECTNESS GATE] An empty query is not proof that no record exists. "
                    "Run database discovery, inspect the relevant schemas/sample rows, then try at least two materially different searches "
                    "(normalized case/whitespace/type and related-table joins). Finish only with real rows or documented diagnostic evidence."
                )

    if kinds["coding"]:
        mutated = any(tool in {"write_file", "edit_file", "write", "edit", "coding"} for tool in tools) or "FILE_WRITTEN" in evidence
        if not mutated:
            return "[CORRECTNESS GATE] Coding task has no code/file modification evidence. Read the repository, implement the complete change, then test it."
        verified = bool(SUCCESS_TEST.search(evidence)) or any(
            tool in {"run_code", "bash"} and not re.search(r"\[(?:exit [1-9]|timed out|shell error)\]", str(item.get("result") or ""), re.I)
            for tool, item in zip(tools, trace)
        )
        if not verified:
            return "[CORRECTNESS GATE] Code was changed but no successful syntax/test/build evidence exists. Run the relevant checks, fix failures, and retry before finishing."

    if kinds["artifact"] and not any(tool in {"write_file", "edit_file", "write", "edit", "make_zip", "create_pdf", "create_docx", "create_presentation", "create_slides"} for tool in tools):
        return "[CORRECTNESS GATE] The request requires a concrete artifact, but no file-producing tool succeeded. Create and inspect the requested output before finishing."
    return None
