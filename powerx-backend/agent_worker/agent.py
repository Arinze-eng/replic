#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# agent.py — WormGPT Agent worker that LIVES INSIDE the Daytona sandbox.
#
# This is the "agent owns the computer" runtime from the design screenshot. A
# long-running process inside the user's persistent sandbox that:
#   • watches an INBOX directory for task files (one JSON file per task),
#   • runs the SAME ReAct plan→act→observe loop the host engine uses,
#   • executes every shell/python/file/docker tool LOCALLY inside this box
#     (it genuinely owns the machine — full Ubuntu userland, podman, etc.),
#   • calls back to the Render HOST ONLY for the LLM brain and a handful of
#     host-side tools (web_search / browse / screenshot / image gen / doc gen)
#     via an authenticated bridge endpoint,
#   • streams progress + writes the final answer (and any produced files) to
#     an OUTBOX directory the host controller polls.
#
# The worker is intentionally dependency-light: it uses only the Python stdlib
# (urllib, json, subprocess, threading) so it runs on the stock Daytona image
# with ZERO pip installs — making startup instant and rock-solid. Heavy tools
# (numpy, pandas, etc.) are installed on-demand by the agent's own run_code.
#
# Protocol (all paths under WORK = /home/daytona/work):
#   WORK/.agent_inbox/<taskId>.json      ← host writes a task here
#   WORK/.agent_outbox/<taskId>.status   ← worker appends progress lines
#   WORK/.agent_outbox/<taskId>.result   ← worker writes final JSON when done
#   WORK/.agent_outbox/<taskId>.lock      ← worker touches while running
#   WORK/<files…>                         ← deliverables live in the work dir
#
# Bridge (host) — POST {BRIDGE_URL} with header X-Agent-Token: {TOKEN}:
#   {"op":"brain","system":"...","messages":[{role,text}...]} → {"text": "..."}
#   {"op":"tool","tool":"web_search","args":{...},"files":[...]} → {"result": "...", "files":[{name,b64}]}
# ─────────────────────────────────────────────────────────────────────────────

import os
import sys
import json
import time
import base64
import hashlib
import subprocess
import threading
import traceback
import selectors
import re
import shlex
import urllib.request
import urllib.error

try:
    from database_intelligence import execute as _database_execute
except Exception:
    _database_execute = None
try:
    from quality_gate import evaluate as _evaluate_completion
except Exception:
    _evaluate_completion = None

# ── In-sandbox HIGH-QUALITY LaTeX→PDF engine ─────────────────────────────────
# latex_render.py is uploaded into the worker dir alongside this file by
# sandboxAgent.js. It builds a REAL LaTeX document (native math + tables + code
# + TikZ/PGFPlots charts & diagrams) and compiles it with Tectonic (a single
# self-contained static binary that auto-fetches only the packages a doc uses)
# INSIDE the sandbox — so create_pdf/convert_file produce print-quality PDFs
# with ZERO stress on the Render host and NO blank/empty PDFs (output is
# validated for a real header + non-trivial size + >=1 page). Import is
# best-effort: if it's missing (older host) create_pdf transparently falls back
# to the host bridge renderer.
#
# NOTE: this REPLACES the old headless-Chromium HTML→PDF renderer (pdf_render.py)
# which produced blank equations/charts and was fragile to provision.
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
except Exception:
    pass
try:
    import latex_render as _latex_render  # noqa
except Exception:
    _latex_render = None

# ── 🏢 ENTERPRISE TOOL REGISTRY (runs the 17 tools LOCALLY, in this sandbox) ──
# tool_registry.py + the tools/ tree are uploaded next to this file by
# sandboxAgent.js. Historically agent.py NEVER imported the registry, so tools
# like grep / bash / read / write / edit / glob / gitclone / gitdiff / todo /
# sql / webshell / http / coding / database were listed in HOST_TOOLS and got
# PROXIED BACK TO THE RENDER HOST over the bridge — the exact opposite of
# "the agent owns the computer". That meant a `grep`/`cat`/`bash` ran on the
# host filesystem (which does NOT have the sandbox's files), so the tools looked
# broken. We now import the registry and run these tools LOCALLY inside the
# sandbox, where the agent's files actually live. Best-effort import so an older
# checkout without the registry still boots (it just proxies as before).
_TOOL_REGISTRY = None
try:
    import tool_registry as _tool_registry_mod  # noqa

    def _get_local_registry():
        global _TOOL_REGISTRY
        if _TOOL_REGISTRY is None:
            tools_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools")
            _TOOL_REGISTRY = _tool_registry_mod.ToolRegistry(tools_dir=tools_dir, work_dir=WORK)
            try:
                _TOOL_REGISTRY.discover()
            except Exception:
                pass
        return _TOOL_REGISTRY
except Exception:
    _tool_registry_mod = None

    def _get_local_registry():
        return None

WORK = os.environ.get("AGENT_WORK", "/home/daytona/work")
INBOX = os.path.join(WORK, ".agent_inbox")
OUTBOX = os.path.join(WORK, ".agent_outbox")
BRIDGE_URL = os.environ.get("AGENT_BRIDGE_URL", "").strip()
TOKEN = os.environ.get("AGENT_TOKEN", "").strip()
SANDBOX_ID = os.environ.get("AGENT_SANDBOX_ID", "").strip()
MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "270"))
MAX_ITERATIONS = int(os.environ.get("AGENT_MAX_ITERATIONS", "270"))
MAX_BUDGET = 1000
# Per-tool-step shell timeout (seconds). Long installs/builds/scans allowed.
STEP_TIMEOUT = int(os.environ.get("AGENT_STEP_TIMEOUT", "900"))
POLL = 1.0

# ── ✨ QUALITY THROUGH CAPABILITY (no persistence nudges / time floors) ───────
# DESIGN CHANGE (CodeBanana-style): the old "Mythos persistence gate" forced the
# agent to keep working until an artificial wall-clock floor (5–6 min) and a
# minimum step/skill count were met, injecting "[PERSISTENCE GATE — DO NOT FINISH
# YET]" nudges that produced stalling and busy-spin instead of quality.
#
# That whole mechanism is REMOVED. Quality now comes from the same place a great
# engineer's quality comes from: a strong working method (Understand → Plan →
# Execute → Validate → Wrap up), real tool/sandbox execution, reading before
# writing, grounding facts via search, and verifying by actually running the
# work — all driven by the system prompt and the tools, NOT by forced nudges.
#
# The agent finishes the moment it has genuinely solved the task. Fast correct
# work is celebrated; there is no minimum-time/step penalty and no push-back.
# `task_started` is kept only for status/telemetry timing.

# ── Live-terminal + stop-control wiring ──────────────────────────────────────
# The host (sandboxAgent.js) tails these files and forwards their new lines to
# the Telegram/WhatsApp chat so the user SEES the real sandbox terminal instead
# of staring at a static screen, and can stop a runaway task immediately.
#   .terminal      ← every shell command + its (truncated) live output is echoed
#   .agent_stop    ← if this flag file appears, the worker aborts the current
#                    task between steps (the user pressed /stop)
TERMINAL_FILE = os.path.join(WORK, ".agent_outbox", "%s.terminal")  # per-task
STOP_FLAG = os.path.join(WORK, ".agent_stop")
# Per-task stop flags live in the outbox as "<taskId>.stop". The GLOBAL
# STOP_FLAG (above) is a "stop EVERYTHING" signal (kept for backwards
# compatibility with the host's requestStop). This split fixes the bug where a
# NEW task's clear_stop_flag() wiped the stop request of a DIFFERENT task, and
# lets /stop target only the currently-running task without disturbing others.
def _task_stop_flag(task_id):
    return os.path.join(OUTBOX, "%s.stop" % task_id)

# Loop-detection knobs: how many identical/near-identical steps before we warn,
# and the hard cap after which we abort the task as a confirmed loop.
LOOP_WARN_AT = int(os.environ.get("AGENT_LOOP_WARN_AT", "3"))
LOOP_ABORT_AT = int(os.environ.get("AGENT_LOOP_ABORT_AT", "5"))

os.makedirs(INBOX, exist_ok=True)
os.makedirs(OUTBOX, exist_ok=True)

# ── 🔒 PER-SESSION TASK SERIALIZATION (fixes "second task restarts the first") ─
# The worker serves ONE sandbox = ONE chat session. Previously main() spawned a
# fresh daemon thread for EVERY inbox file with no coordination, so if the user
# sent task #2 while task #1 was still running, both ran concurrently inside the
# SAME work dir — corrupting each other's terminal sink / stop flag / files and
# making it look like the first task "restarted". We now run tasks STRICTLY one
# at a time through a global lock, and QUEUE any task that arrives while another
# is running (it runs the instant the current one finishes). A brand-new task is
# NEVER started on top of a running one.
_TASK_LOCK = threading.Lock()
_ACTIVE_TASK = {"id": None, "since": 0}

# ── ⏱️ TIME-BOXED "THINK UNTIL DEADLINE" MODE ────────────────────────────────
# When the user says "use 5 minutes to do this / keep thinking for 10 min", the
# host puts a `think_until_ms` (absolute epoch-ms deadline) and/or
# `min_duration_ms` in the payload. In that mode the agent does NOT finish early:
# every time it tries to `finish` before the deadline we bounce it back with a
# directive to EXPLORE A NEW, DIFFERENT strategy/angle it has not tried yet —
# improving, verifying, and deepening the result — instead of repeating itself
# or busy-spinning. The loop-detector still guards against literal repetition, so
# "keep thinking" means "keep producing genuinely new work", never an idle loop.
def _now_ms():
    return int(time.time() * 1000)

# Active per-task terminal sink (set by run_task). Shell tools append here so the
# host can stream the live terminal. A module global keeps run_shell signature
# unchanged for every existing caller.
_TERMINAL = {"path": None}

# ── WRITING-LENGTH ENFORCER (mirrors services/agentEngine.js) ────────────────
# The original user task text for the CURRENT task, captured by run_task. Used
# to infer a requested page/word target ("10 page story book", "a full book")
# so document tools refuse to ship a half-empty stub and instead push the model
# to write the whole thing (chunk-by-chunk into a content_file).
_TASK_TEXT = ""
_WRITE_NUDGES = {}  # filename -> count, reset per task

# ── PER-TASK DELIVERY ISOLATION ──────────────────────────────────────────────
# In a PERSISTENT session sandbox the work dir survives between tasks, so files
# produced by task #1 stay on disk. Without a task-start baseline, any tool that
# re-touches a leftover file (re-clone, npm install, build, formatter…) makes the
# size:mtime diff re-capture it, and it gets re-delivered with EVERY later task —
# the "it keeps giving me files from previous tasks" bug. `_TASK_BASELINE` is the
# whole-workspace snapshot taken at the START of the current task; collect only
# delivers files that are genuinely NEW or CHANGED relative to it.
_TASK_BASELINE = {}   # rel -> (size, mtime) captured at task start
_TASK_BASELINE_HASH = {}  # rel -> sha1 of file content captured at task start
_TASK_START_TS = 0.0  # wall-clock time the current task began (for mtime gating)

_WORDS_PER_PAGE = int(os.environ.get("WRITING_WORDS_PER_PAGE", "480"))
_BOOK_MIN_PAGES = int(os.environ.get("WRITING_BOOK_MIN_PAGES", "12"))
_WRITING_OK_RATIO = float(os.environ.get("WRITING_OK_RATIO", "0.85"))
_WRITING_MAX_NUDGES = int(os.environ.get("WRITING_MAX_NUDGES", "4"))


def _count_words(s):
    return len([w for w in str(s or "").strip().split() if w])


def _resolve_writing_target(args):
    """Return (words, pages, source). words==0 → no enforcement."""
    import re as _re
    a = args or {}
    try:
        ew = int(a.get("target_words") or a.get("min_words") or a.get("words") or 0)
    except Exception:
        ew = 0
    if ew > 0:
        return ew, None, "target_words"
    try:
        ep = float(a.get("pages") or a.get("page_count") or a.get("num_pages") or 0)
    except Exception:
        ep = 0
    if ep > 0:
        return int(round(ep * _WORDS_PER_PAGE)), ep, "pages"
    task = str(_TASK_TEXT or "").lower()
    m = _re.search(r"(\d{1,3})\s*[-\u2013]?\s*page", task)
    if m:
        n = int(m.group(1))
        if 0 < n <= 500:
            return n * _WORDS_PER_PAGE, n, "task:pages"
    m = _re.search(r"(\d{3,6})\s*words?", task)
    if m:
        n = int(m.group(1))
        if n >= 200:
            return n, None, "task:words"
    if _re.search(r"\b(story\s?book|storybook|novel|e-?book|full\s+book|whole\s+book|a\s+book|chapters?)\b", task):
        return _BOOK_MIN_PAGES * _WORDS_PER_PAGE, _BOOK_MIN_PAGES, "task:book"
    return 0, None, "none"


def _enforce_writing_length(kind, filename, body, args):
    """Return None to proceed, or a corrective observation string to bounce."""
    words_target, pages, _src = _resolve_writing_target(args)
    if not words_target:
        return None
    have = _count_words(body)
    need = int(round(words_target * _WRITING_OK_RATIO))
    if have >= need:
        return None
    key = str(filename or "doc")
    n = _WRITE_NUDGES.get(key, 0)
    if n >= _WRITING_MAX_NUDGES:
        return None  # give up bouncing; deliver what we have
    _WRITE_NUDGES[key] = n + 1
    base = (filename or "document")
    stem = base.rsplit(".", 1)[0] if "." in base else base
    pages_txt = (" (~%s pages @ ~%d words/page)" % (pages, _WORDS_PER_PAGE)) if pages else ""
    target_txt = ("%s pages" % pages) if pages else "the requested length"
    return (
        "[%s] \u26d4 NOT DELIVERED \u2014 the content is far too short. "
        "You wrote only ~%d words but the request needs ~%d words%s. "
        "That is a HALF-EMPTY document, which is a HARD FAILURE per WRITING MODE.\n\n"
        "DO THIS NOW to fix it (do NOT call %s again with the same short body):\n"
        "1. Build the FULL body in a file in CHUNKS so nothing is truncated by the step budget:\n"
        "   \u2022 First write_file \"%s.md\" with the opening ~1000 words (title + first section/chapter, in full prose).\n"
        "   \u2022 Then, in SEPARATE steps, call write_file again with {\"filename\":\"%s.md\",\"append\":true,\"content\":\"...next chapter ~1000+ words...\"}. Repeat until the file clearly holds AT LEAST ~%d words \u2014 write every chapter/section fully, no summaries, no \"[continued]\", no placeholders.\n"
        "2. Only when the .md file is genuinely long enough, call %s again with {\"content_file\":\"%s.md\"} (NOT inline content) plus the title/filename.\n"
        "3. Keep going until the document truly fills %s top-to-bottom. Depth over brevity \u2014 develop every idea into full paragraphs."
        % (kind, have, words_target, pages_txt, kind, stem, stem, words_target, kind, stem, target_txt)
    )



def term(line):
    """Append a line to the live-terminal stream for the current task (best-effort)."""
    path = _TERMINAL.get("path")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(str(line).rstrip("\n") + "\n")
    except Exception:
        pass


def stop_requested():
    """True if the user asked to stop the CURRENTLY-RUNNING task.

    Checks BOTH the per-task stop flag (set by /stop for this exact task) and
    the legacy GLOBAL flag (host requestStop / "stop everything"). run_shell()
    and the main loop both call this, so a long shell command is killed and the
    step loop exits promptly the moment either flag appears.
    """
    try:
        if os.path.exists(STOP_FLAG):
            return True
        tid = _TERMINAL.get("task_id")
        if tid and os.path.exists(_task_stop_flag(tid)):
            return True
        return False
    except Exception:
        return False


