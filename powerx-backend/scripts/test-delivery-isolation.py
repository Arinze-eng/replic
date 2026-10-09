"""
Focused test for the PowerX delivery fixes in agent_worker/agent.py:

  1) Everything-else (code, text, data, media) is zipped into ONE archive.
  2) ONLY office docs + images (pdf/docx/pptx/xlsx/png/jpg/gif) ship alone.
  3) Task isolation: files from a PREVIOUS task are NOT re-delivered with a
     later task in a persistent sandbox — even if an incidental op bumps their
     mtime (content-hash gate).

Runs entirely offline: it sets AGENT_WORK to a temp dir, imports agent.py,
and drives _snapshot / DELIVER / baselines / collect_deliverables the same
way run_task does.
"""
import os, sys, tempfile, base64, io, zipfile, importlib, time

WORKDIR = tempfile.mkdtemp(prefix="powerx_test_work_")
os.environ["AGENT_WORK"] = WORKDIR

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent_worker"))
agent = importlib.import_module("agent")


def w(rel, content=b"x"):
    fp = os.path.join(WORKDIR, rel)
    os.makedirs(os.path.dirname(fp) or ".", exist_ok=True)
    if isinstance(content, str):
        content = content.encode()
    with open(fp, "wb") as f:
        f.write(content)


def touch(rel):
    """Bump a file's mtime WITHOUT changing its content (simulates a formatter /
    re-clone / npm install re-touching a leftover file)."""
    fp = os.path.join(WORKDIR, rel)
    st = os.stat(fp)
    os.utime(fp, (st.st_atime + 5, st.st_mtime + 5))


def start_task():
    """Mirror run_task's setup: fresh DELIVER + workspace baselines + start ts."""
    agent.DELIVER = set()
    agent._TASK_START_TS = time.time()
    agent._TASK_BASELINE = agent._snapshot()
    agent._TASK_BASELINE_HASH = {}
    for rel in agent._TASK_BASELINE:
        h = agent._file_sha1(os.path.join(WORKDIR, rel))
        if h is not None:
            agent._TASK_BASELINE_HASH[rel] = h


def deliver_names():
    files = agent.collect_deliverables()
    return files, [f["name"] for f in files]


failures = []


def check(cond, msg):
    if cond:
        print("  PASS:", msg)
    else:
        print("  FAIL:", msg)
        failures.append(msg)


# ─────────────────────────────────────────────────────────────────────────────
print("TEST 1 — multi-file coding output is zipped into ONE archive")
start_task()
w("myapp/main.py", "print('hi')")
w("myapp/utils.py", "def f(): return 1")
w("myapp/requirements.txt", "flask")
agent.DELIVER.update(["myapp/main.py", "myapp/utils.py", "myapp/requirements.txt"])
files, names = deliver_names()
check(len(files) == 1, "3 code files collapse to 1 deliverable, got %d (%s)" % (len(files), names))
check(names and names[0].endswith(".zip"), "the single deliverable is a .zip (%s)" % names)
if files and names[0].endswith(".zip"):
    zdata = base64.b64decode(files[0]["b64"])
    with zipfile.ZipFile(io.BytesIO(zdata)) as zf:
        entries = sorted(zf.namelist())
    check(len(entries) == 3, "zip contains all 3 files, got %s" % entries)
    check(any(e.endswith("main.py") for e in entries), "zip preserves paths (main.py present)")

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 2 — single code file is NOT needlessly zipped")
start_task()
w("solo.py", "print(1)")
agent.DELIVER.add("solo.py")
files, names = deliver_names()
check(names == ["solo.py"], "a lone code file ships as-is, got %s" % names)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 3 — office docs + images ship individually (never zipped)")
start_task()
w("report.pdf", b"%PDF-1.4 fake")
w("data.xlsx", b"PKxlsx")
w("pic.png", b"\x89PNG fake")
w("memo.docx", b"PKdocx")
agent.DELIVER.update(["report.pdf", "data.xlsx", "pic.png", "memo.docx"])
files, names = deliver_names()
check(sorted(names) == ["data.xlsx", "memo.docx", "pic.png", "report.pdf"],
      "pdf+xlsx+png+docx delivered individually, got %s" % names)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 4 — NON-doc, non-code files (.csv/.txt/.json) are ZIPPED, not split")
