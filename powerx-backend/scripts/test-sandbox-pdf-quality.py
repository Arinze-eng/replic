#!/usr/bin/env python3
"""Provider-neutral E2E regression for every sandbox PDF entry point."""
import importlib.util
import os
import re
import shutil
import sys
import tempfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, "agent_worker")
sys.path.insert(0, WORKER)
# This suite isolates the emergency native renderer. Production and live
# provider quality are covered separately and require real pdflatex.
os.environ["LATEX_FORCE_PURE"] = "1"
os.environ["LATEX_ALLOW_NATIVE_FALLBACK"] = "1"
os.environ["LATEX_AUTO_INSTALL"] = "0"

import latex_render as lr  # noqa

WORK = tempfile.mkdtemp(prefix="sandbox_pdf_quality_")
FAILS = []

CONTENT = r"""# Engineering Mathematics Report

A production PDF must typeset nested expressions instead of printing source commands.

$$\boxed{\int_0^1 \frac{x^2+\sqrt{x}}{1+x}\,dx = \sum_{n=1}^{\infty}\frac{(-1)^{n+1}}{n}}$$

Inline vectors $\vec{v}=\begin{bmatrix}1\\2\\3\end{bmatrix}$, accents $\widehat{x}$,
and an intentionally unsupported wrapper $\mystyle{E=mc^2}$ must remain readable.

| Quantity | Formula |
|---|---|
| Energy | $E=mc^2$ |
| Gradient | $\nabla f$ |
"""


def check(cond, label):
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        FAILS.append(label)


def visible_stream_text(path):
    data = open(path, "rb").read()
    chunks = []
    for stream in re.findall(rb"stream\r?\n(.*?)endstream", data, re.S):
        try:
            stream = zlib.decompress(stream)
        except Exception:
            pass
        chunks.append(stream.decode("latin-1", "replace"))
    return "\n".join(chunks)


def assert_pdf(path, label):
    data = open(path, "rb").read() if os.path.isfile(path) else b""
    text = visible_stream_text(path) if data else ""
    leaked = re.findall(r"\\(?:frac|sqrt|int|sum|begin|end|boxed|vec|widehat|mystyle)\b", text)
    check(data.startswith(b"%PDF") and len(data) > 1000, label + " is a non-trivial PDF")
    check(bool(re.search(rb"/Type\s*/Page\b", data)), label + " contains a page")
    check(not leaked, label + " contains no raw LaTeX commands")


try:
    print("== shared renderer ==")
    direct = os.path.join(WORK, "direct.pdf")
    lr.build_pdf(CONTENT, direct, title="Quality Gate")
    assert_pdf(direct, "direct build_pdf")

    print("== in-sandbox create_pdf and convert_file ==")
    os.environ["AGENT_WORK"] = WORK
    import agent  # noqa
    created = agent.execute_tool("create_pdf", {"filename": "created.pdf", "title": "Quality", "content": CONTENT}, lambda *a, **k: None)
    check("created.pdf" in str(created), "create_pdf completed")
    assert_pdf(os.path.join(WORK, "created.pdf"), "create_pdf")

    md_path = os.path.join(WORK, "source.md")
    open(md_path, "w", encoding="utf-8").write(CONTENT)
    converted = agent.execute_tool("convert_file", {"source": "source.md", "to": "pdf", "filename": "converted.pdf"}, lambda *a, **k: None)
    check("converted.pdf" in str(converted), "convert_file completed")
    assert_pdf(os.path.join(WORK, "converted.pdf"), "convert_file")

    print("== enterprise documents tool ==")
    tool_path = os.path.join(WORKER, "tools", "documents", "documents_tool.py")
    spec = importlib.util.spec_from_file_location("documents_tool_quality", tool_path)
    documents = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(documents)

    class Ctx:
        def _resolve(self, p):
            p = str(p).replace("\\", "/").lstrip("/")
            if ".." in p.split("/"):
                raise ValueError("unsafe path")
            return os.path.join(WORK, p)

    result = documents.run(Ctx(), {"action": "generate", "output_path": "documents.pdf", "output_format": "pdf", "title": "Documents", "content": CONTENT})
    check(result.get("method") == "latex_render", "documents.generate uses shared renderer")
    assert_pdf(os.path.join(WORK, "documents.pdf"), "documents.generate")

    result = documents.run(Ctx(), {"action": "convert", "input_path": "source.md", "output_path": "documents-convert.pdf", "output_format": "pdf"})
    check(result.get("method") == "latex_render", "documents.convert uses shared renderer")
    assert_pdf(os.path.join(WORK, "documents-convert.pdf"), "documents.convert")
finally:
    shutil.rmtree(WORK, ignore_errors=True)

print("\n" + ("ALL SANDBOX PDF QUALITY TESTS PASSED" if not FAILS else "FAILED: " + ", ".join(FAILS)))
sys.exit(1 if FAILS else 0)
