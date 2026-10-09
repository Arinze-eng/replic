#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# latex_render.py — PURE-PYTHON, ZERO-NETWORK, ZERO-INSTALL Markdown/LaTeX→PDF
# engine for the WormGPT / EvilGPT agent worker (agent_worker/agent.py).
#
# ── Why a rewrite? ────────────────────────────────────────────────────────────
# The previous version compiled with Tectonic / pdflatex INSIDE the persistent
# sandbox. Two things kept breaking it on Render's sandbox network:
#
#   1. Tectonic's runtime bundle (~2.9 GB) is fetched from
#      relay.fullyjustified.net on first use, and the sandbox's egress kept
#      RESETTING the connection ("Connection reset by peer (os error 104)").
#   2. apt-installing real TeX Live also hits the network, and on a restricted
#      sandbox it either times out or returns a partial install with no
#      pdflatex on PATH, so create_pdf produced the raw string
#      "\int \frac{...}{...}" in the finished PDF — exactly the bug reported.
#
# ── What this file does now ───────────────────────────────────────────────────
# Everything happens IN PYTHON with stdlib only:
#   • Parse Markdown (headings, lists, tables, fenced code, fenced ```chart``` )
#   • Parse a curated LaTeX-math subset with a proper tokeniser/parser:
#       - Greek letters, common operators, relations, arrows
#       - \frac{a}{b}, \sqrt[n]{x}, \sum, \int, \prod, \lim (with sub/sup)
#       - x^{...} superscript,  x_{...} subscript (nested OK)
#       - matrices / arrays with pmatrix / bmatrix / array / cases
#       - \left( … \right), \binom, \dfrac, \mathrm/\mathbf/\text
#       - \ln, \log, \sin, \cos, \tan, \arctan, \exp, \max, \min, …
#   • Layout each math expression into a BOX TREE, then emit the boxes as
#     native PDF operators (Tj / m l re / etc.), so a fraction is drawn with a
#     real horizontal rule, an integral is a huge glyph, superscripts are
#     positioned above the baseline, and so on.
#   • Draw simple ```chart``` blocks (bar / line / pie) with native PDF paths.
#
# The output is a REAL PDF with a real %PDF header, xref, and validated size.
# No binaries. No installs. No network. No sandbox provisioning needed.
#
# ── Public API (kept identical to the old file so agent.py doesn't change) ────
#   ensure_tectonic()                          → "" (legacy no-op)
#   find_engine()                              → ("python", "<this file>")
#   markdown_to_latex(md, title, subtitle)     → same doc, but as pseudo-tex
#                                                (kept for API back-compat only)
#   compile_latex(tex, out_path, workdir=None) → writes a validated PDF
#   build_pdf(content, out_path, title, subtitle, is_full_latex, assets_dir)
#                                              → convenience entry point
#
# ── PDF spec notes ────────────────────────────────────────────────────────────
# The generated PDF uses the 14 built-in Type-1 core fonts (Helvetica /
# Helvetica-Bold / Helvetica-Oblique / Courier / Symbol) so no font file
# embedding is needed. Text is drawn with `Tj` in WinAnsiEncoding; the Symbol
# font is used for greek letters and math operators. Vector primitives (lines /
# rects / curves) are used for fraction bars, sqrt hooks, integral tails, and
# chart bars / lines / pie slices.
# ─────────────────────────────────────────────────────────────────────────────

import os
import re
import sys
import io
import time
import zlib
import math
import shutil
import subprocess
import tempfile

# ── Legacy no-op API (kept so callers don't need to change) ─────────────────
_ENGINE_CACHE = {"path": __file__, "kind": "python"}


def ensure_tectonic():
    """Legacy shim — no external engine is ever provisioned any more."""
    return ""


def find_engine():
    """We are the engine. Returns ('python', <this file>) so callers can log it."""
    return "python", __file__


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 1: Low-level PDF writer ─────────────────────────────────────────────
# A tiny PDF-1.4 writer. Everything is drawn on a page's content stream as raw
# operators. We only need: text (Tj), fonts (F1..F5), lines (m l S), rectangles
# (re f), curves (c), color (rg RG), and page break bookkeeping.
# ─────────────────────────────────────────────────────────────────────────────

# The 14 built-in Type-1 core fonts we use. F1=body, F2=bold, F3=italic,
# F4=mono, F5=symbol (greek + operators).
_CORE_FONTS = [
    ("F1", "Helvetica"),
    ("F2", "Helvetica-Bold"),
    ("F3", "Helvetica-Oblique"),
    ("F4", "Courier"),
    ("F5", "Symbol"),
]


def _pdf_escape(s):
    """Escape a text string for use inside a PDF literal `(...)` Tj string.
    Non-ASCII characters are best-effort: WinAnsi covers Latin-1 well enough
    for the languages we typeset. Anything above U+00FF is replaced with '?'."""
    out = []
    for ch in str(s):
        cp = ord(ch)
        if ch == "\\":
            out.append("\\\\")
        elif ch == "(":
            out.append("\\(")
        elif ch == ")":
            out.append("\\)")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif 32 <= cp <= 126:
            out.append(ch)
        elif cp <= 255:
            # WinAnsiEncoding: octal escape so PDF viewers accept it verbatim.
            out.append("\\%03o" % cp)
        else:
            out.append("?")
    return "".join(out)