start_task()
w("out/notes.txt", "hello")
w("out/rows.csv", "a,b\n1,2")
w("out/config.json", "{}")
agent.DELIVER.update(["out/notes.txt", "out/rows.csv", "out/config.json"])
files, names = deliver_names()
check(len(files) == 1 and names[0].endswith(".zip"),
      "3 misc files (txt/csv/json) collapse to ONE zip, got %s" % names)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 5 — MIXED: code+data zipped together, docs kept separate")
start_task()
w("app/server.js", "console.log(1)")
w("app/index.html", "<html></html>")
w("app/style.css", "body{}")
w("guide.pdf", b"%PDF fake")
w("logo.png", b"\x89PNG fake")
agent.DELIVER.update(["app/server.js", "app/index.html", "app/style.css",
                      "guide.pdf", "logo.png"])
files, names = deliver_names()
zips = [n for n in names if n.endswith(".zip")]
docs = sorted(n for n in names if not n.endswith(".zip"))
check(len(zips) == 1, "code/html/css bundled into ONE zip, got zips=%s" % zips)
check(docs == ["guide.pdf", "logo.png"], "pdf+png stay individual, got %s" % docs)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 6 — TASK ISOLATION: previous task's files are NOT re-delivered")
# Task #1: produce a project, deliver it.
start_task()
w("proj/a.py", "a")
w("proj/b.py", "b")
agent.DELIVER.update(["proj/a.py", "proj/b.py"])
files1, names1 = deliver_names()
check(len(files1) == 1 and names1[0].endswith(".zip"), "task#1 delivered a zip (%s)" % names1)

# Task #2 in the SAME persistent workspace: only creates ONE new file. A buggy
# tool re-adds the old files to DELIVER, they must NOT be re-delivered.
start_task()  # baseline now includes proj/a.py, proj/b.py
w("newfeature.py", "new")
agent.DELIVER.update(["proj/a.py", "proj/b.py", "newfeature.py"])
files2, names2 = deliver_names()
check(names2 == ["newfeature.py"],
      "task#2 delivers ONLY the new file, not task#1 leftovers, got %s" % names2)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 7 — ISOLATION survives an mtime bump with UNCHANGED content")
# THE reported bug: a leftover whose timestamp got bumped (formatter/re-clone)
# but whose bytes are identical must still be filtered out.
start_task()  # baseline includes proj/*, newfeature.py
touch("proj/a.py")   # mtime moves, content identical
touch("proj/b.py")
w("todays_output.py", "brand new work")
agent.DELIVER.update(["proj/a.py", "proj/b.py", "todays_output.py"])
files4, names4 = deliver_names()
check(names4 == ["todays_output.py"],
      "mtime-bumped-but-unchanged leftovers are NOT re-delivered, got %s" % names4)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 8 — a CHANGED old file IS re-delivered (legit edit this task)")
start_task()  # baseline includes everything above
time.sleep(1.1)  # ensure mtime bucket changes
w("proj/a.py", "a-modified-content-now-genuinely-different")  # real change
agent.DELIVER.add("proj/a.py")
files3, names3 = deliver_names()
check(names3 == ["a.py"], "a genuinely edited file is delivered, got %s" % names3)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 9 — build/dependency artifacts are NEVER delivered (npm/pip leftovers)")
start_task()
w("realproj/app.py", "print('real')")
# Simulate npm/pip side-effects re-writing artifacts this task:
w("realproj/package-lock.json", '{"lockfileVersion":3}')
w("realproj/node_modules/dep/index.js", "module.exports={}")
w("realproj/dist/bundle.js", "minified")
w("realproj/__pycache__/app.cpython-311.pyc", b"\x00cache")
agent.DELIVER.update([
    "realproj/app.py", "realproj/package-lock.json",
    "realproj/node_modules/dep/index.js", "realproj/dist/bundle.js",
    "realproj/__pycache__/app.cpython-311.pyc",
])
files9, names9 = deliver_names()
# Only app.py is a real deliverable → single non-doc file → shipped as-is.
check(names9 == ["app.py"],
      "only the real source file ships; lockfile/node_modules/dist/pycache excluded, got %s" % names9)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 10 — REALISTIC MULTI-TASK: task#2 never re-delivers task#1's zip contents")
