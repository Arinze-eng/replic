"""bash_tool.py — Execute bash commands in the sandbox."""

import os
import subprocess


def run(ctx, args):
    command = args.get("command", "")
    timeout = max(1, min(int(args.get("timeout", 600)), 6 * 60 * 60))
    work_dir = args.get("work_dir")

    if not command:
        return {"error": "No command provided", "stdout": "", "stderr": "", "exit_code": -1}

    cwd = ctx._resolve(work_dir) if work_dir else ctx.work_dir

    try:
        result = subprocess.run(
            command, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "HOME": os.path.expanduser("~")},
        )
        return {
            "stdout": result.stdout[:50000],
            "stderr": result.stderr[:10000],
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"[timeout] Exceeded {timeout}s", "exit_code": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1}