"""write_tool.py — Write content to files (any extension)."""

import os


def run(ctx, args):
    path = args.get("path", "")
    content = args.get("content", "")
    append = args.get("append", False)

    if not path:
        return {"error": "No path provided", "written": False}

    # Prevent path traversal
    abspath = ctx._resolve(path)
    os.makedirs(os.path.dirname(abspath), exist_ok=True)

    mode = "a" if append else "w"
    with open(abspath, mode, encoding="utf-8") as f:
        f.write(content)

    stat = os.stat(abspath)
    ext = os.path.splitext(path)[1].lower() if "." in path else ""

    return {
        "path": path,
        "size": stat.st_size,
        "extension": ext,
        "written": True,
        "append": append,
    }