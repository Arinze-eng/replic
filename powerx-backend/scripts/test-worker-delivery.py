#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# test-worker-delivery.py — proves the DELIVERY PIPELINE fix in agent_worker/agent.py
#
# The bug: host-proxied convert_file wrote the converted file into WORK but the
# worker NEVER added it to the DELIVER set, so collect_deliverables() returned
# nothing → "it converted but didn't give me the file".
#
# This test imports the REAL agent.py, stubs only the network `bridge` (so no
# sandbox/host is needed), and asserts that after a host-proxied convert_file
# the produced file is queued and collected for delivery.
# ─────────────────────────────────────────────────────────────────────────────
import os, sys, base64, tempfile, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "agent_worker", "agent.py")

# Force a temp WORK dir + file bridge mode BEFORE importing agent.py.
tmp = tempfile.mkdtemp(prefix="workertest_")
os.environ["AGENT_WORK"] = tmp
os.environ["AGENT_BRIDGE_MODE"] = "http"  # avoid the file-bridge inbox watcher paths

spec = importlib.util.spec_from_file_location("agentworker", WORKER)
agent = importlib.util.module_from_spec(spec)
# agent.py reads WORK from env/const at import — load it and then override WORK.
spec.loader.exec_module(agent)

# Point the module's WORK at our temp dir regardless of how it computed it.
agent.WORK = tmp
os.makedirs(tmp, exist_ok=True)

PASS = []

# ── 1) Stub the network bridge to emulate the HOST converter returning a file ─
FAKE_PDF = b"%PDF-1.4\n%fake converted pdf bytes for delivery test\n%%EOF\n"
def fake_bridge(payload, timeout=180, retries=3):
    if payload.get("op") == "tool" and payload.get("tool") in ("convert_file", "convert", "file_convert"):
        return {
            "result": "[convert_file] ✅ Converted sample.docx → sample.pdf via LibreOffice. Queued for delivery.",
            "files": [{"name": "sample.pdf", "b64": base64.b64encode(FAKE_PDF).decode("ascii")}],
        }
    return {"result": "", "files": []}
agent.bridge = fake_bridge

# ── 2) Reset delivery state, then call host_tool exactly like the office path ─
agent.DELIVER.clear()
# Force the office-proxy branch: give it a non-text source so tool_convert_file
# proxies straight to host_tool (which now must register the file for delivery).
open(os.path.join(tmp, "sample.docx"), "wb").write(b"fake docx bytes")
res = agent.tool_convert_file({"source": "sample.docx", "to": "pdf"})
print("tool_convert_file returned:", res[:120])

# ── 3) Assert the produced file was written AND queued for delivery ──────────
wrote = os.path.isfile(os.path.join(tmp, "sample.pdf"))
queued = "sample.pdf" in agent.DELIVER
delivered = agent.collect_deliverables()
names = [f["name"] for f in delivered]
got_bytes = any(base64.b64decode(f["b64"]) == FAKE_PDF for f in delivered if f["name"] == "sample.pdf")

print("file written to WORK:", wrote)
print("queued in DELIVER   :", queued)
print("collect_deliverables:", names)
print("bytes match original:", got_bytes)

ok1 = wrote and queued and ("sample.pdf" in names) and got_bytes
PASS.append(("host-proxied convert_file delivers the converted file", ok1))

# ── 4) Also verify the execute_tool snapshot safety-net catches local writes ──
agent.DELIVER.clear()
# Register a fake LOCAL tool that writes a file WITHOUT calling DELIVER.add.
def _sneaky_local(args):
    open(os.path.join(tmp, "surprise.txt"), "w").write("converted content the tool forgot to queue")
    return "[sneaky] wrote a file but forgot to queue it"
agent.LOCAL_TOOLS["_sneaky"] = _sneaky_local
agent.execute_tool("_sneaky", {}, lambda *a, **k: None)
snap_caught = "surprise.txt" in agent.DELIVER
print("\nsafety-net caught un-queued local file:", snap_caught)
PASS.append(("execute_tool snapshot safety-net captures un-queued outputs", snap_caught))

print("\n" + "=" * 44)
allok = all(ok for _, ok in PASS)
for label, ok in PASS:
    print(("  ✅ " if ok else "  ❌ ") + label)
print("RESULT:", "ALL PASS" if allok else "FAILURES PRESENT")
sys.exit(0 if allok else 1)