def clear_stop_flag(task_id=None):
    """Clear the global stop flag and (optionally) this task's own stop flag.

    A brand-new task clears the global flag so a stale "stop everything" from a
    previous session never aborts it, and clears its OWN per-task flag. It must
    NOT touch OTHER tasks' flags."""
    try:
        if os.path.exists(STOP_FLAG):
            os.remove(STOP_FLAG)
    except Exception:
        pass
    if task_id:
        try:
            f = _task_stop_flag(task_id)
            if os.path.exists(f):
                os.remove(f)
        except Exception:
            pass


# ── Bridge (host callback) ───────────────────────────────────────────────────
# Two transports, tried in order:
#   1. FILE bridge (default, works on ALL Daytona tiers — no sandbox egress
#      needed): write a request file to BRIDGE dir, the host (which is already
#      polling the sandbox via the Daytona toolbox channel) fulfils it and
#      writes a response file back. We poll for the response.
#   2. HTTP bridge (used only if AGENT_BRIDGE_MODE=http): direct POST to the
#      host endpoint — requires outbound network from the sandbox (higher tiers).
#
# The file bridge is the robust default because Daytona Tier 1/2 sandboxes block
# arbitrary outbound traffic, so the worker cannot call the host directly.
BRIDGE_MODE = os.environ.get("AGENT_BRIDGE_MODE", "file").strip().lower()
BRIDGE_DIR = os.path.join(WORK, ".agent_bridge")
os.makedirs(BRIDGE_DIR, exist_ok=True)
_REQ_SEQ = {"n": 0}
_REQ_LOCK = threading.Lock()


def bridge_http(payload, timeout=180, retries=3):
    if not BRIDGE_URL:
        raise RuntimeError("AGENT_BRIDGE_URL not set")
    data = json.dumps(payload).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                BRIDGE_URL, data=data,
                headers={"Content-Type": "application/json", "X-Agent-Token": TOKEN, "X-Agent-Sandbox": SANDBOX_ID},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("http bridge failed: %s" % last)


