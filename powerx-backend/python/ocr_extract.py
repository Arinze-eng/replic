#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# =============================================================================
# ocr_extract.py — high-accuracy, self-contained OCR / document extractor that
# runs INSIDE the sandbox (GitHub Actions runner with root, Novita, Daytona,
# HopX, or the local host). It is dispatched by services/simpleOcr.js.
#
# WHY THIS EXISTS
#   The old pure-Node path sent every image straight to a vision model (Gemini),
#   which is unreliable for dense, text-heavy inputs — e.g. a photo of a full
#   past-question paper with many questions: the model transcribes ONE question
#   and drops the rest. This script does REAL OCR with Tesseract + strong image
#   preprocessing and a multi-pass strategy, so ALL text on a busy page is
#   recovered. It also handles scanned PDFs (image-only pages) via OCR, and
#   native PDF/DOCX/XLSX text layers.
#
# DESIGN
#   • Single entrypoint. Reads ONE input file, prints ONE JSON object to stdout.
#     The JSON is wrapped in unique sentinels so the Node bridge can extract it
#     even if apt/pip printed noise around it.
#   • Never crashes the caller: any fatal error is reported as JSON ok:false.
#   • Auto-installs its OWN system + python deps on first run inside the sandbox
#     (idempotent, cached). Root is available on the GitHub runner (sudo) and on
#     the Novita/Daytona boxes.
#   • Every heavy import is lazy + guarded so a missing lib degrades gracefully
#     (e.g. no OpenCV → OCR still runs on the raw image via Pillow).
#
# OUTPUT (stdout, between the sentinels):
#   {
#     "ok": true/false,
#     "type": "image" | "pdf" | "docx" | "excel" | "text",
#     "text": "....",              # the extracted text (may be "")
#     "has_text": true/false,      # did we find meaningful text?
#     "word_count": 123,
#     "confidence": 0-100,
#     "engine": "tesseract" | "pymupdf" | "ocrmypdf+tesseract" | "docx" | "xlsx" | "text",
#     "pages": N,                  # for PDFs
#     "meta": { ... },
#     "reason": "..."              # present when ok:false or has_text:false
#   }
# =============================================================================

import os
import re
import sys
import json
import base64
import subprocess
import shutil
import tempfile

JSON_BEGIN = "<<<PXOCR_JSON_BEGIN>>>"
JSON_END = "<<<PXOCR_JSON_END>>>"

# Extensions we recognise.
IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".webp", ".tif", ".tiff",
    ".bmp", ".dib", ".gif", ".ppm", ".pgm", ".pbm", ".pnm", ".pcx",
    ".tga", ".ico", ".heic", ".heif",
}
PDF_EXTS = {".pdf"}
DOCX_EXTS = {".docx", ".docm", ".doc"}
XLSX_EXTS = {".xlsx", ".xlsm", ".xlsb", ".xls"}
PPTX_EXTS = {".pptx", ".pptm", ".ppt"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".log", ".yaml", ".yml"}
ARCHIVE_EXTS = {".zip"}


def _emit(obj):
    """Print the result JSON wrapped in sentinels, then exit 0 (never fail the
    workflow step — the caller reads ok:false from the JSON)."""
    try:
        payload = json.dumps(obj, ensure_ascii=False)
    except Exception:
        payload = json.dumps({"ok": False, "reason": "json-encode-failed"})
    sys.stdout.write("\n" + JSON_BEGIN + "\n" + payload + "\n" + JSON_END + "\n")
    sys.stdout.flush()
    sys.exit(0)


