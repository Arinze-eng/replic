"""gitdiff_tool.py — Show git diff of changes."""

import os
import subprocess


def run(ctx, args):
    rel_path = args.get("path", ".")
    staged = args.get("staged", False)
    specific_files = args.get("files", [])

    cwd = ctx._resolve(rel_path) if rel_path and rel_path != "." else ctx.work_dir
    git_dir = os.path.join(cwd, ".git")

    if not os.path.isdir(git_dir):
        parent = cwd
        while parent != "/":
            if os.path.isdir(os.path.join(parent, ".git")):
                cwd = parent
                break
            parent = os.path.dirname(parent)
        if not os.path.isdir(os.path.join(cwd, ".git")):
            return {"error": "Not a git repository", "diffs": [], "files_changed": 0}

    flag = "--cached" if staged else ""
    file_args = " -- " + " ".join(specific_files) if specific_files else ""

    try:
        stat_result = subprocess.run(
            f"git diff {flag} --stat{file_args}",
            shell=True, cwd=cwd, capture_output=True, text=True, timeout=30,
        )
        stat = stat_result.stdout or ""

        diff_result = subprocess.run(
            f"git diff {flag}{file_args} 2>&1",
            shell=True, cwd=cwd, capture_output=True, text=True, timeout=30,
        )
        diff_text = diff_result.stdout or ""

        changed = []
        for line in stat.strip().split("\n"):
            if line:
                parts = line.split("|")
                if len(parts) >= 1:
                    changed.append(parts[0].strip())

        return {
            "stat": stat[:2000], "diff": diff_text[:50000],
            "files_changed": changed, "staged": staged,
        }
    except subprocess.TimeoutExpired:
        return {"error": "git diff timed out", "diffs": []}
    except Exception as e:
        return {"error": str(e), "diffs": []}