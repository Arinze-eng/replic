"""Evidence-first SQLite/database tool.

SQLite work is delegated to database_intelligence.py so discovery, schema
inspection, reads, and writes follow the same rules as the direct worker tool.
Remote PostgreSQL remains available through psql when an explicit db_url is
provided; credentials are never echoed in the result.
"""
import os
import subprocess
import sys

TOOLS_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if TOOLS_ROOT not in sys.path:
    sys.path.insert(0, TOOLS_ROOT)

from database_intelligence import execute  # noqa: E402


def run(ctx, args):
    db_url = str(args.get("db_url") or args.get("url") or "").strip()
    if db_url:
        sql = str(args.get("sql") or args.get("query") or "").strip()
        if not sql:
            return {"ok": False, "error": "No SQL provided"}
        if not db_url.lower().startswith(("postgres://", "postgresql://")):
            return {"ok": False, "error": "Only explicit PostgreSQL URLs are supported here; use db/database for SQLite"}
        try:
            completed = subprocess.run(
                ["psql", db_url, "-v", "ON_ERROR_STOP=1", "-A", "-F", "\t", "-c", sql],
                capture_output=True,
                text=True,
                timeout=60,
            )
            return {
                "ok": completed.returncode == 0,
                "engine": "postgresql",
                "stdout": completed.stdout[:20000],
                "stderr": completed.stderr[:4000],
                "exit_code": completed.returncode,
                "evidence": "REMOTE_DATABASE_QUERY_VERIFIED" if completed.returncode == 0 else "REMOTE_DATABASE_QUERY_FAILED",
            }
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Query timed out", "evidence": "REMOTE_DATABASE_QUERY_TIMEOUT"}
        except Exception as exc:
            return {"ok": False, "error": str(exc), "evidence": "REMOTE_DATABASE_QUERY_FAILED"}

    return execute(dict(args), ctx.work_dir)