def _log(msg):
    # Diagnostic noise goes to stderr so it never pollutes the JSON on stdout.
    try:
        sys.stderr.write("[ocr_extract] " + str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# ── Dependency bootstrap (idempotent, cached) ────────────────────────────────
def _have(cmd):
    return shutil.which(cmd) is not None


def _run(cmd, timeout=600):
    try:
        p = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, (p.stdout or b"").decode("utf-8", "replace")
    except Exception as e:
        return 1, str(e)


def _sudo_prefix():
    # On the GitHub runner the dispatcher already runs the command under `sudo`,
    # so apt/pip run as root. But when this script is invoked directly (e.g.
    # Novita/Daytona) we may need sudo. Use it only if present and not already root.
    if os.geteuid() == 0:
        return ""
    return "sudo " if _have("sudo") else ""


def ensure_system_deps(need_tesseract=True, need_poppler=True):
    """Install tesseract + poppler (+ optional ocrmypdf) once. Cached via a
    stamp file so repeat calls in the same sandbox are instant."""
    stamp = "/tmp/.pxocr_sysdeps_ok"
    ok_tess = _have("tesseract") or not need_tesseract
    ok_popp = _have("pdftoppm") or not need_poppler
    if os.path.exists(stamp) and ok_tess and ok_popp:
        return
    if ok_tess and ok_popp:
        try:
            open(stamp, "w").close()
        except Exception:
            pass
        return

    sudo = _sudo_prefix()
    pkgs = []
    if need_tesseract and not _have("tesseract"):
        pkgs += ["tesseract-ocr"]
    if need_poppler and not _have("pdftoppm"):
        pkgs += ["poppler-utils"]
    if pkgs:
        _log("installing system packages: " + " ".join(pkgs))
        # apt is the common case on ubuntu runners / debian sandboxes.
        _run(sudo + "apt-get update -y -q", timeout=300)
        _run(sudo + "DEBIAN_FRONTEND=noninteractive apt-get install -y -q "
             + " ".join(pkgs), timeout=600)
        # Fallback for alpine / other package managers.
        if need_tesseract and not _have("tesseract"):
            _run(sudo + "apk add --no-cache tesseract-ocr", timeout=300)
        if need_poppler and not _have("pdftoppm"):
            _run(sudo + "apk add --no-cache poppler-utils", timeout=300)
    try:
        open(stamp, "w").close()
    except Exception:
        pass


def ensure_python_deps(mods):
    """pip-install the given python modules if their import fails. Idempotent.

    Multiple images can arrive together, so guard first-use pip bootstrap with a
    cross-process file lock. Without this, parallel OCR workers can corrupt or
    partially install the same wheels and every page returns no text.
    """
    missing = []
    import importlib
    name_map = {
        "cv2": "opencv-python-headless",
        "PIL": "Pillow",
        "fitz": "PyMuPDF",
        "pytesseract": "pytesseract",
        "numpy": "numpy",
        "docx": "python-docx",
        "openpyxl": "openpyxl",
        "pdf2image": "pdf2image",
    }
    for m in mods:
        try:
            importlib.import_module(m)
        except Exception:
            missing.append(name_map.get(m, m))
    if not missing:
        return
    lock_path = "/tmp/.pxocr_pip.lock"
    lock_fh = None
    try:
        try:
            import fcntl
            lock_fh = open(lock_path, "w")
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
        except Exception:
            lock_fh = None
        # Another OCR process may have completed installation while we waited.
        still_missing = []
        for m in mods:
            try:
                importlib.import_module(m)
            except Exception:
                still_missing.append(name_map.get(m, m))
        if not still_missing:
            return
        _log("pip installing: " + " ".join(still_missing))
        # Prefer the active interpreter so packages land where this process can
        # import them; provider-level pip executables can target another Python.
        for pip in (sys.executable + " -m pip", "pip3", "pip"):
            code, _out = _run(pip + " install --quiet --no-input --disable-pip-version-check "
                              + " ".join(still_missing), timeout=600)
            if code == 0:
                return
        _log("pip install may have failed; continuing with whatever is available")
    finally:
        if lock_fh is not None:
            try: lock_fh.close()
            except Exception: pass


# ── Image preprocessing (OpenCV, optional) ───────────────────────────────────
def _preprocess_variants(img_path):
    """Return a list of (label, numpy_image_or_path) preprocessing variants to
    OCR. More variants → more robust recovery of dense pages. Falls back to the
    raw image if OpenCV/numpy are unavailable."""
    variants = []
    try:
        import cv2
        import numpy as np
        # Preserve alpha so black text on a transparent canvas is composited on
        # white instead of becoming black-on-black when OpenCV drops alpha.
        raw = cv2.imread(img_path, cv2.IMREAD_UNCHANGED)
        img = None
        if raw is not None:
            if len(raw.shape) == 2:
                img = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
            elif raw.shape[2] == 4:
                bgr = raw[:, :, :3].astype(np.float32)
                alpha = raw[:, :, 3:4].astype(np.float32) / 255.0
                img = np.clip(bgr * alpha + 255.0 * (1.0 - alpha), 0, 255).astype(np.uint8)
            else:
                img = raw[:, :, :3]
        if img is None:
            # Pillow handles formats OpenCV cannot and applies EXIF rotation.
            from PIL import Image, ImageOps
            im = ImageOps.exif_transpose(Image.open(img_path)).convert("RGBA")
            bg = Image.new("RGBA", im.size, "white")
            bg.alpha_composite(im)
            img = cv2.cvtColor(np.array(bg.convert("RGB")), cv2.COLOR_RGB2BGR)

        # Upscale small images — Tesseract needs ~300 DPI equivalent. Scale so the
        # shorter side is >= 1800px (dense exam photos are often too small).
        h, w = img.shape[:2]
        short = min(h, w)
        if short < 1800:
            scale = min(4.0, 1800.0 / max(1, short))
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Deskew based on the dominant text angle.
        try:
            coords = np.column_stack(np.where(gray < 128))
            if coords.size > 0:
                angle = cv2.minAreaRect(coords)[-1]
                if angle < -45:
                    angle = -(90 + angle)
                else:
                    angle = -angle
                if abs(angle) > 0.5:
                    (gh, gw) = gray.shape[:2]
                    M = cv2.getRotationMatrix2D((gw / 2, gh / 2), angle, 1.0)
                    gray = cv2.warpAffine(gray, M, (gw, gh),
                                          flags=cv2.INTER_CUBIC,
                                          borderMode=cv2.BORDER_REPLICATE)
        except Exception:
            pass

        # Denoise.
        try:
            denoised = cv2.fastNlMeansDenoising(gray, None, 10, 7, 21)
        except Exception:
            denoised = gray

        # Variant 1: adaptive threshold (great for uneven lighting / photos).
        try:
            adapt = cv2.adaptiveThreshold(denoised, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                          cv2.THRESH_BINARY, 31, 15)
            variants.append(("adaptive", adapt))
        except Exception:
            pass

        # Variant 2: Otsu global threshold (great for clean scans / screenshots).
        try:
            _t, otsu = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            variants.append(("otsu", otsu))
        except Exception:
            pass

        # Variant 3: the plain (upscaled/deskewed) grayscale — sometimes beats
        # binarization for anti-aliased digital text.
        variants.append(("gray", gray))
    except Exception as e:
        _log("preprocess unavailable (%s) — using raw image" % e)

    return variants


def _tess_text(image_or_path, psm):
    """Run Tesseract with a given PSM. Prefer pytesseract for in-memory OpenCV
    variants, but use the Tesseract CLI directly for file paths when Python
    wheels cannot be installed in a restricted sandbox."""
    cfg = "--oem 1 --psm %d -c preserve_interword_spaces=1" % psm
    try:
        import pytesseract
        from pytesseract import Output
        data = pytesseract.image_to_data(image_or_path, config=cfg, output_type=Output.DICT)
        confs = []
        for i, txt in enumerate(data.get("text", [])):
            if not (txt or "").strip(): continue
            try: c = float(data["conf"][i])
            except Exception: c = -1
            if c >= 0: confs.append(c)
        text = pytesseract.image_to_string(image_or_path, config=cfg)
        return text, (sum(confs) / len(confs)) if confs else 0.0
    except Exception as py_error:
        # Restricted images (notably Daytona) may have OpenCV from the base
        # template but no writable pip environment for pytesseract. The real
        # Tesseract CLI is still available, so serialize in-memory processed
        # variants to a temporary PNG and invoke it directly.
        tmp_path = None
        cli_path = image_or_path if isinstance(image_or_path, str) else None
        if cli_path is None and _have("tesseract"):
            try:
                import cv2
                fd, tmp_path = tempfile.mkstemp(suffix=".png")
                os.close(fd)
                if cv2.imwrite(tmp_path, image_or_path): cli_path = tmp_path
            except Exception:
                cli_path = None
        try:
            if cli_path and _have("tesseract"):
                quoted = str(cli_path).replace('"', '')
                code, text = _run('tesseract "%s" stdout %s 2>/dev/null' % (quoted, cfg), timeout=180)
                if code == 0: return text, 0.0
        finally:
            if tmp_path:
                try: os.unlink(tmp_path)
                except Exception: pass
        _log("tesseract pass psm=%d failed: %s" % (psm, py_error))
        return "", 0.0


def _score(text):
    """Cheap quality heuristic: more real alnum content = better."""
    if not text:
        return 0
    words = re.findall(r"[A-Za-z0-9]{2,}", text)
    return len(words) + len(text.strip())


def _question_markers(text):
    return len(re.findall(r"(?:^|\n)\s*(?:question\s*)?(?:\d{1,3}|[ivxlcdm]{1,8})\s*[.)\]:-]|\b(?:solve|calculate|evaluate|find|determine|prove|simplify)\b", text or "", re.I))


def _stitch_bands(parts):
    """Join overlapping OCR bands while removing only exact adjacent duplicate
    lines. Conservative de-duplication is intentional: losing a repeated exam
    line is worse than retaining a harmless duplicate."""
    out = []
    for part in parts:
        lines = [x.rstrip() for x in (part or "").splitlines()]
        while lines and not lines[0].strip(): lines.pop(0)
        while lines and not lines[-1].strip(): lines.pop()
        overlap = 0
        max_overlap = min(8, len(out), len(lines))
        for size in range(max_overlap, 0, -1):
            left = [re.sub(r"\s+", " ", x).strip().lower() for x in out[-size:]]
            right = [re.sub(r"\s+", " ", x).strip().lower() for x in lines[:size]]
            if left == right and any(left): overlap = size; break
        out.extend(lines[overlap:])
    return "\n".join(out).strip()


def ocr_image(img_path):
    """OCR an image with multiple preprocessing variants + PSM modes, keep the
    best result. PSM 6 (uniform block) and PSM 4 (variable-size columns) both
    matter for dense multi-question pages; PSM 3 (auto) is the general fallback."""
    ensure_system_deps(need_tesseract=True, need_poppler=False)
    ensure_python_deps(["pytesseract", "PIL", "numpy", "cv2"])

    best_text, best_conf, best_label = "", 0.0, "none"

    variants = _preprocess_variants(img_path)
    if not variants:
        # No OpenCV/Pillow wheel: Tesseract's native image loader supports PNG,
        # JPEG, TIFF and WebP directly, so OCR the original path with zero
        # Python imaging dependencies.
        variants = [("raw-cli", img_path)]

    # Try the most useful PSMs. Order matters only for tie-breaking.
    for label, img in variants:
        for psm in (6, 4, 3, 11):
            text, conf = _tess_text(img, psm)
            s = _score(text)
            if s > _score(best_text) or (s == _score(best_text) and conf > best_conf):
                best_text, best_conf, best_label = text, conf, "%s/psm%d" % (label, psm)

    # Dense portrait exam pages are where full-frame segmentation most often
    # skips middle/bottom questions. Run one additional tiled pass (three
    # overlapping horizontal bands) on the clearest processed variant. Choose
    # it when it recovers more question markers or materially more text.
    try:
        tile_source = next((img for label, img in variants if label in ("gray", "otsu", "adaptive") and not isinstance(img, str)), None)
        if tile_source is not None and getattr(tile_source, "shape", (0, 0))[0] >= 900:
            h = tile_source.shape[0]
            band_h = int(h * 0.40)
            starts = [0, max(0, int(h * 0.30)), max(0, h - band_h)]
            band_texts, band_confs = [], []
            for start in starts:
                band = tile_source[start:min(h, start + band_h), :]
                txt, conf = _tess_text(band, 6)
                band_texts.append(txt); band_confs.append(conf)
            tiled = _stitch_bands(band_texts)
            tiled_score, best_score = _score(tiled), _score(best_text)
            if (_question_markers(tiled) > _question_markers(best_text) and tiled_score >= best_score * 0.72) or tiled_score > best_score * 1.12:
                best_text = tiled
                best_conf = sum(band_confs) / max(1, len(band_confs))
                best_label = "tiled-3x/psm6"
    except Exception as e:
        _log("tiled OCR pass failed: %s" % e)

    text = (best_text or "").replace("\x00", "").strip()
    wc = len(re.findall(r"\S+", text))
    has = wc >= 2 and len(text) >= 6
    return {
        "ok": True,
        "type": "image",
        "text": text,
        "has_text": has,
        "word_count": wc,
        "confidence": round(best_conf, 1),
        "engine": "tesseract",
        "meta": {"variant": best_label},
        "reason": "" if has else "no-meaningful-text",
    }


# ── PDF extraction (native text + OCR for scanned pages) ─────────────────────
def extract_pdf(pdf_path, max_pages=0):
    """Extract text from a PDF. Uses the native text layer (PyMuPDF) when
    present; for pages with little/no text (scanned images) it rasterizes and
    OCRs them so image-only PDFs are fully recovered."""
    ensure_python_deps(["fitz"])
    text_parts = []
    pages = 0
    ocr_pages = 0
    engine = "pymupdf"
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf_path)
        pages = doc.page_count
        limit = doc.page_count if not max_pages else min(max_pages, doc.page_count)
        need_ocr_pages = []
        page_methods = []
        for i in range(limit):
            page = doc.load_page(i)
            native = (page.get_text("text", sort=True) or "").strip()
            if len(native) >= 20:
                text_parts.append(native)
                page_methods.append("native")
            else:
                need_ocr_pages.append(i)
                text_parts.append(None)  # placeholder, filled by OCR below
                page_methods.append("ocr")

        # OCR the image-only pages.
        if need_ocr_pages:
            ensure_system_deps(need_tesseract=True, need_poppler=True)
            ensure_python_deps(["pytesseract", "PIL", "numpy", "cv2"])
            engine = "pymupdf+tesseract"
            for i in need_ocr_pages:
                try:
                    page = doc.load_page(i)
                    # Render at ~300 DPI for good OCR.
                    pix = page.get_pixmap(matrix=fitz.Matrix(300 / 72.0, 300 / 72.0))
                    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                    tmp.write(pix.tobytes("png"))
                    tmp.close()
                    r = ocr_image(tmp.name)
                    try:
                        os.unlink(tmp.name)
                    except Exception:
                        pass
                    if r.get("ok") and r.get("text"):
                        text_parts[i] = r["text"]
                        ocr_pages += 1
                    else:
                        text_parts[i] = ""
                except Exception as e:
                    _log("pdf page %d OCR failed: %s" % (i, e))
                    text_parts[i] = ""
        doc.close()
    except Exception as e:
        # PyMuPDF may be unavailable in a locked-down sandbox. Poppler is the
        # deterministic second engine: extract each page independently so page
        # boundaries/completeness are still preserved, then OCR only empty pages.
        _log("PyMuPDF unavailable (%s) — using Poppler page pipeline" % e)
        ensure_system_deps(need_tesseract=False, need_poppler=True)
        if not (_have("pdfinfo") and _have("pdftotext")):
            return {"ok": False, "reason": "pdf-extract-failed: %s" % e, "engine": engine}
        code, info = _run('pdfinfo "%s"' % pdf_path.replace('"', ''), timeout=60)
        m = re.search(r"^Pages:\s+(\d+)", info, re.M | re.I)
        pages = int(m.group(1)) if m else 0
        limit = pages if not max_pages else min(max_pages, pages)
        text_parts, page_methods = [], []
        for i in range(limit):
            out_txt = tempfile.NamedTemporaryFile(suffix=".txt", delete=False).name
            _run('pdftotext -layout -f %d -l %d "%s" "%s"' %
                 (i + 1, i + 1, pdf_path.replace('"', ''), out_txt.replace('"', '')), timeout=60)
            try:
                native = open(out_txt, "rb").read().decode("utf-8", "replace").strip()
            except Exception:
                native = ""
            try: os.unlink(out_txt)
            except Exception: pass
            if len(native) >= 20:
                text_parts.append(native); page_methods.append("native-poppler")
                continue
            page_methods.append("ocr-poppler")
            ensure_system_deps(need_tesseract=True, need_poppler=True)
            prefix = tempfile.NamedTemporaryFile(delete=False).name
            try: os.unlink(prefix)
            except Exception: pass
            _run('pdftoppm -f %d -l %d -singlefile -r 300 -png "%s" "%s"' %
                 (i + 1, i + 1, pdf_path.replace('"', ''), prefix.replace('"', '')), timeout=180)
            png = prefix + ".png"
            r = ocr_image(png) if os.path.exists(png) else {"ok": False}
            try: os.unlink(png)
            except Exception: pass
            text_parts.append(r.get("text", "") if r.get("ok") else "")
            if r.get("ok") and r.get("text"): ocr_pages += 1
        engine = "poppler+tesseract" if ocr_pages else "poppler"

    # Keep explicit page boundaries. This is critical for past-question sets:
    # downstream completeness checks can prove every processed page is present
    # instead of receiving one undifferentiated text blob.
    marked = []
    for i, part in enumerate(text_parts):
        method = page_methods[i] if i < len(page_methods) else "unknown"
        marked.append("=== PAGE %d/%d [%s] ===\n%s" % (i + 1, limit, method, (part or "[NO TEXT EXTRACTED]")))
    joined = "\n\n".join(marked).replace("\x00", "").strip()
    wc = len(re.findall(r"\S+", joined))
    extracted_pages = sum(1 for p in text_parts if p and p.strip())
    has = extracted_pages > 0
    return {
        "ok": True,
        "type": "pdf",
        "text": joined,
        "has_text": has,
        "word_count": wc,
        "confidence": 100 if (engine == "pymupdf") else 90,
        "engine": engine,
        "pages": pages,
        "meta": {"processed_pages": limit, "extracted_pages": extracted_pages,
                 "missing_pages": [i + 1 for i, p in enumerate(text_parts) if not (p and p.strip())],
                 "ocr_pages": ocr_pages, "page_methods": page_methods,
                 "complete": extracted_pages == limit},
        "reason": "" if has else "no-text-in-pdf",
    }