def bridge_file(payload, timeout=600):
    """Write a request file and poll for the host-written response file.

    Robust against the work dir / .agent_bridge being recreated, cleaned or
    racing with host-side cleanup (common when a chat platform — e.g. WhatsApp —
    fires several brain calls in quick succession). We (re)ensure the bridge dir
    exists immediately before every write and retry the write on a transient
    FileNotFoundError instead of bubbling up an [Errno 2] gateway error.
    """
    with _REQ_LOCK:
        _REQ_SEQ["n"] += 1
        rid = "r_%d_%d" % (int(time.time() * 1000), _REQ_SEQ["n"])
    req_tmp = os.path.join(BRIDGE_DIR, rid + ".req.tmp")
    req_path = os.path.join(BRIDGE_DIR, rid + ".req")
    resp_path = os.path.join(BRIDGE_DIR, rid + ".resp")

    # Atomically stage the request, recreating the bridge dir on the fly if a
    # concurrent cleanup removed it. Retry a few times before giving up.
    last_err = None
    for attempt in range(5):
        try:
            os.makedirs(BRIDGE_DIR, exist_ok=True)
            with open(req_tmp, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
                fh.flush()
                try:
                    os.fsync(fh.fileno())
                except Exception:
                    pass
            os.replace(req_tmp, req_path)  # atomic — host never sees a partial request
            last_err = None
            break
        except FileNotFoundError as e:
            # Bridge dir or temp file vanished mid-write (race with cleanup).
            last_err = e
            try:
                if os.path.exists(req_tmp):
                    os.remove(req_tmp)
            except Exception:
                pass
            time.sleep(0.3 * (attempt + 1))
        except Exception as e:
            last_err = e
            time.sleep(0.3 * (attempt + 1))
    if last_err is not None:
        raise RuntimeError("file bridge could not stage request %s: %s" % (rid, last_err))

    deadline = time.time() + timeout
    while time.time() < deadline:
        if stop_requested():
            for p in (req_tmp, req_path, resp_path):
                try:
                    if os.path.exists(p): os.remove(p)
                except Exception:
                    pass
            raise RuntimeError("bridge aborted: task stopped by user")
        if os.path.exists(resp_path):
            try:
                with open(resp_path, "r", encoding="utf-8") as fh:
                    out = json.load(fh)
            except Exception:
                time.sleep(0.4)
                continue
            try:
                os.remove(resp_path)
            except Exception:
                pass
            try:
                if os.path.exists(req_path):
                    os.remove(req_path)
            except Exception:
                pass
            return out
        time.sleep(0.6)
    raise RuntimeError("file bridge timed out for %s" % rid)


def bridge(payload, timeout=180, retries=3):
    if BRIDGE_MODE == "http":
        return bridge_http(payload, timeout=timeout, retries=retries)
    return bridge_file(payload, timeout=max(timeout, 300))


def brain(system, messages):
    """Ask the host's LLM brain for the next JSON action."""
    out = bridge({"op": "brain", "system": system, "messages": messages}, timeout=240)
    if out.get("error"):
        raise RuntimeError("brain error: %s" % out["error"])
    return out.get("text", "") or ""


def host_tool(tool, args, files=None):
    """Run a HOST-side tool (web_search/browse/screenshot/generate_image/…).

    Any files the host returns (b64) are written into the work dir AND queued
    for delivery via the DELIVER set. Previously they were only written to disk
    but never registered, so host-proxied conversions (convert_file → office/
    image/OCR) silently dropped the converted file — the "it says it converted
    but never gives me the file" bug. We now DELIVER.add() every host-produced
    output so it always reaches the user.
    """
    payload = {"op": "tool", "tool": tool, "args": args or {}}
    if files:
        payload["files"] = files
    out = bridge(payload, timeout=600)
    # Host may return produced files (b64) → write them into the work dir and
    # mark them for delivery so the user actually receives them.
    for f in out.get("files", []) or []:
        try:
            safe_name = _safe(f["name"])
            p = os.path.join(WORK, safe_name)
            with open(p, "wb") as fh:
                fh.write(base64.b64decode(f["b64"]))
            # 🔧 CRITICAL FIX: register the host-produced file for delivery.
            if not _is_internal_artifact(safe_name):
                DELIVER.add(safe_name)
        except Exception:
            pass
    return out.get("result", "")


# ── Local tools (executed INSIDE the sandbox — the agent owns this box) ──────
def _safe(name):
    keep = [c if (c.isalnum() or c in "._-") else "_" for c in str(name or "file")]
    return "".join(keep) or "file"


def run_shell(cmd, timeout=STEP_TIMEOUT, stream=True):
    """Run a shell command in the work dir.

    When `stream` is True (the default for agent tool calls), the command line
    and its output are echoed LIVE to the per-task .terminal sink — so the user
    watching on Telegram/WhatsApp sees the real terminal scroll by instead of a
    static "working..." screen. The command is also abortable mid-flight: if the
    user presses /stop (the host drops the .agent_stop flag) we kill the process
    group immediately.
    """
    if not stream:
        try:
            p = subprocess.run(
                ["bash", "-lc", "cd %s 2>/dev/null; %s" % (WORK, cmd)],
                capture_output=True, text=True, timeout=timeout,
            )
            out = (p.stdout or "") + (("\n" + p.stderr) if p.stderr else "")
            if p.returncode != 0:
                out += "\n[exit %s]" % p.returncode
            return out.strip() or "(no output)"
        except subprocess.TimeoutExpired:
            return "[timed out after %ss]" % timeout
        except Exception as e:  # noqa
            return "[shell error] %s" % e

    # Streaming path — echo the prompt + live output to the terminal sink.
    term("$ %s" % str(cmd).strip()[:400])
    collected = []
    try:
        proc = subprocess.Popen(
            ["bash", "-lc", "cd %s 2>/dev/null; %s" % (WORK, cmd)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, start_new_session=True,
        )
    except Exception as e:  # noqa
        term("[shell error] %s" % e)
        return "[shell error] %s" % e

    deadline = time.time() + timeout
    killed_reason = None
    selector = selectors.DefaultSelector()
    try:
        selector.register(proc.stdout, selectors.EVENT_READ)
        # Never block on readline(): many installers/builds produce no output for
        # minutes. Poll the pipe at 200ms so /stop and timeouts are observed even
        # while the child is completely silent.
        while True:
            if stop_requested():
                killed_reason = "stopped"
                break
            if time.time() > deadline:
                killed_reason = "timeout"
                break
            events = selector.select(timeout=0.2)
            for key, _ in events:
                line = key.fileobj.readline()
                if line:
                    collected.append(line)
                    term(line.rstrip("\n")[:500])
            if proc.poll() is not None:
                # Drain any final buffered output after process exit.
                tail = proc.stdout.read() or ""
                if tail:
                    collected.append(tail)
                    for line in tail.splitlines():
                        term(line[:500])
                break
        if killed_reason:
            try:
                os.killpg(os.getpgid(proc.pid), 9)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    finally:
        try:
            selector.close()
        except Exception:
            pass
        try:
            proc.stdout.close()
        except Exception:
            pass

    out = "".join(collected)
    rc = proc.returncode
    if killed_reason == "stopped":
        term("[stopped by user]")
        out += "\n[stopped by user]"
    elif killed_reason == "timeout":
        term("[timed out after %ss]" % timeout)
        out += "\n[timed out after %ss]" % timeout
    elif rc not in (0, None):
        term("[exit %s]" % rc)
        out += "\n[exit %s]" % rc
    return out.strip() or "(no output)"


def tool_run_code(args):
    lang = (args.get("language") or "python").lower()
    code = args.get("code") or ""
    if not code.strip():
        return "[run_code] No code provided."
    before = _snapshot()
    if lang in ("python", "py"):
        fn = os.path.join(WORK, "_step.py")
        open(fn, "w").write(code)
        out = run_shell("python3 _step.py 2>&1 || python _step.py 2>&1")
        # ── AUTO-HEAL missing Python deps ──────────────────────────────────
        # A very common cause of "tools failing on the sandbox" is a missing
        # pip module. Instead of returning the raw ModuleNotFoundError (which
        # looks like the agent "did rubbish"), detect the missing module,
        # install it via a robust retry ladder, and re-run ONCE. This makes
        # run_code self-repairing for the overwhelming majority of failures.
        heal_rounds = 0
        while heal_rounds < 3:
            mod = _missing_python_module(out)
            if not mod:
                break
            installed = _ensure_pkg(mod, kind="pip")
            if not installed:
                out += "\n[auto-install] could not install '%s' after trying pip/apt — see ladder above.]" % mod
                break
            term("[auto-install] installed missing module '%s' — re-running." % mod)
            out = run_shell("python3 _step.py 2>&1 || python _step.py 2>&1")
            heal_rounds += 1
    elif lang in ("node", "js", "javascript"):
        fn = os.path.join(WORK, "_step.js")
        open(fn, "w").write(code)
        out = run_shell("node _step.js 2>&1")
        heal_rounds = 0
        while heal_rounds < 3:
            mod = _missing_node_module(out)
            if not mod:
                break
            installed = _ensure_pkg(mod, kind="npm")
            if not installed:
                out += "\n[auto-install] could not install node module '%s'.]" % mod
                break
            term("[auto-install] installed missing node module '%s' — re-running." % mod)
            out = run_shell("node _step.js 2>&1")
            heal_rounds += 1
    else:
        fn = os.path.join(WORK, "_step.sh")
        open(fn, "w").write(code)
        out = run_shell("bash _step.sh 2>&1")
        # Shell: auto-install a missing CLI tool ("foo: command not found").
        heal_rounds = 0
        while heal_rounds < 2:
            tool = _missing_shell_tool(out)
            if not tool:
                break
            installed = _ensure_pkg(tool, kind="apt")
            if not installed:
                out += "\n[auto-install] could not install CLI '%s'.]" % tool
                break
            term("[auto-install] installed missing CLI '%s' — re-running." % tool)
            out = run_shell("bash _step.sh 2>&1")
            heal_rounds += 1
    captured = _captured(before)
    note = ("\n[%d file(s) created/modified]" % len(captured)) if captured else ""
    return "[run_code:%s @sandbox]\n%s%s" % (lang, out[:12000], note)


# ── ROBUST DEPENDENCY INSTALLER (fixes "tools fail to install on sandbox") ──
# The old prewarm/install paths swallowed every failure with `|| true`, so a
# tool that needed a package would silently break and the agent looked broken.
# _ensure_pkg tries a real LADDER of install methods and only gives up when all
# are exhausted, returning True/False so callers know if the tool is now usable.
#
# PyPI import name != package name for a few common libs — map them so e.g.
# `import cv2` installs opencv-python.
_PIP_NAME_MAP = {
    "cv2": "opencv-python-headless", "PIL": "pillow", "bs4": "beautifulsoup4",
    "sklearn": "scikit-learn", "yaml": "pyyaml", "Crypto": "pycryptodome",
    "fitz": "PyMuPDF", "docx": "python-docx", "pptx": "python-pptx",
    "dotenv": "python-dotenv", "OpenSSL": "pyOpenSSL", "serial": "pyserial",
    "google.generativeai": "google-generativeai", "dns": "dnspython",
}
_PIP_IMPORT_MAP = {
    "opencv-python": "cv2", "opencv-python-headless": "cv2", "pillow": "PIL",
    "beautifulsoup4": "bs4", "scikit-learn": "sklearn", "pyyaml": "yaml",
    "pycryptodome": "Crypto", "pymupdf": "fitz", "python-docx": "docx",
    "python-pptx": "pptx", "python-dotenv": "dotenv", "pyopenssl": "OpenSSL",
    "pyserial": "serial", "google-generativeai": "google.generativeai", "dnspython": "dns",
}
# apt package for a missing CLI tool where the binary name != package name.
# NOTE: keys are binary names as they appear in "foo: command not found"; values
# are the real Debian/Kali apt package that provides them. This map MUST cover
# every binary whose package name differs — otherwise apt fails and (previously)
# a dangerous blind `pip install <binary>` fallback grabbed a junk PyPI squatter
# (e.g. `pip install dig` → broken /usr/local/bin/dig). We now allowlist pip.
_APT_NAME_MAP = {
    # documents / media / OCR
    "convert": "imagemagick", "identify": "imagemagick", "mogrify": "imagemagick",
    "pdftoppm": "poppler-utils", "pdfinfo": "poppler-utils", "pdftotext": "poppler-utils",
    "soffice": "libreoffice", "libreoffice": "libreoffice",
    "tesseract": "tesseract-ocr", "ffmpeg": "ffmpeg", "ffprobe": "ffmpeg",
    "pdflatex": "texlive-latex-base", "latexmk": "latexmk", "exiftool": "libimage-exiftool-perl",
    # DNS / net recon (the screenshot bug lived here)
    "dig": "dnsutils", "nslookup": "dnsutils", "host": "dnsutils", "delv": "dnsutils",
    "nmap": "nmap", "ncat": "nmap", "masscan": "masscan",
    "nc": "netcat-openbsd", "netcat": "netcat-openbsd",
    "ifconfig": "net-tools", "netstat": "net-tools", "route": "net-tools", "arp": "net-tools",
    "ping": "iputils-ping", "traceroute": "traceroute", "tcpdump": "tcpdump",
    "whois": "whois", "arping": "arping", "hping3": "hping3",
    # web / vuln
    "sqlmap": "sqlmap", "nikto": "nikto", "whatweb": "whatweb", "wafw00f": "wafw00f",
    "gobuster": "gobuster", "dirb": "dirb", "wfuzz": "wfuzz", "ffuf": "ffuf",
    "wpscan": "wpscan", "sslscan": "sslscan", "sslyze": "sslyze", "testssl": "testssl.sh",
    # passwords / hashes
    "hydra": "hydra", "john": "john", "hashcat": "hashcat", "hashid": "hashid",
    "medusa": "medusa", "crunch": "crunch",
    # generic dev CLIs
    "unzip": "unzip", "zip": "zip", "jq": "jq", "git": "git", "make": "build-essential",
    "gcc": "build-essential", "g++": "build-essential", "curl": "curl", "wget": "wget",
    "openssl": "openssl", "rsync": "rsync", "ssh": "openssh-client", "sshpass": "sshpass",
    "xxd": "xxd", "file": "file", "unrar": "unrar", "7z": "p7zip-full",
    "convert_pdf": "poppler-utils", "aria2c": "aria2",
}

# ── SAFE pip fallback allowlist for the apt ladder ─────────────────────────────
# When a CLI binary is NOT in _APT_NAME_MAP and apt genuinely can't find it, we
# may ONLY try pip for a curated set of tools that REALLY ship an entry-point of
# the same (or mapped) name on PyPI. This kills the "pip install dig" class of
# bugs where a junk squatter package installs a broken /usr/local/bin/<tool>.
# key = binary name → value = the correct PyPI package that provides it.
_CLI_PIP_ALLOW = {
    "dnsrecon": "dnsrecon", "wafw00f": "wafw00f", "wapiti": "wapiti3",
    "dirsearch": "dirsearch", "sublist3r": "sublist3r", "arjun": "arjun",
    "droopescan": "droopescan", "theharvester": "theHarvester", "shodan": "shodan",
    "sqlmap": "sqlmap", "httpx": "httpx", "yt-dlp": "yt-dlp", "youtube-dl": "youtube-dl",
    "csvtool": "csvkit", "http": "httpie", "https": "httpie", "s3cmd": "s3cmd",
    "sslyze": "sslyze", "commix": "commix", "xsstrike": "XSStrike",
}
# Binaries we must NEVER pip-install (system C/Go tools with malicious/broken
# PyPI squatters). If not in _APT_NAME_MAP and apt fails, we give up cleanly.
_CLI_PIP_BLOCK = {
    "dig", "host", "nslookup", "nc", "netcat", "ncat", "nmap", "masscan", "ping",
    "traceroute", "tcpdump", "whois", "ifconfig", "netstat", "hydra", "john",
    "hashcat", "gcc", "g++", "make", "ssh", "curl", "wget", "git", "ffmpeg",
    "openssl", "gobuster", "nikto", "dirb", "ffuf", "wpscan",
}

_INSTALL_CACHE = {}  # key -> {ok, ts}; failed installs expire and can self-heal
_INSTALL_LOCK = threading.Lock()  # apt/dpkg cannot safely run concurrently
_APT_REPOS_READY = {"v": False}  # contrib/non-free + Kali repo enabled once per process


def _enable_extra_repos():
    """Enable Debian contrib/non-free + the Kali repo (pinned LOW) so classic
    pentest packages (sqlmap, nikto, hydra, whois, seclists, …) actually resolve.
    Idempotent + best-effort. Mirrors services/kaliBootstrap.js so a per-step
    install never fails just because the background bootstrap hasn't finished."""
    if _APT_REPOS_READY["v"]:
        return
    script = (
        'set +e; export DEBIAN_FRONTEND=noninteractive; '
        'SU=""; [ "$(id -u)" = "0" ] || SU="sudo"; '
        # Debian 12 deb822 .sources OR classic sources.list → add contrib/non-free
        'if [ -f /etc/apt/sources.list.d/debian.sources ]; then '
        '$SU sed -i "s/^Components:.*/Components: main contrib non-free non-free-firmware/" /etc/apt/sources.list.d/debian.sources 2>/dev/null; '
        'elif [ -f /etc/apt/sources.list ]; then '
        '$SU sed -i "s/ main$/ main contrib non-free non-free-firmware/" /etc/apt/sources.list 2>/dev/null; fi; '
        # Kali repo, pinned priority 50 so it NEVER auto-upgrades Debian
        'if command -v curl >/dev/null 2>&1 && [ ! -f /usr/share/keyrings/kali.gpg ]; then '
        'curl -fsSL https://archive.kali.org/archive-key.asc 2>/dev/null | $SU gpg --dearmor -o /usr/share/keyrings/kali.gpg 2>/dev/null; '
        'echo "deb [signed-by=/usr/share/keyrings/kali.gpg] http://http.kali.org/kali kali-rolling main contrib non-free non-free-firmware" | $SU tee /etc/apt/sources.list.d/kali.list >/dev/null 2>&1; '
        'printf "Package: *\\nPin: release o=Kali\\nPin-Priority: 50\\n" | $SU tee /etc/apt/preferences.d/kali-pin >/dev/null 2>&1; fi; '
        '$SU apt-get update -y >/dev/null 2>&1; true'
    )
    try:
        run_shell(script, timeout=180, stream=False)
    except Exception:
        pass
    _APT_REPOS_READY["v"] = True


def _ensure_pkg(name, kind="pip"):
    """Install a dependency using a robust retry ladder. Returns True on success.

    kind: 'pip' (python), 'npm' (node) or 'apt' (system CLI). Idempotent + cached.

    APT hardening (fixes the "/usr/local/bin/dig line 5" traceback class of bug):
      * Enable Debian contrib/non-free + the Kali repo first so pentest packages
        actually resolve, instead of "E: Unable to locate package".
      * A missing binary is mapped to its REAL apt package via _APT_NAME_MAP.
      * The pip fallback for a CLI is ALLOWLIST-ONLY (_CLI_PIP_ALLOW). We NEVER
        blindly `pip install <binary>` — that pulls junk squatter packages that
        drop a broken /usr/local/bin/<tool>. Blocked binaries (_CLI_PIP_BLOCK)
        are never pip-installed under any circumstance.
      * Success is proven by `command -v` (the tool is actually runnable) AND a
        smoke `--version`/`-h` where cheap — not by parsing installer chatter.
    """
    key = "%s:%s" % (kind, name)
    cached = _INSTALL_CACHE.get(key)
    if isinstance(cached, dict):
        # Success is durable for this worker; transient failures may be retried
        # after five minutes instead of poisoning the whole persistent session.
        if cached.get("ok") or (time.time() - cached.get("ts", 0) < 300):
            return bool(cached.get("ok"))
    ok = False
    _INSTALL_LOCK.acquire()
    try:
        if kind == "pip":
            pkg = _PIP_NAME_MAP.get(name, name)
            ladder = [
                "python3 -m pip install -q --break-system-packages %s" % pkg,
                "python3 -m pip install -q %s" % pkg,
                "pip3 install -q %s" % pkg,
                # last resort: apt python3-<name> for a few libs shipped by Debian
                "sudo apt-get install -y --no-install-recommends python3-%s" % name.replace("_", "-"),
            ]
            for cmd in ladder:
                r = run_shell(cmd, timeout=300, stream=False)
                if "[exit" not in r and "error" not in r.lower()[-400:] or "already satisfied" in r.lower():
                    # verify import actually works now
                    v = run_shell("python3 -c 'import %s' 2>&1" % name, timeout=30, stream=False)
                    if "Error" not in v and "Traceback" not in v:
                        ok = True
                        break
        elif kind == "npm":
            ladder = [
                "npm install --no-audit --no-fund %s" % name,
                "npm install -g --no-audit --no-fund %s" % name,
            ]
            for cmd in ladder:
                r = run_shell(cmd, timeout=300, stream=False)
                if "[exit" not in r:
                    ok = True
                    break
        else:  # apt / system CLI
            # If it's already runnable, we're done (idempotent + fast).
            v = run_shell("command -v %s >/dev/null 2>&1 && echo FOUND || echo NO" % name, timeout=15, stream=False)
            if "FOUND" in v:
                _INSTALL_CACHE[key] = {"ok": True, "ts": time.time()}
                return True
            # Make sure contrib/non-free + Kali repos are enabled so pentest pkgs resolve.
            _enable_extra_repos()
            pkg = _APT_NAME_MAP.get(name, name)
            ladder = [
                "sudo apt-get install -y --no-install-recommends %s" % pkg,
                "sudo apt-get install -y %s" % pkg,
                # If the mapped name differs from the binary, also try installing
                # a package literally named like the binary (covers Kali tools
                # where binary == package, e.g. amass, subfinder if in apt).
                "sudo apt-get install -y %s" % name if pkg != name else None,
            ]
            for cmd in ladder:
                if not cmd:
                    continue
                run_shell(cmd, timeout=420, stream=False)
                v = run_shell("command -v %s >/dev/null 2>&1 && echo FOUND || echo NO" % name, timeout=15, stream=False)
                if "FOUND" in v:
                    ok = True
                    break
            # SAFE pip fallback — ONLY for allowlisted CLIs that genuinely ship a
            # same-named entry-point on PyPI, and NEVER for blocked system tools.
            if not ok and name not in _CLI_PIP_BLOCK:
                pip_pkg = _CLI_PIP_ALLOW.get(name)
                if pip_pkg:
                    run_shell("python3 -m pip install -q --break-system-packages %s" % pip_pkg,
                              timeout=300, stream=False)
                    v = run_shell("command -v %s >/dev/null 2>&1 && echo FOUND || echo NO" % name, timeout=15, stream=False)
                    if "FOUND" in v:
                        ok = True
            if not ok:
                term("[auto-install] '%s' (apt pkg '%s') not installable via apt/allowlisted-pip — leaving unchanged (no junk squatter)." % (name, pkg))
    except Exception as e:  # noqa
        term("[auto-install] error installing %s: %s" % (name, e))
        ok = False
    finally:
        _INSTALL_LOCK.release()
    _INSTALL_CACHE[key] = {"ok": ok, "ts": time.time()}
    return ok



def tool_install(args):
    """Install a requested dependency and prove it is usable.

    The caller declares the ecosystem instead of the agent silently swapping to
    a different tool. The existing guarded ladder handles package-name mapping,
    retries, repository enablement, anti-squatter rules and smoke verification.
    """
    name = str(args.get("name") or args.get("package") or "").strip()
    kind = str(args.get("kind") or args.get("manager") or "apt").strip().lower()
    aliases = {"python": "pip", "pypi": "pip", "node": "npm", "system": "apt", "cli": "apt"}
    kind = aliases.get(kind, kind)
    if not name or not re.match(r"^[A-Za-z0-9_@./+\-]+$", name):
        return "[install_tool] error: invalid package name"
    if kind not in ("apt", "pip", "npm"):
        return "[install_tool] error: kind must be apt, pip, or npm"
    import_name = str(args.get("import_name") or "").strip()
    install_name = name
    if kind == "pip":
        import_name = import_name or _PIP_IMPORT_MAP.get(name.lower(), name.replace("-", "_"))
        install_name = import_name
    ok = _ensure_pkg(install_name, kind=kind)
    if not ok:
        return "[install_tool] INSTALL_FAILED name=%s kind=%s — all safe methods were exhausted; inspect the install log and choose a source/build/container strategy explicitly." % (name, kind)
    if kind == "apt":
        proof = run_shell("command -v %s && (%s --version 2>/dev/null | head -1 || %s -h 2>/dev/null | head -1 || true)" % (name, name, name), timeout=30, stream=False)
    elif kind == "pip":
        proof = run_shell("python3 -c 'import %s; print(\"IMPORT_OK:%s\")'" % (import_name, import_name), timeout=30, stream=False)
    else:
        proof = run_shell("node -e 'import(%s).then(()=>console.log(\"IMPORT_OK\"))'" % json.dumps(name), timeout=30, stream=False)
    return "[install_tool] INSTALL_VERIFIED name=%s kind=%s\n%s" % (name, kind, proof[:1000])


def _missing_python_module(out):
    m = re.search(r"ModuleNotFoundError: No module named ['\"]([\w\.]+)['\"]", out or "")
    if m:
        return m.group(1).split(".")[0]
    m = re.search(r"ImportError: cannot import name .* from ['\"]?([\w\.]+)", out or "")
    return None


def _missing_node_module(out):
    m = re.search(r"Cannot find module ['\"]([^'\"]+)['\"]", out or "")
    if m:
        name = m.group(1)
        # ignore relative/local requires
        if name.startswith(".") or name.startswith("/"):
            return None
        return name.split("/")[0] if not name.startswith("@") else "/".join(name.split("/")[:2])
    return None


def _missing_shell_tool(out):
    m = re.search(r"([\w\-\.]+): command not found", out or "")
    if m:
        return m.group(1)
    m = re.search(r"([\w\-\.]+): not found", out or "")
    if m:
        return m.group(1)
    return None





def tool_docker_run(args):
    cmd = (args.get("cmd") or args.get("command") or "").strip()
    if not cmd:
        return '[docker_run] No command. Pass {"cmd":"run --rm alpine echo hi"}.'
    cmd = cmd.lstrip()
    for pfx in ("sudo ", "docker ", "podman "):
        if cmd.startswith(pfx):
            cmd = cmd[len(pfx):].lstrip()
    # Ensure the container engine is set up once (idempotent).
    _ensure_docker()
    out = run_shell(
        "sudo BUILDAH_ISOLATION=chroot podman --cgroup-manager=cgroupfs %s 2>&1" % cmd,
        timeout=STEP_TIMEOUT,
    )
    return "[docker_run] $ docker %s\n%s" % (cmd, out[:12000])


_DOCKER_READY = {"v": False}


def _ensure_docker():
    if _DOCKER_READY["v"]:
        return
    sentinel = "/home/daytona/.dind_ready"
    if os.path.exists(sentinel) and run_shell("command -v podman >/dev/null 2>&1 && echo Y").strip().endswith("Y"):
        _DOCKER_READY["v"] = True
        return
    setup = r"""
set -e
sudo apt-get update -y >/dev/null 2>&1 || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y podman buildah fuse-overlayfs uidmap slirp4netns crun >/dev/null 2>&1 || true
sudo mkdir -p /etc/containers /var/lib/containers/storage /var/lib/containers/runroot
sudo tee /etc/containers/storage.conf >/dev/null <<'EOF'
[storage]
driver = "vfs"
runroot = "/var/lib/containers/runroot"
graphroot = "/var/lib/containers/storage"
EOF
sudo tee /etc/containers/containers.conf >/dev/null <<'EOF'
[containers]
default_sysctls = []
netns = "host"
userns = "host"
ipcns = "host"
utsns = "host"
cgroupns = "host"
cgroups = "disabled"
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
EOF
sudo tee /etc/containers/registries.conf >/dev/null <<'EOF'
unqualified-search-registries = ["docker.io"]
EOF
sudo ln -sf /usr/bin/podman /usr/local/bin/docker
touch /home/daytona/.dind_ready
echo DIND_OK
"""
    run_shell(setup, timeout=STEP_TIMEOUT)
    _DOCKER_READY["v"] = True


def _resolve_existing_work_path(requested):
    """Resolve a user/model supplied path inside WORK without guessing wildly.

    Accepts relative paths, the sandbox's absolute WORK prefix, and a unique
    basename fallback for attachments whose caller omitted their subdirectory.
    Every returned path is realpath-confined to WORK, including symlinks.
    """
    raw = str(requested or "").replace("\\", "/").strip()
    work_real = os.path.realpath(WORK)
    if os.path.isabs(raw):
        candidate = os.path.realpath(raw)
        if not (candidate == work_real or candidate.startswith(work_real + os.sep)):
            return "", ""
        rel = os.path.relpath(candidate, work_real).replace(os.sep, "/")
    else:
        rel = _safe_rel(raw)
        if not rel:
            return "", ""
        candidate = os.path.realpath(os.path.join(work_real, rel))
        if not (candidate == work_real or candidate.startswith(work_real + os.sep)):
            return "", ""
    if os.path.exists(candidate):
        return rel, candidate

    # Conservative recovery for the common "file exists but caller omitted the
    # extracted/upload subdirectory" failure: only resolve a UNIQUE basename.
    base = os.path.basename(rel)
    if not base:
        return rel, candidate
    matches = []
    for root, dirs, files in os.walk(work_real):
        dirs[:] = [d for d in dirs if d not in ('.git', 'node_modules') and not d.startswith('.agent_')]
        if base in files:
            matches.append(os.path.join(root, base))
            if len(matches) > 1:
                break
    if len(matches) == 1:
        found = os.path.realpath(matches[0])
        return os.path.relpath(found, work_real).replace(os.sep, "/"), found
    return rel, candidate


def tool_list_files(args):
    requested = (args or {}).get("path") or "."
    rel = _safe_rel(requested) or "."
    root = os.path.realpath(os.path.join(WORK, rel))
    work_real = os.path.realpath(WORK)
    if not (root == work_real or root.startswith(work_real + os.sep)) or not os.path.isdir(root):
        return "[list_files] Directory not found inside workspace: %s" % requested
    root_q = shlex.quote("." if rel == "." else "./" + rel.strip("/"))
    out = run_shell(
        "find %s -type f -not -path '*/.git/*' -not -path '*/node_modules/*' " % root_q +
        "-not -name '_step.*' -not -name '_step_*' -not -path './.agent_inbox/*' "
        "-not -path './.agent_outbox/*' -not -path './.agent_bridge/*' "
        "-not -path './.omni_ocr_engine/*' -not -name '.omni_*' -not -name '.agent_*' "
        "-not -path './.chrome-cache/*' -not -path './.chrome-profile*' -not -path './.latex-cache/*' "
        "-not -name '.tools_prewarmed' -not -name '.dind_ready' -not -name '.prewarm*' "
        "-printf '%s\\t%p\\n' 2>/dev/null | head -300"
    )
    return "[list_files]\n%s" % out


def tool_inspect_codebase(args):
    """Read and index the complete first-party codebase before bug fixing.

    This is deterministic grounding, not an LLM summary: every included file is
    opened in full, hashed, sized, classified, and scanned for imports. Vendor,
    VCS, caches, binaries and generated build output are excluded explicitly.
    The detailed map stays internal; the model receives compact architecture
    evidence plus a completion marker consumed by the correctness gate.
    """
    root_rel = _safe_rel(args.get("path") or ".") or "."
    root = os.path.realpath(os.path.join(WORK, root_rel))
    if not (root == os.path.realpath(WORK) or root.startswith(os.path.realpath(WORK) + os.sep)):
        return "[inspect_codebase] error: path escapes workspace"
    skip_dirs = {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", ".next", "dist", "build", "coverage", ".dart_tool", ".gradle", "target"}
    text_ext = {".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".dart", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".sh", ".sql", ".html", ".css", ".scss", ".vue", ".svelte", ".json", ".yaml", ".yml", ".toml", ".xml", ".md"}
    manifests = {"Dockerfile", "Makefile", "Procfile", "Gemfile", "Rakefile"}
    files = []
    imports = {}
    total_bytes = 0
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in skip_dirs and not d.startswith(".agent_"))
        for name in sorted(names):
            ext = os.path.splitext(name)[1].lower()
            if ext not in text_ext and name not in manifests:
                continue
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                with open(full, "rb") as fh:
                    data = fh.read()  # deliberately read the entire first-party file
                if b"\x00" in data[:8192]:
                    continue
                text = data.decode("utf-8", "replace")
            except Exception:
                continue
            digest = hashlib.sha256(data).hexdigest()
            total_bytes += len(data)
            files.append({"path": rel, "bytes": len(data), "lines": text.count("\n") + 1, "sha256": digest})
            refs = []
            for pat in (
                r"(?:require\(|from\s+|import\s+(?:[^'\"]+?\s+from\s+)?)[\"']([^\"']+)",
                r"^\s*from\s+([\w\.]+)\s+import\s+", r"^\s*import\s+([\w\.]+)",
            ):
                refs.extend(re.findall(pat, text, re.M)[:80])
            if refs:
                imports[rel] = sorted(set(refs))[:80]
    payload = {
        "root": root_rel, "generated_at": int(time.time()), "file_count": len(files),
        "total_bytes": total_bytes, "files": files, "imports": imports,
    }
    map_path = os.path.join(WORK, ".agent_codebase_map.json")
    with open(map_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    top = {}
    for item in files:
        part = item["path"].split("/", 1)[0]
        top[part] = top.get(part, 0) + 1
    sample = "\n".join("- %s (%d lines, %s)" % (f["path"], f["lines"], f["sha256"][:12]) for f in files[:120])
    return ("[inspect_codebase]\nCODEBASE_INVENTORY_COMPLETE files=%d bytes=%d hashed_full_files=%d\n"
            "Top-level architecture: %s\nImport-bearing files: %d\nFiles (first 120):\n%s\n"
            "Detailed full inventory saved internally to .agent_codebase_map.json. Now grep for the symptom, then read every file you may change in full before editing."
            % (len(files), total_bytes, len(files), json.dumps(top, sort_keys=True), len(imports), sample))


def tool_read_file(args):
    requested = args.get("path") or ""
    path, full = _resolve_existing_work_path(requested)
    if not path:
        return "[read_file] Invalid path: %s" % requested
    if not os.path.isfile(full):
        parent = os.path.dirname(path) or "."
        nearby = []
        try:
            nearby = sorted(os.listdir(os.path.join(WORK, parent)))[:40]
        except Exception:
            pass
        return "[read_file] Not found: %s. Nearby entries: %s" % (requested, ", ".join(nearby) or "none")
    try:
        with open(full, "rb") as fh:
            data = fh.read(180000)
        try:
            return "[read_file] %s:\n%s" % (path, data.decode("utf-8"))
        except Exception:
            return "[read_file] %s (binary, %d bytes)" % (path, os.path.getsize(full))
    except Exception as e:  # noqa
        return "[read_file] error: %s" % e


def tool_write_file(args):
    requested = args.get("filename") or args.get("path") or "output.txt"
    name = _safe_rel(requested)
    if not name:
        return "[write_file] Invalid path: %s" % requested
    content = args.get("content")
    if content is None:
        content = ""
    full = os.path.join(WORK, name)
    os.makedirs(os.path.dirname(full) or WORK, exist_ok=True)
    # APPEND MODE — lets the model build a long book/report one chapter per step
    # (each step stays within the brain's output budget) without truncation.
    want_append = (args.get("append") in (True, "true", "True", 1)) or \
        (str(args.get("mode") or "").lower() == "append")
    if want_append and os.path.isfile(full):
        try:
            with open(full, "r", encoding="utf-8") as fh:
                prev = fh.read()
        except Exception:
            prev = ""
        joiner = "\n\n" if (prev and not prev.endswith("\n")) else ""
        merged = prev + joiner + str(content)
        with open(full, "w", encoding="utf-8") as fh:
            fh.write(merged)
        DELIVER.add(name)
        return "[write_file] appended to %s (+%d bytes -> %d bytes total, ~%d words). Keep appending chapters until it hits the requested length, then render with {\"content_file\":\"%s\"}." % (
            name, len(str(content)), len(merged), _count_words(merged), name)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(str(content))
    DELIVER.add(name)
    return "[write_file] wrote %s (%d bytes) — queued for delivery." % (name, len(str(content)))


def tool_edit_file(args):
    path = _safe_rel(args.get("path") or "")
    if not path:
        return "[edit_file] No path."
    full = os.path.join(WORK, path)
    os.makedirs(os.path.dirname(full) or WORK, exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(str(args.get("content") or ""))
    DELIVER.add(path)
    return "[edit_file] updated %s — queued for delivery. EVIDENCE:FILE_WRITTEN"


def tool_database(args):
    """Discover/inspect/query SQLite in the current sandbox with evidence."""
    if _database_execute is None:
        return "[database] error: database intelligence module is unavailable"
    try:
        result = _database_execute(dict(args or {}), WORK)
        # A written database is a concrete deliverable; reads never queue files.
        if result.get("ok") and result.get("action") == "write" and result.get("database"):
            try:
                rel = os.path.relpath(result["database"], WORK)
                if not rel.startswith(".."):
                    DELIVER.add(rel)
            except Exception:
                pass
        return "[database]\n%s" % json.dumps(result, ensure_ascii=False, indent=2, default=str)[:16000]
    except Exception as e:  # noqa
        return "[database] error: %s" % e


def tool_make_zip(args):
    output = _safe(args.get("output") or "result.zip")
    source = _safe_rel(args.get("source") or ".") or "."
    out = run_shell("zip -r -q '%s' '%s' -x '*_step.*' '*.agent_inbox*' '*.agent_outbox*' 2>&1 || "
                    "(command -v zip >/dev/null || (sudo apt-get install -y zip >/dev/null 2>&1)); "
                    "zip -r -q '%s' '%s' 2>&1; echo done" % (output, source, output, source))
    if os.path.exists(os.path.join(WORK, output)):
        DELIVER.add(output)
        return "[make_zip] created %s — queued for delivery." % output
    return "[make_zip] %s" % out


def _safe_rel(p):
    p = str(p or "").replace("\\", "/").lstrip("/")
    if ".." in p.split("/"):
        return ""
    return p


# ── 📎 CONSOLIDATE — merge many chunk files into ONE document (req #3) ────────
# The agent sometimes produces its output in PIECES (chapter1.md, chapter2.md, …
# or several small zips) because each brain step has a bounded output size. The
# user then receives a pile of fragments instead of one deliverable. This tool
# merges the pieces into a SINGLE ordered document (Markdown by default; can also
# render straight to PDF), so the final answer is one clean file — never "split
# into different zips/documents".
#
# Args:
#   sources  : explicit list of files to merge, in order. If omitted, we
#              auto-discover the natural chunk set in WORK (part*/chapter*/
#              section*/*_1,*_2… and loose *.md/*.txt) sorted naturally.
#   output   : output filename (default combined.md). If it ends in .pdf we
#              render the merged Markdown to a validated PDF via latex_render.
#   title    : optional document title (used for the PDF cover / top heading).
#   separators (bool, default True): insert a "\n\n---\n\n" between pieces.
def _natural_key(s):
    import re as _r2
    return [int(t) if t.isdigit() else t.lower() for t in _r2.split(r"(\d+)", str(s))]


def _auto_chunk_files():
    """Discover the natural set of chunk files in WORK to merge, sorted so
    part2 comes before part10. Excludes internal scaffolding + already-merged
    outputs + binaries we shouldn't concatenate as text."""
    import re as _r2
    cand = []
    chunk_re = _r2.compile(r"(part|chapter|chap|section|sec|page|piece|chunk)[ _\-]?\d+", _r2.I)
    for name in os.listdir(WORK):
        full = os.path.join(WORK, name)
        if not os.path.isfile(full):
            continue
        if _is_internal_artifact(name):
            continue
        low = name.lower()
        if low in ("combined.md", "combined.pdf", "final.md", "final.pdf"):
            continue
        if low.endswith((".md", ".markdown", ".txt")) or chunk_re.search(name):
            if low.endswith((".zip", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".gif", ".bin")):
                continue
            cand.append(name)
    cand.sort(key=_natural_key)
    return cand


def tool_consolidate(args):
    sources = args.get("sources") or args.get("files") or []
    if isinstance(sources, str):
        sources = [s.strip() for s in re.split(r"[,\n]", sources) if s.strip()]
    if not sources:
        sources = _auto_chunk_files()
    # Resolve + keep only readable text files that exist.
    resolved = []
    for s in sources:
        rel = _safe_rel(s)
        full = os.path.join(WORK, rel)
        if rel and os.path.isfile(full):
            resolved.append((rel, full))
    if not resolved:
        return ("[consolidate] No chunk files found to merge. Pass "
                '{"sources":["part1.md","part2.md",...]} or write the chunks first '
                "(write_file with append:true), then consolidate.")

    want_seps = args.get("separators", True) not in (False, "false", "False", 0, "0")
    title = str(args.get("title") or "").strip()
    output = _safe(args.get("output") or "combined.md")

    parts = []
    if title:
        parts.append("# %s\n" % title)
    for i, (rel, full) in enumerate(resolved):
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                body = fh.read().rstrip()
        except Exception as e:  # noqa
            body = "[could not read %s: %s]" % (rel, e)
        if want_seps and (i > 0 or title):
            parts.append("\n\n---\n\n")
        parts.append(body)
    merged = "\n".join(parts).strip() + "\n"

    # If the output is a PDF, render the merged Markdown to a validated PDF.
    if output.lower().endswith(".pdf"):
        if _latex_render is not None:
            try:
                n = _local_render_pdf(merged, output, title=title)
                DELIVER.add(output)
                return "[consolidate] merged %d file(s) → %s (PDF, %d KB) @sandbox. Queued for delivery. Source chunks NOT delivered separately." % (
                    len(resolved), output, n // 1024)
            except Exception as e:  # noqa
                term("[consolidate] PDF render failed (%s) — writing merged Markdown instead." % e)
        # Fall back to writing the merged markdown with a .md name.
        output = output[:-4] + ".md"

    full_out = os.path.join(WORK, output)
    with open(full_out, "w", encoding="utf-8") as fh:
        fh.write(merged)
    DELIVER.add(output)
    # De-queue the individual chunks so the user gets ONE file, not the pieces.
    for rel, _f in resolved:
        try:
            DELIVER.discard(rel)
        except Exception:
            pass
    return ("[consolidate] merged %d file(s) → %s (%d bytes, ~%d words). "
            "Queued for delivery; the individual chunk files were removed from delivery so "
            "the user gets ONE document." % (len(resolved), output, len(merged), _count_words(merged)))


# ─────────────────────────────────────────────────────────────────────────────
# LOCAL create_pdf / *→pdf — HIGH-QUALITY, IN-SANDBOX (no host round-trip)
#
# Builds a REAL LaTeX document (native math + tables + code + TikZ/PGFPlots
# charts & diagrams) via latex_render.py and compiles it with Tectonic INSIDE
# the sandbox. The agent produces print-quality, VALIDATED PDFs — vastly better
# than the old blank-prone HTML→PDF path — right here on the box:
#   • light on the Render host (all compilation happens in the sandbox),
#   • Tectonic auto-fetches ONLY the packages a doc uses, then caches them,
#   • output is validated (real header + non-trivial size + >=1 page) so a
#     blank/empty PDF is never shipped.
# If the LaTeX engine can't be provisioned (no network for the tectonic download
# and no system pdflatex), we fall back to the host bridge create_pdf so the
# user ALWAYS gets a PDF.
# ─────────────────────────────────────────────────────────────────────────────

def _esc_html(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _md_inline(s):
    """Very small inline-markdown → HTML (bold/italic/code/strikethrough/links).

    Math delimiters \\( \\) \\[ \\] $ $$ are preserved untouched so MathJax can
    typeset them in the rendered DOM.
    """
    s = _esc_html(s)
    s = _re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = _re.sub(r"\*\*\*([^*]+)\*\*\*", r"<strong><em>\1</em></strong>", s)
    s = _re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = _re.sub(r"~~([^~]+)~~", r"<del>\1</del>", s)
    s = _re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = _re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def _md_to_html(md):
    """Block-level markdown → HTML: headings, lists, tables, code fences,
    blockquotes, hr, paragraphs. Deliberately compact but covers what the agent
    emits for reports and worked solutions. Raw HTML lines are passed through so
    the model can embed <img>/<svg>/styled cards."""
    md = str(md or "")
    lines = md.split("\n")
    out = []
    i = 0
    n = len(lines)
    in_code = False
    code_buf = []

    def flush_para(buf):
        text = " ".join(buf).strip()
        if text:
            out.append("<p>%s</p>" % _md_inline(text))

    para = []
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # Fenced code blocks.
        if stripped.startswith("```"):
            if in_code:
                out.append("<pre><code>%s</code></pre>" % _esc_html("\n".join(code_buf)))
                code_buf = []
                in_code = False
            else:
                flush_para(para); para = []
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(raw)
            i += 1
            continue

        if not stripped:
            flush_para(para); para = []
            i += 1
            continue

        # Pagebreak directive.
        if _re.match(r"^(\\pagebreak|\\newpage)$", stripped, _re.I):
            flush_para(para); para = []
            out.append('<div class="pagebreak"></div>')
            i += 1
            continue

        # Horizontal rule.
        if _re.match(r"^([-*_])(\s*\1){2,}$", stripped):
            flush_para(para); para = []
            out.append("<hr/>")
            i += 1
            continue

        # Headings.
        hm = _re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if hm:
            flush_para(para); para = []
            level = len(hm.group(1))
            out.append("<h%d>%s</h%d>" % (level, _md_inline(hm.group(2)), level))
            i += 1
            continue

        # Tables (| a | b | with a --- separator row).
        if "|" in stripped and i + 1 < n and _re.match(r"^\s*\|?[\s:\-|]+\|?\s*$", lines[i + 1]):
            flush_para(para); para = []
            header = [c.strip() for c in stripped.strip("|").split("|")]
            rows = []
            i += 2
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join("<th>%s</th>" % _md_inline(c) for c in header)
            trs = ""
            for r in rows:
                trs += "<tr>%s</tr>" % "".join("<td>%s</td>" % _md_inline(c) for c in r)
            out.append("<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>" % (th, trs))
            continue

        # Blockquote.
        if _re.match(r"^>\s?", stripped):
            flush_para(para); para = []
            out.append("<blockquote><p>%s</p></blockquote>" % _md_inline(_re.sub(r"^>\s?", "", stripped)))
            i += 1
            continue

        # Unordered list.
        if _re.match(r"^[-*+]\s+", stripped):
            flush_para(para); para = []
            items = []
            while i < n and _re.match(r"^\s*[-*+]\s+", lines[i]):
                items.append("<li>%s</li>" % _md_inline(_re.sub(r"^\s*[-*+]\s+", "", lines[i].strip())))
                i += 1
            out.append("<ul>%s</ul>" % "".join(items))
            continue

        # Ordered list.
        if _re.match(r"^\d+[.)]\s+", stripped):
            flush_para(para); para = []
            items = []
            while i < n and _re.match(r"^\s*\d+[.)]\s+", lines[i]):
                items.append("<li>%s</li>" % _md_inline(_re.sub(r"^\s*\d+[.)]\s+", "", lines[i].strip())))
                i += 1
            out.append("<ol>%s</ol>" % "".join(items))
            continue

        # Raw HTML line — pass through untouched (embedded img/svg/cards).
        if stripped.startswith("<") and _re.match(r"^<\/?[a-zA-Z]", stripped):
            flush_para(para); para = []
            out.append(raw)
            i += 1
            continue

        para.append(stripped)
        i += 1

    if in_code and code_buf:
        out.append("<pre><code>%s</code></pre>" % _esc_html("\n".join(code_buf)))
    flush_para(para)
    return "\n".join(out)


# MathJax runtime + a readiness flag (window.__mjReady) — identical config to the
# host buildMathHtml so \( \) \[ \] $ $$ typeset and the renderer's wait resolves.
_MATHJAX_HEAD = (
    "<script>\n"
    "  window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)'],['$','$']],"
    "displayMath:[['\\\\[','\\\\]'],['$$','$$']]},svg:{fontCache:'global'},"
    "startup:{pageReady(){return MathJax.startup.defaultPageReady().then(function(){window.__mjReady=true;});}}};\n"
    "  setTimeout(function(){ if(!window.__mjReady) window.__mjReady=true; }, 6000);\n"
    "</script>\n"
    '<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>\n'
)

_PDF_CSS = """
  @page { margin: 22mm 18mm 20mm 18mm; }
  body{font-family:'Georgia','Segoe UI',Arial,serif;font-size:12pt;line-height:1.6;color:#1a1a1a;}
  h1{font-size:21pt;border-bottom:2px solid #333;padding-bottom:6px;margin:1.1em 0 .5em;page-break-after:avoid;}
  h2{font-size:16pt;margin:1.1em 0 .4em;color:#222;page-break-after:avoid;}
  h3{font-size:13.5pt;margin:.9em 0 .3em;color:#333;page-break-after:avoid;}
  h4,h5,h6{font-size:12pt;margin:.8em 0 .3em;color:#444;page-break-after:avoid;}
  p{margin:.45em 0;text-align:justify;}
  ul,ol{margin:.35em 0 .7em 1.4em;} li{margin:.18em 0;}
  blockquote{margin:.6em 0;padding:.3em 1em;border-left:4px solid #ccc;color:#555;background:#fafafa;}
  blockquote p{margin:.2em 0;}
  code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-family:Consolas,'Courier New',monospace;font-size:.9em;}
  pre{background:#f6f8fa;padding:11px 13px;border-radius:6px;overflow:auto;border:1px solid #eaecef;page-break-inside:avoid;}
  pre code{background:none;padding:0;font-size:.86em;line-height:1.45;}
  table{border-collapse:collapse;margin:.7em 0;width:100%;font-size:.95em;page-break-inside:avoid;}
  th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top;}
  th{background:#f0f0f0;font-weight:600;}
  hr{border:none;border-top:1px solid #ddd;margin:1em 0;}
  .pagebreak{page-break-after:always;height:0;}
  .doc-title{font-size:26pt;font-weight:700;margin:0 0 .15em;line-height:1.2;}
  .doc-subtitle{font-size:13pt;font-style:italic;color:#666;margin-bottom:1.2em;}
  del{color:#999;}
  .diagram{margin:.9em 0;text-align:center;page-break-inside:avoid;}
  .diagram svg,.diagram img{max-width:100%;height:auto;}
"""


def _build_math_html(title, content, subtitle=""):
    body = _md_to_html(content)
    sub = ('<div class="doc-subtitle">%s</div>' % _esc_html(subtitle)) if subtitle else ""
    head_title = ('<div class="doc-title">%s</div>' % _esc_html(title)) if title else ""
    return (
        '<!doctype html><html><head><meta charset="utf-8">\n'
        "<style>%s</style>\n%s</head><body>\n%s\n%s\n%s\n</body></html>"
        % (_PDF_CSS, _MATHJAX_HEAD, head_title, sub, body)
    )


def _ensure_mathjax(html):
    """Guarantee a rich HTML doc has the MathJax runtime + readiness flag so the
    local renderer's wait resolves and \\( \\) / \\[ \\] typeset even if the model
    forgot the script. Mirrors the host ensureMathJax."""
    s = str(html or "")
    if _re.search(r"MathJax|tex-svg\.js|tex-chtml\.js", s, _re.I):
        # Still ensure a readiness flag exists so the renderer doesn't wait the
        # full ceiling on a doc that already typesets fast.
        if "__mjReady" not in s:
            inject = ("<script>setTimeout(function(){window.__mjReady=true;},6000);</script>")
            if _re.search(r"</head>", s, _re.I):
                return _re.sub(r"</head>", inject + "</head>", s, count=1, flags=_re.I)
            return inject + s
        return s
    if _re.search(r"</head>", s, _re.I):
        return _re.sub(r"</head>", _MATHJAX_HEAD + "</head>", s, count=1, flags=_re.I)
    if _re.search(r"<body", s, _re.I):
        return _re.sub(r"(<body[^>]*>)", _MATHJAX_HEAD + r"\1", s, count=1, flags=_re.I)
    return "<head>%s</head>%s" % (_MATHJAX_HEAD, s)


def _html_to_markish(html):
    """Best-effort convert a chunk of HTML into Markdown-ish text so the LaTeX
    engine can typeset it. Preserves headings, lists, bold/italic, code and
    paragraph structure; strips scripts/styles. NOT a full HTML engine — the
    agent is instructed to author Markdown/LaTeX, this is only a safety net for
    when a model hands us HTML."""
    s = str(html or "")
    s = _re.sub(r"(?is)<script.*?</script>", "", s)
    s = _re.sub(r"(?is)<style.*?</style>", "", s)
    s = _re.sub(r"(?is)<h1[^>]*>(.*?)</h1>", r"\n# \1\n", s)
    s = _re.sub(r"(?is)<h2[^>]*>(.*?)</h2>", r"\n## \1\n", s)
    s = _re.sub(r"(?is)<h3[^>]*>(.*?)</h3>", r"\n### \1\n", s)
    s = _re.sub(r"(?is)<h4[^>]*>(.*?)</h4>", r"\n#### \1\n", s)
    s = _re.sub(r"(?is)<(b|strong)[^>]*>(.*?)</\1>", r"**\2**", s)
    s = _re.sub(r"(?is)<(i|em)[^>]*>(.*?)</\1>", r"*\2*", s)
    s = _re.sub(r"(?is)<code[^>]*>(.*?)</code>", r"`\1`", s)
    s = _re.sub(r"(?is)<li[^>]*>(.*?)</li>", r"\n- \1", s)
    s = _re.sub(r"(?is)<br\s*/?>", "\n", s)
    s = _re.sub(r"(?is)</p>", "\n\n", s)
    s = _re.sub(r"(?is)<img[^>]*src=[\"']([^\"']+)[\"'][^>]*>", r"\n![](\1)\n", s)
    s = _re.sub(r"(?s)<[^>]+>", "", s)  # strip any remaining tags
    # Unescape the few common entities.
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
                 ("&#39;", "'"), ("&nbsp;", " ")):
        s = s.replace(a, b)
    return s.strip()


def _local_render_pdf(content, out_name, title="", subtitle="", is_full_latex=False):
    """Build `content` (Markdown/LaTeX) → out_name (in WORK) with the in-sandbox
    LaTeX engine (Tectonic). Returns bytes written, or raises. The output is
    VALIDATED (real header + non-trivial size + >=1 page) by latex_render, so a
    blank/empty PDF raises instead of silently shipping. Marks the file for
    delivery on success."""
    if _latex_render is None:
        raise RuntimeError("latex_render module not available in this worker")
    out_full = os.path.join(WORK, _safe(out_name))
    # Compile inside WORK so relative \includegraphics{image.png} resolve to the
    # deliverables the agent already produced.
    n = _latex_render.build_pdf(
        content, out_full, title=title, subtitle=subtitle,
        is_full_latex=is_full_latex, assets_dir=WORK,
    )
    DELIVER.add(_safe(out_name))
    return n


def tool_create_pdf(args):
    """LOCAL create_pdf — build a REAL LaTeX document (native math + tables +
    code + TikZ/PGFPlots charts & diagrams) and compile it to a print-quality,
    VALIDATED PDF INSIDE the sandbox with Tectonic. Falls back to the host
    bridge renderer only if the local LaTeX compile genuinely fails, so a PDF is
    ALWAYS produced — and never a blank one (latex_render validates the output).

    Accepts (in priority order):
      • latex  : a full LaTeX document string (\\documentclass … \\end{document})
      • content: Markdown (headings, lists, tables, $math$, ```chart blocks, …)
      • content_file: a path in WORK to read the Markdown/LaTeX from
      • html   : (legacy) HTML — converted to Markdown-ish text as a safety net
    """
    filename = _safe(args.get("filename") or "document.pdf")
    if not filename.lower().endswith(".pdf"):
        filename += ".pdf"
    title = args.get("title") or ""
    subtitle = args.get("subtitle") or ""

    # 1) Explicit full-LaTeX document (highest fidelity; agent-authored TikZ etc).
    raw_latex = args.get("latex") or args.get("tex")
    if isinstance(raw_latex, str) and "\\documentclass" in raw_latex:
        try:
            n = _local_render_pdf(raw_latex, filename, is_full_latex=True)
            return "[create_pdf] created %s (LaTeX document, %d KB) @sandbox." % (filename, n // 1024)
        except Exception as e:  # noqa
            term("[create_pdf] LaTeX compile failed (%s) — proxying to host." % e)
            return host_tool("create_pdf", dict(args))

    # 2) Resolve Markdown content (inline `content` OR `content_file`).
    content = args.get("content")
    if content is None or (isinstance(content, str) and not content.strip()):
        cf = _safe_rel(args.get("content_file") or "")
        if cf and os.path.isfile(os.path.join(WORK, cf)):
            try:
                with open(os.path.join(WORK, cf), "r", encoding="utf-8") as fh:
                    content = fh.read()
            except Exception:
                content = ""

    # 3) Legacy HTML input → downgrade to Markdown-ish so LaTeX can typeset it.
    if (content is None or (isinstance(content, str) and not content.strip())):
        raw_html = args.get("html")
        if isinstance(raw_html, str) and raw_html.strip():
            content = _html_to_markish(raw_html)

    content = "" if content is None else str(content)

    # WRITING-LENGTH GATE — refuse to ship a half-empty story/report; bounce
    # back to the loop with precise instructions to write it in full. Only
    # applies to text/markdown content (a full-LaTeX doc already returned above).
    _gate = _enforce_writing_length("create_pdf", filename, content, args)
    if _gate:
        return _gate

    if content.strip():
        try:
            n = _local_render_pdf(content, filename, title=title, subtitle=subtitle)
            return "[create_pdf] created %s (LaTeX: math + charts + diagrams, %d KB) @sandbox." % (
                filename, n // 1024)
        except Exception as e:  # noqa
            term("[create_pdf] LaTeX compile failed (%s) — proxying to host." % e)

    # 4) Fallback: host bridge so we ALWAYS return a PDF even if the sandbox
    #    LaTeX engine can't be provisioned (e.g. no network for the tectonic
    #    download and no system pdflatex).
    proxy_args = dict(args)
    proxy_args["content"] = content
    return host_tool("create_pdf", proxy_args)


def tool_convert_file(args):
    """convert_file — handle *→PDF LOCALLY for text-ish inputs (Markdown / LaTeX
    / HTML) via the in-sandbox LaTeX engine (high quality, validated, no blank
    PDFs); proxy every other conversion pair (office / image / OCR) to the host
    converter (LibreOffice/Pandoc/etc.).

    This gives the LaTeX quality boost to the common quality-sensitive text→pdf
    pairs while leaving the rich office/OCR matrix on the host tool that already
    handles it. NOTE: replaces the old Chromium html→pdf path."""
    to = str(args.get("to") or args.get("target") or "").lower().lstrip(".").strip()
    src = str(args.get("source") or args.get("path") or args.get("input") or "").lstrip("./")
    from_ext = str(args.get("from") or "").lower().lstrip(".")
    inline_html = args.get("html")
    inline_latex = args.get("latex") or args.get("tex")
    inline_md = args.get("content") or args.get("markdown")

    src_lower = src.lower()
    is_tex_src = (from_ext in ("tex", "latex")) or src_lower.endswith((".tex", ".latex")) or \
        (isinstance(inline_latex, str) and inline_latex.strip())
    is_md_src = (from_ext in ("md", "markdown", "txt")) or src_lower.endswith((".md", ".markdown", ".txt")) or \
        (isinstance(inline_md, str) and inline_md.strip())
    is_html_src = (from_ext in ("html", "htm")) or src_lower.endswith((".html", ".htm")) or \
        (isinstance(inline_html, str) and inline_html.strip())

    if to == "pdf" and (is_tex_src or is_md_src or is_html_src) and _latex_render is not None:
        try:
            is_full_latex = False
            if is_tex_src:
                text = inline_latex if (isinstance(inline_latex, str) and inline_latex.strip()) else None
                if text is None:
                    full = os.path.join(WORK, _safe_rel(src))
                    if not os.path.isfile(full):
                        return host_tool("convert_file", args)
                    with open(full, "r", encoding="utf-8") as fh:
                        text = fh.read()
                is_full_latex = True
                kind = "latex"
            elif is_md_src:
                text = inline_md if (isinstance(inline_md, str) and inline_md.strip()) else None
                if text is None:
                    full = os.path.join(WORK, _safe_rel(src))
                    if not os.path.isfile(full):
                        return host_tool("convert_file", args)
                    with open(full, "r", encoding="utf-8") as fh:
                        text = fh.read()
                kind = "markdown"
            else:  # html
                if isinstance(inline_html, str) and inline_html.strip():
                    text = _html_to_markish(inline_html)
                else:
                    full = os.path.join(WORK, _safe_rel(src))
                    if not os.path.isfile(full):
                        return host_tool("convert_file", args)
                    with open(full, "r", encoding="utf-8") as fh:
                        text = _html_to_markish(fh.read())
                kind = "html"

            base = _safe(args.get("filename") or (os.path.basename(src).rsplit(".", 1)[0] if src else "output"))
            out = base if base.lower().endswith(".pdf") else (base + ".pdf")
            n = _local_render_pdf(text, out, title=(args.get("title") or ""), is_full_latex=is_full_latex)
            return "[convert_file] ✅ Converted %s → %s via in-sandbox LaTeX (%d KB). Queued for delivery." % (
                kind, out, n // 1024)
        except Exception as e:  # noqa
            term("[convert_file] local %s→pdf failed (%s) — proxying to host." % (to, e))

    # Everything else → the host converter (office/pdf/image/latex matrix).
    return host_tool("convert_file", args)


# ── Deliverable tracking ─────────────────────────────────────────────────────
DELIVER = set()

import re as _re

# Internal SCAFFOLDING that must NEVER be returned to the user as a deliverable.
# Mirrors agentEngine._isInternalArtifact on the host. Without this, the OmniOCR
# engine (staged into ./.omni_ocr_engine/…), staged OCR inputs (.omni_in_*),
# scratch scripts (_step*), the analysis-memory note, and docker/pre-warm
# scaffolding were swept into the deliverables — burying the real PDF/DOCX among
# a dozen junk *.py files (the "file path is broken" symptom).
def _is_internal_artifact(rel):
    p = str(rel or "").replace("\\", "/")
    # Strip a single leading "./" or "/" prefix WITHOUT eating a leading dot
    # (lstrip("./") would turn ".omni_ocr_engine" into "omni_ocr_engine").
    if p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    if not p:
        return True
    if _re.search(r"(^|/)_step(_|\.)", p):
        return True
    if _re.search(r"(^|/)\.agent_", p):           # .agent_memory.md / inbox / outbox / bridge
        return True
    if _re.search(r"(^|/)\.omni_ocr_engine(/|$)", p):
        return True
    if _re.search(r"(^|/)\.omni_", p):             # .omni_in_*, .omni_*
        return True
    if _re.search(r"(^|/)\.dind_ready$", p):
        return True
    if _re.search(r"(^|/)\.prewarm(\.|_)", p):
        return True
    # In-sandbox PDF engine scaffolding — the LaTeX package/tectonic cache and
    # the downloaded Chromium cache (legacy) must NEVER be delivered.
    if _re.search(r"(^|/)\.chrome-cache(/|$)", p):
        return True
    if _re.search(r"(^|/)\.chrome-profile", p):
        return True
    if _re.search(r"(^|/)\.latex-cache(/|$)", p):
        return True
    if _re.search(r"(^|/)(pdf_render|latex_render)\.py$", p):
        return True
    if _re.search(r"(^|/)\.mkarchive_", p):
        return True
    if _re.search(r"(^|/)(\.git|node_modules)(/|$)", p):
        return True
    # Build / dependency / cache artifacts that incidental shell ops (npm/pip/
    # build) rewrite — they are NOT task deliverables and must never leak into
    # the user's files, even when a command bumps their mtime/content.
    if _re.search(r"(^|/)(dist|build|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|vendor|\.gradle|target|\.svelte-kit|\.expo|\.dart_tool|Pods)(/|$)", p):
        return True
    if _re.search(r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|go\.sum)$", p):
        return True
    if _re.search(r"\.(pyc|pyo|class|o|obj|log)$", p):
        return True
    # Loose OmniOCR engine source files if ever flattened into the workdir.
    if _re.match(r"^(ocr_extract|omni_ocr|engine|preprocessing|documents|__init__)(_\d+)?\.py$", p):
        return True
    return False


def _snapshot():
    snap = {}
    for root, dirs, fnames in os.walk(WORK):
        if "/.git" in root or "/node_modules" in root or ".agent_inbox" in root or ".agent_outbox" in root \
                or ".agent_bridge" in root or ".omni_ocr_engine" in root \
                or ".chrome-cache" in root or ".chrome-profile" in root or ".latex-cache" in root:
            # Prune heavy renderer dirs from the walk so snapshots stay fast.
            dirs[:] = [d for d in dirs if d not in (".chrome-cache", ".latex-cache") and not d.startswith(".chrome-profile")]
            continue
        # Never descend into the LaTeX/Chromium caches / throwaway profiles (huge).
        dirs[:] = [d for d in dirs if d not in (".chrome-cache", ".latex-cache") and not d.startswith(".chrome-profile")]
        for fn in fnames:
            fp = os.path.join(root, fn)
            try:
                st = os.stat(fp)
                rel = os.path.relpath(fp, WORK)
                if _is_internal_artifact(rel):
                    continue
                snap[rel] = (st.st_size, int(st.st_mtime))
            except Exception:
                pass
    return snap


def _captured(before):
    after = _snapshot()
    changed = []
    for rel, sig in after.items():
        if _is_internal_artifact(rel):
            continue
        if before.get(rel) != sig:
            changed.append(rel)
            DELIVER.add(rel)
    return changed


# File extensions that indicate "this is source code / a coding project" — used
# to decide whether a multi-file deliverable should be bundled into ONE zip.
_CODE_EXTS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".java", ".kt", ".go",
    ".rs", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift",
    ".sh", ".bash", ".sql", ".html", ".htm", ".css", ".scss", ".sass", ".vue",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".xml", ".gradle",
    ".dockerfile", ".makefile", ".cmake", ".lua", ".dart", ".scala", ".ex",
    ".exs", ".r", ".m", ".pl", ".pm", ".tsx", ".proto",
}
# Non-code binary/document deliverables that should ALWAYS be sent as-is (never
# swept into a zip) because the user wants the individual document back.
# ⚠️ PER USER RULE: ONLY office documents + images are shipped individually
# (pdf, docx/doc, pptx/ppt, xlsx/xls, png, jpg/jpeg, gif and close cousins).
# EVERYTHING ELSE — including all code, text, data (.csv/.json/.txt/.md), media
# (.mp4/.mp3), and pre-made archives — is bundled into ONE zip whenever there
# are 2+ such files. A single non-document file is delivered as-is.
_STANDALONE_EXTS = {
    ".pdf",
    ".docx", ".doc",
    ".pptx", ".ppt",
    ".xlsx", ".xls",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff",
}


def _is_code_rel(rel):
    base = os.path.basename(str(rel or "")).lower()
    ext = os.path.splitext(base)[1]
    if ext in _CODE_EXTS:
        return True
    # Common extension-less code/config files.
    if base in ("dockerfile", "makefile", "cmakelists.txt", ".gitignore",
                "requirements.txt", "package.json", "readme.md", ".env"):
        return True
    return False


def _file_sha1(fp, max_bytes=64 * 1024 * 1024):
    """SHA-1 of a file's content, or None on error / oversize. Used to tell a
    genuinely NEW/CHANGED deliverable from a leftover whose mtime was merely
    bumped (formatter, re-clone, npm install) but whose bytes are unchanged."""
    try:
        if os.path.getsize(fp) > max_bytes:
            return None
        h = hashlib.sha1()
        with open(fp, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _list_task_deliverables(max_bytes):
    """The set of files to deliver for the CURRENT task only.

    A file qualifies when it is registered in DELIVER AND it is genuinely NEW or
    CHANGED relative to the task-start baseline. Isolation uses THREE gates so
    that leftovers from earlier tasks in a persistent sandbox are never
    re-delivered even when an incidental op (re-clone, npm install, formatter,
    git) bumps their mtime:
      1) size:mtime unchanged vs baseline  → skip (fast path, untouched file);
      2) mtime older than the task start   → skip (predates this task);
      3) content hash equal to baseline    → skip (bytes identical to a file
         that existed before this task — only its mtime changed).
    Only files that survive all three gates are this task's real output.
    """
    rels = []
    seen = set()
    # A small epsilon so a file written in the same second the task started
    # (baseline snapshot vs first write race) is not wrongly excluded.
    start_floor = (_TASK_START_TS or 0) - 2.0
    for rel in sorted(DELIVER):
        if _is_internal_artifact(rel):
            continue
        fp = os.path.join(WORK, rel)
        try:
            if not os.path.isfile(fp):
                continue
            size = os.path.getsize(fp)
            if size > max_bytes:
                continue
            mtime = os.path.getmtime(fp)
            # Gate 1: identical size:mtime as baseline → untouched leftover.
            try:
                if _TASK_BASELINE.get(rel) == (size, int(mtime)):
                    continue
            except Exception:
                pass
            # Only apply the older-than-start & hash gates to files that ALREADY
            # existed at task start. A brand-new file (not in baseline) is always
            # this task's output and must be delivered.
            if rel in _TASK_BASELINE:
                # Gate 2: file's mtime predates the task → not produced now.
                if start_floor and mtime < start_floor:
                    continue
                # Gate 3: content byte-identical to baseline → only mtime moved.
                base_hash = _TASK_BASELINE_HASH.get(rel)
                if base_hash is not None:
                    cur_hash = _file_sha1(fp)
                    if cur_hash is not None and cur_hash == base_hash:
                        continue
            if rel in seen:
                continue
            seen.add(rel)
            rels.append(rel)
        except Exception:
            pass
    return rels



def _read_b64(rel, max_bytes):
    fp = os.path.join(WORK, rel)
    if not os.path.isfile(fp):
        return None
    if os.path.getsize(fp) > max_bytes:
        return None
    with open(fp, "rb") as fh:
        return base64.b64encode(fh.read()).decode("ascii")


def collect_deliverables(max_bytes=45 * 1024 * 1024):
    """Return this task's deliverables as [{name, b64}].

    Two guarantees (the two bugs this fixes):
      1) ISOLATION — only files created/changed during THIS task are returned;
         leftovers from earlier tasks in a persistent sandbox are filtered out
         via the task-start baseline (size:mtime + content hash + start time).
      2) ZIP EVERYTHING-ELSE — per the user's rule, ONLY office documents and
         images (pdf, docx/doc, pptx/ppt, xlsx/xls, png/jpg/jpeg/gif/…) are
         delivered individually. EVERYTHING ELSE (code, text, data, media,
         pre-made archives) is bundled into ONE zip when there are 2+ such
         files; a lone non-document file is delivered as-is (no pointless
         one-file zip).
    """
    import zipfile as _zip
    import io as _io

    rels = _list_task_deliverables(max_bytes)
    if not rels:
        return []

    # Prefer a REAL, valid agent-built ZIP when it contains every loose
    # non-document output. The former unconditional archive drop could discard
    # a complete post-coding project.zip and rebuild a partial archive from only
    # the files touched in the last step. Invalid or incomplete archives are
    # still removed and rebuilt deterministically below.
    _ARCHIVE_EXTS = (".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar")
    def _is_archive(rel):
        low = os.path.basename(rel).lower()
        return low.endswith(_ARCHIVE_EXTS) or low.endswith(".tar.gz") or low.endswith(".tar.bz2")
    non_archive = [r for r in rels if not _is_archive(r)]
    loose_project = [r for r in non_archive if os.path.splitext(os.path.basename(r))[1].lower() not in _STANDALONE_EXTS]
    complete_zip = None
    for archive_rel in [r for r in rels if r.lower().endswith(".zip")]:
        try:
            archive_fp = os.path.join(WORK, archive_rel)
            with _zip.ZipFile(archive_fp, "r") as zf:
                entries = [n.lstrip("./") for n in zf.namelist() if n and not n.endswith("/")]
                bad = zf.testzip()
            if bad or not entries:
                continue
            covers = True
            for rel in loose_project:
                norm = str(rel).replace("\\", "/").lstrip("./")
                base = os.path.basename(norm)
                if not any(e == norm or e == base or e.endswith("/" + norm) or e.endswith("/" + base) for e in entries):
                    covers = False
                    break
            if covers:
                complete_zip = archive_rel
                break
        except Exception:
            pass
    if complete_zip:
        files = []
        b64 = _read_b64(complete_zip, max_bytes)
        if b64 is not None:
            files.append({"name": os.path.basename(complete_zip), "b64": b64})
        for rel in non_archive:
            ext = os.path.splitext(os.path.basename(rel))[1].lower()
            if ext in _STANDALONE_EXTS:
                doc_b64 = _read_b64(rel, max_bytes)
                if doc_b64 is not None:
                    files.append({"name": os.path.basename(rel), "b64": doc_b64})
        return files
    if non_archive:
        rels = non_archive
    if not rels:
        return []

    # Split into "individual" (office docs + images) vs "bundle" (everything
    # else — code, text, data, media, unknown).
    individual_rels = []
    bundle_rels = []
    for rel in rels:
        ext = os.path.splitext(os.path.basename(rel))[1].lower()
        if ext in _STANDALONE_EXTS:
            individual_rels.append(rel)
        else:
            bundle_rels.append(rel)

    files = []

    def _emit_individually(rel_list):
        for rel in rel_list:
            try:
                b64 = _read_b64(rel, max_bytes)
                if b64 is not None:
                    files.append({"name": os.path.basename(rel), "b64": b64})
            except Exception:
                pass

    # RULE: bundle the "everything-else" side into ONE zip when it has 2+ files.
    # A single such file is delivered as-is (no pointless one-file zip).
    if len(bundle_rels) >= 2:
        zipped_ok = False
        try:
            # Name the zip after the single top-level project dir if there is
            # one, else "project.zip".
            tops = set()
            for rel in bundle_rels:
                parts = str(rel).replace("\\", "/").lstrip("./").split("/")
                tops.add(parts[0] if len(parts) > 1 else "")
            zip_base = "project"
            named_tops = [t for t in tops if t]
            if len(named_tops) == 1 and "" not in tops:
                zip_base = named_tops[0]
            buf = _io.BytesIO()
            with _zip.ZipFile(buf, "w", _zip.ZIP_DEFLATED) as zf:
                for rel in bundle_rels:
                    fp = os.path.join(WORK, rel)
                    if os.path.isfile(fp) and os.path.getsize(fp) <= max_bytes:
                        # Preserve relative structure inside the zip.
                        arc = str(rel).replace("\\", "/").lstrip("./")
                        zf.write(fp, arc)
            data = buf.getvalue()
            if data and len(data) <= max_bytes:
                files.append({
                    "name": "%s.zip" % re.sub(r"[^\w.\-]", "_", zip_base),
                    "b64": base64.b64encode(data).decode("ascii"),
                })
                zipped_ok = True
        except Exception:
            zipped_ok = False
        if not zipped_ok:
            # Zip too large / empty / failed → fall back to individual files.
            _emit_individually(bundle_rels)
    else:
        # 0 or 1 non-document file → deliver directly.
        _emit_individually(bundle_rels)

    # Office documents / images always ship individually.
    _emit_individually(individual_rels)

    return files


# ── Host-side tools (proxied) ────────────────────────────────────────────────
HOST_TOOLS = {
    "web_search", "wolfram_alpha", "browse", "screenshot", "read_document",
    "analyze_image", "analyze_images", "solve_math", "create_docx",
    "fetch_url", "generate_image", "edit_image", "host_media", "create_chart",
    # 🖼️ web_image — go online, find a REAL photo (or fetch a direct URL), then
    # crop/resize it (sharp) and stage it for embedding into a PDF/PPTX/DOCX.
    # Runs host-side (needs sharp + network), proxy the result back.
    "web_image", "image_search", "find_image", "fetch_image", "crop_image", "get_image",
    # 📈 Deterministic live market data for trading (gold-api/Yahoo/coingecko/
    # coinbase/binance.us fallback chain) — runs host-side, proxy back. This is
    # the reliable price source the trading-skills workflow MUST use first.
    "get_market_price", "market_price", "live_price", "get_price",
    "create_slides", "create_presentation", "browser_action",
    "deploy_site", "deploy_cloudflare_pages", "deploy_github", "deploy_render",
    # Generic GitHub code push + Flutter APK CI lifecycle. These stay host-side
    # so PATs never enter Novita/Runloop/Upstash/Daytona environments.
    "github_scan", "scan_github", "scan_repo",
    "github_workflow", "trigger_workflow", "workflow",
    "github_monitor", "monitor_workflow", "watch_workflow",
    "github_push", "push_code", "git_push",
    "github_apk", "apk_build", "build_apk", "watch_apk",
    "scan_secrets",
    # 🐘 PHP runner + 🗄️ Supabase table browser (new host tools). run_php writes,
    # lints (php -l) and runs PHP in THIS sandbox via the host bridge (installs
    # php-cli with sudo). supabase_tables queries the Supabase REST API host-side.
    "run_php", "php", "exec_php",
    "supabase_tables", "supabase", "supabase_db", "browse_tables",
    # 🦾 Power scraper — final-fallback browser tool (rotating-UA fetch + jina
    # reader + DDG/Bing search). Lives host-side (no sandbox deps), proxy back.
    "power_scrape", "power_browse", "fallback_browse",
    # LIVE / VNC screen streaming — runs the visible browser in THIS sandbox but
    # is driven host-side (runHostTool) so frames stream to the user over SSE.
    "browse_live", "live_browse", "live_view", "live_screen", "watch_live",
    # Skill library lives in the HOST repo (.codebanana/.skills) — proxy back.
    "read_skill", "load_skill", "use_skill", "list_skills", "skills",
    # 🔌 MCP (Model Context Protocol) servers — sequential-thinking + filesystem
    # (+ git/github/fetch/websearch/sqlite) run HOST-side via services/mcpBridge.js
    # over stdio. Proxy these back so the LLM can use them everywhere.
    "sequential_thinking", "think", "reasoning", "sequentialthinking",
    "mcp_filesystem", "fs", "filesystem",
    "mcp_call", "mcp", "mcp_tool",
    # 🏢 Enterprise tool suite — these now run LOCALLY inside THIS sandbox via
    # the imported tool_registry (see LOCAL_REGISTRY_TOOLS + execute_tool). They
    # are intentionally NOT listed in HOST_TOOLS any more: proxying grep/bash/
    # read/write/etc. to the Render host ran them against the HOST filesystem
    # (which does not have this sandbox's files), which is why the "50+ tools"
    # looked broken. The document/OCR-heavy tools (documents/docx/pptx/xlsx/pdf)
    # stay host-side because they need host-only libraries; deepseek is a host
    # LLM call. Everything file/shell/git/db-oriented is now genuinely local.
    "documents", "document", "docx", "pptx", "xlsx", "pdf",
    "deepseek", "ds",
    # 📤 File upload — uploads files to catbox.moe or temp services for sharing
    "upload_file", "upload", "catbox",
}

# ── Tools that run LOCALLY via the enterprise registry (inside THIS sandbox) ──
# Maps the action name the model may use → the registry tool name. This is the
# fix for "grep/cat/bash/+50 tools should work in the sandbox": these execute on
# the sandbox's OWN filesystem where the agent's files live, never proxied to
# the host. Aliases (e.g. git_clone → gitclone) are included so the model's
# natural naming still resolves.
LOCAL_REGISTRY_TOOLS = {
    "glob": "glob",
    "grep": "grep",
    "bash": "bash", "sh": "bash", "shell": "bash",
    "gitclone": "gitclone", "git_clone": "gitclone", "clone": "gitclone",
    "gitdiff": "gitdiff", "git_diff": "gitdiff",
    "write": "write",
    "read": "read", "cat": "read",
    "edit": "edit",
    "coding": "coding",
    "sql": "sql",
    "webshell": "webshell", "web_shell": "webshell",
    "todo": "todo",
    "http": "http", "http_fetch": "http",
    "sandbox": "sandbox", "sandbox_info": "sandbox",
    "deepseek_local": "deepseek",
}


def _run_registry_tool(reg_name, args):
    """Execute a registry tool LOCALLY in this sandbox and format the result as
    a compact observation string (the ReAct loop expects a string). Falls back
    to the host bridge only if the registry is unavailable."""
    reg = _get_local_registry()
    if reg is None:
        # No registry in this worker — proxy to host as a last resort so the
        # action still does *something* rather than erroring out.
        return host_tool(reg_name, args)
    before = _snapshot()
    out = reg.run_tool(reg_name, dict(args or {}))
    _captured(before)  # queue any files the tool produced for delivery
    if not out.get("success"):
        return "[%s] error: %s%s" % (
            reg_name, out.get("error") or "failed",
            ("\n" + out.get("stderr")) if out.get("stderr") else "")
    result = out.get("result")
    try:
        body = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2, default=str)
    except Exception:
        body = str(result)
    return "[%s @sandbox]\n%s" % (reg_name, str(body)[:12000])


LOCAL_TOOLS = {
    "run_code": tool_run_code,
    "install_tool": tool_install,
    "ensure_tool": tool_install,
    "docker_run": tool_docker_run,
    "docker": tool_docker_run,
    "dind": tool_docker_run,
    "list_files": tool_list_files,
    "inspect_codebase": tool_inspect_codebase,
    "codebase_map": tool_inspect_codebase,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "edit_file": tool_edit_file,
    "database": tool_database,
    "db": tool_database,
    "make_zip": tool_make_zip,
    # 📎 Merge split chunk files into ONE document (fixes "split into different
    # zips/documents"). Auto-discovers part*/chapter*/*.md chunks or takes an
    # explicit ordered list; can render straight to a single PDF.
    "consolidate": tool_consolidate,
    "merge_docs": tool_consolidate,
    "combine": tool_consolidate,
    "merge_files": tool_consolidate,
    # High-quality, in-sandbox PDF generation (LaTeX + Tectonic) — real math,
    # tables, code and TikZ/PGFPlots charts & diagrams; output is validated so a
    # blank/empty PDF is never shipped. No host round-trip, light on Render.
    "create_pdf": tool_create_pdf,
    "convert_file": tool_convert_file,
}


def execute_tool(name, args, status):
    name = (name or "").lower()
    if name in LOCAL_TOOLS:
        # Wrap local tools with a before/after snapshot so ANY file they write
        # into the work dir is captured for delivery — even if the tool forgets
        # to call DELIVER.add() itself. This is the safety net that guarantees
        # convert_file (and any other local tool) always hands the produced
        # file back to the user.
        before = _snapshot()
        try:
            res = LOCAL_TOOLS[name](args)
        finally:
            try:
                _captured(before)
            except Exception:
                pass
        return res
    # 🏢 Enterprise registry tools — run LOCALLY inside this sandbox.
    if name in LOCAL_REGISTRY_TOOLS:
        try:
            return _run_registry_tool(LOCAL_REGISTRY_TOOLS[name], args)
        except Exception as e:  # noqa
            return "[%s] local tool error: %s" % (name, e)
    if name == "plan":
        steps = args.get("steps") or []
        return "[plan] recorded %d steps:\n%s" % (
            len(steps), "\n".join("%d. %s" % (i + 1, s) for i, s in enumerate(steps)))
    if name in HOST_TOOLS:
        # Some host tools need the produced files captured back.
        before = _snapshot()
        try:
            res = host_tool(name, args)
        except Exception as e:  # noqa
            return "[%s] host bridge error: %s" % (name, e)
        _captured(before)
        return res
    return ('[error] Unknown action "%s". Valid local: run_code, docker_run, list_files, inspect_codebase, '
            'read_file, write_file, edit_file, make_zip, and registry tools (%s). Host: %s, plan, finish.'
            % (name, ", ".join(sorted(set(LOCAL_REGISTRY_TOOLS.keys()))), ", ".join(sorted(HOST_TOOLS))))


# ── JSON action parsing (mirror of the host parseAction, lenient + salvage) ──
def parse_action(raw):
    if not raw:
        return None
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1]
        if s.endswith("```"):
            s = s[:-3]
    a = s.find("{")
    b = s.rfind("}")
    if a != -1 and b != -1 and b > a:
        cand = s[a:b + 1]
        for attempt in (cand, _strip_trailing_commas(cand)):
            try:
                obj = json.loads(attempt)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                continue
    # ── SALVAGE: the JSON is truncated/invalid (e.g. the brain gateway cut off a
    # huge create_pdf "content" arg → INVALID_ARGUMENT). Rather than give up and
    # dump raw JSON to the user, pull out action + args by regex so a document is
    # STILL produced. Mirrors the host parseAction last-resort extraction.
    return _salvage_action(s)


def _salvage_action(s):
    try:
        am = _re.search(r'"action"\s*:\s*"([a-zA-Z_]+)"', s)
        if not am:
            return None
        action = am.group(1)
        args = {}
        for key in ("filename", "title", "subtitle", "content_file", "path", "output", "language", "message"):
            m = _re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % key, s)
            if m:
                try:
                    args[key] = json.loads('"%s"' % m.group(1))
                except Exception:
                    args[key] = m.group(1)
        # content can be a very long, possibly-unterminated string — grab whatever
        # is there from the opening quote to the end so the body isn't lost.
        cm = _re.search(r'"content"\s*:\s*"', s)
        if cm:
            tail = s[cm.end():]
            # cut at the last clean closing quote if present, else take all of it.
            end = tail.rfind('"')
            body = tail[:end] if end > 0 else tail
            try:
                args["content"] = json.loads('"%s"' % body)
            except Exception:
                args["content"] = body.replace('\\n', '\n').replace('\\t', '\t').replace('\\"', '"')
        if action or args:
            return {"action": action, "args": args, "_salvaged": True}
    except Exception:
        pass
    return None


def _strip_trailing_commas(s):
    return _re.sub(r",\s*([}\]])", r"\1", s)


def brain_retry(system, messages, attempts=3):
    """brain() with retries — transient gateway errors (INVALID_ARGUMENT, 5xx,
    timeouts) must NOT kill the whole task; we retry a couple of times first."""
    last = None
    for i in range(attempts):
        try:
            return brain(system, messages)
        except Exception as e:  # noqa
            last = e
            time.sleep(1.5 * (i + 1))
    raise last if last else RuntimeError("brain failed")


# ── Task runner ──────────────────────────────────────────────────────────────
def status_writer(task_id):
    path = os.path.join(OUTBOX, "%s.status" % task_id)

    def write(note):
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(note.rstrip("\n") + "\n")
        except Exception:
            pass
    return write


def _step_fingerprint(action):
    """A compact signature of (action + key args) used for loop detection.

    Two consecutive steps with the SAME fingerprint mean the agent is repeating
    itself — the classic "stuck in a loop" failure. We compare the action name
    plus a trimmed view of the most identifying args (command/code/path/url/query)
    so cosmetic differences (a changing thought) don't mask a real loop.
    """
    try:
        name = str(action.get("action") or "").lower()
        args = action.get("args") or {}
        ident = ""
        for k in ("cmd", "command", "code", "path", "url", "query", "filename", "name", "output", "source"):
            v = args.get(k)
            if v:
                ident += "%s=%s;" % (k, str(v)[:240])
        return "%s|%s" % (name, ident.strip())
    except Exception:
        return ""


def run_task(task_id, payload):
    global DELIVER, _TASK_BASELINE, _TASK_BASELINE_HASH, _TASK_START_TS
    DELIVER = set()
    # PER-TASK ISOLATION: snapshot the whole workspace NOW so collect_deliverables
    # can tell which files were actually produced/changed by THIS task (vs.
    # leftovers from earlier tasks in a persistent sandbox). We record THREE
    # things: the size:mtime signature, a content hash of every pre-existing
    # file, and the task-start wall-clock time. Together they stop a leftover
    # whose mtime was merely bumped (re-clone/npm/formatter) from being
    # re-delivered. Best-effort: on any failure we fall back to empty baselines
    # (delivers everything in DELIVER, the previous behaviour).
    _TASK_START_TS = time.time()
    try:
        _TASK_BASELINE = _snapshot()
    except Exception:
        _TASK_BASELINE = {}
    try:
        _TASK_BASELINE_HASH = {}
        for _rel in _TASK_BASELINE:
            _h = _file_sha1(os.path.join(WORK, _rel))
            if _h is not None:
                _TASK_BASELINE_HASH[_rel] = _h
    except Exception:
        _TASK_BASELINE_HASH = {}
    status = status_writer(task_id)
    # Bind the per-task live-terminal sink so shell tools stream into it and the
    # host can forward the real terminal to the chat. Also record the task_id so
    # stop_requested() (called from run_shell) checks THIS task's stop flag.
    _TERMINAL["path"] = TERMINAL_FILE % task_id
    _TERMINAL["task_id"] = task_id
    try:
        open(_TERMINAL["path"], "w").close()  # fresh terminal per task
    except Exception:
        pass
    # A brand-new task always starts with no pending stop request (clears the
    # global "stop everything" flag + this task's own flag; never other tasks').
    clear_stop_flag(task_id)
    lock = os.path.join(OUTBOX, "%s.lock" % task_id)
    open(lock, "w").write(str(int(time.time())))

    system = payload.get("system") or ""
    conversation = payload.get("conversation") or []
    # conversation: [{role, text}], already seeded with TASK + history by host.
    # Capture the user's task text so the WRITING-LENGTH ENFORCER can infer a
    # requested page/word target, and reset the per-task nudge counter.
    global _TASK_TEXT, _WRITE_NUDGES
    _WRITE_NUDGES = {}
    try:
        _TASK_TEXT = payload.get("task") or payload.get("goal") or ""
        if not _TASK_TEXT:
            for _m in conversation:
                if (_m.get("role") in ("user", "human")) and _m.get("text"):
                    _TASK_TEXT = str(_m.get("text"))
                    break
    except Exception:
        _TASK_TEXT = ""

    # ── ⏱️ TIME-BOXED "THINK UNTIL DEADLINE" ─────────────────────────────────
    # The host may set an absolute deadline (think_until_ms) and/or a minimum
    # duration (min_duration_ms). While the deadline is in the future the agent
    # must NOT finish — it keeps producing genuinely NEW work (new angles,
    # deeper research, verification, improvements). We cap the number of
    # "keep going" bounces so a stuck model still eventually completes, and the
    # loop-detector guarantees "keep thinking" never becomes an idle spin.
    think_until_ms = 0
    try:
        tu = payload.get("think_until_ms")
        md = payload.get("min_duration_ms")
        if tu:
            think_until_ms = int(tu)
        elif md:
            think_until_ms = _now_ms() + int(md)
    except Exception:
        think_until_ms = 0
    keep_thinking_bounces = 0
    max_keep_thinking = int(os.environ.get("AGENT_KEEP_THINKING_MAX", "60"))
    if think_until_ms and think_until_ms > _now_ms():
        _left = int((think_until_ms - _now_ms()) / 1000)
        status("⏱️ time-boxed mode: I'll keep thinking and improving for ~%ds before finishing." % _left)

    def time_left_ms():
        return (think_until_ms - _now_ms()) if think_until_ms else 0

    def keep_thinking_directive():
        """Directive that pushes the model to explore a NEW angle until the
        deadline, instead of finishing early or repeating itself."""
        secs = max(0, int(time_left_ms() / 1000))
        return (
            "OBSERVATION:\nYou still have ~%ds of dedicated thinking time left, and the user "
            "explicitly asked you to keep working for the full duration. Do NOT finish yet and do "
            "NOT repeat a previous step. Instead take a genuinely DIFFERENT, concrete next action "
            "that improves the result: try a new approach or angle, verify/stress-test what you "
            "already have, research an additional source, cover an edge case, refine quality, or "
            "add depth. Respond with ONE new JSON action (never the same as before)." % secs
        )

    final_message = ""
    bad_parses = 0
    max_iterations = max(1, min(MAX_BUDGET, int(payload.get("max_iterations") or MAX_ITERATIONS)))
    max_tool_steps = max(1, min(MAX_BUDGET, int(payload.get("max_tool_steps") or MAX_STEPS)))
    iterations = 0
    tool_steps = 0
    # ── Loop-detection state ─────────────────────────────────────────────────
    last_fp = None          # fingerprint of the previous step
    repeat_count = 0        # how many times the SAME fingerprint repeated
    loop_warned = False     # whether we already nudged the model to break out
    recent_fps = []         # catches A→B→A cycles, not only consecutive repeats
    result_by_fp = {}       # detects no-progress retries with identical output
    # ── Telemetry only (no persistence gate / no time floor / no nudges) ──────
    task_started = time.time()
    # Objective execution trace used by the bounded correctness gate. It stores
    # tool names + truncated observations, never credentials or raw environment.
    gate_state = {"skill_loaded": False, "codebase_inspected": False, "tool_steps": 0, "searched": 0, "nudges": 0, "trace": []}
    max_gate_nudges = int(os.environ.get("AGENT_CORRECTNESS_GATE_NUDGES", "4"))

    def persistence_gate(attempted_final):
        """Block only unsupported completion claims; never enforce a time floor.

        The evaluator asks for concrete missing evidence (database discovery,
        tests, produced files). A hard nudge cap guarantees eventual completion
        even if the model cannot satisfy a check after several changed attempts.
        """
        if _evaluate_completion is None or gate_state["nudges"] >= max_gate_nudges:
            return None
        gate_trace = gate_state["trace"]
        if gate_state["codebase_inspected"] and not any(str(x.get("tool") or "") in ("inspect_codebase", "codebase_map") for x in gate_trace):
            gate_trace = [{"tool": "inspect_codebase", "result": "CODEBASE_INVENTORY_COMPLETE"}] + gate_trace
        correction = _evaluate_completion(_TASK_TEXT, gate_trace, attempted_final)
        if correction:
            gate_state["nudges"] += 1
            return correction + "\nChoose a materially different next action; do not repeat the failed call."
        return None


    try:
        for step in range(max_iterations):
            iterations += 1
            # 🛑 STOP: the user pressed /stop — abort cleanly between steps.
            if stop_requested():
                status("🛑 stopped by the user — halting the sandbox.")
                term("[task stopped by user]")
                final_message = "🛑 Stopped. I halted the task as you requested."
                break

            try:
                raw = brain_retry(system, conversation)
            except Exception as e:  # noqa
                final_message = "⚠️ AI gateway error: %s" % e
                break

            action = parse_action(raw)
            if not action or not action.get("action"):
                # If the model clearly TRIED to call a tool but the JSON came back
                # malformed/truncated, don't surrender — nudge it to retry with a
                # shorter payload (or to use content_file for big documents).
                looks_like_tool = '"action"' in (raw or "")
                if looks_like_tool and bad_parses < 3:
                    bad_parses += 1
                    status("⚠️ previous step was malformed/truncated — asking the model to retry")
                    conversation.append({"role": "model", "text": str(raw)[:4000]})
                    conversation.append({
                        "role": "user",
                        "text": (
                            "OBSERVATION:\nYour previous response was not valid JSON "
                            "(it was likely truncated because the inline 'content' was too long). "
                            "For long documents: FIRST use write_file to save the full body to a file "
                            "(e.g. report.md), THEN call create_pdf/create_docx with "
                            "{\"filename\":\"...\",\"title\":\"...\",\"content_file\":\"report.md\"} instead of inline content. "
                            "Respond with ONE compact, valid JSON action now."
                        ),
                    })
                    continue
                # A plain-prose final answer ALSO goes through the persistence gate.
                _candidate = (raw or "").strip().strip("`").strip()
                # ⏱️ Time-box: if the user asked me to think for the full duration,
                # keep exploring new angles until the deadline instead of finishing.
                if think_until_ms and time_left_ms() > 0 and keep_thinking_bounces < max_keep_thinking:
                    keep_thinking_bounces += 1
                    conversation.append({"role": "model", "text": ("(attempted finish) " + _candidate)[:2000]})
                    conversation.append({"role": "user", "text": keep_thinking_directive()})
                    continue
                _nudge = persistence_gate(_candidate)
                if _nudge:
                    conversation.append({"role": "model", "text": ("(attempted finish) " + _candidate)[:2000]})
                    conversation.append({"role": "user", "text": _nudge})
                    continue
                final_message = _candidate
                break

            name = str(action.get("action")).lower()
            thought = action.get("thought") or ""
            if name == "finish":
                _candidate = (action.get("args") or {}).get("message") or thought or "Done."
                # ⏱️ Time-box: honour "use N minutes / keep thinking" — do NOT
                # finish while the dedicated thinking window is still open; bounce
                # the model back to take a genuinely new, improving action.
                if think_until_ms and time_left_ms() > 0 and keep_thinking_bounces < max_keep_thinking:
                    keep_thinking_bounces += 1
                    if keep_thinking_bounces == 1 or keep_thinking_bounces % 5 == 0:
                        status("⏱️ still within the requested thinking time — exploring a new angle (%ds left)." % int(time_left_ms() / 1000))
                    conversation.append({"role": "model", "text": ("(attempted finish) " + _candidate)[:2000]})
                    conversation.append({"role": "user", "text": keep_thinking_directive()})
                    continue
                # persistence_gate() is now a NO-OP (returns None) — `finish` is
                # honored immediately. The call is kept only so the control flow
                # stays identical; quality comes from the method, not a gate.
                _nudge = persistence_gate(_candidate)
                if _nudge:
                    conversation.append({"role": "model", "text": ("(attempted finish) " + _candidate)[:2000]})
                    conversation.append({"role": "user", "text": _nudge})
                    continue
                final_message = _candidate
                break

            if tool_steps >= max_tool_steps:
                status("🛑 tool-step budget reached (%d); stopping before another action." % max_tool_steps)
                final_message = "Tool-step budget reached. I stopped safely and preserved the work completed so far."
                break

            # ── 🔁 LOOP DETECTION ────────────────────────────────────────────
            # Compare this step to the previous one and to a recent window.
            # This catches direct repeats plus alternating A→B→A cycles.
            fp = _step_fingerprint(action)
            recent_count = recent_fps[-12:].count(fp) if fp else 0
            if fp and recent_count >= 2:
                status("🔁 LOOP_GUARD — repeated action found in recent history; forcing a new approach.")
                conversation.append({"role": "model", "text": json.dumps(action)})
                conversation.append({
                    "role": "user",
                    "text": "OBSERVATION:\n[LOOP_GUARD] This materially identical action already occurred multiple times recently. Do not execute it again. Diagnose the latest evidence and choose a different file, command, hypothesis, or verification strategy.",
                })
                continue
            recent_fps.append(fp)
            if len(recent_fps) > 40:
                recent_fps = recent_fps[-40:]
            if fp and fp == last_fp:
                repeat_count += 1
            else:
                repeat_count = 0
                loop_warned = False
            last_fp = fp

            if repeat_count >= LOOP_ABORT_AT:
                status("🔁 LOOP_DETECTED — the agent repeated the same step %d× and is stuck. Aborting to avoid an infinite loop." % (repeat_count + 1))
                term("[LOOP_DETECTED] aborting after %d identical steps" % (repeat_count + 1))
                final_message = (
                    "🔁 I detected I was stuck in a loop (repeating the same step) and stopped to avoid "
                    "running forever. Here is where I got to — please refine the request or send /stop "
                    "and try a different angle."
                )
                break
            elif repeat_count >= LOOP_WARN_AT and not loop_warned:
                loop_warned = True
                status("🔁 possible loop — nudging the agent to change approach.")
                conversation.append({"role": "model", "text": json.dumps(action)})
                conversation.append({
                    "role": "user",
                    "text": (
                        "OBSERVATION:\nYou have now issued the SAME action with the same arguments %d times "
                        "in a row — you are stuck in a LOOP. STOP repeating it. Re-read the latest real "
                        "observation, diagnose WHY it is not progressing, and take a DIFFERENT, concrete next "
                        "step (a different command, a different file, a different approach), or call finish "
                        "if the goal is actually already met. Do NOT repeat the previous action."
                        % (repeat_count + 1)
                    ),
                })
                continue

            status("🧠 %s%s" % ((thought + " — ") if thought else "", "using " + name))
            args = action.get("args") or {}
            # ── 🧠 Track progress for the persistence gate ───────────────────
            gate_state["tool_steps"] += 1
            if name in ("read_skill", "list_skills"):
                gate_state["skill_loaded"] = True
            if name in ("inspect_codebase", "codebase_map"):
                gate_state["codebase_inspected"] = True
            if name in ("web_search", "browse", "fetch_url", "wolfram_alpha",
                        "get_market_price", "market_price", "live_price", "get_price",
                        "power_scrape"):
                gate_state["searched"] += 1
            tool_steps += 1
            try:
                result = execute_tool(name, args, status)
            except Exception as e:  # noqa
                result = "[error] tool %s crashed: %s" % (name, e)
            result_text = str(result)
            stagnation = ""
            result_sig = " ".join(result_text.split())[:1200]
            if fp and result_by_fp.get(fp) == result_sig:
                stagnation = "\n\n[PROGRESS_GUARD] This action produced the same result as before. Treat that approach as exhausted and choose a materially different next step."
            if fp:
                result_by_fp[fp] = result_sig
            gate_state["trace"].append({"tool": name, "args": args, "result": result_text[:6000]})
            if len(gate_state["trace"]) > 80:
                gate_state["trace"] = gate_state["trace"][-80:]

            conversation.append({"role": "model", "text": json.dumps(action)})
            conversation.append({
                "role": "user",
                "text": "OBSERVATION:\n%s%s\n\nContinue. Respond with the next JSON step (or finish)." % (result_text[:9000], stagnation),
            })
        if not final_message:
            final_message = "✅ Task complete."
    except Exception as e:  # noqa
        final_message = "❌ Worker error: %s" % e
        status("error: %s" % traceback.format_exc()[:500])

    # If files were produced but the final message is just a raw tool-JSON blob
    # (salvage edge cases), give the user a clean confirmation instead.
    files_out = collect_deliverables()
    if files_out and final_message.lstrip().startswith("{") and '"action"' in final_message:
        names = ", ".join(f.get("name", "file") for f in files_out)
        final_message = "✅ Done. Attached: %s" % names

    result_obj = {
        "ok": True,
        "message": final_message,
        "files": files_out,
        "steps": tool_steps,
        "iterations": iterations,
    }
    try:
        with open(os.path.join(OUTBOX, "%s.result" % task_id), "w", encoding="utf-8") as fh:
            json.dump(result_obj, fh)
    finally:
        try:
            os.remove(lock)
        except Exception:
            pass
        # Detach the terminal sink and clear this task's stop flag so the next
        # task starts clean. Do NOT touch the global "stop everything" flag here
        # in a way that would race a queued task — clear_stop_flag only removes
        # a stale global flag + THIS task's flag.
        _TERMINAL["path"] = None
        _TERMINAL["task_id"] = None
        clear_stop_flag(task_id)
    status("✅ done")


# ── Main inbox watcher ───────────────────────────────────────────────────────
# 🔒 SERIALIZED EXECUTION (fixes "a second task restarts / collides with the
# first"). This worker owns ONE sandbox = ONE chat session, so tasks MUST run
# strictly one at a time in the SAME work dir. We enqueue every new inbox file
# and a single dedicated worker thread drains the queue in arrival order. A task
# that arrives while another is running WAITS its turn (the user is told, on the
# host side, that the previous task is still running) — it never starts on top
# of a live task. This keeps the terminal sink, stop flag and working files from
# ever being shared between two concurrent runs.
import collections as _collections

_TASK_QUEUE = _collections.deque()
_QUEUE_COND = threading.Condition()


def _task_worker():
    while True:
        with _QUEUE_COND:
            while not _TASK_QUEUE:
                _QUEUE_COND.wait()
            task_id, payload = _TASK_QUEUE.popleft()
        with _TASK_LOCK:
            _ACTIVE_TASK["id"] = task_id
            _ACTIVE_TASK["since"] = int(time.time())
            try:
                run_task(task_id, payload)
            except Exception:
                sys.stderr.write("[agent.py] run_task crashed: %s\n" % traceback.format_exc()[:800])
                sys.stderr.flush()
            finally:
                _ACTIVE_TASK["id"] = None


def main():
    sys.stderr.write("[agent.py] worker online (serialized) v=delivery-fix-2 zip-all-nondoc+hash-isolation. WORK=%s BRIDGE=%s\n" % (WORK, bool(BRIDGE_URL)))
    # 🏢 Boot-time tool self-test: discover the local registry tools and run a
    # tiny smoke test (write→read→grep→bash) so the worker log PROVES the "50+
    # tools work in the sandbox" instead of leaving it to chance. Best-effort:
    # never blocks the worker coming online.
    try:
        reg = _get_local_registry()
        if reg is not None:
            names = sorted(t.name for t in reg.list_tools())
            sys.stderr.write("[agent.py] local registry tools (%d): %s\n" % (len(names), ", ".join(names)))
            # Smoke test in an isolated subdir so we never touch deliverables.
            _st = os.path.join(WORK, ".selftest")
            try:
                os.makedirs(_st, exist_ok=True)
                _r = _tool_registry_mod.ToolRegistry(
                    tools_dir=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"),
                    work_dir=_st)
                _r.discover()
                _r.run_tool("write", {"path": "t.txt", "content": "sandbox tool selftest OK\n"})
                _g = _r.run_tool("grep", {"pattern": "selftest", "glob": "*"})
                _b = _r.run_tool("bash", {"command": "echo LINUX_OK && uname -a"})
                ok = bool(_g.get("success")) and bool(_b.get("success"))
                sys.stderr.write("[agent.py] tool self-test: %s\n" % ("PASSED ✅" if ok else "FAILED ⚠️"))
            except Exception as _e:
                sys.stderr.write("[agent.py] tool self-test error: %s\n" % _e)
            finally:
                try:
                    import shutil as _sh
                    _sh.rmtree(_st, ignore_errors=True)
                except Exception:
                    pass
        else:
            sys.stderr.write("[agent.py] tool registry NOT available — file/shell tools will proxy to host.\n")
    except Exception as _e:
        sys.stderr.write("[agent.py] registry init error: %s\n" % _e)
    sys.stderr.flush()
    # Start the single serialized task-runner thread.
    threading.Thread(target=_task_worker, daemon=True).start()
    seen = set()
    while True:
        try:
            for fn in sorted(os.listdir(INBOX)):
                if not fn.endswith(".json") or fn in seen:
                    continue
                seen.add(fn)
                task_id = fn[:-5]
                fp = os.path.join(INBOX, fn)
                try:
                    payload = json.load(open(fp, encoding="utf-8"))
                except Exception:
                    continue
                # Enqueue for serialized execution — NEVER spawn a task on top of
                # a running one. The single _task_worker drains this queue in
                # order, so task #2 begins only after task #1 finishes/stops.
                with _QUEUE_COND:
                    _TASK_QUEUE.append((task_id, payload))
                    _QUEUE_COND.notify()
        except Exception:
            pass
        time.sleep(POLL)


if __name__ == "__main__":
    main()