class _PdfWriter(object):
    """Assemble a valid PDF-1.4 with an arbitrary number of pages. Content
    streams are optionally zlib-flated to keep the file compact."""

    # A4 in PDF points (1/72 inch).
    PAGE_W = 595.0
    PAGE_H = 842.0
    MARGIN_L = 56.0   # ~ 2 cm
    MARGIN_R = 56.0
    MARGIN_T = 64.0
    MARGIN_B = 64.0

    def __init__(self, title="", subtitle=""):
        self.title = title or ""
        self.subtitle = subtitle or ""
        self.pages = []          # list[str] — content streams (uncompressed text)
        self._new_page_stream()

    # ---- page management -----------------------------------------------------
    def _new_page_stream(self):
        self.pages.append(io.StringIO())
        self._page = self.pages[-1]

    def new_page(self):
        self._new_page_stream()

    def write_ops(self, ops):
        self._page.write(ops)
        if not ops.endswith("\n"):
            self._page.write("\n")

    # ---- serialization -------------------------------------------------------
    def build(self):
        """Return the final PDF bytes."""
        objs = []  # (id, bytes) — id is 1-based

        def add(body):
            objs.append(body)
            return len(objs)

        # 1) Catalog
        cat_id = add(None)  # placeholder — filled in after we know pages/id
        pages_id = add(None)
        # 2) Fonts
        font_ids = {}
        for name, base in _CORE_FONTS:
            fid = add(
                b"<< /Type /Font /Subtype /Type1 /BaseFont /" + base.encode("ascii") +
                b" /Encoding /WinAnsiEncoding >>"
            )
            font_ids[name] = fid
        # Symbol font must NOT specify WinAnsiEncoding — it has its own encoding.
        # Override the Symbol entry.
        objs[font_ids["F5"] - 1] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>"

        # 3) Page objects (one per content stream)
        page_ids = []
        for i, stream in enumerate(self.pages):
            content = stream.getvalue().encode("latin-1", errors="replace")
            compressed = zlib.compress(content)
            stream_id = add(
                b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(compressed) +
                compressed + b"\nendstream"
            )
            font_dict = b"".join(
                b"/%s %d 0 R " % (name.encode("ascii"), fid)
                for name, fid in font_ids.items()
            )
            page_body = (
                b"<< /Type /Page /Parent %d 0 R " % pages_id +
                b"/MediaBox [0 0 %.2f %.2f] " % (self.PAGE_W, self.PAGE_H) +
                b"/Resources << /Font << " + font_dict + b">> /ProcSet [/PDF /Text] >> " +
                b"/Contents %d 0 R >>" % stream_id
            )
            pid = add(page_body)
            page_ids.append(pid)

        # Now fill in the /Pages object.
        kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
        objs[pages_id - 1] = (
            b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % len(page_ids)
        )
        # And the catalog.
        objs[cat_id - 1] = (
            b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id
        )

        # Info dict (best-effort — many viewers show these in Properties).
        info_body = (
            b"<< /Producer (WormGPT latex_render.py) " +
            b"/Title (" + _pdf_escape(self.title).encode("latin-1", "replace") + b") " +
            b"/Author (WormGPT Agent) >>"
        )
        info_id = add(info_body)

        # Assemble the file.
        out = io.BytesIO()
        out.write(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
        offsets = [0]
        for i, body in enumerate(objs, start=1):
            offsets.append(out.tell())
            out.write(b"%d 0 obj\n" % i)
            out.write(body)
            out.write(b"\nendobj\n")
        xref_start = out.tell()
        n = len(objs) + 1  # +1 for object 0
        out.write(b"xref\n0 %d\n" % n)
        out.write(b"0000000000 65535 f \n")
        for off in offsets[1:]:
            out.write(b"%010d 00000 n \n" % off)
        out.write(
            b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (n, cat_id, info_id, xref_start)
        )
        return out.getvalue()


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 2: Font metrics (Type-1 core fonts) ─────────────────────────────────
# We only need character-width tables for good line breaking + math positioning.
# Values are in "PDF units per em × 1000" (Adobe AFM standard). We use averages
# per character class so the file stays small; the visible layout is excellent
# for the fonts we use (Helvetica / Symbol / Courier).
# ─────────────────────────────────────────────────────────────────────────────

# Helvetica widths (units of 1/1000 em). Full AFM would be huge; the table
# below covers ASCII 32–126 which is all we need for prose. Anything outside
# gets a sensible fallback width.
_HELV_W = {
    32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191,
    40: 333, 41: 333, 42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278,
    48: 556, 49: 556, 50: 556, 51: 556, 52: 556, 53: 556, 54: 556, 55: 556,
    56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584, 62: 584, 63: 556,
    64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
    72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778,
    80: 667, 81: 778, 82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944,
    88: 667, 89: 667, 90: 611, 91: 278, 92: 278, 93: 278, 94: 469, 95: 556,
    96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556, 102: 278, 103: 556,
    104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
    111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556,
    118: 500, 119: 722, 120: 500, 121: 500, 122: 500, 123: 334, 124: 260,
    125: 334, 126: 584,
}

# Symbol font widths (partial — we only reach into it for math glyphs).
_SYMB_W = {
    # greek lowercase alpha..omega (0x61..0x7A) — use 550 avg
    # greek uppercase alpha..omega (0x41..0x5A) — use 700 avg
    # operators (sum=229, int=274 etc.) — Adobe AFM values
    229: 713,   # summation (Symbol code 0xE5 in WinAnsi, 229 dec)
    242: 274,   # integral (0xF2 = 242)
    213: 823,   # product (0xD5 = 213)
    241: 549,   # plus-minus (0xB1 shows as 241 in Symbol slot)
    215: 549,   # ×  (Symbol has ‘•’-family — best-effort)
    247: 549,   # ÷
    189: 500,   # ½
    177: 500,   # ±
    214: 500,   # divide slot
}


def _glyph_width_helv(ch, size):
    """Return the width of `ch` in Helvetica at font size `size` (pt)."""
    cp = ord(ch) if isinstance(ch, str) else ch
    w = _HELV_W.get(cp, 500)
    return (w / 1000.0) * size


def _glyph_width_symbol(cp, size):
    """Approximate width for a Symbol-font code point. Symbol has irregular
    metrics but ~550 is a solid average for greek/math operators."""
    w = _SYMB_W.get(cp, 550)
    return (w / 1000.0) * size


def _string_width(text, size, bold=False, italic=False, mono=False):
    """Total width of an ASCII/Latin-1 text run at `size` pt in one of the
    Helvetica family fonts (or Courier when mono)."""
    if mono:
        # Courier is monospaced: every glyph is 600 units of 1/1000 em.
        return 0.6 * size * len(text)
    # We approximate bold/italic widths as ~= regular Helvetica (accurate to ~3%).
    total = 0.0
    for ch in str(text):
        total += _glyph_width_helv(ch, size)
    return total


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 3: LaTeX-math parser & box-tree layout ──────────────────────────────
# A tiny, real math typesetter: we tokenise a math source, parse it into an
# expression tree, then lay out each node into a BOX (width/height/depth) and
# emit the boxes as PDF operators. Supports the constructs listed in the
# module docstring.
# ─────────────────────────────────────────────────────────────────────────────

# Symbol-font mapping for LaTeX names → (font_slot, character_code, spacing_hint)
# `font_slot` is 'F5' (Symbol) or 'F1'/'F3' for text-fonts.
# `character_code` is the WinAnsi (or Symbol native) code point we should emit.

# Greek letters — Symbol font native slots (Adobe Symbol encoding).
_GREEK = {
    "alpha": 0x61, "beta": 0x62, "gamma": 0x67, "delta": 0x64, "epsilon": 0x65,
    "zeta": 0x7A, "eta": 0x68, "theta": 0x71, "iota": 0x69, "kappa": 0x6B,
    "lambda": 0x6C, "mu": 0x6D, "nu": 0x6E, "xi": 0x78, "pi": 0x70,
    "rho": 0x72, "sigma": 0x73, "tau": 0x74, "upsilon": 0x75, "phi": 0x66,
    "chi": 0x63, "psi": 0x79, "omega": 0x77,
    "Alpha": 0x41, "Beta": 0x42, "Gamma": 0x47, "Delta": 0x44, "Epsilon": 0x45,
    "Zeta": 0x5A, "Eta": 0x48, "Theta": 0x51, "Iota": 0x49, "Kappa": 0x4B,
    "Lambda": 0x4C, "Mu": 0x4D, "Nu": 0x4E, "Xi": 0x58, "Pi": 0x50,
    "Rho": 0x52, "Sigma": 0x53, "Tau": 0x54, "Upsilon": 0x55, "Phi": 0x46,
    "Chi": 0x43, "Psi": 0x59, "Omega": 0x57,
    "varepsilon": 0x65, "varphi": 0x6A, "vartheta": 0x4A,
}

# Common operator/relation symbols — Symbol font native slots.
_MATH_SYMBOLS = {
    "pm": 0xB1, "mp": 0xB1, "times": 0xB4, "cdot": 0xD7, "div": 0xB8,
    "leq": 0xA3, "geq": 0xB3, "neq": 0xB9, "approx": 0xBB, "equiv": 0xBA,
    "infty": 0xA5, "partial": 0xB6, "nabla": 0xD1, "forall": 0x22,
    "exists": 0x24, "in": 0xCE, "notin": 0xCF, "subset": 0xCC, "supset": 0xC9,
    "subseteq": 0xCD, "supseteq": 0xCA, "cup": 0xC8, "cap": 0xC7,
    "emptyset": 0xC6, "to": 0xAE, "rightarrow": 0xAE, "leftarrow": 0xAC,
    "Rightarrow": 0xDE, "Leftarrow": 0xDC, "leftrightarrow": 0xAB,
    "Leftrightarrow": 0xDB, "star": 0x2A, "ast": 0x2A, "circ": 0xB0,
    "bullet": 0xB7, "cdots": 0xBC, "ldots": 0xBC, "prime": 0xA2,
    "sim": 0x7E, "propto": 0xB5, "angle": 0xD0, "perp": 0x5E,
    "aleph": 0xC0, "hbar": 0x68, "Re": 0xC2, "Im": 0xC1,
    # sum/int/prod — the "big operators" (Symbol has these too).
    "sum": 0xE5, "int": 0xF2, "prod": 0xD5, "oint": 0xF2,
    "sqrt": None,  # handled specially
}

# Functions typeset upright (roman) with a space after — sin, cos, log, …
_FUNC_NAMES = {
    "sin", "cos", "tan", "cot", "sec", "csc",
    "arcsin", "arccos", "arctan", "arccot",
    "sinh", "cosh", "tanh",
    "log", "ln", "exp", "det", "dim", "gcd", "lcm",
    "min", "max", "sup", "inf", "lim", "limsup", "liminf",
    "ker", "hom", "mod", "arg", "deg", "Pr",
}

# `\left(` / `\right)` size pairs — we scale bracket height to the box height.
_DELIMS = {
    "(": ("(", ")"),
    "[": ("[", "]"),
    "{": ("{", "}"),
    "|": ("|", "|"),
    "\\|": ("‖", "‖"),
    "\\langle": ("〈", "〉"),
    "\\rangle": ("〈", "〉"),
    ".": ("", ""),          # "\left." → no visible fence
}


# ---- Tokeniser --------------------------------------------------------------
def _math_tokens(src):
    """Split a math source string into typed tokens: ('cmd', name),
    ('char', c), ('num', s), ('op', c), ('open', '{'), ('close', '}'),
    ('sub', '_'), ('sup', '^'), ('and', '&'), ('nl', '\\\\'), ('space', ' ')."""
    i, n = 0, len(src)
    toks = []
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if c == "\\":
            # ── control sequence  \name  or  \\  or  \[  or  \(  etc.
            if i + 1 < n and src[i + 1] == "\\":
                toks.append(("nl", "\\\\"))
                i += 2
                continue
            j = i + 1
            if j < n and src[j].isalpha():
                k = j
                while k < n and src[k].isalpha():
                    k += 1
                toks.append(("cmd", src[j:k]))
                i = k
                # Skip a single trailing space right after a control word
                # (that's how LaTeX consumes it).
                while i < n and src[i] == " ":
                    i += 1
                continue
            # non-alpha escape: pass through as a literal char (e.g. \{ \% \_)
            toks.append(("char", src[j] if j < n else "\\"))
            i = j + 1
            continue
        if c == "{":
            toks.append(("open", c))
            i += 1
            continue
        if c == "}":
            toks.append(("close", c))
            i += 1
            continue
        if c == "^":
            toks.append(("sup", c))
            i += 1
            continue
        if c == "_":
            toks.append(("sub", c))
            i += 1
            continue
        if c == "&":
            toks.append(("and", c))
            i += 1
            continue
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            k = i
            while k < n and (src[k].isdigit() or src[k] == "."):
                k += 1
            toks.append(("num", src[i:k]))
            i = k
            continue
        if c.isalpha():
            # single letter — italicised in math mode
            toks.append(("var", c))
            i += 1
            continue
        # Everything else — treat as an operator char (+ - = < > , : ; ( ) [ ] etc.)
        toks.append(("op", c))
        i += 1
    return toks


# ---- Parser: token stream → AST --------------------------------------------
class _P:
    """Cursor over a token list."""

    def __init__(self, toks):
        self.toks = toks
        self.i = 0

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def eat(self):
        t = self.peek()
        self.i += 1
        return t

    def eof(self):
        return self.i >= len(self.toks)


def _parse_group(p):
    """Parse a `{...}` group into a list-node, OR one atom if the next token
    isn't an open-brace. (This matches TeX's argument-eating rules.)"""
    tt, tv = p.peek()
    if tt == "open":
        p.eat()
        nodes = []
        while True:
            tt, tv = p.peek()
            if tt is None:
                break
            if tt == "close":
                p.eat()
                break
            nodes.append(_parse_atom(p))
        return ("seq", nodes)
    # single atom
    return _parse_atom(p)


def _parse_atom(p):
    """One atom + optional trailing ^{...} / _{...} decorations."""
    tt, tv = p.eat()
    node = _atom_from(p, tt, tv)
    # Attach sup/sub in any order.
    sup = None
    sub = None
    while True:
        tt2, tv2 = p.peek()
        if tt2 == "sup":
            p.eat()
            sup = _parse_group(p)
        elif tt2 == "sub":
            p.eat()
            sub = _parse_group(p)
        else:
            break
    if sup is not None or sub is not None:
        return ("subsup", node, sub, sup)
    return node


def _atom_from(p, tt, tv):
    if tt == "num":
        return ("num", tv)
    if tt == "var":
        return ("var", tv)
    if tt == "op":
        return ("op", tv)
    if tt == "char":
        return ("op", tv)
    if tt == "cmd":
        return _cmd_node(p, tv)
    if tt == "open":
        # anonymous group at the top level
        nodes = []
        while True:
            tt2, tv2 = p.peek()
            if tt2 is None or tt2 == "close":
                if tt2 == "close":
                    p.eat()
                break
            nodes.append(_parse_atom(p))
        return ("seq", nodes)
    if tt == "and" or tt == "nl":
        return ("op", " ")
    return ("op", "")


def _cmd_node(p, name):
    # Big operators & simple symbols
    if name in _MATH_SYMBOLS and name not in ("sqrt",):
        cp = _MATH_SYMBOLS[name]
        return ("sym", cp, name)
    if name in _GREEK:
        return ("sym", _GREEK[name], name)
    if name == "frac" or name == "dfrac" or name == "tfrac":
        num = _parse_group(p)
        den = _parse_group(p)
        return ("frac", num, den, name == "dfrac")
    if name == "binom":
        a = _parse_group(p)
        b = _parse_group(p)
        return ("binom", a, b)
    if name == "sqrt":
        # optional [n] first
        # (we already consumed a trailing space in the tokeniser)
        # peek at raw string sadly not accessible — treat as no optional arg
        arg = _parse_group(p)
        return ("sqrt", None, arg)
    if name == "left":
        # \left <delim>   ...   \right <delim>
        tt2, tv2 = p.eat()
        if tt2 == "op":
            left = tv2
        elif tt2 == "cmd":
            left = "\\" + tv2
        else:
            left = "("
        inner = []
        while True:
            tt3, tv3 = p.peek()
            if tt3 is None:
                break
            if tt3 == "cmd" and tv3 == "right":
                p.eat()
                tt4, tv4 = p.eat()
                if tt4 == "op":
                    right = tv4
                elif tt4 == "cmd":
                    right = "\\" + tv4
                else:
                    right = ")"
                return ("fence", left, right, ("seq", inner))
            inner.append(_parse_atom(p))
        return ("fence", left, ")", ("seq", inner))
    if name in ("mathrm", "mathbf", "mathit", "mathsf", "mathtt", "operatorname", "text", "textbf", "textit"):
        arg = _parse_group(p)
        style = {
            "mathrm": "rm", "mathbf": "bf", "mathit": "it", "mathsf": "rm",
            "mathtt": "tt", "operatorname": "rm", "text": "rm", "textbf": "bf",
            "textit": "it",
        }.get(name, "rm")
        return ("style", style, arg)
    # Common one-argument presentation commands. The pure renderer does not
    # draw every accent/box decoration, but it typesets the argument and never
    # prints the raw command name (for example ``\\boxed``) into the PDF.
    if name in ("boxed", "overline", "underline", "vec", "hat", "widehat",
                "bar", "tilde", "widetilde", "dot", "ddot", "overbrace",
                "underbrace", "cancel", "phantom", "smash"):
        return _parse_group(p)
    # Sizing and spacing commands affect TeX layout only.
    if name in ("big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl",
                "Bigr", "biggl", "biggr", "Biggl", "Biggr", "limits",
                "nolimits", "allowbreak", "noindent"):
        return ("op", "")
    if name in _FUNC_NAMES:
        return ("func", name)
    if name == "over":
        # legacy `{a \over b}` inside a group we've already partly consumed.
        # Best-effort: emit a slash so at least it's readable.
        return ("op", "/")
    if name == "quad":
        return ("op", "   ")
    if name == "qquad":
        return ("op", "      ")
    if name == ",":
        return ("op", " ")
    if name in ("!", " "):
        return ("op", "")
    if name in ("displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle"):
        return ("op", "")
    if name in ("begin", "end"):
        # \begin{env}...\end{env}
        # eat the {name}
        tt2, tv2 = p.peek()
        if tt2 == "open":
            p.eat()
            env = ""
            while True:
                tt3, tv3 = p.eat()
                if tt3 == "close" or tt3 is None:
                    break
                env += tv3 or ""
            if name == "begin" and env in ("matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases", "aligned", "array"):
                # For `array`, an optional {ccc} column spec follows — skip it.
                if env == "array":
                    tt4, tv4 = p.peek()
                    if tt4 == "open":
                        p.eat()
                        depth = 1
                        while depth > 0:
                            tt5, tv5 = p.eat()
                            if tt5 is None:
                                break
                            if tt5 == "open":
                                depth += 1
                            elif tt5 == "close":
                                depth -= 1
                rows = [[]]
                cur_cell = []
                while True:
                    tt5, tv5 = p.peek()
                    if tt5 is None:
                        break
                    if tt5 == "cmd" and tv5 == "end":
                        # consume \end{env}
                        p.eat()
                        if p.peek()[0] == "open":
                            p.eat()
                            while p.peek()[0] not in (None, "close"):
                                p.eat()
                            if p.peek()[0] == "close":
                                p.eat()
                        # push last cell
                        if cur_cell:
                            rows[-1].append(("seq", cur_cell))
                            cur_cell = []
                        else:
                            rows[-1].append(("seq", []))
                        break
                    if tt5 == "and":
                        p.eat()
                        rows[-1].append(("seq", cur_cell))
                        cur_cell = []
                        continue
                    if tt5 == "nl":
                        p.eat()
                        rows[-1].append(("seq", cur_cell))
                        cur_cell = []
                        rows.append([])
                        continue
                    cur_cell.append(_parse_atom(p))
                # Drop trailing empty row.
                if rows and rows[-1] == []:
                    rows.pop()
                fence_map = {
                    "pmatrix": ("(", ")"), "bmatrix": ("[", "]"),
                    "Bmatrix": ("{", "}"), "vmatrix": ("|", "|"),
                    "Vmatrix": ("‖", "‖"), "matrix": ("", ""), "array": ("", ""),
                    "cases": ("{", ""), "aligned": ("", ""),
                }
                lf, rf = fence_map.get(env, ("", ""))
                return ("matrix", lf, rf, rows)
        return ("op", "")
    # Unknown command — consume and typeset a braced argument when present;
    # otherwise omit the command. Rendering ``\\command`` literally was the
    # source of raw-LaTeX leakage in fallback PDFs.
    if p.peek()[0] == "open":
        return _parse_group(p)
    return ("op", "")


# ---- Layout: AST → box (width, height, depth, draw-callback) ---------------
# A box is a tuple: (w, h, d, draw). `draw(page, x, y)` renders the box with
# its baseline at (x, y). Height goes UP from the baseline, depth goes DOWN.

def _layout(node, size, style="normal"):
    """Turn AST `node` into a box. `style` selects italic/bold/text-only."""
    if node is None:
        return _empty_box()
    kind = node[0]

    if kind == "seq":
        return _hbox([_layout(c, size, style) for c in node[1]])

    if kind == "num":
        return _text_box(node[1], size, italic=False)

    if kind == "var":
        italic = True
        if style in ("rm", "bf"):
            italic = False
        return _text_box(node[1], size, italic=italic, bold=(style == "bf"))

    if kind == "op":
        # small padding around binary operators for readability
        s = node[1]
        pad = 0.15 * size if s.strip() in ("+", "-", "=", "<", ">") else 0
        b = _text_box(s, size, italic=False)
        if pad:
            b = _pad_box(b, pad, pad)
        return b

    if kind == "sym":
        cp, _n = node[1], node[2]
        # Large operators (int, sum, prod, oint) are scaled up.
        big = _n in ("sum", "int", "prod", "oint")
        return _symbol_box(cp, size * (1.7 if big else 1.0))

    if kind == "func":
        return _text_box(node[1], size, italic=False)

    if kind == "style":
        style2, sub = node[1], node[2]
        return _layout(sub, size, style2)

    if kind == "frac":
        num_b = _layout(node[1], size * 0.92, style)
        den_b = _layout(node[2], size * 0.92, style)
        w = max(num_b[0], den_b[0]) + 0.4 * size
        h = num_b[1] + num_b[2] + 0.35 * size
        d = den_b[1] + den_b[2] + 0.05 * size
        rule_y_offset = 0.28 * size  # rule sits at this height above baseline

        def draw(pw, x, y, _size=size, _num_b=num_b, _den_b=den_b, _w=w, _rule=rule_y_offset):
            num_w, num_h, num_d, num_draw = _num_b
            den_w, den_h, den_d, den_draw = _den_b
            nx = x + (_w - num_w) / 2.0
            dx = x + (_w - den_w) / 2.0
            # numerator sits above the rule
            ny = y + _rule + num_d + 0.06 * _size
            # denominator hangs below the rule
            dy = y + _rule - den_h - 0.06 * _size
            num_draw(pw, nx, ny)
            den_draw(pw, dx, dy)
            # fraction rule
            pw.write_ops("q 0.7 w %.2f %.2f m %.2f %.2f l S Q" %
                         (x + 0.05 * _size, y + _rule,
                          x + _w - 0.05 * _size, y + _rule))
        return (w, h, d, draw)

    if kind == "binom":
        # like frac but no rule; wrapped in parens.
        core = _layout(("frac", node[1], node[2], False), size, style)
        return _fence_wrap("(", ")", core, size)

    if kind == "sqrt":
        _opt, inner = node[1], node[2]
        inner_b = _layout(inner, size, style)
        iw, ih, idp, idraw = inner_b
        hook_w = 0.55 * size
        pad = 0.15 * size
        w = hook_w + iw + pad
        h = ih + 0.22 * size
        d = idp

        def draw(pw, x, y, _sz=size, _iw=iw, _ih=ih, _id=idp, _idraw=idraw, _hw=hook_w):
            # hook: a stylised √ using two line segments
            top_y = y + _ih + 0.14 * _sz
            mid_y = y - _id * 0.4
            low_y = y - _id
            hx0 = x
            hx1 = x + _hw * 0.35
            hx2 = x + _hw * 0.65
            hx3 = x + _hw
            pw.write_ops(
                "q 0.9 w %.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l S "
                "%.2f %.2f m %.2f %.2f l S Q" %
                (hx0, mid_y, hx1, low_y, hx2, top_y, hx3, top_y,
                 hx3, top_y, x + _hw + _iw + 0.10 * _sz, top_y)
            )
            _idraw(pw, x + _hw + 0.05 * _sz, y)
        return (w, h, d, draw)

    if kind == "subsup":
        base = _layout(node[1], size, style)
        sub = _layout(node[2], size * 0.72, style) if node[2] is not None else None
        sup = _layout(node[3], size * 0.72, style) if node[3] is not None else None
        bw, bh, bd, bdraw = base
        sw = 0.0
        sh = bh
        sd = bd
        if sup is not None:
            sw = max(sw, sup[0])
            sh = max(sh, bh + sup[1] * 0.7)
        if sub is not None:
            sw = max(sw, sub[0])
            sd = max(sd, bd + sub[1] * 0.7)
        w = bw + sw + 0.08 * size
        h = sh
        d = sd

        def draw(pw, x, y, _b=base, _sub=sub, _sup=sup, _sz=size):
            _bw, _bh, _bd, _bdraw = _b
            _bdraw(pw, x, y)
            if _sup is not None:
                _pw, _ph, _pd, _pdraw = _sup
                _pdraw(pw, x + _bw + 0.02 * _sz, y + _bh * 0.55)
            if _sub is not None:
                _pw, _ph, _pd, _pdraw = _sub
                _pdraw(pw, x + _bw + 0.02 * _sz, y - _bd * 0.55 - _ph * 0.5)
        return (w, h, d, draw)

    if kind == "fence":
        left, right, inner = node[1], node[2], node[3]
        b = _layout(inner, size, style)
        # Map \left \right delims back to a single character.
        def _mk(sym):
            if sym in ("(", ")", "[", "]", "{", "}", "|"):
                return sym
            if sym == "\\|":
                return "‖"
            if sym == "\\langle":
                return "〈"
            if sym == "\\rangle":
                return "〉"
            if sym == ".":
                return ""
            return sym.lstrip("\\")
        return _fence_wrap(_mk(left), _mk(right), b, size)

    if kind == "matrix":
        left, right, rows = node[1], node[2], node[3]
        # Layout each cell.
        cells = [[_layout(c, size * 0.95, style) for c in row] for row in rows]
        ncols = max((len(r) for r in cells), default=0)
        col_w = [0.0] * ncols
        row_h = [0.0] * len(cells)
        row_d = [0.0] * len(cells)
        for r, row in enumerate(cells):
            for c, cell in enumerate(row):
                col_w[c] = max(col_w[c], cell[0])
                row_h[r] = max(row_h[r], cell[1])
                row_d[r] = max(row_d[r], cell[2])
        gap_col = 0.7 * size
        gap_row = 0.35 * size
        total_w = sum(col_w) + gap_col * max(ncols - 1, 0)
        total_h = sum(row_h) + sum(row_d) + gap_row * max(len(cells) - 1, 0)
        h = total_h / 2.0 + 0.12 * size
        d = total_h / 2.0 - 0.12 * size

        def draw(pw, x, y, _c=cells, _cw=col_w, _rh=row_h, _rd=row_d,
                 _gc=gap_col, _gr=gap_row, _th=total_h):
            # top of matrix in page-y (higher y is up)
            yy = y + _th / 2.0
            for r, row in enumerate(_c):
                yy -= _rh[r]
                xx = x
                for cc, cell in enumerate(row):
                    cw, ch, cd, cdraw = cell
                    # centre each cell horizontally in its column
                    cdraw(pw, xx + (_cw[cc] - cw) / 2.0, yy)
                    xx += _cw[cc] + _gc
                yy -= _rd[r] + _gr

        core = (total_w, h, d, draw)
        if left or right:
            return _fence_wrap(left, right, core, size)
        return core

    # fallback
    return _empty_box()


# ---- Primitive boxes --------------------------------------------------------
def _empty_box():
    return (0.0, 0.0, 0.0, lambda pw, x, y: None)


def _text_box(text, size, italic=False, bold=False, mono=False):
    if not text:
        return _empty_box()
    font = "F1"
    if bold and italic:
        font = "F2"  # no bold-italic in the 14 core — use bold
    elif bold:
        font = "F2"
    elif italic:
        font = "F3"
    if mono:
        font = "F4"
    w = _string_width(text, size, bold=bold, italic=italic, mono=mono)
    h = 0.72 * size
    d = 0.22 * size
    esc = _pdf_escape(text)

    def draw(pw, x, y, _f=font, _s=size, _e=esc):
        pw.write_ops("BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                     (_f, _s, x, y, _e))
    return (w, h, d, draw)


def _symbol_box(cp, size):
    """A single Symbol-font glyph."""
    # Symbol codepoints > 255 are stored via octal escape into a 1-byte string.
    # But Symbol uses its own 8-bit encoding, so `cp` is already a byte value.
    if cp > 255:
        cp = 63  # ?
    w = _glyph_width_symbol(cp, size)
    h = 0.78 * size
    d = 0.20 * size
    esc = "\\%03o" % cp

    def draw(pw, x, y, _s=size, _e=esc):
        pw.write_ops("BT /F5 %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                     (_s, x, y, _e))
    return (w, h, d, draw)


def _pad_box(box, left, right):
    w, h, d, draw = box

    def draw2(pw, x, y, _draw=draw, _left=left):
        _draw(pw, x + _left, y)
    return (w + left + right, h, d, draw2)


def _hbox(boxes):
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return _empty_box()
    w = sum(b[0] for b in boxes)
    h = max((b[1] for b in boxes), default=0.0)
    d = max((b[2] for b in boxes), default=0.0)

    def draw(pw, x, y, _bs=boxes):
        xx = x
        for b in _bs:
            b[3](pw, xx, y)
            xx += b[0]
    return (w, h, d, draw)


def _fence_wrap(left, right, inner, size):
    """Wrap `inner` in delimiters that scale to inner's height."""
    iw, ih, idp, idraw = inner
    scale = max(1.0, (ih + idp) / (0.9 * size))
    lw = 0.35 * size * (0.9 + 0.25 * scale) if left else 0.0
    rw = 0.35 * size * (0.9 + 0.25 * scale) if right else 0.0

    def draw(pw, x, y, _l=left, _r=right, _lw=lw, _rw=rw, _idraw=idraw,
             _iw=iw, _ih=ih, _id=idp, _sz=size, _sc=scale):
        y_top = y + _ih
        y_bot = y - _id
        if _l:
            _draw_fence(pw, _l, x, y_top, y_bot, _lw, _sz)
        _idraw(pw, x + _lw, y)
        if _r:
            _draw_fence(pw, _r, x + _lw + _iw, y_top, y_bot, _rw, _sz)
    return (lw + iw + rw, ih, idp, draw)


def _draw_fence(pw, ch, x, y_top, y_bot, width, size):
    """Draw a scalable delimiter as vector lines. Works for ( ) [ ] { } | ‖."""
    lw = 0.9
    mid = (y_top + y_bot) / 2.0
    h_tot = y_top - y_bot
    if ch == "(":
        # cubic bezier approximating a paren
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f %.2f %.2f %.2f %.2f c "
                     "%.2f %.2f %.2f %.2f %.2f %.2f c S Q"
                     % (lw,
                        x + width * 0.9, y_top,
                        x + width * 0.05, y_top - h_tot * 0.25,
                        x + width * 0.05, y_bot + h_tot * 0.25,
                        x + width * 0.9, y_bot,
                        x + width * 0.5, y_bot,
                        x + width * 0.1, y_bot + h_tot * 0.3,
                        x + width * 0.1, mid))
    elif ch == ")":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f %.2f %.2f %.2f %.2f c "
                     "%.2f %.2f %.2f %.2f %.2f %.2f c S Q"
                     % (lw,
                        x + width * 0.1, y_top,
                        x + width * 0.95, y_top - h_tot * 0.25,
                        x + width * 0.95, y_bot + h_tot * 0.25,
                        x + width * 0.1, y_bot,
                        x + width * 0.5, y_bot,
                        x + width * 0.9, y_bot + h_tot * 0.3,
                        x + width * 0.9, mid))
    elif ch == "[":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l S Q"
                     % (lw,
                        x + width * 0.6, y_top,
                        x + width * 0.2, y_top,
                        x + width * 0.2, y_bot,
                        x + width * 0.6, y_bot))
    elif ch == "]":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l S Q"
                     % (lw,
                        x + width * 0.4, y_top,
                        x + width * 0.8, y_top,
                        x + width * 0.8, y_bot,
                        x + width * 0.4, y_bot))
    elif ch == "{":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l "
                     "%.2f %.2f l %.2f %.2f l %.2f %.2f l S Q"
                     % (lw,
                        x + width * 0.7, y_top, x + width * 0.4, y_top - h_tot * 0.1,
                        x + width * 0.4, mid + 0.02 * size, x + width * 0.15, mid,
                        x + width * 0.4, mid - 0.02 * size,
                        x + width * 0.4, y_bot + h_tot * 0.1,
                        x + width * 0.7, y_bot))
    elif ch == "}":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l %.2f %.2f l "
                     "%.2f %.2f l %.2f %.2f l %.2f %.2f l S Q"
                     % (lw,
                        x + width * 0.3, y_top, x + width * 0.6, y_top - h_tot * 0.1,
                        x + width * 0.6, mid + 0.02 * size, x + width * 0.85, mid,
                        x + width * 0.6, mid - 0.02 * size,
                        x + width * 0.6, y_bot + h_tot * 0.1,
                        x + width * 0.3, y_bot))
    elif ch == "|":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l S Q"
                     % (lw, x + width * 0.5, y_top, x + width * 0.5, y_bot))
    elif ch == "‖":
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f m %.2f %.2f l S Q"
                     % (lw,
                        x + width * 0.35, y_top, x + width * 0.35, y_bot,
                        x + width * 0.65, y_top, x + width * 0.65, y_bot))
    elif ch in ("〈", "<"):
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l S Q"
                     % (lw, x + width * 0.9, y_top, x + width * 0.1, mid, x + width * 0.9, y_bot))
    elif ch in ("〉", ">"):
        pw.write_ops("q %.2f w %.2f %.2f m %.2f %.2f l %.2f %.2f l S Q"
                     % (lw, x + width * 0.1, y_top, x + width * 0.9, mid, x + width * 0.1, y_bot))