def extract_docx(path):
    # OOXML is a ZIP of XML files, so DOCX/DOCM needs no third-party package.
    # Parse paragraphs, tables, headers, footers, footnotes and endnotes in
    # document order with Python's standard library. Embedded images remain
    # available to higher-level OCR when their surrounding page is rendered.
    if os.path.splitext(path)[1].lower() in {".docx", ".docm"}:
        import zipfile
        import xml.etree.ElementTree as ET
        try:
            with zipfile.ZipFile(path) as z:
                names = [n for n in z.namelist() if n == "word/document.xml" or
                         re.match(r"word/(header|footer)\d+\.xml$", n) or
                         n in {"word/footnotes.xml", "word/endnotes.xml"}]
                names.sort(key=lambda n: (0 if n == "word/document.xml" else 1, n))
                parts = []
                for name in names:
                    root = ET.fromstring(z.read(name))
                    for para in root.iter():
                        if not str(para.tag).endswith("}p"):
                            continue
                        runs = []
                        for node in para.iter():
                            tag = str(node.tag)
                            if tag.endswith("}t") and node.text: runs.append(node.text)
                            elif tag.endswith("}tab"): runs.append("\t")
                            elif tag.endswith("}br"): runs.append("\n")
                        line = "".join(runs).strip()
                        if line: parts.append(line)
            text = "\n".join(parts).replace("\x00", "").strip()
            wc = len(re.findall(r"\S+", text))
            return {"ok": True, "type": "docx", "text": text, "has_text": wc >= 1,
                    "word_count": wc, "confidence": 100, "engine": "docx-ooxml",
                    "meta": {"parts": len(names)}, "reason": "" if wc else "empty-docx"}
        except Exception as e:
            return {"ok": False, "reason": "docx-extract-failed: %s" % e}
    return extract_via_libreoffice(path, "Word")


