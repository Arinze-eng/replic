"""grep_tool.py — Enterprise regex search across files."""

import os
import re
import fnmatch


def run(ctx, args):
    pattern = args.get("pattern", "")
    glob_pattern = args.get("glob", "*")
    max_results = int(args.get("max_results", 100))

    if not pattern:
        return {"error": "No pattern provided", "results": []}

    try:
        compiled = re.compile(pattern, re.MULTILINE | re.DOTALL)
    except re.error as e:
        return {"error": f"Invalid regex: {e}", "results": []}

    results = []
    for root, dirs, files in os.walk(ctx.work_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if len(results) >= max_results:
                break
            if not fnmatch.fnmatch(f, glob_pattern) and not fnmatch.fnmatch(os.path.join(root, f), glob_pattern):
                continue
            fpath = os.path.join(root, f)
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as fh:
                    for i, line in enumerate(fh, 1):
                        if compiled.search(line):
                            rel = os.path.relpath(fpath, ctx.work_dir)
                            results.append({
                                "file": rel, "line": i,
                                "match": line.rstrip()[:200],
                            })
                            if len(results) >= max_results:
                                break
            except Exception:
                continue

    return {"pattern": pattern, "total": len(results), "results": results}