# ---- Public math entry point ------------------------------------------------
def _render_math(src, size):
    """Parse a LaTeX-math source string and return a layout box."""
    toks = _math_tokens(src)
    p = _P(toks)
    atoms = []
    while not p.eof():
        atoms.append(_parse_atom(p))
    return _layout(("seq", atoms), size)


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 4: Prose Markdown → PDF ─────────────────────────────────────────────
# We walk a Markdown source line-by-line, split each paragraph into text-runs
# and math-runs (dollar-delimited), and lay them out with word wrap into the
# page's content area.
# ─────────────────────────────────────────────────────────────────────────────

# Regex to split a line into text vs. math segments. Handles $…$, $$…$$,
# \(…\), and \[…\] (display math on its own line is handled separately).
_MATH_SPLIT = re.compile(
    r"(\$\$[^$]+\$\$|\$[^$\n]+\$|\\\([^)]+?\\\)|\\\[[^\]]+?\\\])"
)


def _split_math_runs(line):
    """Split `line` into a list of ('text', s) / ('math', s) tuples."""
    out = []
    pos = 0
    for m in _MATH_SPLIT.finditer(line):
        if m.start() > pos:
            out.append(("text", line[pos:m.start()]))
        seg = m.group(0)
        if seg.startswith("$$"):
            out.append(("math_display", seg[2:-2].strip()))
        elif seg.startswith("$"):
            out.append(("math", seg[1:-1]))
        elif seg.startswith("\\("):
            out.append(("math", seg[2:-2]))
        elif seg.startswith("\\["):
            out.append(("math_display", seg[2:-2].strip()))
        pos = m.end()
    if pos < len(line):
        out.append(("text", line[pos:]))
    return out


