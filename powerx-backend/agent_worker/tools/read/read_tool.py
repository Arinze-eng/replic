"""read_tool.py — Read file content from the work directory."""

import os
import base64


def run(ctx, args):
    path = args.get("path", "")
    max_length = int(args.get("max_length", 0)) or None
    binary = args.get("binary", False)

    if not path:
        return {"error": "No path provided"}

    abspath = ctx._resolve(path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {path}"}

    stat = os.stat(abspath)
    ext = os.path.splitext(path)[1].lower() if "." in path else ""

    if binary:
        with open(abspath, "rb") as f:
            data = f.read()
        content = base64.b64encode(data).decode("ascii")
        return {
            "path": path,
            "size": stat.st_size,
            "extension": ext,
            "content_base64": content,
            "binary": True,
        }

    with open(abspath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    truncated = False
    if max_length and len(content) > max_length:
        content = content[:max_length]
        truncated = True

    return {
        "path": path,
        "size": stat.st_size,
        "extension": ext,
        "content": content,
        "truncated": truncated,
        "binary": False,
    }