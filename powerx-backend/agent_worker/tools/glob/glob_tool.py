"""glob_tool.py — Enterprise file globbing tool."""

import os
import fnmatch


def run(ctx, args):
    pattern = args.get("pattern", "**/*")
    base_dir = args.get("base_dir", ".")

    base = ctx._resolve(base_dir)
    if not os.path.isdir(base):
        return {"error": f"Directory not found: {base_dir}", "matches": []}

    matches = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        rel_root = os.path.relpath(root, base)
        for f in files:
            rel = os.path.join(rel_root, f) if rel_root != "." else f
            if fnmatch.fnmatch(rel, pattern):
                size = os.path.getsize(os.path.join(root, f))
                matches.append({"path": rel, "size": size})

    return {
        "pattern": pattern,
        "base_dir": base_dir,
        "total": len(matches),
        "matches": matches[:1000],
    }