# Task #1: a coding project.
start_task()
w("t1/server.py", "s1")
w("t1/models.py", "m1")
w("t1/config.yaml", "c: 1")
agent.DELIVER.update(["t1/server.py", "t1/models.py", "t1/config.yaml"])
f1, n1 = deliver_names()
check(len(f1) == 1 and n1[0].endswith(".zip"), "task#1 → one zip, got %s" % n1)
# Task #2: user asks for a DIFFERENT coding project. A buggy re-capture pulls in
# task#1 files (mtime bumped by an incidental `ls`/`grep`/formatter) PLUS the
# new project. task#2 must deliver ONLY task#2's zip.
start_task()
touch("t1/server.py"); touch("t1/models.py"); touch("t1/config.yaml")  # incidental touch
w("t2/main.js", "j2")
w("t2/util.js", "u2")
agent.DELIVER.update([
    "t1/server.py", "t1/models.py", "t1/config.yaml",  # leftovers (touched)
    "t2/main.js", "t2/util.js",                          # this task
])
f2, n2 = deliver_names()
check(len(f2) == 1 and n2[0].endswith(".zip"), "task#2 → one zip, got %s" % n2)
if f2 and n2[0].endswith(".zip"):
    import base64 as _b64, io as _io2, zipfile as _z2
    with _z2.ZipFile(_io2.BytesIO(_b64.b64decode(f2[0]["b64"]))) as zf:
        entries = sorted(zf.namelist())
    check(all(e.startswith("t2/") for e in entries),
          "task#2 zip contains ONLY task#2 files, got %s" % entries)
    check(not any("t1/" in e for e in entries),
          "task#2 zip has NO task#1 leftovers, got %s" % entries)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 11 — agent-made archives are DROPPED (no zip-inside-zip)")
start_task()
w("mywork/index.js", "console.log(1)")
w("mywork/lib.js", "module.exports={}")
# The LLM foolishly made its own archive this task:
w("mywork/project.zip", b"PK\x03\x04 fake zip made by agent")
w("mywork/backup.tar.gz", b"\x1f\x8b fake tar")
agent.DELIVER.update(["mywork/index.js", "mywork/lib.js",
                      "mywork/project.zip", "mywork/backup.tar.gz"])
f11, n11 = deliver_names()
check(len(f11) == 1 and n11[0].endswith(".zip"), "delivered ONE runtime zip, got %s" % n11)
if f11 and n11[0].endswith(".zip"):
    import base64 as _b3, io as _i3, zipfile as _z3
    with _z3.ZipFile(_i3.BytesIO(_b3.b64decode(f11[0]["b64"]))) as zf:
        ent = sorted(zf.namelist())
    check(not any(e.endswith(".zip") or e.endswith(".gz") for e in ent),
          "delivered zip has NO nested archives, got %s" % ent)
    check(sorted(os.path.basename(e) for e in ent) == ["index.js", "lib.js"],
          "delivered zip has only the real source files, got %s" % ent)

# ─────────────────────────────────────────────────────────────────────────────
print("TEST 12 — a valid COMPLETE project ZIP is preserved, not replaced by partial loose files")
start_task()
w("complete/src/app.js", "app")
w("complete/src/auth.js", "auth")
zip_path = os.path.join(WORKDIR, "complete-project.zip")
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    zf.write(os.path.join(WORKDIR, "complete/src/app.js"), "complete/src/app.js")
    zf.write(os.path.join(WORKDIR, "complete/src/auth.js"), "complete/src/auth.js")
    zf.writestr("complete/package.json", "{}")
agent.DELIVER.update(["complete/src/app.js", "complete/src/auth.js", "complete-project.zip"])
f12, n12 = deliver_names()
check(n12 == ["complete-project.zip"], "complete authored ZIP wins, got %s" % n12)
if f12:
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(f12[0]["b64"]))) as zf:
        e12 = sorted(zf.namelist())
    check("complete/package.json" in e12, "untouched project manifest remains in complete ZIP")

# ─────────────────────────────────────────────────────────────────────────────
print("\nRESULT:", "ALL PASSED" if not failures else ("%d FAILED" % len(failures)))
sys.exit(1 if failures else 0)
