#!/usr/bin/env python3
"""Evidence-first SQLite discovery and query execution for the autonomous agent.

Read operations never create a database.  Every result identifies the exact file,
its schema, and enough diagnostics to distinguish "no matching row" from "I
opened the wrong empty file".  The module is dependency-free and can be called
from agent.py or as a small JSON CLI inside any sandbox.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from pathlib import Path

SQLITE_HEADER = b"SQLite format 3\x00"
READ_PREFIXES = {"select", "pragma", "with", "explain"}
DB_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".db3"}
SKIP_DIRS = {".git", "node_modules", ".agent_inbox", ".agent_outbox", ".agent_bridge"}


def _first_keyword(sql: str) -> str:
    cleaned = re.sub(r"(?s)^\s*(?:--[^\n]*\n|/\*.*?\*/\s*)*", "", sql or "")
    match = re.match(r"([A-Za-z]+)", cleaned)
    return match.group(1).lower() if match else ""


def is_read_query(sql: str) -> bool:
    return _first_keyword(sql) in READ_PREFIXES


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_db_path(work_dir: str, value: str) -> Path:
    root = Path(work_dir).resolve()
    raw = Path(value or "")
    candidate = raw.resolve() if raw.is_absolute() else (root / raw).resolve()
    if not _inside(root, candidate):
        raise ValueError(f"database path escapes the workspace: {value}")
    return candidate


def _looks_like_sqlite(path: Path) -> bool:
    try:
        if not path.is_file():
            return False
        # sqlite3 creates a zero-byte file before the first schema write. Treat
        # extension-bearing zero-byte files as valid empty candidates/decoys.
        if path.stat().st_size == 0 and path.suffix.lower() in DB_SUFFIXES:
            return True
        if path.stat().st_size < len(SQLITE_HEADER):
            return False
        with path.open("rb") as fh:
            return fh.read(len(SQLITE_HEADER)) == SQLITE_HEADER
    except OSError:
        return False


def _quote_identifier(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def inspect_database(path: Path, include_schema: bool = True) -> dict:
    uri = f"file:{path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        quick = conn.execute("PRAGMA quick_check").fetchone()[0]
        objects = conn.execute(
            "SELECT name, type, sql FROM sqlite_master "
            "WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        tables = []
        total_rows = 0
        for obj in objects:
            name = obj["name"]
            columns = []
            if include_schema:
                columns = [dict(row) for row in conn.execute(
                    f"PRAGMA table_info({_quote_identifier(name)})"
                ).fetchall()]
            count = None
            try:
                count = int(conn.execute(
                    f"SELECT COUNT(*) FROM {_quote_identifier(name)}"
                ).fetchone()[0])
                total_rows += count
            except sqlite3.Error:
                pass
            tables.append({
                "name": name,
                "type": obj["type"],
                "row_count": count,
                "columns": columns,
                "sql": obj["sql"] if include_schema else None,
            })
        return {
            "path": str(path),
            "size_bytes": path.stat().st_size,
            "quick_check": quick,
            "table_count": len(tables),
            "total_rows": total_rows,
            "tables": tables,
        }
    finally:
        conn.close()


def discover_databases(work_dir: str, max_files: int = 100) -> list[dict]:
    root = Path(work_dir).resolve()
    candidates = []
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for filename in files:
            path = Path(current) / filename
            if path.suffix.lower() not in DB_SUFFIXES and not _looks_like_sqlite(path):
                continue
            if not _looks_like_sqlite(path):
                continue
            try:
                info = inspect_database(path, include_schema=True)
            except (OSError, sqlite3.Error) as exc:
                info = {"path": str(path), "error": str(exc), "table_count": 0, "total_rows": 0}
            info["relative_path"] = str(path.relative_to(root))
            # Prefer real populated databases over empty decoys and backups.
            info["score"] = (
                int(info.get("total_rows") or 0) * 10
                + int(info.get("table_count") or 0) * 100
                + min(int(info.get("size_bytes") or 0) // 1024, 1000)
                - (200 if re.search(r"(?:empty|blank|test|backup|old)", filename, re.I) else 0)
            )
            candidates.append(info)
            if len(candidates) >= max_files:
                break
        if len(candidates) >= max_files:
            break
    return sorted(candidates, key=lambda item: (-item.get("score", 0), item.get("relative_path", "")))


def execute(payload: dict, work_dir: str) -> dict:
    action = str(payload.get("action") or "query").lower()
    sql = str(payload.get("sql") or payload.get("query") or "").strip()
    db_value = str(payload.get("db") or payload.get("database") or payload.get("file") or "").strip()

    if action in {"discover", "scan", "find", "inspect_all"}:
        candidates = discover_databases(work_dir)
        return {
            "ok": True,
            "action": "discover",
            "workspace": str(Path(work_dir).resolve()),
            "candidate_count": len(candidates),
            "candidates": candidates,
            "evidence": "DATABASE_DISCOVERY_COMPLETE",
        }

    candidates = discover_databases(work_dir)
    if not db_value:
        if len(candidates) == 1:
            db_value = candidates[0]["relative_path"]
        else:
            return {
                "ok": False,
                "error": "database path is required because discovery found zero or multiple candidates",
                "candidate_count": len(candidates),
                "candidates": candidates,
                "next_action": "inspect the ranked candidates and retry with the exact relative_path",
                "evidence": "DATABASE_TARGET_UNRESOLVED",
            }

    path = resolve_db_path(work_dir, db_value)
    read_only = is_read_query(sql) or action in {"inspect", "schema", "tables"}
    if read_only and not path.exists():
        return {
            "ok": False,
            "error": f"refusing to create a database during a read: {db_value}",
            "resolved_path": str(path),
            "candidates": candidates,
            "evidence": "WRONG_DATABASE_PATH_BLOCKED",
        }
    if path.exists() and not _looks_like_sqlite(path):
        return {"ok": False, "error": f"not a valid SQLite database: {db_value}", "resolved_path": str(path)}

    if action in {"inspect", "schema", "tables"}:
        return {"ok": True, "action": "inspect", "database": inspect_database(path), "evidence": "DATABASE_SCHEMA_INSPECTED"}
    if not sql:
        return {"ok": False, "error": "no SQL provided", "candidates": candidates}

    path.parent.mkdir(parents=True, exist_ok=True)
    uri = f"file:{path.as_posix()}?mode=ro" if read_only else str(path)
    conn = sqlite3.connect(uri, uri=read_only)
    conn.row_factory = sqlite3.Row
    params = payload.get("params") or []
    try:
        cur = conn.execute(sql, params)
        if cur.description:
            rows = [dict(row) for row in cur.fetchmany(int(payload.get("limit") or 500))]
            schema = inspect_database(path)
            result = {
                "ok": True,
                "action": "query",
                "database": schema,
                "sql": sql,
                "row_count": len(rows),
                "rows": rows,
                "evidence": "DATABASE_QUERY_VERIFIED" if rows else "EMPTY_RESULT_REQUIRES_DIAGNOSIS",
            }
            if not rows:
                result["diagnosis"] = {
                    "message": "The query returned zero rows; this is not proof that the requested record does not exist.",
                    "required_checks": [
                        "confirm this is the highest-ranked populated database",
                        "inspect relevant table schemas and sample rows",
                        "retry case/whitespace/type-normalized matching",
                        "check related tables/views and required joins",
                    ],
                    "other_candidates": [c for c in candidates if c.get("relative_path") != db_value],
                }
            return result
        conn.commit()
        return {
            "ok": True,
            "action": "write",
            "database": str(path),
            "changes": cur.rowcount,
            "last_row_id": cur.lastrowid,
            "evidence": "DATABASE_WRITE_COMMITTED",
        }
    except sqlite3.Error as exc:
        return {
            "ok": False,
            "error": str(exc),
            "database": str(path),
            "schema": inspect_database(path) if path.exists() and _looks_like_sqlite(path) else None,
            "evidence": "DATABASE_QUERY_FAILED",
        }
    finally:
        conn.close()


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        work_dir = payload.pop("work_dir", os.environ.get("AGENT_WORK", os.getcwd()))
        print(json.dumps(execute(payload, work_dir), ensure_ascii=False, default=str))
        return 0
    except Exception as exc:  # pragma: no cover - outer safety net
        print(json.dumps({"ok": False, "error": str(exc), "evidence": "DATABASE_TOOL_CRASHED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