def _xml_text(path, pattern, label):
    """Extract ordered text from an OOXML zip without rendering or an AI model."""
    import zipfile
    import html
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.search(pattern, n, re.I)]
            def number(n):
                m = re.search(r"(\d+)(?=\.xml$)", n)
                return int(m.group(1)) if m else 0
            names.sort(key=number)
            parts = []
            for idx, name in enumerate(names, 1):
                xml = z.read(name).decode("utf-8", "replace")
                runs = re.findall(r"<(?:a:t|w:t)(?:\s[^>]*)?>([\s\S]*?)</(?:a:t|w:t)>", xml, re.I)
                text = " ".join(html.unescape(re.sub(r"<[^>]+>", "", x)) for x in runs).strip()
                parts.append("=== %s %d/%d ===\n%s" % (label, idx, len(names), text or "[NO TEXT EXTRACTED]"))
        joined = "\n\n".join(parts).strip()
        wc = len(re.findall(r"\S+", joined))
        extracted = sum(1 for p in parts if "[NO TEXT EXTRACTED]" not in p)
        return {"ok": True, "type": label.lower(), "text": joined, "has_text": extracted > 0,
                "word_count": wc, "confidence": 100, "engine": "ooxml",
                "meta": {"items": len(parts), "extracted_items": extracted,
                         "complete": extracted == len(parts)},
                "reason": "" if extracted else "no-text"}
    except Exception as e:
        return {"ok": False, "reason": "%s-extract-failed: %s" % (label.lower(), e)}


