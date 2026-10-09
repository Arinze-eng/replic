#!/usr/bin/env python3
"""
test-sandbox-tools.py — Offline E2E for the in-sandbox tool upgrades.

Verifies the fixes for the four reported issues WITHOUT needing a live sandbox
or any API keys (it exercises agent.py's real dispatch path on a temp workdir):

  1. The 17 enterprise registry tools (grep/bash/glob/read/write/edit/…) run
     LOCALLY inside the worker (they used to be proxied to the host and so ran
     against the wrong filesystem — the "tools don't work in the sandbox" bug).
  2. consolidate merges split chunk files into ONE deliverable and de-queues the
     pieces (the "AI splits output into multiple zips/docs" bug).
  3. latex_render produces a valid PDF with NO raw LaTeX leaking into it (the
     "PDF shows raw \\int\\frac{...}" bug), with the pure-python engine forced.

Run:  python3 scripts/test-sandbox-tools.py
"""
import os
import sys
import tempfile
import zlib
import re
import time
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "agent_worker")
sys.path.insert(0, WORKER)

FAILS = []


def check(cond, msg):
    mark = "✅" if cond else "❌"
    print("  %s %s" % (mark, msg))
    if not cond:
        FAILS.append(msg)


def main():
    tmp = tempfile.mkdtemp(prefix="sbxtools_")
    os.environ["AGENT_WORK"] = tmp
    os.environ["LATEX_FORCE_PURE"] = "1"  # test the always-available renderer

    import agent  # noqa  (imports with AGENT_WORK already set)

    def et(name, args):
        return agent.execute_tool(name, args, lambda *a, **k: None)

    print("== 1) Registry tools run LOCALLY in the sandbox ==")
    reg = agent._get_local_registry()
    check(reg is not None, "tool registry imported into the worker")
    names = sorted(t.name for t in reg.list_tools()) if reg else []
    check(len(names) >= 15, "discovered %d registry tools (>=15)" % len(names))

    et("write", {"path": "app.py", "content": "print('ok')\n# needle-token here\n"})
    check(os.path.isfile(os.path.join(tmp, "app.py")), "write created the file in the sandbox workdir")

    r = et("bash", {"command": "ls && python3 app.py"})
    check("ok" in r, "bash ran python locally and captured its stdout")

    r = et("grep", {"pattern": "needle-token"})
    check("needle-token" in r and "app.py" in r, "grep found the match in the sandbox file")

    r = et("glob", {"pattern": "*.py"})
    check("app.py" in r, "glob listed the sandbox file")

    r = et("read", {"path": "app.py"})
    check("needle-token" in r, "read returned the sandbox file content")

    r = et("write_file", {"path": "nested/results/report.txt", "content": "nested-path-ok"})
    check(os.path.isfile(os.path.join(tmp, "nested", "results", "report.txt")),
          "native write_file preserves requested subdirectories")
    r = et("read_file", {"path": "report.txt"})
    check("nested-path-ok" in r, "native read_file uniquely recovers an omitted subdirectory")
    r = et("read", {"path": os.path.join(tmp, "nested", "results", "report.txt")})
    check("nested-path-ok" in r, "registry read accepts absolute paths confined to the workspace")
    blocked = et("read", {"path": "/etc/passwd"})
    check("Path traversal blocked" in blocked or 'error' in blocked.lower(),
          "registry absolute paths outside the workspace remain blocked")

    r = et("bash", {"command": "sleep 1; echo LONG_COMMAND_OK", "timeout": 2})
    check("LONG_COMMAND_OK" in r and "timed out" not in r.lower(), "bash honors caller-supplied command timeouts")

    print("== 1b) Full repository grounding + verified install ==")
    os.makedirs(os.path.join(tmp, "repo", "src"), exist_ok=True)
    open(os.path.join(tmp, "repo", "package.json"), "w").write('{"name":"fixture"}\n')
    open(os.path.join(tmp, "repo", "src", "index.js"), "w").write("const x = require('./x');\nconsole.log(x);\n")
    open(os.path.join(tmp, "repo", "src", "x.js"), "w").write("module.exports = 42;\n")
    r = et("inspect_codebase", {"path": "repo"})
    check("CODEBASE_INVENTORY_COMPLETE" in r and "files=3" in r, "inspect_codebase reads and hashes every first-party fixture file")
    code_map = os.path.join(tmp, ".agent_codebase_map.json")
    check(os.path.isfile(code_map) and len(__import__('json').load(open(code_map))["files"]) == 3,
          "inspect_codebase persists detailed architecture evidence internally")
    r = et("install_tool", {"name": "bash", "kind": "apt"})
    check("INSTALL_VERIFIED" in r, "install_tool proves an existing CLI is runnable")

    print("== 1c) /stop interrupts a silent child process ==")
    agent._TERMINAL["task_id"] = "silent-stop-test"
    agent.clear_stop_flag("silent-stop-test")
    def request_stop():
        time.sleep(0.35)
        open(agent._task_stop_flag("silent-stop-test"), "w").write("stop\n")
    th = threading.Thread(target=request_stop, daemon=True)
    th.start()
    started = time.time()
    r = agent.run_shell("sleep 20", timeout=25)
    elapsed = time.time() - started
    check("stopped by user" in r.lower() and elapsed < 3,
          "silent shell process is killed promptly after the per-task stop flag")
    agent.clear_stop_flag("silent-stop-test")

    et("write", {"path": "legacy.js", "content": "var answer = 42;\n"})
    r = et("coding", {"action": "refactor", "path": "legacy.js"})
    check("refactored" in r and open(os.path.join(tmp, "legacy.js")).read().startswith("const "),
          "coding refactor executes synchronously and persists its change")

    print("== 2) consolidate merges chunks into ONE document ==")
    open(os.path.join(tmp, "chapter1.md"), "w").write("# Chapter 1\nAlpha body.")
    open(os.path.join(tmp, "chapter2.md"), "w").write("# Chapter 2\nBeta body.")
    open(os.path.join(tmp, "chapter10.md"), "w").write("# Chapter 10\nLast body.")
    order = agent._auto_chunk_files()
    check(order.index("chapter2.md") < order.index("chapter10.md"),
          "natural sort orders chapter2 before chapter10")
    r = et("consolidate", {"output": "combined.md", "title": "Book"})
    merged_path = os.path.join(tmp, "combined.md")
    check(os.path.isfile(merged_path), "consolidate wrote one merged file")
    body = open(merged_path).read()
    check("Chapter 1" in body and "Chapter 10" in body, "merged file contains every chapter")
    check("combined.md" in agent.DELIVER, "merged file queued for delivery")
    check("chapter1.md" not in agent.DELIVER, "individual chunks de-queued from delivery")

    print("== 3) LaTeX/Markdown renders a PDF with NO raw LaTeX leak ==")
    import latex_render as lr
    pdf = os.path.join(tmp, "math.pdf")
    n = lr.build_pdf(
        "# Math\n\nInline $E=mc^2$ and $\\frac{a}{b}$.\n\n$$\\int_0^1 x^2 dx = \\frac{1}{3}$$\n",
        pdf, title="Math",
    )
    data = open(pdf, "rb").read()
    check(n > 512 and data.startswith(b"%PDF"), "produced a valid PDF")
    # Decompress streams and confirm no raw \frac/\int/\sum leaked as text.
    leaked = False
    for s in re.findall(rb"stream\r?\n(.*?)endstream", data, re.S):
        try:
            t = zlib.decompress(s)
        except Exception:
            t = s
        txt = t.decode("latin-1", "replace")
        if "\\frac" in txt or "\\int" in txt or "\\sum" in txt:
            leaked = True
    check(not leaked, "no raw LaTeX (\\frac/\\int/\\sum) leaked into the PDF")

    print("")
    if FAILS:
        print("SOME CHECKS FAILED ❌ (%d):" % len(FAILS))
        for f in FAILS:
            print("  - " + f)
        sys.exit(1)
    print("ALL PASSED ✅")


if __name__ == "__main__":
    main()