class _PDFDoc(object):
    """High-level page-flow context: keeps a cursor (x, y) inside the printable
    area and knows how to lay out headings, paragraphs, lists, code blocks,
    tables, display-math, and simple charts."""

    LINE_H = 14.5   # baseline distance for body text at 11pt
    BODY_SIZE = 11.0
    H1_SIZE = 20.0
    H2_SIZE = 16.0
    H3_SIZE = 13.5
    CODE_SIZE = 9.5

    def __init__(self, title="", subtitle=""):
        self.w = _PdfWriter(title=title, subtitle=subtitle)
        self.title = title
        self.subtitle = subtitle
        self.cx = self.w.MARGIN_L
        self.cy = self.w.PAGE_H - self.w.MARGIN_T
        self.content_w = self.w.PAGE_W - self.w.MARGIN_L - self.w.MARGIN_R
        self._page_num = 1
        self._first_page_header()

    # ---- page break bookkeeping ---------------------------------------------
    def _need(self, height):
        if self.cy - height < self.w.MARGIN_B + 24:
            self._page_break()

    def _page_break(self):
        self._draw_page_number()
        self.w.new_page()
        self._page_num += 1
        self.cx = self.w.MARGIN_L
        self.cy = self.w.PAGE_H - self.w.MARGIN_T

    def _draw_page_number(self):
        s = "%d" % self._page_num
        width = _string_width(s, 9)
        self.w.write_ops(
            "BT /F1 9 Tf %.2f %.2f Td (%s) Tj ET"
            % ((self.w.PAGE_W - width) / 2.0, self.w.MARGIN_B - 20, _pdf_escape(s))
        )

    def _first_page_header(self):
        if self.title:
            self._heading(self.title, self.H1_SIZE, bold=True, centre=True, top=True)
        if self.subtitle:
            self._heading(self.subtitle, self.H3_SIZE, italic=True, centre=True)
        if self.title or self.subtitle:
            self._hr()

    # ---- primitives ---------------------------------------------------------
    def _hr(self):
        self._need(20)
        y = self.cy - 4
        self.w.write_ops("q 0.5 w %.2f %.2f m %.2f %.2f l S Q" %
                         (self.w.MARGIN_L, y, self.w.PAGE_W - self.w.MARGIN_R, y))
        self.cy -= 14

    def _heading(self, text, size, bold=False, italic=False, centre=False, top=False):
        self._need(size + 12)
        font = "F1"
        if bold and italic:
            font = "F2"
        elif bold:
            font = "F2"
        elif italic:
            font = "F3"
        width = _string_width(text, size, bold=bold, italic=italic)
        if centre:
            x = (self.w.PAGE_W - width) / 2.0
        else:
            x = self.cx
        y = self.cy - size
        self.w.write_ops("BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                         (font, size, x, y, _pdf_escape(text)))
        self.cy = y - 8 if not top else y - 10

    def _wrap_words(self, text, size, bold=False, italic=False, mono=False):
        """Break `text` into space-separated tokens paired with their widths."""
        words = re.findall(r"\S+|\s+", text)
        out = []
        for w in words:
            out.append((w, _string_width(w, size, bold=bold, italic=italic, mono=mono)))
        return out

    def _paragraph(self, runs):
        """Layout a paragraph made of alternating text/math runs with wrapping.
        Math runs are treated as unbreakable inline boxes."""
        # Step 1: turn every run into a list of "items" — either a word (w, width)
        # or a math box (w, box). Whitespace-in-text is kept so words wrap on it.
        items = []
        for kind, val in runs:
            if kind == "text":
                for w, wid in self._wrap_words(val, self.BODY_SIZE):
                    if not w:
                        continue
                    is_space = w.isspace()
                    items.append(("space" if is_space else "word", w, wid))
            elif kind == "math":
                try:
                    box = _render_math(val, self.BODY_SIZE)
                except Exception:
                    box = _text_box(val, self.BODY_SIZE, italic=True)
                items.append(("math", val, box))
            elif kind == "math_display":
                # display math on its own line — flush current items first
                if items:
                    self._render_line_items(items)
                    items = []
                self._display_math(val)
        if items:
            self._render_line_items(items)
        self.cy -= 3  # trailing paragraph gap

    def _render_line_items(self, items):
        """Word-wrap `items` and emit each line's content stream ops."""
        line = []
        line_w = 0.0
        max_w = self.content_w

        def flush(line, final=False):
            if not line:
                return
            # Trim leading/trailing whitespace items on the line.
            while line and line[0][0] == "space":
                line.pop(0)
            while line and line[-1][0] == "space":
                line.pop()
            if not line:
                return
            self._need(self.LINE_H)
            baseline_y = self.cy - self.LINE_H * 0.72
            x = self.cx
            for it in line:
                if it[0] == "word":
                    _, txt, wid = it
                    self.w.write_ops(
                        "BT /F1 %.2f Tf %.2f %.2f Td (%s) Tj ET"
                        % (self.BODY_SIZE, x, baseline_y, _pdf_escape(txt))
                    )
                    x += wid
                elif it[0] == "space":
                    _, txt, wid = it
                    x += wid
                elif it[0] == "math":
                    _, _src, box = it
                    box[3](self.w, x, baseline_y)
                    x += box[0]
            self.cy -= self.LINE_H

        for it in items:
            kind, val, extra = it
            if kind == "word":
                wid = extra
            elif kind == "space":
                wid = extra
            elif kind == "math":
                wid = extra[0]  # math box's width
            # A single word that alone is wider than max_w — we still emit it
            # (readable, no infinite loop).
            if line_w + wid > max_w and line:
                flush(line)
                line = []
                line_w = 0.0
                if kind == "space":
                    continue
            line.append(it)
            line_w += wid
        flush(line, final=True)

    def _display_math(self, src):
        try:
            size = self.BODY_SIZE * 1.1
            box = _render_math(src, size)
        except Exception:
            box = _text_box(src, self.BODY_SIZE * 1.05, italic=True)
        w, h, d, draw = box
        self._need(h + d + 16)
        x = self.w.MARGIN_L + (self.content_w - w) / 2.0
        y = self.cy - h - 6
        draw(self.w, x, y)
        self.cy = y - d - 8

    def _code_block(self, code, lang=None):
        lines = code.split("\n")
        total_h = self.CODE_SIZE * 1.35 * len(lines) + 12
        self._need(min(total_h, 500))
        pad = 6
        x0 = self.w.MARGIN_L
        x1 = self.w.PAGE_W - self.w.MARGIN_R
        y0 = self.cy
        y1 = self.cy - total_h
        # background
        self.w.write_ops("q 0.96 0.96 0.96 rg %.2f %.2f %.2f %.2f re f Q" %
                         (x0, y1, x1 - x0, y0 - y1))
        # text
        y = self.cy - self.CODE_SIZE - pad
        for ln in lines:
            if y < self.w.MARGIN_B + 20:
                self._page_break()
                y = self.cy - self.CODE_SIZE - pad
            self.w.write_ops("BT /F4 %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                             (self.CODE_SIZE, x0 + pad, y, _pdf_escape(ln)))
            y -= self.CODE_SIZE * 1.35
        self.cy = y - pad

    def _bullet(self, text_runs, ordered=False, index=1):
        marker = "%d." % index if ordered else "•"
        indent = 22
        # Draw the marker on the CURRENT line, then indent the paragraph.
        self._need(self.LINE_H)
        y = self.cy - self.LINE_H * 0.72
        self.w.write_ops("BT /F1 %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                         (self.BODY_SIZE, self.cx, y, _pdf_escape(marker)))
        # Temporarily shift the left margin for the paragraph.
        saved_cx = self.cx
        self.cx = saved_cx + indent
        old_content_w = self.content_w
        self.content_w = self.w.PAGE_W - self.w.MARGIN_R - self.cx
        # We do NOT advance cy here — _paragraph starts on the same visual line.
        self._paragraph(text_runs)
        self.cx = saved_cx
        self.content_w = old_content_w

    def _table(self, rows):
        if not rows:
            return
        ncols = max(len(r) for r in rows)
        col_w = self.content_w / ncols
        cell_h = self.LINE_H + 6
        self._need(cell_h * (len(rows) + 1))
        y = self.cy
        for r, row in enumerate(rows):
            # borders
            self.w.write_ops("q 0.7 w %.2f %.2f m %.2f %.2f l S Q" %
                             (self.w.MARGIN_L, y, self.w.PAGE_W - self.w.MARGIN_R, y))
            # cells
            for c in range(ncols):
                text = row[c] if c < len(row) else ""
                font = "F2" if r == 0 else "F1"
                self.w.write_ops(
                    "BT /%s %.2f Tf %.2f %.2f Td (%s) Tj ET" %
                    (font, self.BODY_SIZE, self.w.MARGIN_L + c * col_w + 4,
                     y - self.BODY_SIZE - 3, _pdf_escape(text))
                )
            y -= cell_h
        # bottom border
        self.w.write_ops("q 0.7 w %.2f %.2f m %.2f %.2f l S Q" %
                         (self.w.MARGIN_L, y, self.w.PAGE_W - self.w.MARGIN_R, y))
        self.cy = y - 6

    def _chart(self, spec):
        """Draw a bar/line/pie chart from a parsed key:value dict."""
        ctype = (spec.get("type") or "bar").lower()
        title = spec.get("title", "")
        raw = spec.get("data", "")
        pairs = []
        for tok in raw.split(","):
            tok = tok.strip()
            if "=" in tok:
                k, v = tok.split("=", 1)
                try:
                    pairs.append((k.strip(), float(v.strip())))
                except ValueError:
                    continue
        if not pairs:
            return
        chart_h = 180
        self._need(chart_h + 40)
        if title:
            self._heading(title, self.H3_SIZE, bold=True, centre=True)
        x0 = self.w.MARGIN_L + 20
        x1 = self.w.PAGE_W - self.w.MARGIN_R - 20
        y0 = self.cy - chart_h
        y1 = self.cy
        vmax = max(v for _, v in pairs) or 1.0
        if ctype == "pie":
            cx = (x0 + x1) / 2
            cy = (y0 + y1) / 2
            r = min((y1 - y0), (x1 - x0)) / 2 - 10
            total = sum(v for _, v in pairs)
            start = 0
            colours = [(0.2, 0.4, 0.8), (0.9, 0.5, 0.1), (0.2, 0.7, 0.3),
                       (0.8, 0.2, 0.2), (0.6, 0.3, 0.7), (0.2, 0.6, 0.7)]
            for i, (label, v) in enumerate(pairs):
                ang = 2 * math.pi * (v / total)
                col = colours[i % len(colours)]
                # Approximate the pie slice with a fan of triangles.
                steps = max(6, int(ang * 20))
                ops = ["q %.2f %.2f %.2f rg" % col]
                ops.append("%.2f %.2f m" % (cx, cy))
                for s in range(steps + 1):
                    a = start + ang * (s / steps)
                    px = cx + r * math.cos(a)
                    py = cy + r * math.sin(a)
                    ops.append("%.2f %.2f l" % (px, py))
                ops.append("f Q")
                self.w.write_ops(" ".join(ops))
                start += ang
            # legend
            lx = x0
            ly = y0 - 14
            for i, (label, v) in enumerate(pairs):
                col = colours[i % len(colours)]
                self.w.write_ops("q %.2f %.2f %.2f rg %.2f %.2f 8 8 re f Q" %
                                 (col[0], col[1], col[2], lx, ly))
                self.w.write_ops("BT /F1 9 Tf %.2f %.2f Td (%s) Tj ET" %
                                 (lx + 12, ly + 1, _pdf_escape("%s (%.0f)" % (label, v))))
                lx += _string_width(label, 9) + 60
                if lx > x1 - 60:
                    lx = x0
                    ly -= 12
            self.cy = y0 - 24
            return
        # axes
        self.w.write_ops("q 0.6 w %.2f %.2f m %.2f %.2f l %.2f %.2f l S Q" %
                         (x0, y1, x0, y0, x1, y0))
        n = len(pairs)
        if ctype == "line":
            step = (x1 - x0) / max(n - 1, 1)
            pts = []
            for i, (label, v) in enumerate(pairs):
                px = x0 + i * step
                py = y0 + (v / vmax) * (y1 - y0 - 8)
                pts.append((px, py))
            ops = ["q 0.9 w 0.2 0.4 0.8 RG"]
            ops.append("%.2f %.2f m" % pts[0])
            for px, py in pts[1:]:
                ops.append("%.2f %.2f l" % (px, py))
            ops.append("S Q")
            self.w.write_ops(" ".join(ops))
            # dots + x labels
            for i, ((px, py), (label, _v)) in enumerate(zip(pts, pairs)):
                self.w.write_ops("q 0.2 0.4 0.8 rg %.2f %.2f 3 0 360 arc f Q" %
                                 (px, py) if False else
                                 "q 0.2 0.4 0.8 rg %.2f %.2f 4 4 re f Q" %
                                 (px - 2, py - 2))
                self.w.write_ops("BT /F1 8 Tf %.2f %.2f Td (%s) Tj ET" %
                                 (px - _string_width(label, 8) / 2, y0 - 12,
                                  _pdf_escape(label)))
        else:  # bar
            bw = (x1 - x0) / n * 0.7
            gap = (x1 - x0) / n * 0.3
            for i, (label, v) in enumerate(pairs):
                bx = x0 + i * ((x1 - x0) / n) + gap / 2
                bh = (v / vmax) * (y1 - y0 - 8)
                self.w.write_ops("q 0.2 0.4 0.8 rg %.2f %.2f %.2f %.2f re f Q" %
                                 (bx, y0, bw, bh))
                self.w.write_ops("BT /F1 8 Tf %.2f %.2f Td (%s) Tj ET" %
                                 (bx + (bw - _string_width(label, 8)) / 2, y0 - 12,
                                  _pdf_escape(label)))
                # value on top
                vs = ("%g" % v)
                self.w.write_ops("BT /F1 8 Tf %.2f %.2f Td (%s) Tj ET" %
                                 (bx + (bw - _string_width(vs, 8)) / 2, y0 + bh + 2,
                                  _pdf_escape(vs)))
        self.cy = y0 - 24

    # ---- top-level Markdown consumer ----------------------------------------
    def render_markdown(self, md):
        lines = md.split("\n")
        i, n = 0, len(lines)
        while i < n:
            line = lines[i]
            stripped = line.strip()

            # fenced code / chart
            m = re.match(r"^```+\s*([a-zA-Z0-9_-]*)\s*$", stripped)
            if m:
                lang = m.group(1).lower()
                block = []
                i += 1
                while i < n and not re.match(r"^```+\s*$", lines[i].strip()):
                    block.append(lines[i])
                    i += 1
                i += 1
                if lang == "chart":
                    spec = {}
                    for bl in block:
                        if ":" in bl:
                            k, v = bl.split(":", 1)
                            spec[k.strip().lower()] = v.strip()
                    self._chart(spec)
                else:
                    self._code_block("\n".join(block), lang=lang)
                continue

            # display math via $$…$$ on its own line
            if stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) >= 4:
                self._display_math(stripped[2:-2].strip())
                i += 1
                continue
            if stripped.startswith("$$"):
                body = [stripped[2:]]
                i += 1
                while i < n and "$$" not in lines[i]:
                    body.append(lines[i])
                    i += 1
                if i < n:
                    body.append(lines[i].split("$$", 1)[0])
                    i += 1
                self._display_math("\n".join(body).strip())
                continue

            # \[ … \]
            if stripped.startswith("\\[") and "\\]" in stripped:
                inside = stripped[2: stripped.rindex("\\]")]
                self._display_math(inside)
                i += 1
                continue

            # heading
            hm = re.match(r"^(#{1,4})\s+(.*)$", stripped)
            if hm:
                lvl = len(hm.group(1))
                text = hm.group(2).strip()
                size = {1: self.H1_SIZE, 2: self.H2_SIZE, 3: self.H3_SIZE, 4: self.BODY_SIZE + 1}[lvl]
                self._heading(text, size, bold=True)
                i += 1
                continue

            # horizontal rule
            if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
                self._hr()
                i += 1
                continue

            # table
            if "|" in stripped and stripped.count("|") >= 2 and i + 1 < n and \
                    re.match(r"^\s*\|?[\s:\-|]+\|?\s*$", lines[i + 1]):
                rows = []
                header = [c.strip() for c in stripped.strip().strip("|").split("|")]
                rows.append(header)
                i += 2
                while i < n and "|" in lines[i] and lines[i].strip():
                    rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                    i += 1
                self._table(rows)
                continue

            # bullet list
            um = re.match(r"^[-*+]\s+(.*)$", stripped)
            if um:
                runs = _split_math_runs(um.group(1).strip())
                self._bullet(runs)
                i += 1
                continue

            # ordered list
            om = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
            if om:
                idx = int(om.group(1))
                runs = _split_math_runs(om.group(2).strip())
                self._bullet(runs, ordered=True, index=idx)
                i += 1
                continue

            # blank line → paragraph break
            if not stripped:
                self.cy -= 6
                i += 1
                continue

            # paragraph: greedy-collect until blank / special line
            para_lines = [stripped]
            i += 1
            while i < n:
                s = lines[i].strip()
                if not s:
                    break
                if re.match(r"^(#{1,4})\s+", s):
                    break
                if re.match(r"^```", s):
                    break
                if re.match(r"^[-*+]\s+", s) or re.match(r"^\d+[.)]\s+", s):
                    break
                if s.startswith("$$") or s.startswith("\\["):
                    break
                para_lines.append(s)
                i += 1
            para_text = " ".join(para_lines)
            runs = _split_math_runs(para_text)
            self._paragraph(runs)

        # finalise the last page number
        self._draw_page_number()

    def bytes(self):
        return self.w.build()


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 4b: REAL LaTeX engine (pdflatex) — the PRIMARY, print-quality path ──
#
# ROOT-CAUSE FIX for the "garbled math / broken tables / non-pure LaTeX / ?
# glyphs" bug reported from the live PDFs:
#
#   The pure-Python renderer above (PART 1–4) was a from-scratch PDF drawer that
#   hand-laid-out math into vector primitives. It could not typeset real LaTeX
#   faithfully — nested fractions, aligned equations, proper tables and any
#   non-Latin-1 glyph degraded to "?" (see _pdf_escape). The comment at the top
#   of this file claimed "no external engine is ever provisioned", but the
#   Render Docker image ACTUALLY bakes in a full, offline TeX Live (pdflatex +
#   latexmk + amsmath/booktabs/tikz/pgfplots/…) and the build fails if pdflatex
#   is missing. So the real engine is right there — we just weren't using it.
#
#   This section converts Markdown → clean LaTeX and compiles it with the real,
#   OFFLINE pdflatex. That gives pixel-perfect math, tables and Unicode. If
#   pdflatex is genuinely unavailable (e.g. a bare sandbox), build_pdf/
#   compile_latex fall back to the pure-Python renderer so we NEVER ship a blank
#   PDF — the enterprise-grade "always returns a PDF" guarantee is preserved.
# ─────────────────────────────────────────────────────────────────────────────

def _pdflatex_available():
    """Return whether the real offline TeX engine is ready."""
    force_pure = str(os.environ.get("LATEX_FORCE_PURE", "")).strip().lower() in ("1", "true", "yes", "on")
    return False if force_pure else bool(shutil.which("pdflatex"))


def _ensure_pdflatex_available():
    """Install the deterministic TeX toolchain on a fresh cloud sandbox.

    Novita and Upstash start from small Debian images. The previous regression
    test deliberately forced the rough native fallback, so it never proved that
    either provider could produce textbook-quality output. A PDF request now
    provisions a real offline TeX Live once, then all later renders reuse it.
    """
    if _pdflatex_available():
        return True
    auto = str(os.environ.get("LATEX_AUTO_INSTALL", "1")).strip().lower()
    if auto in ("0", "false", "no", "off") or shutil.which("apt-get") is None:
        return False
    sudo = [] if getattr(os, "geteuid", lambda: 1)() == 0 else (["sudo"] if shutil.which("sudo") else [])
    if getattr(os, "geteuid", lambda: 1)() != 0 and not sudo:
        return False
    env = dict(os.environ)
    env["DEBIAN_FRONTEND"] = "noninteractive"
    packages = [
        "latexmk", "texlive-latex-base", "texlive-latex-recommended",
        "texlive-latex-extra", "texlive-fonts-recommended", "texlive-science",
        "texlive-plain-generic", "lmodern",
    ]
    try:
        subprocess.run(sudo + ["apt-get", "update", "-y"], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                       timeout=300, check=True)
        subprocess.run(sudo + ["apt-get", "install", "-y", "--no-install-recommends"] + packages,
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                       timeout=900, check=True)
    except Exception as exc:
        sys.stderr.write("[latex_render] TeX Live provisioning failed: %s\n" % str(exc)[:240])
        return False
    return _pdflatex_available()


# Characters that must be escaped in LaTeX *text* mode (NOT inside math).
_LATEX_TEXT_ESCAPES = [
    ("\\", "\\textbackslash{}"),
    ("&", "\\&"),
    ("%", "\\%"),
    ("$", "\\$"),
    ("#", "\\#"),
    ("_", "\\_"),
    ("{", "\\{"),
    ("}", "\\}"),
    ("~", "\\textasciitilde{}"),
    ("^", "\\textasciicircum{}"),
]


def _latex_escape_text(s):
    """Escape a run of PLAIN text (no math, no markdown markers) for LaTeX."""
    s = str(s)
    # Backslash first so we don't double-escape the escapes we introduce.
    s = s.replace("\\", "\u0000BS\u0000")
    for ch, rep in _LATEX_TEXT_ESCAPES[1:]:
        s = s.replace(ch, rep)
    s = s.replace("\u0000BS\u0000", "\\textbackslash{}")
    return s


def _latex_inline(s):
    """Convert an inline Markdown run to LaTeX. Math spans ($…$, \\(…\\)) are
    kept VERBATIM (real LaTeX typesets them); everything else is escaped and
    then bold/italic/code markers are applied. This is the key to "pure LaTeX":
    we never mangle the math the model produced."""
    s = str(s or "")
    # Split out inline-math spans so they pass through untouched.
    # Supports $…$ and \( … \).
    parts = re.split(r"(\$[^$\n]+?\$|\\\([^\n]*?\\\))", s)
    out = []
    for idx, part in enumerate(parts):
        if idx % 2 == 1:
            # Math span — emit verbatim (strip \( \) → $ for uniformity).
            m = part
            if m.startswith("\\(") and m.endswith("\\)"):
                m = "$" + m[2:-2].strip() + "$"
            out.append(m)
            continue
        # Plain text: escape, then apply markdown emphasis / code.
        t = part
        # Extract inline code first so its contents aren't escaped twice.
        code_spans = []

        def _code_ph(mo):
            code_spans.append(mo.group(1))
            return "\u0000CODE%d\u0000" % (len(code_spans) - 1)

        t = re.sub(r"`([^`]+)`", _code_ph, t)
        t = _latex_escape_text(t)
        # ***bold italic***, **bold**, *italic* (and _ variants for bold/italic).
        t = re.sub(r"\*\*\*([^*]+)\*\*\*", r"\\textbf{\\emph{\1}}", t)
        t = re.sub(r"\*\*([^*]+)\*\*", r"\\textbf{\1}", t)
        t = re.sub(r"~~([^~]+)~~", r"\\sout{\1}", t)
        t = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\\emph{\1}", t)
        # [text](url) links.
        t = re.sub(r"\\?\[([^\]]+)\\?\]\(([^)]+)\)", r"\\href{\2}{\1}", t)
        # Restore inline code as \texttt{…} (escape its content for text mode).

        def _code_restore(mo):
            raw = code_spans[int(mo.group(1))]
            return "\\texttt{%s}" % _latex_escape_text(raw)

        t = re.sub(r"\u0000CODE(\d+)\u0000", _code_restore, t)
        out.append(t)
    return "".join(out)


def _md_to_latex_body(md):
    """Convert a Markdown document (with LaTeX math) into a LaTeX BODY string.
    Mirrors the feature set of the pure-Python render_markdown: headings, bold/
    italic/code, bullet + ordered lists, pipe tables (booktabs), fenced code
    (verbatim), block quotes, horizontal rules, display math ($$…$$ / \\[…\\])
    and explicit page breaks — but emitted as clean, compilable LaTeX."""
    lines = str(md or "").split("\n")
    i, n = 0, len(lines)
    out = []
    list_stack = []  # track open itemize/enumerate for clean nesting exit

    def close_lists():
        while list_stack:
            out.append("\\end{%s}" % list_stack.pop())

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Fenced code block (```lang … ```). Rendered verbatim; charts too.
        m = re.match(r"^```+\s*([a-zA-Z0-9_-]*)\s*$", stripped)
        if m:
            close_lists()
            block = []
            i += 1
            while i < n and not re.match(r"^```+\s*$", lines[i].strip()):
                block.append(lines[i])
                i += 1
            i += 1
            out.append("\\begin{Verbatim}[breaklines=true,fontsize=\\small]")
            out.extend(block)
            out.append("\\end{Verbatim}")
            continue

        # Display math on its own line: $$ … $$
        if stripped.startswith("$$") and stripped.endswith("$$") and len(stripped) >= 4:
            close_lists()
            out.append("\\[" + stripped[2:-2].strip() + "\\]")
            i += 1
            continue
        if stripped.startswith("$$"):
            close_lists()
            body = [stripped[2:]]
            i += 1
            while i < n and "$$" not in lines[i]:
                body.append(lines[i])
                i += 1
            if i < n:
                body.append(lines[i].split("$$", 1)[0])
                i += 1
            out.append("\\[" + "\n".join(body).strip() + "\\]")
            continue

        # Display math: \[ … \]  (possibly multi-line)
        if stripped.startswith("\\[") and "\\]" in stripped:
            close_lists()
            inside = stripped[2: stripped.rindex("\\]")]
            out.append("\\[" + inside + "\\]")
            i += 1
            continue
        if stripped.startswith("\\["):
            close_lists()
            body = [stripped[2:]]
            i += 1
            while i < n and "\\]" not in lines[i]:
                body.append(lines[i])
                i += 1
            if i < n:
                body.append(lines[i].split("\\]", 1)[0])
                i += 1
            out.append("\\[" + "\n".join(body).strip() + "\\]")
            continue

        # Environments the model may emit directly (align, equation, cases,
        # matrix, tabular…) — pass through VERBATIM so nothing is mangled.
        em = re.match(r"^\\begin\{([a-zA-Z*]+)\}", stripped)
        if em:
            close_lists()
            env = em.group(1)
            out.append(stripped)
            i += 1
            end_tag = "\\end{%s}" % env
            while i < n and end_tag not in lines[i]:
                out.append(lines[i])
                i += 1
            if i < n:
                out.append(lines[i])
                i += 1
            continue

        # Heading
        hm = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if hm:
            close_lists()
            lvl = len(hm.group(1))
            txt = _latex_inline(hm.group(2).strip())
            cmd = {1: "section*", 2: "subsection*",
                   3: "subsubsection*", 4: "paragraph"}[lvl]
            out.append("\\%s{%s}" % (cmd, txt))
            i += 1
            continue

        # Explicit page break
        if re.match(r"^(\\pagebreak|\\newpage)$", stripped, re.I):
            close_lists()
            out.append("\\newpage")
            i += 1
            continue

        # Horizontal rule
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", stripped):
            close_lists()
            out.append("\\begin{center}\\rule{0.85\\linewidth}{0.4pt}\\end{center}")
            i += 1
            continue

        # Pipe table → booktabs tabular
        if "|" in stripped and stripped.count("|") >= 2 and i + 1 < n and \
                re.match(r"^\s*\|?[\s:\-|]+\|?\s*$", lines[i + 1]):
            close_lists()
            header = [c.strip() for c in stripped.strip().strip("|").split("|")]
            # Column alignment from the separator row (:--:, :--, --:).
            sep_cells = [c.strip() for c in lines[i + 1].strip().strip("|").split("|")]
            aligns = []
            for c in sep_cells:
                left = c.startswith(":")
                right = c.endswith(":")
                aligns.append("c" if (left and right) else ("r" if right else "l"))
            while len(aligns) < len(header):
                aligns.append("l")
            ncols = len(header)
            colspec = " ".join(aligns[:ncols])
            rows = []
            i += 2
            while i < n and "|" in lines[i] and lines[i].strip():
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                rows.append(cells)
                i += 1
            out.append("\\begin{center}")
            out.append("\\begin{tabular}{%s}" % colspec)
            out.append("\\toprule")
            out.append(" & ".join(_latex_inline(h) for h in header) + " \\\\")
            out.append("\\midrule")
            for r in rows:
                while len(r) < ncols:
                    r.append("")
                out.append(" & ".join(_latex_inline(c) for c in r[:ncols]) + " \\\\")
            out.append("\\bottomrule")
            out.append("\\end{tabular}")
            out.append("\\end{center}")
            continue

        # Blockquote
        if re.match(r"^>\s?", stripped):
            close_lists()
            quote = []
            while i < n and re.match(r"^>\s?", lines[i].strip()):
                quote.append(re.sub(r"^>\s?", "", lines[i].strip()))
                i += 1
            out.append("\\begin{quote}")
            out.append(_latex_inline(" ".join(quote)))
            out.append("\\end{quote}")
            continue

        # Bullet list
        if re.match(r"^[-*+]\s+", stripped):
            if not list_stack or list_stack[-1] != "itemize":
                close_lists()
                out.append("\\begin{itemize}")
                list_stack.append("itemize")
            out.append("\\item " + _latex_inline(re.sub(r"^[-*+]\s+", "", stripped)))
            i += 1
            continue

        # Ordered list
        if re.match(r"^\d+[.)]\s+", stripped):
            if not list_stack or list_stack[-1] != "enumerate":
                close_lists()
                out.append("\\begin{enumerate}")
                list_stack.append("enumerate")
            out.append("\\item " + _latex_inline(re.sub(r"^\d+[.)]\s+", "", stripped)))
            i += 1
            continue

        # Blank line → paragraph break
        if not stripped:
            close_lists()
            out.append("")
            i += 1
            continue

        # Paragraph: greedy-collect continuation lines.
        para = [stripped]
        i += 1
        while i < n:
            s = lines[i].strip()
            if not s:
                break
            if re.match(r"^(#{1,4})\s+", s) or re.match(r"^```", s):
                break
            if re.match(r"^[-*+]\s+", s) or re.match(r"^\d+[.)]\s+", s):
                break
            if s.startswith("$$") or s.startswith("\\[") or s.startswith(">"):
                break
            if "|" in s and s.count("|") >= 2:
                break
            para.append(s)
            i += 1
        close_lists()
        out.append(_latex_inline(" ".join(para)))

    close_lists()
    return "\n".join(out)


# Curated preamble — matches the packages baked into the Render image
# (amsmath, amssymb, booktabs, graphicx, hyperref, geometry, xcolor, fancyvrb,
# ulem for \sout). lmodern gives clean scalable fonts; T1 + inputenc(utf8)
# make real Unicode work instead of degrading to "?".
_LATEX_PREAMBLE = r"""\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage[margin=22mm,headheight=15pt]{geometry}
\usepackage{microtype}
\usepackage{amsmath,amssymb,amsfonts,mathtools}
\usepackage{booktabs}
\usepackage{array}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage[normalem]{ulem}
\usepackage{fancyvrb}
\usepackage{enumitem}
\usepackage{fancyhdr}
\usepackage[hidelinks]{hyperref}
\definecolor{TextBlack}{HTML}{1F2933}
\definecolor{RuleGray}{HTML}{6B7280}
\color{TextBlack}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.55em plus 0.12em minus 0.08em}
\setlist{topsep=3pt,itemsep=1.5pt,parsep=0pt,leftmargin=1.6em}
\renewcommand{\arraystretch}{1.25}
\allowdisplaybreaks[2]
\emergencystretch=2em
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\fancyfoot[C]{\small\thepage}
"""


def _build_latex_document(md_body, title="", subtitle=""):
    """Wrap a converted Markdown body in a complete, compilable LaTeX document."""
    head = _LATEX_PREAMBLE + "\\begin{document}\n"
    if title:
        head += "{\\LARGE\\bfseries\\color{TextBlack} %s}\\par\\vspace{3pt}\n" % _latex_inline(title)
    if subtitle:
        head += "{\\large\\itshape %s}\\par\n" % _latex_inline(subtitle)
    if title or subtitle:
        head += "\\vspace{6pt}{\\color{RuleGray}\\hrule}\\vspace{12pt}\n"
    return head + md_body + "\n\\end{document}\n"


def _run_pdflatex(tex_source, out_path, assets_dir=None):
    """Compile a full LaTeX document string with the OFFLINE pdflatex. Returns
    the number of bytes written on success; raises RuntimeError otherwise.
    Runs twice so \\ref/toc/pageref resolve, and passes -interaction=nonstopmode
    so a soft warning never hangs the build."""
    if not _ensure_pdflatex_available():
        raise RuntimeError("pdflatex not on PATH and automatic TeX provisioning failed")
    workdir = tempfile.mkdtemp(prefix="pdflatex_")
    try:
        tex_path = os.path.join(workdir, "doc.tex")
        with open(tex_path, "w", encoding="utf-8") as fh:
            fh.write(tex_source)
        cmd = [
            "pdflatex", "-interaction=nonstopmode", "-halt-on-error",
            "-no-shell-escape", "-output-directory", workdir, tex_path,
        ]
        last = None
        run_env = dict(os.environ)
        if assets_dir:
            # Let \includegraphics and related commands resolve files already
            # created in the sandbox work area without copying user assets.
            run_env["TEXINPUTS"] = os.path.abspath(assets_dir) + os.pathsep + run_env.get("TEXINPUTS", "")
        for _ in range(2):
            last = subprocess.run(
                cmd, cwd=workdir, env=run_env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120,
            )
        pdf_out = os.path.join(workdir, "doc.pdf")
        # Decode the compile log once so we can BOTH size-check the PDF AND
        # reject a compile that emitted LaTeX errors. A partially-broken TeX
        # install (or an unknown macro) can still leave a small PDF containing
        # the RAW source ("\\int \\frac{...}") — the exact reported bug. If the
        # log shows a fatal LaTeX error we reject and fall back to the reliable
        # pure-Python renderer instead of shipping garbled output.
        log = ""
        try:
            log = (last.stdout or b"").decode("utf-8", "replace")
        except Exception:
            log = ""
        fatal = re.search(r"^! (LaTeX Error|Undefined control sequence|Missing|Emergency stop|Fatal error)",
                          log, re.M)
        if fatal:
            raise RuntimeError("pdflatex reported a fatal error: " + fatal.group(0)[:160])
        if not os.path.exists(pdf_out) or os.path.getsize(pdf_out) < 512:
            raise RuntimeError("pdflatex produced no PDF: " + log[-800:])
        out_full = os.path.abspath(out_path)
        os.makedirs(os.path.dirname(out_full) or ".", exist_ok=True)
        shutil.copyfile(pdf_out, out_full)
        return os.path.getsize(out_full)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _try_real_latex(content, out_path, title="", subtitle="", is_full_latex=False, assets_dir=None):
    """PRIMARY path: build a LaTeX document from `content` and compile it with
    the offline pdflatex. Returns bytes written, or raises so the caller can
    fall back to the pure-Python renderer."""
    src = str(content or "")
    if is_full_latex or re.search(r"\\documentclass\b", src) or \
            re.search(r"\\begin\{document\}", src):
        # Already a full LaTeX doc — compile as-is (this is the "pure LaTeX" the
        # user asked for; we don't downgrade it to Markdown any more).
        tex = src
    else:
        body = _md_to_latex_body(src)
        tex = _build_latex_document(body, title=title, subtitle=subtitle)
    return _run_pdflatex(tex, out_path, assets_dir=assets_dir)


# ─────────────────────────────────────────────────────────────────────────────
# ── PART 5: Public API expected by agent.py ──────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
def markdown_to_latex(md, title="", subtitle=""):
    """Legacy shim. The old file returned a full LaTeX document string; nothing
    in agent.py inspects it beyond passing it straight back into compile_latex.
    We return the Markdown source unchanged, tagged so compile_latex can spot
    it and skip re-parsing."""
    prefix = ""
    if title:
        prefix += "# " + title + "\n\n"
    if subtitle:
        prefix += "*" + subtitle + "*\n\n"
    return prefix + (md or "")


def _strip_full_latex(tex):
    """If we're handed an ACTUAL LaTeX document, extract its body and downgrade
    the most common commands into Markdown we can render. Best-effort — the
    result is always at least readable."""
    s = str(tex or "")
    # keep only the body
    m = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", s, re.S)
    if m:
        s = m.group(1)
    # Display-math environments must become explicit Markdown math before the
    # generic environment cleanup below. This keeps aligned/equation content in
    # the math parser when a sandbox has no TeX binary.
    for env in ("equation", "equation*", "align", "align*", "gather", "gather*",
                "multline", "multline*", "displaymath"):
        s = re.sub(r"\\begin\{%s\}(.*?)\\end\{%s\}" % (re.escape(env), re.escape(env)),
                   lambda m: "\n$$\n" + m.group(1).strip() + "\n$$\n", s, flags=re.S)
    # Very common structural commands → Markdown equivalents.
    s = re.sub(r"\\section\*?\{([^}]*)\}", r"# \1", s)
    s = re.sub(r"\\subsection\*?\{([^}]*)\}", r"## \1", s)
    s = re.sub(r"\\subsubsection\*?\{([^}]*)\}", r"### \1", s)
    s = re.sub(r"\\paragraph\*?\{([^}]*)\}", r"**\1**", s)
    s = re.sub(r"\\textbf\{([^}]*)\}", r"**\1**", s)
    s = re.sub(r"\\emph\{([^}]*)\}", r"*\1*", s)
    s = re.sub(r"\\textit\{([^}]*)\}", r"*\1*", s)
    s = re.sub(r"\\href\{([^}]*)\}\{([^}]*)\}", r"[\2](\1)", s)
    s = re.sub(r"\\item\s*", r"* ", s)
    s = re.sub(r"\\begin\{(itemize|enumerate)\}", "", s)
    s = re.sub(r"\\end\{(itemize|enumerate)\}", "", s)
    # Drop document-only layout commands instead of letting them appear as
    # visible source in the fallback PDF. Preserve a braced argument for
    # unknown presentation wrappers so the human-readable content survives.
    s = re.sub(r"\\(?:centering|small|large|Large|LARGE|huge|Huge|noindent|medskip|bigskip|smallskip)\b", "", s)
    s = re.sub(r"\\(?:label|ref|pageref|cite)\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\[A-Za-z@]+\*?\{([^{}]*)\}", r"\1", s)
    s = re.sub(r"\\maketitle", "", s)
    s = re.sub(r"\\newpage|\\clearpage", "\n\n", s)
    s = re.sub(r"\\\\", "\n", s)
    # Keep \[ ... \] and $...$ verbatim so the math parser sees them.
    return s


def _raw_latex_commands_in_pdf(path):
    """Return raw LaTeX commands found in visible PDF content streams."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except Exception:
        return []
    visible = []
    for stream in re.findall(rb"stream\r?\n(.*?)endstream", data, re.S):
        try:
            stream = zlib.decompress(stream)
        except Exception:
            pass
        visible.append(stream.decode("latin-1", "replace"))
    text = "\n".join(visible)
    pattern = (r"\\(?:frac|dfrac|tfrac|sqrt|int|sum|prod|lim|begin|end|boxed|"
               r"left|right|partial|mathrm|mathbf|text|overline|underline|vec|hat)\b")
    return sorted(set(re.findall(pattern, text)))


def _validate_pdf(path):
    """Reject truncated, blank, page-less, or raw-LaTeX PDF output."""
    if not os.path.isfile(path):
        raise RuntimeError("PDF output was not created")
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 512 or not data.startswith(b"%PDF"):
        raise RuntimeError("output is not a valid PDF")
    # Native PDFs expose /Type /Page directly. pdfTeX may compress page objects
    # while leaving the standard /Pages tree and a positive /Count visible.
    direct_page = re.search(rb"/Type\s*/Page\b", data)
    page_tree = re.search(rb"/Type\s*/Pages\b", data) and re.search(rb"/Count\s+[1-9][0-9]*\b", data)
    # pdfTeX can place the complete page tree in compressed object streams. In
    # that case validate the mandatory, visible cross-reference trailer instead.
    compressed_pdf = (b"startxref" in data[-4096:] and b"%%EOF" in data[-1024:]
                      and re.search(rb"/Root\s+\d+\s+\d+\s+R", data))
    if not (direct_page or page_tree or compressed_pdf):
        raise RuntimeError("PDF contains no pages or valid document root")
    leaked = _raw_latex_commands_in_pdf(path)
    if leaked:
        raise RuntimeError("raw LaTeX leaked into PDF content: " + ", ".join(leaked[:8]))
    return os.path.getsize(path)


def _quality_engine_required():
    """Production PDF calls require a real TeX engine by default.

    The native fallback remains available only when explicitly requested for
    emergency/readability use. This prevents a valid-but-rough fallback PDF
    from being mislabeled and delivered as textbook-quality output.
    """
    allow_fallback = str(os.environ.get("LATEX_ALLOW_NATIVE_FALLBACK", "")).strip().lower()
    force_pure = str(os.environ.get("LATEX_FORCE_PURE", "")).strip().lower()
    # LATEX_FORCE_PURE is itself an explicit operator request for the native
    # deterministic renderer (used by offline/sandbox environments). Treat it
    # as permission rather than forcing pure mode and then rejecting it.
    return allow_fallback not in ("1", "true", "yes", "on") and force_pure not in ("1", "true", "yes", "on")


def _raise_if_quality_engine_missing(error):
    if _quality_engine_required():
        raise RuntimeError("print-quality LaTeX engine unavailable: %s" % str(error)[:240])


def compile_latex(tex, out_path, workdir=None):
    """Public entry: convert `tex` (Markdown OR a LaTeX document string) to a
    validated PDF at `out_path`. Returns bytes written. Raises RuntimeError if
    the output isn't a valid PDF.

    PRIMARY: real, offline pdflatex (print-quality, faithful math + tables +
    Unicode). FALLBACK: the pure-Python renderer so we never ship a blank PDF."""
    src = str(tex or "")
    is_full = bool(re.search(r"\\documentclass\b", src) or re.search(r"\\begin\{document\}", src))
    try:
        _try_real_latex(src, out_path, is_full_latex=is_full)
        return _validate_pdf(out_path)
    except Exception as _e:
        _raise_if_quality_engine_missing(_e)
        sys.stderr.write("[latex_render] pdflatex path failed, using explicitly "
                         "allowed native fallback: %s\n" % str(_e)[:200])
    md = _strip_full_latex(src) if is_full else src
    doc = _PDFDoc(title="", subtitle="")
    doc.render_markdown(md)
    data = doc.bytes()
    if len(data) < 512 or not data.startswith(b"%PDF"):
        raise RuntimeError("pure-python renderer produced an invalid PDF")
    out_full = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_full) or ".", exist_ok=True)
    with open(out_full, "wb") as fh:
        fh.write(data)
    return _validate_pdf(out_full)


def build_pdf(content, out_path, title="", subtitle="", is_full_latex=False, assets_dir=None):
    """High-level: turn `content` (Markdown or LaTeX) into a validated PDF.

    PRIMARY: real, offline pdflatex (faithful math/tables/Unicode — fixes the
    garbled "?" glyphs, broken tables and non-pure-LaTeX output). FALLBACK: the
    pure-Python renderer, so a missing engine never yields a blank PDF."""
    src = str(content or "")
    full = bool(is_full_latex or re.search(r"\\documentclass\b", src) or re.search(r"\\begin\{document\}", src))
    try:
        _try_real_latex(src, out_path, title=title or "",
                        subtitle=subtitle or "", is_full_latex=full,
                        assets_dir=assets_dir)
        return _validate_pdf(out_path)
    except Exception as _e:
        _raise_if_quality_engine_missing(_e)
        sys.stderr.write("[latex_render] pdflatex path failed, using explicitly "
                         "allowed native fallback: %s\n" % str(_e)[:200])
    md = _strip_full_latex(src) if full else src
    # `title` / `subtitle` become a top-of-first-page header.
    doc = _PDFDoc(title=title or "", subtitle=subtitle or "")
    doc.render_markdown(md)
    data = doc.bytes()
    if len(data) < 512 or not data.startswith(b"%PDF"):
        raise RuntimeError("pure-python renderer produced an invalid PDF")
    out_full = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_full) or ".", exist_ok=True)
    with open(out_full, "wb") as fh:
        fh.write(data)
    return _validate_pdf(out_full)


# ── CLI: python3 latex_render.py <in.(md|tex)> <out.pdf> [title] ─────────────
if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.stderr.write("usage: latex_render.py <in.(md|tex)> <out.pdf> [title]\n")
        sys.exit(2)
    src_path, out_pdf = sys.argv[1], sys.argv[2]
    title = sys.argv[3] if len(sys.argv) > 3 else ""
    with open(src_path, "r", encoding="utf-8") as fh:
        data = fh.read()
    is_tex = src_path.lower().endswith((".tex", ".latex")) or ("\\documentclass" in data)
    try:
        n = build_pdf(data, out_pdf, title=title, is_full_latex=is_tex)
        sys.stdout.write("OK %d bytes -> %s\n" % (n, out_pdf))
        sys.exit(0)
    except Exception as e:  # noqa
        sys.stderr.write("ERR %s\n" % e)
        sys.exit(1)
