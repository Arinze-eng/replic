"""edit_tool.py — Edit files by find-and-replace (all extensions)."""

import os


def run(ctx, args):
    path = args.get("path", "")
    old_text = args.get("old_text", "")
    new_text = args.get("new_text", "")
    replace_all = args.get("replace_all", False)

    if not path:
        return {"error": "No path provided"}
    if not old_text:
        return {"error": "No old_text provided"}

    abspath = ctx._resolve(path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {path}"}

    with open(abspath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    if replace_all:
        new_content = content.replace(old_text, new_text)
    else:
        new_content = content.replace(old_text, new_text, 1)

    if new_content == content:
        return {"error": f"Text not found in {path}", "replaced": 0}

    count = content.count(old_text)

    with open(abspath, "w", encoding="utf-8") as f:
        f.write(new_content)

    ext = os.path.splitext(path)[1].lower() if "." in path else ""
    return {
        "path": path,
        "replaced": count if replace_all else 1,
        "total_occurrences": count if not replace_all else count,
        "extension": ext,
        "new_size": os.path.getsize(abspath),
    }