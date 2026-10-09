#!/usr/bin/env python3
"""documents_tool.py — Enterprise document processing engine.

Uses LibreOffice for rock-solid format conversion (PDF↔DOCX↔PPTX↔XLSX↔HTML↔ODT↔ODP↔TXT)
and Python libraries for precise editing/generation:
  - python-docx: DOCX create/edit (tables, images, styles, headers, footers)
  - python-pptx: PPTX create/edit (slides, charts, images, notes)
  - openpyxl: XLSX create/edit (formulas, charts, styles, data validation)
  - PyMuPDF (fitz): PDF read/extract/merge/split
  - weasyprint: HTML→PDF with CSS
  - reportlab: PDF generation from scratch
  - markdown: MD→HTML conversion
  - csv: CSV read/write

Supports every conversion LibreOffice supports (100+ formats).
"""

import os
import sys
import json
import re
import csv
import io
import subprocess
import traceback
import tempfile
import shutil
from datetime import datetime
from pathlib import Path


def run(ctx, args):
    action = args.get("action", "convert")
    input_path = args.get("input_path", "")
    output_path = args.get("output_path", "")
    output_format = args.get("output_format", "")

    if action == "convert":
        return _convert(ctx, input_path, output_path, output_format)
    elif action == "generate":
        return _generate(ctx, args)
    elif action == "edit":
        return _edit(ctx, args)
    elif action == "inspect":
        return _inspect(ctx, input_path)
    elif action == "merge":
        return _merge(ctx, args)
    elif action == "split":
        return _split(ctx, args)
    elif action == "extract_text":
        return _extract_text(ctx, input_path)
    else:
        return {"error": f"Unknown action: {action}"}


# ── LibreOffice Conversion ────────────────────────────────────────────────────
def _convert(ctx, input_path, output_path, output_format):
    if not input_path:
        return {"error": "No input_path provided"}

    abspath = ctx._resolve(input_path)
    if not os.path.isfile(abspath):
        return {"error": f"Input file not found: {input_path}"}

    # Determine output format
    if not output_format and not output_path:
        return {"error": "Provide either output_format or output_path"}

    if not output_format and output_path:
        ext = os.path.splitext(output_path)[1].lower().lstrip(".")
        output_format = ext

    if not output_path:
        base = os.path.splitext(input_path)[0]
        output_path = f"{base}.{output_format}"

    output_abspath = ctx._resolve(output_path)
    os.makedirs(os.path.dirname(output_abspath), exist_ok=True)

    # Text-like sources bound for PDF must bypass LibreOffice/WeasyPrint: those
    # converters preserve LaTeX as plain text. Use the shared math-aware engine
    # before any provider-dependent conversion path.
    ext = os.path.splitext(input_path)[1].lower()
    if output_format.lower() == "pdf" and ext in (".md", ".markdown", ".txt", ".tex", ".latex", ".html", ".htm"):
        with open(abspath, "r", encoding="utf-8", errors="replace") as f:
            source = f.read()
        if ext in (".html", ".htm"):
            source = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", source)
            source = re.sub(r"(?is)<h1[^>]*>(.*?)</h1>", r"\n# \1\n", source)
            source = re.sub(r"(?is)<h2[^>]*>(.*?)</h2>", r"\n## \1\n", source)
            source = re.sub(r"(?is)<h3[^>]*>(.*?)</h3>", r"\n### \1\n", source)
            source = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>", "\n", source)
            source = re.sub(r"(?s)<[^>]+>", "", source)
            source = source.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
        return _render_shared_pdf(output_abspath, output_path, "", source)

    # Use LibreOffice for conversion
    try:
        cmd = [
            "libreoffice", "--headless", "--convert-to", output_format,
            "--outdir", os.path.dirname(output_abspath),
            abspath,
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=120,
            env={**os.environ, "HOME": os.path.expanduser("~")},
        )

        # LibreOffice names files with the output format extension
        lo_output = os.path.join(
            os.path.dirname(output_abspath),
            os.path.basename(os.path.splitext(input_path)[0]) + "." + output_format
        )
        if os.path.isfile(lo_output) and lo_output != output_abspath:
            shutil.move(lo_output, output_abspath)

        if os.path.isfile(output_abspath):
            stat = os.stat(output_abspath)
            return {
                "action": "converted",
                "input": input_path,
                "output": output_path,
                "format": output_format,
                "size": stat.st_size,
                "stdout": result.stdout[:2000],
                "stderr": result.stderr[:1000],
            }
        else:
            return {
                "action": "conversion_failed",
                "input": input_path,
                "output_format": output_format,
                "stdout": result.stdout[:2000],
                "stderr": result.stderr[:2000],
                "error": "LibreOffice did not produce output file",
            }
    except subprocess.TimeoutExpired:
        return {"error": "LibreOffice conversion timed out after 120s"}
    except FileNotFoundError:
        # LibreOffice not installed — try Python fallback
        return _convert_fallback(ctx, abspath, output_abspath, input_path, output_path, output_format)
    except Exception as e:
        return {"error": str(e)}