def extract_pptx(path):
    # Legacy binary .ppt is handled by LibreOffice fallback below when present.
    if os.path.splitext(path)[1].lower() in {".pptx", ".pptm"}:
        return _xml_text(path, r"^ppt/slides/slide\d+\.xml$", "SLIDE")
    return extract_via_libreoffice(path, "PowerPoint")


def extract_via_libreoffice(path, kind="document"):
    if not _have("soffice"):
        return {"ok": False, "reason": "%s-needs-libreoffice" % kind.lower()}
    outdir = tempfile.mkdtemp(prefix="pxocr_lo_")
    try:
        code, out = _run('soffice --headless --norestore --convert-to txt:Text --outdir "%s" "%s"' %
                         (outdir.replace('"', ''), path.replace('"', '')), timeout=180)
        candidates = [os.path.join(outdir, n) for n in os.listdir(outdir) if n.lower().endswith(".txt")]
        if code != 0 or not candidates:
            return {"ok": False, "reason": "%s-libreoffice-failed: %s" % (kind.lower(), out[-200:])}
        text = open(candidates[0], "rb").read().decode("utf-8", "replace").replace("\x00", "").strip()
        wc = len(re.findall(r"\S+", text))
        return {"ok": True, "type": kind.lower(), "text": text, "has_text": wc > 0,
                "word_count": wc, "confidence": 95, "engine": "libreoffice", "meta": {},
                "reason": "" if wc else "empty"}
    finally:
        shutil.rmtree(outdir, ignore_errors=True)


