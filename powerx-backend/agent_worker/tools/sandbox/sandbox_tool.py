"""sandbox_tool.py — Sandbox environment utilities."""

import os
import subprocess
import shutil


def run(ctx, args):
    action = args.get("action", "info")

    if action == "info":
        result = subprocess.run(
            "uname -a && cat /etc/os-release 2>/dev/null | head -5",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        python_ver = subprocess.run(
            "python3 --version 2>&1", shell=True, capture_output=True, text=True, timeout=5,
        )
        return {
            "os": result.stdout.strip(),
            "python": python_ver.stdout.strip(),
            "work_dir": ctx.work_dir,
            "hostname": os.uname().nodename,
            "cpus": os.cpu_count(),
        }

    elif action == "processes":
        result = subprocess.run(
            "ps aux --sort=-%cpu | head -30",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        return {"processes": result.stdout}

    elif action == "disk":
        result = subprocess.run(
            "df -h / /home 2>/dev/null | tail -5",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        return {"disk": result.stdout}

    elif action == "memory":
        result = subprocess.run(
            "free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -5",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        return {"memory": result.stdout}

    elif action == "ports":
        result = subprocess.run(
            "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo 'no port tools'",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        return {"listening_ports": result.stdout}

    elif action == "env":
        env = dict(os.environ)
        # Redact sensitive keys
        sensitive = ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASS", "AUTH"]
        for k in list(env.keys()):
            for s in sensitive:
                if s in k.upper():
                    env[k] = env[k][:8] + "..." if len(env[k]) > 8 else "***"
                    break
        return {"env": {k: v for k, v in sorted(env.items())}}

    elif action == "whoami":
        result = subprocess.run(
            "id && whoami 2>/dev/null",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        return {"identity": result.stdout.strip()}

    return {"error": f"Unknown action: {action}"}