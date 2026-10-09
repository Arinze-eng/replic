"""coding_tool.py — Heavy enterprise code editing tool for all file types."""

import os
import re
import subprocess


FILE_EXTENSIONS = {
    "py", "js", "jsx", "ts", "tsx", "php", "md", "java", "go", "rs", "c", "cpp",
    "h", "hpp", "css", "scss", "less", "html", "htm", "vue", "svelte", "rb",
    "swift", "kt", "dart", "lua", "r", "scala", "sh", "bash", "zsh", "yaml",
    "yml", "json", "xml", "sql", "toml", "ini", "cfg", "dockerfile", "makefile",
    "terraform", "tf", "hcl", "gradle", "cmake", "mjs", "cjs", "mts", "cts",
    "pl", "pm", "t", "ps1", "bat", "cmd", "env", "gitignore", "prettierrc",
    "eslintrc", "babelrc", "editorconfig", "npmrc", "yarnrc", "lock",
}


def run(ctx, args):
    action = args.get("action", "create")
    path = args.get("path", "")

    if not path:
        return {"error": "No path provided"}

    ext = os.path.splitext(path)[1].lower().lstrip(".") if "." in path else ""
    abspath = ctx._resolve(path)

    if action == "create":
        content = args.get("content", "")
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        with open(abspath, "w", encoding="utf-8") as f:
            f.write(content)
        return {
            "action": "created", "path": path,
            "size": len(content), "extension": ext,
        }

    elif action == "read":
        if not os.path.isfile(abspath):
            return {"error": f"File not found: {path}"}
        with open(abspath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        lines = content.split("\n")
        return {
            "action": "read", "path": path,
            "size": len(content), "lines": len(lines),
            "extension": ext, "content": content,
        }

    elif action == "search_replace":
        if not os.path.isfile(abspath):
            return {"error": f"File not found: {path}"}
        old_text = args.get("old_text", "")
        new_text = args.get("new_text", "")
        if not old_text:
            return {"error": "No old_text provided"}
        with open(abspath, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        count = content.count(old_text)
        if count == 0:
            return {"error": f"Text not found in {path}"}
        new_content = content.replace(old_text, new_text)
        with open(abspath, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {
            "action": "search_replace", "path": path,
            "replaced": count, "extension": ext,
        }

    elif action == "edit":
        if not os.path.isfile(abspath):
            return {"error": f"File not found: {path}"}
        with open(abspath, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        insert_after = args.get("insert_after")
        insert_before = args.get("insert_before")
        content = args.get("content", "")
        line_start = args.get("line_start")
        line_end = args.get("line_end")

        if line_start and line_end:
            # Replace lines range
            start = max(1, int(line_start))
            end = min(len(lines), int(line_end))
            new_lines = content.split("\n")
            lines = lines[:start-1] + [l + "\n" if not l.endswith("\n") else l for l in new_lines] + lines[end:]
        elif insert_after:
            for i, line in enumerate(lines):
                if insert_after in line:
                    indent = re.match(r"^(\s*)", line).group(1) if line.strip() else ""
                    indented = "\n".join(indent + l for l in content.split("\n"))
                    lines.insert(i + 1, indented + "\n")
                    break
        elif insert_before:
            for i, line in enumerate(lines):
                if insert_before in line:
                    indent = re.match(r"^(\s*)", line).group(1) if line.strip() else ""
                    indented = "\n".join(indent + l for l in content.split("\n"))
                    lines.insert(i, indented + "\n")
                    break
        else:
            return {"error": "Provide line_start/line_end, insert_after, or insert_before"}

        new_content = "".join(lines)
        with open(abspath, "w", encoding="utf-8") as f:
            f.write(new_content)
        return {
            "action": "edited", "path": path,
            "new_size": len(new_content), "extension": ext,
        }

    elif action == "format":
        if not os.path.isfile(abspath):
            return {"error": f"File not found: {path}"}
        # Try formatters based on extension
        formatters = {
            "py": ["black", "--quiet"],
            "js": ["prettier", "--write"],
            "ts": ["prettier", "--write"],
            "jsx": ["prettier", "--write"],
            "tsx": ["prettier", "--write"],
            "css": ["prettier", "--write"],
            "json": ["prettier", "--write"],
            "md": ["prettier", "--write"],
            "go": ["gofmt", "-w"],
            "rs": ["rustfmt"],
            "java": ["google-java-format", "--replace"],
        }
        fmt = formatters.get(ext)
        if fmt:
            try:
                subprocess.run(fmt + [abspath], capture_output=True, text=True, timeout=30)
                return {"action": "formatted", "path": path, "formatter": fmt[0], "extension": ext}
            except Exception as e:
                return {"action": "format_failed", "path": path, "error": str(e)}
        return {"action": "no_formatter", "path": path, "extension": ext}

    elif action == "lint":
        if not os.path.isfile(abspath):
            return {"error": f"File not found: {path}"}
        linters = {
            "py": ["flake8", abspath],
            "js": ["eslint", "--no-eslintrc", "--format=compact", abspath],
            "ts": ["tsc", "--noEmit", abspath],
        }
        linter = linters.get(ext)
        if linter:
            try:
                result = subprocess.run(linter, capture_output=True, text=True, timeout=30)
                return {
                    "action": "linted", "path": path,
                    "stdout": result.stdout[:5000],
                    "stderr": result.stderr[:2000],
                    "exit_code": result.returncode,
                }
            except Exception as e:
                return {"action": "lint_failed", "error": str(e)}
        return {"action": "no_linter", "path": path, "extension": ext}

    elif action == "refactor":
        return _refactor(ctx, args, abspath, path, ext)

    return {"error": f"Unknown action: {action}"}


def _refactor(ctx, args, abspath, path, ext):
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {path}"}

    with open(abspath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    changes = []

    # Python refactoring
    if ext == "py":
        # Remove unused imports (basic)
        content = re.sub(r"^import\s+\w+\s*$", "", content, flags=re.MULTILINE)
        # Fix long lines at 120 chars
        lines = content.split("\n")
        new_lines = []
        for line in lines:
            if len(line) > 120 and not line.strip().startswith("#"):
                changes.append(f"Long line: {len(line)} chars")
            new_lines.append(line)
        content = "\n".join(new_lines)

    elif ext in ("js", "ts", "jsx", "tsx"):
        # Convert var to const/let
        count = 0
        content, count = re.subn(r"\bvar\s+", "const ", content)
        if count:
            changes.append(f"Converted {count} var to const")

    elif ext == "html":
        # Ensure proper doctype
        if not content.strip().startswith("<!doctype") and not content.strip().startswith("<!DOCTYPE"):
            content = "<!DOCTYPE html>\n" + content
            changes.append("Added DOCTYPE")

    elif ext == "md":
        # Ensure proper heading spacing
        content = re.sub(r"\n(#{1,6}\s)", r"\n\n\1", content)

    with open(abspath, "w", encoding="utf-8") as f:
        f.write(content)

    return {
        "action": "refactored", "path": path,
        "changes": changes, "extension": ext,
        "new_size": len(content),
    }