def extract_zip(path):
    """Safely inventory an archive. Actual recursive processing is performed by
    the agent staging layer, which enforces file-count and expanded-size caps."""
    import zipfile
    try:
        with zipfile.ZipFile(path) as z:
            entries = []
            total = 0
            for info in z.infolist():
                if info.is_dir():
                    continue
                name = info.filename.replace("\\", "/")
                unsafe = name.startswith("/") or any(p == ".." for p in name.split("/"))
                entries.append("%s\t%d bytes%s" % (name, info.file_size, "\t[UNSAFE PATH]" if unsafe else ""))
                total += max(0, info.file_size)
        text = "=== ARCHIVE MANIFEST ===\n" + "\n".join(entries)
        return {"ok": True, "type": "archive", "text": text, "has_text": bool(entries),
                "word_count": len(entries), "confidence": 100, "engine": "zipfile",
                "meta": {"entries": len(entries), "expanded_bytes": total,
                         "unsafe_entries": sum(1 for x in entries if "UNSAFE PATH" in x)},
                "reason": "" if entries else "empty-archive"}
    except Exception as e:
        return {"ok": False, "reason": "zip-extract-failed: %s" % e}


def extract_excel(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in {".xlsx", ".xlsm"}:
        return extract_via_libreoffice(path, "Excel")
    import zipfile
    import xml.etree.ElementTree as ET
    try:
        with zipfile.ZipFile(path) as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                for si in root:
                    shared.append("".join(n.text or "" for n in si.iter() if str(n.tag).endswith("}t")))
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rels = {}
            if "xl/_rels/workbook.xml.rels" in z.namelist():
                rr = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
                for r in rr: rels[r.attrib.get("Id", "")] = r.attrib.get("Target", "")
            sheets = []
            for s in wb.iter():
                if not str(s.tag).endswith("}sheet"): continue
                rid = next((v for k, v in s.attrib.items() if k.endswith("}id")), "")
                target = rels.get(rid, "worksheets/sheet%d.xml" % (len(sheets) + 1)).lstrip("/")
                if not target.startswith("xl/"): target = "xl/" + target
                sheets.append((s.attrib.get("name", "Sheet%d" % (len(sheets) + 1)), target))
            parts = []
            for title, target in sheets:
                root = ET.fromstring(z.read(target))
                rows = []
                for row in root.iter():
                    if not str(row.tag).endswith("}row"): continue
                    cells = []
                    for c in row:
                        if not str(c.tag).endswith("}c"): continue
                        typ = c.attrib.get("t", "")
                        vals = [n for n in c.iter() if str(n.tag).endswith("}v") or str(n.tag).endswith("}t")]
                        value = "".join(n.text or "" for n in vals)
                        if typ == "s" and value.isdigit() and int(value) < len(shared): value = shared[int(value)]
                        cells.append(value)
                    if any(x.strip() for x in cells): rows.append(",".join(cells))
                parts.append("# Sheet: %s\n%s" % (title, "\n".join(rows) if rows else "[NO CELLS EXTRACTED]"))
        text = "\n\n".join(parts).replace("\x00", "").strip()
        wc = len(re.findall(r"\S+", text))
        extracted = sum(1 for p in parts if "[NO CELLS EXTRACTED]" not in p)
        return {"ok": True, "type": "excel", "text": text, "has_text": extracted > 0,
                "word_count": wc, "confidence": 100, "engine": "xlsx-ooxml",
                "meta": {"sheets": len(sheets), "extracted_sheets": extracted,
                         "complete": extracted == len(sheets)},
                "reason": "" if extracted else "empty-excel"}
    except Exception as e:
        return {"ok": False, "reason": "excel-extract-failed: %s" % e}


def main():
    # Args: --file PATH [--mode classify|extract|warmup] [--pages N]
    args = sys.argv[1:]
    path = None
    mode = "extract"
    max_pages = 0
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--file" and i + 1 < len(args):
            path = args[i + 1]; i += 2; continue
        if a == "--mode" and i + 1 < len(args):
            mode = args[i + 1]; i += 2; continue
        if a == "--pages" and i + 1 < len(args):
            try:
                max_pages = int(args[i + 1])
            except Exception:
                max_pages = 0
            i += 2; continue
        i += 1

    if mode == "warmup":
        ensure_system_deps(need_tesseract=True, need_poppler=True)
        ensure_python_deps(["pytesseract", "PIL", "numpy", "cv2", "fitz"])
        ready = _have("tesseract") and _have("pdftoppm")
        _emit({"ok": ready, "type": "warmup", "text": "OCR_READY" if ready else "",
               "has_text": ready, "word_count": 1 if ready else 0,
               "confidence": 100 if ready else 0, "engine": "tesseract+poppler",
               "reason": "" if ready else "ocr-dependencies-unavailable"})

    if not path or not os.path.exists(path):
        _emit({"ok": False, "reason": "input-file-missing"})

    ext = os.path.splitext(path)[1].lower()
    try:
        if ext in IMAGE_EXTS:
            res = ocr_image(path)
        elif ext in PDF_EXTS:
            res = extract_pdf(path, max_pages=max_pages)
        elif ext in DOCX_EXTS:
            res = extract_docx(path)
        elif ext in XLSX_EXTS:
            res = extract_excel(path)
        elif ext in PPTX_EXTS:
            res = extract_pptx(path)
        elif ext in ARCHIVE_EXTS:
            res = extract_zip(path)
        elif ext in TEXT_EXTS:
            with open(path, "rb") as f:
                raw = f.read()
            text = raw.decode("utf-8", "replace").replace("\x00", "").strip()
            wc = len(re.findall(r"\S+", text))
            res = {"ok": True, "type": "text", "text": text, "has_text": wc >= 1,
                   "word_count": wc, "confidence": 100, "engine": "text", "meta": {},
                   "reason": "" if wc else "empty"}
        else:
            # Unknown → try to read as UTF-8 text.
            try:
                with open(path, "rb") as f:
                    raw = f.read()
                text = raw.decode("utf-8", "replace").replace("\x00", "").strip()
                wc = len(re.findall(r"\S+", text))
                res = {"ok": True, "type": "text", "text": text, "has_text": wc >= 1,
                       "word_count": wc, "confidence": 100, "engine": "text", "meta": {},
                       "reason": "" if wc else "empty"}
            except Exception as e:
                res = {"ok": False, "reason": "unsupported-type: %s" % e}
    except Exception as e:
        res = {"ok": False, "reason": "fatal: %s" % e}

    # In classify mode we only need has_text + a short preview (keeps payload small).
    if mode == "classify" and res.get("ok"):
        preview = (res.get("text") or "")[:400]
        res = {"ok": True, "type": res.get("type"), "has_text": res.get("has_text", False),
               "word_count": res.get("word_count", 0), "confidence": res.get("confidence", 0),
               "engine": res.get("engine"), "text": preview, "reason": res.get("reason", "")}

    _emit(res)


if __name__ == "__main__":
    main()
