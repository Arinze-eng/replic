"""gitclone_tool.py — Clone git repositories into the work dir."""

import os
import subprocess


def run(ctx, args):
    url = args.get("url", "")
    dest = args.get("dest")
    branch = args.get("branch")
    depth = args.get("depth")

    if not url:
        return {"error": "No URL provided", "stdout": ""}

    if not dest:
        dest = url.rstrip("/").split("/")[-1].replace(".git", "")

    target = os.path.join(ctx.work_dir, dest)
    if os.path.isdir(target):
        return {"stdout": f"Directory '{dest}' already exists", "dest": dest, "exit_code": 0, "already_exists": True}

    cmd = f"git clone {url} {dest}"
    if branch:
        cmd += f" --branch {branch}"
    if depth:
        cmd += f" --depth {depth}"

    try:
        result = subprocess.run(
            cmd, shell=True, cwd=ctx.work_dir,
            capture_output=True, text=True, timeout=300,
        )
        out = result.stdout or ""
        err = result.stderr or ""

        subprocess.run(
            f"cd {dest} && git submodule update --init --recursive 2>/dev/null",
            shell=True, capture_output=True, timeout=120,
        )

        file_count = 0
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            file_count += len(files)

        return {
            "stdout": out[:5000], "stderr": err[:2000],
            "exit_code": result.returncode, "dest": dest, "file_count": file_count,
        }
    except subprocess.TimeoutExpired:
        return {"error": "git clone timed out after 300s", "stdout": "", "stderr": "", "dest": dest}
    except Exception as e:
        return {"error": str(e), "stdout": "", "stderr": "", "dest": dest}