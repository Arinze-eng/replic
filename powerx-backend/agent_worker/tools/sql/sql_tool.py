"""sql_tool.py — Simple SQL query interface (delegates to database tool)."""

import os
import re
import subprocess


def run(ctx, args):
    query = args.get("query", "")
    fmt = args.get("format", "table")

    if not query:
        return {"error": "No query provided", "rows": [], "columns": []}

    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    db_password = os.environ.get("SUPABASE_DB_PASSWORD", "")

    if supabase_url and service_key:
        ref_match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
        if ref_match:
            ref = ref_match.group(1)
            db_url = f"postgresql://postgres:{db_password}@db.{ref}.supabase.co:5432/postgres"
            try:
                if fmt == "json":
                    result = subprocess.run(
                        f'psql "{db_url}" -c {_q(query)} -t --csv 2>&1',
                        shell=True, capture_output=True, text=True, timeout=30,
                    )
                else:
                    result = subprocess.run(
                        f'psql "{db_url}" -c {_q(query)} 2>&1',
                        shell=True, capture_output=True, text=True, timeout=30,
                    )
                return {
                    "stdout": result.stdout[:20000],
                    "stderr": result.stderr[:2000],
                    "exit_code": result.returncode,
                }
            except subprocess.TimeoutExpired:
                return {"error": "Query timed out"}
            except Exception as e:
                return {"error": str(e)}
        else:
            return {"error": "Could not parse Supabase URL"}
    else:
        return {"error": "No Supabase credentials configured in environment"}


def _q(s):
    return "'" + s.replace("'", "'\\''") + "'"