def _convert_fallback(ctx, abspath, output_abspath, input_path, output_path, output_format):
    ext = os.path.splitext(input_path)[1].lower()
    try:
        if ext == ".md" and output_format in ("html", "pdf"):
            md_text = open(abspath, "r", encoding="utf-8").read()
            if output_format == "html":
                import markdown
                html = markdown.markdown(md_text, extensions=["extra", "codehilite", "tables"])
                with open(output_abspath, "w", encoding="utf-8") as f:
                    f.write(html)
            elif output_format == "pdf":
                return _render_shared_pdf(output_abspath, output_path, "", md_text)

        elif ext == ".html" and output_format == "pdf":
            try:
                from weasyprint import HTML
                HTML(filename=abspath).write_pdf(output_abspath)
            except ImportError:
                return {"error": "weasyprint not available for HTML→PDF"}

        elif ext == ".csv" and output_format in ("xlsx", "xls"):
            import openpyxl
            wb = openpyxl.Workbook()
            ws = wb.active
            with open(abspath, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                for row in reader:
                    ws.append(row)
            wb.save(output_abspath)

        elif ext in (".xlsx", ".xls") and output_format == "csv":
            import openpyxl
            wb = openpyxl.load_workbook(abspath, data_only=True)
            ws = wb.active
            with open(output_abspath, "w", encoding="utf-8", newline="") as f:
                writer = csv.writer(f)
                for row in ws.iter_rows(values_only=True):
                    writer.writerow(row)

        elif ext == ".txt" and output_format == "html":
            with open(abspath, "r", encoding="utf-8") as f:
                text = f.read()
            html = f"<html><body><pre>{text}</pre></body></html>"
            with open(output_abspath, "w", encoding="utf-8") as f:
                f.write(html)

        else:
            return {"error": f"Fallback conversion not available for {ext}→{output_format}. Install LibreOffice or the appropriate Python library"}

        if os.path.isfile(output_abspath):
            stat = os.stat(output_abspath)
            return {
                "action": "converted",
                "input": input_path,
                "output": output_path,
                "format": output_format,
                "size": stat.st_size,
                "method": "python_fallback",
            }
        return {"error": "Fallback conversion failed to produce output"}
    except Exception as e:
        return {"error": f"Fallback conversion error: {e}"}


# ── Document Generation ───────────────────────────────────────────────────────
def _generate(ctx, args):
    output_path = args.get("output_path", "output.docx")
    output_format = args.get("output_format", "")
    title = args.get("title", "Document")
    content = args.get("content", "")
    data = args.get("data", {})
    slides = args.get("slides", [])

    output_abspath = ctx._resolve(output_path)
    os.makedirs(os.path.dirname(output_abspath), exist_ok=True)

    if not output_format:
        output_format = os.path.splitext(output_path)[1].lower().lstrip(".")

    try:
        if output_format in ("docx",):
            return _generate_docx(output_abspath, output_path, title, content, args)
        elif output_format in ("pptx",):
            return _generate_pptx(output_abspath, output_path, title, slides, args)
        elif output_format in ("xlsx", "xls"):
            return _generate_xlsx(output_abspath, output_path, data, args)
        elif output_format == "pdf":
            return _generate_pdf(output_abspath, output_path, title, content, args)
        elif output_format in ("html", "htm"):
            with open(output_abspath, "w", encoding="utf-8") as f:
                f.write(f"<!DOCTYPE html><html><head><title>{title}</title></head><body>{content}</body></html>")
            return {"action": "generated", "output": output_path, "format": "html", "size": os.path.getsize(output_abspath)}
        elif output_format == "md":
            with open(output_abspath, "w", encoding="utf-8") as f:
                f.write(content or f"# {title}\n\n")
            return {"action": "generated", "output": output_path, "format": "md", "size": os.path.getsize(output_abspath)}
        elif output_format == "txt":
            with open(output_abspath, "w", encoding="utf-8") as f:
                f.write(content or title)
            return {"action": "generated", "output": output_path, "format": "txt", "size": os.path.getsize(output_abspath)}
        else:
            # Try LibreOffice: generate a DOCX first then convert
            docx_path = output_abspath + ".docx"
            r = _generate_docx(docx_path, output_path, title, content, args)
            if "error" in r:
                return r
            return _convert(ctx, output_path + ".docx", output_path, output_format)
    except Exception as e:
        return {"error": f"Generation error: {e}"}


def _generate_docx(abspath, relpath, title, content, args):
    try:
        from docx import Document
        from docx.shared import Inches, Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.enum.table import WD_TABLE_ALIGNMENT
    except ImportError:
        return {"error": "python-docx not installed. Run: pip install python-docx"}

    doc = Document()
    doc.add_heading(title, 0)

    # Add content with markdown-like formatting
    if content:
        for line in content.split("\n"):
            if line.startswith("# "):
                doc.add_heading(line[2:], 1)
            elif line.startswith("## "):
                doc.add_heading(line[3:], 2)
            elif line.startswith("### "):
                doc.add_heading(line[4:], 3)
            elif line.startswith("- "):
                doc.add_paragraph(line[2:], style="List Bullet")
            elif line.startswith("|") and "|" in line:
                # Simple table
                pass
            elif line.strip():
                doc.add_paragraph(line)

    # Add tables from data
    data = args.get("data", {})
    if data and "rows" in data:
        rows = data["rows"]
        columns = data.get("columns", [])
        if columns:
            table = doc.add_table(rows=1 + len(rows), cols=len(columns))
            table.style = "Table Grid"
            for i, col in enumerate(columns):
                table.cell(0, i).text = str(col)
            for i, row in enumerate(rows):
                for j, val in enumerate(row):
                    table.cell(i + 1, j).text = str(val)

    doc.save(abspath)
    return {"action": "generated", "output": relpath, "format": "docx", "size": os.path.getsize(abspath)}


def _generate_pptx(abspath, relpath, title, slides, args):
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt, Emu
        from pptx.dml.color import RGBColor
        from pptx.enum.text import PP_ALIGN
    except ImportError:
        return {"error": "python-pptx not installed. Run: pip install python-pptx"}

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    if not slides:
        slides = [{"title": title, "content": args.get("content", "")}]

    for slide_data in slides:
        slide_layout = prs.slide_layouts[1]  # Title and Content
        slide = prs.slides.add_slide(slide_layout)
        slide.shapes.title.text = slide_data.get("title", "")

        content_text = slide_data.get("content", "")
        bullets = slide_data.get("bullets", [])
        body = slide.placeholders[1]

        if bullets:
            text_frame = body.text_frame
            for i, bullet in enumerate(bullets):
                if i == 0:
                    text_frame.text = bullet
                else:
                    p = text_frame.add_paragraph()
                    p.text = bullet
                    p.level = 0
        elif content_text:
            body.text = content_text

    prs.save(abspath)
    return {"action": "generated", "output": relpath, "format": "pptx", "size": os.path.getsize(abspath), "slides": len(slides)}


def _generate_xlsx(abspath, relpath, data, args):
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    except ImportError:
        return {"error": "openpyxl not installed. Run: pip install openpyxl"}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = args.get("sheet_name", "Sheet1")

    data = data or {}
    rows = data.get("rows", [])
    columns = data.get("columns", [])

    if columns:
        # Header row with styling
        header_font = Font(bold=True, color="FFFFFF")
        header_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
        for i, col in enumerate(columns):
            cell = ws.cell(row=1, column=i + 1, value=col)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center")

    for i, row in enumerate(rows):
        for j, val in enumerate(row):
            ws.cell(row=i + 2, column=j + 1, value=val)

    # Auto-adjust column widths
    for col in ws.columns:
        max_length = 0
        col_letter = col[0].column_letter
        for cell in col:
            try:
                if cell.value:
                    max_length = max(max_length, len(str(cell.value)))
            except Exception:
                pass
        ws.column_dimensions[col_letter].width = min(max_length + 2, 50)

    wb.save(abspath)
    return {"action": "generated", "output": relpath, "format": "xlsx", "size": os.path.getsize(abspath), "rows": len(rows), "columns": len(columns)}


def _render_shared_pdf(abspath, relpath, title, content):
    """Use the worker's validated Markdown/LaTeX renderer for every PDF path.

    documents_tool.py lives under agent/tools/documents while latex_render.py
    is deployed beside agent.py. Importing through that shared worker directory
    keeps Novita, Upstash, create_pdf, convert_file, and documents.generate on
    one deterministic rendering implementation.
    """
    worker_dir = str(Path(__file__).resolve().parents[2])
    if worker_dir not in sys.path:
        sys.path.insert(0, worker_dir)
    try:
        import latex_render
        size = latex_render.build_pdf(content or "", abspath, title=title or "")
        return {"action": "generated", "output": relpath, "format": "pdf",
                "size": size, "method": "latex_render"}
    except Exception as e:
        return {"error": f"Validated PDF rendering failed: {e}"}


def _generate_pdf(abspath, relpath, title, content, args):
    # Always use the same offline, math-aware, raw-LaTeX-safe renderer as the
    # dedicated create_pdf tool. ReportLab's Paragraph path printed commands
    # such as \\frac and \\int verbatim and therefore cannot be a PDF fallback.
    return _render_shared_pdf(abspath, relpath, title, content)


def _generate_pdf_reportlab_legacy(abspath, relpath, title, content, args):
    """Retained only for non-production reference; PDF dispatch never calls it."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import inch, mm
        from reportlab.lib.colors import HexColor
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
        from reportlab.lib import colors
    except ImportError:
        # Try weasyprint
        try:
            from weasyprint import HTML
            html = f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>{title}</title></head><body><h1>{title}</h1><pre>{content}</pre></body></html>"
            HTML(string=html).write_pdf(abspath)
            return {"action": "generated", "output": relpath, "format": "pdf", "size": os.path.getsize(abspath), "method": "weasyprint"}
        except ImportError:
            return {"error": "Neither reportlab nor weasyprint available. Install one: pip install reportlab or pip install weasyprint"}

    doc = SimpleDocTemplate(abspath, pagesize=A4,
                            leftMargin=2 * cm, rightMargin=2 * cm,
                            topMargin=2 * cm, bottomMargin=2 * cm)
    styles = getSampleStyleSheet()
    story = []

    story.append(Paragraph(title, styles["Title"]))
    story.append(Spacer(1, 12))

    if content:
        for line in content.split("\n"):
            if line.strip():
                story.append(Paragraph(line, styles["Normal"]))
                story.append(Spacer(1, 6))

    doc.build(story)
    return {"action": "generated", "output": relpath, "format": "pdf", "size": os.path.getsize(abspath), "method": "reportlab"}


# ── Document Editing ──────────────────────────────────────────────────────────
def _edit(ctx, args):
    input_path = args.get("input_path", "")
    output_path = args.get("output_path", input_path)
    replacements = args.get("replacements", {})
    content = args.get("content", "")

    if not input_path:
        return {"error": "No input_path provided"}

    abspath = ctx._resolve(input_path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {input_path}"}

    ext = os.path.splitext(input_path)[1].lower()
    changes = 0

    try:
        if ext == ".docx":
            from docx import Document
            doc = Document(abspath)
            for para in doc.paragraphs:
                for old, new in replacements.items():
                    if old in para.text:
                        for run in para.runs:
                            if old in run.text:
                                run.text = run.text.replace(old, new)
                                changes += 1
            if content:
                doc.add_paragraph(content)
            doc.save(ctx._resolve(output_path))
            return {"action": "edited", "output": output_path, "changes": changes, "format": "docx"}

        elif ext == ".xlsx":
            import openpyxl
            wb = openpyxl.load_workbook(abspath)
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                for row in ws.iter_rows():
                    for cell in row:
                        if cell.value and isinstance(cell.value, str):
                            for old, new in replacements.items():
                                if old in cell.value:
                                    cell.value = cell.value.replace(old, new)
                                    changes += 1
            if content:
                ws = wb.active
                for line in content.split("\n"):
                    ws.append([line])
            wb.save(ctx._resolve(output_path))
            return {"action": "edited", "output": output_path, "changes": changes, "format": "xlsx"}

        elif ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(abspath)
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        for para in shape.text_frame.paragraphs:
                            for run in para.runs:
                                for old, new in replacements.items():
                                    if old in run.text:
                                        run.text = run.text.replace(old, new)
                                        changes += 1
            prs.save(ctx._resolve(output_path))
            return {"action": "edited", "output": output_path, "changes": changes, "format": "pptx"}

        elif ext == ".pdf":
            try:
                import fitz
                doc = fitz.open(abspath)
                for page in doc:
                    for old, new in replacements.items():
                        text_instances = page.search_for(old)
                        for inst in text_instances:
                            page.add_redact_annot(inst, fill=(1, 1, 1))
                            page.apply_redactions()
                            page.insert_text(inst[:2], new, fontsize=11)
                            changes += 1
                doc.save(ctx._resolve(output_path))
                doc.close()
                return {"action": "edited", "output": output_path, "changes": changes, "format": "pdf"}
            except ImportError:
                return {"error": "PyMuPDF (fitz) not available for PDF editing. Install: pip install PyMuPDF"}

        else:
            # Text file editing
            with open(abspath, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            for old, new in replacements.items():
                c = text.count(old)
                if c:
                    text = text.replace(old, new)
                    changes += c
            if content:
                text += "\n" + content
            with open(ctx._resolve(output_path), "w", encoding="utf-8") as f:
                f.write(text)
            return {"action": "edited", "output": output_path, "changes": changes, "format": ext.lstrip(".")}

    except Exception as e:
        return {"error": f"Edit error: {e}"}


# ── Document Inspection ───────────────────────────────────────────────────────
def _inspect(ctx, input_path):
    if not input_path:
        return {"error": "No input_path provided"}

    abspath = ctx._resolve(input_path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {input_path}"}

    ext = os.path.splitext(input_path)[1].lower()
    stat = os.stat(abspath)
    info = {
        "path": input_path,
        "size": stat.st_size,
        "extension": ext,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
    }

    try:
        if ext == ".pdf":
            try:
                import fitz
                doc = fitz.open(abspath)
                info["pages"] = len(doc)
                info["metadata"] = doc.metadata
                # Extract text sample
                text = ""
                for i, page in enumerate(doc):
                    text += page.get_text()[:2000]
                    if i >= 5:
                        break
                info["text_sample"] = text[:3000]
                doc.close()
            except ImportError:
                info["pages"] = "unknown (PyMuPDF not installed)"

        elif ext == ".docx":
            from docx import Document
            doc = Document(abspath)
            info["paragraphs"] = len(doc.paragraphs)
            info["tables"] = len(doc.tables)
            info["text_sample"] = "\n".join(p.text for p in doc.paragraphs[:20])[:3000]

        elif ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(abspath)
            info["slides"] = len(prs.slides)
            info["slide_width"] = str(prs.slide_width)
            info["slide_height"] = str(prs.slide_height)
            info["text_sample"] = "\n".join(
                shape.text for slide in prs.slides[:5]
                for shape in slide.shapes if shape.has_text_frame
            )[:2000]

        elif ext in (".xlsx", ".xls"):
            import openpyxl
            wb = openpyxl.load_workbook(abspath, data_only=True)
            info["sheets"] = wb.sheetnames
            info["sheet_count"] = len(wb.sheetnames)
            ws = wb.active
            info["rows"] = ws.max_row
            info["columns"] = ws.max_column
            # Sample data
            sample = []
            for i, row in enumerate(ws.iter_rows(values_only=True)):
                if i > 10:
                    break
                sample.append([str(c)[:50] if c else "" for c in row])
            info["data_sample"] = sample

        elif ext in (".html", ".htm"):
            with open(abspath, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            info["length"] = len(text)
            info["text_sample"] = text[:2000]

        elif ext == ".md":
            with open(abspath, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
            info["length"] = len(text)
            info["lines"] = text.count("\n") + 1
            info["text_sample"] = text[:2000]

        else:
            with open(abspath, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(5000)
            info["length"] = len(text)
            info["text_sample"] = text[:2000]

    except Exception as e:
        info["inspect_error"] = str(e)

    return {"action": "inspected", "info": info}


# ── Merge ─────────────────────────────────────────────────────────────────────
def _merge(ctx, args):
    files = args.get("files", [])
    output_path = args.get("output_path", "merged.pdf")

    if not files:
        return {"error": "No files provided for merge"}

    output_abspath = ctx._resolve(output_path)
    os.makedirs(os.path.dirname(output_abspath), exist_ok=True)

    try:
        import fitz
        merged = fitz.open()
        for f in files:
            abspath = ctx._resolve(f)
            if os.path.isfile(abspath):
                doc = fitz.open(abspath)
                merged.insert_pdf(doc)
                doc.close()
        merged.save(output_abspath)
        merged.close()
        return {"action": "merged", "output": output_path, "files": len(files), "size": os.path.getsize(output_abspath)}
    except ImportError:
        # Fallback: use pdftk or Ghostscript
        pass
    except Exception as e:
        return {"error": f"Merge error: {e}"}

    return {"error": "PyMuPDF not available for merge. Install: pip install PyMuPDF"}


# ── Split ─────────────────────────────────────────────────────────────────────
def _split(ctx, args):
    input_path = args.get("input_path", "")
    output_path = args.get("output_path", "")
    start_page = int(args.get("start_page", 1))
    end_page = args.get("end_page")

    if not input_path:
        return {"error": "No input_path provided"}

    abspath = ctx._resolve(input_path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {input_path}"}

    if not output_path:
        base = os.path.splitext(input_path)[0]
        ext = os.path.splitext(input_path)[1]
        output_path = f"{base}_split{ext}"

    output_abspath = ctx._resolve(output_path)
    os.makedirs(os.path.dirname(output_abspath), exist_ok=True)

    try:
        import fitz
        doc = fitz.open(abspath)
        total = len(doc)
        end = int(end_page) if end_page else total

        if start_page < 1 or end > total:
            return {"error": f"Page range {start_page}-{end} out of bounds (1-{total})"}

        new_doc = fitz.open()
        new_doc.insert_pdf(doc, from_page=start_page - 1, to_page=end - 1)
        new_doc.save(output_abspath)
        new_doc.close()
        doc.close()

        return {"action": "split", "output": output_path, "pages": f"{start_page}-{end}", "total_pages": total, "size": os.path.getsize(output_abspath)}
    except ImportError:
        return {"error": "PyMuPDF not available for split. Install: pip install PyMuPDF"}
    except Exception as e:
        return {"error": f"Split error: {e}"}


# ── Extract Text ──────────────────────────────────────────────────────────────
def _extract_text(ctx, input_path):
    if not input_path:
        return {"error": "No input_path provided"}

    abspath = ctx._resolve(input_path)
    if not os.path.isfile(abspath):
        return {"error": f"File not found: {input_path}"}

    ext = os.path.splitext(input_path)[1].lower()
    text = ""

    try:
        if ext == ".pdf":
            try:
                import fitz
                doc = fitz.open(abspath)
                for page in doc:
                    text += page.get_text()
                doc.close()
            except ImportError:
                # Try pdftotext
                result = subprocess.run(["pdftotext", abspath, "-"], capture_output=True, text=True, timeout=30)
                text = result.stdout

        elif ext == ".docx":
            from docx import Document
            doc = Document(abspath)
            text = "\n".join(p.text for p in doc.paragraphs)

        elif ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(abspath)
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        text += shape.text + "\n"

        elif ext in (".xlsx", ".xls"):
            import openpyxl
            wb = openpyxl.load_workbook(abspath, data_only=True)
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                text += f"\n=== {sheet_name} ===\n"
                for row in ws.iter_rows(values_only=True):
                    text += "\t".join(str(c) if c else "" for c in row) + "\n"

        else:
            with open(abspath, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()

        return {"action": "extracted", "text": text[:50000], "length": len(text), "truncated": len(text) > 50000}

    except Exception as e:
        return {"error": f"Extract error: {e}"}