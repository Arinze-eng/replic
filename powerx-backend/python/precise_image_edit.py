#!/usr/bin/env python3
"""Deterministic, sandbox-safe raster image editor.

Consumes a JSON job and performs ordered edits with Pillow/OpenCV/rembg. Every
result is reopened and validated before success is reported. No generative image
model is used.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageColor, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps, ImageStat
except Exception as exc:
    raise SystemExit("Pillow is required: %s" % exc)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def safe_path(root: Path, value: str) -> Path:
    p = (root / str(value)).resolve() if not os.path.isabs(str(value)) else Path(value).resolve()
    if p != root and root not in p.parents:
        raise ValueError("path outside working directory")
    return p


def rgba(value, default=(255, 255, 255, 255)):
    if value is None:
        return default
    try:
        c = ImageColor.getcolor(str(value), "RGBA")
        return tuple(c)
    except Exception:
        if isinstance(value, (list, tuple)) and 3 <= len(value) <= 4:
            return tuple(int(x) for x in value) + (() if len(value) == 4 else (255,))
        raise ValueError("invalid color: %r" % (value,))


def font_for(size: int, font_path: str | None = None):
    candidates = [
        font_path,
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            try:
                return ImageFont.truetype(candidate, max(6, int(size)))
            except Exception:
                continue
    return ImageFont.load_default()


def normalized_words(value: str):
    return re.findall(r"[\w]+", str(value).casefold(), flags=re.UNICODE)


def text_length(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return max(0, box[2] - box[0]), max(0, box[3] - box[1])


def fit_font(draw, text, preferred_size, max_width, max_height, font_path=None, minimum=6):
    size = max(minimum, int(preferred_size))
    while size > minimum:
        font = font_for(size, font_path)
        tw, th = text_length(draw, text, font)
        if tw <= max_width and th <= max_height:
            return font, size, tw, th
        size -= 1
    font = font_for(minimum, font_path)
    tw, th = text_length(draw, text, font)
    return font, minimum, tw, th


def fit_size(current, op):
    w, h = current
    width = op.get("width")
    height = op.get("height")
    if width is None and height is None:
        raise ValueError("resize requires width or height")
    if op.get("keep_aspect", True):
        if width is None:
            width = max(1, round(w * int(height) / h))
        elif height is None:
            height = max(1, round(h * int(width) / w))
        elif op.get("fit") in ("contain", "inside"):
            ratio = min(int(width) / w, int(height) / h)
            width, height = max(1, round(w * ratio)), max(1, round(h * ratio))
    return int(width), int(height)


def remove_background(im: Image.Image, op):
    try:
        from rembg import remove
        out = remove(im.convert("RGBA"))
        if not isinstance(out, Image.Image):
            from io import BytesIO
            out = Image.open(BytesIO(out)).convert("RGBA")
        return out, "rembg"
    except Exception:
        # Deterministic fallback for flat/near-flat backgrounds. Estimate the
        # background from border pixels and feather a color-distance alpha mask.
        src = im.convert("RGBA")
        rgb = src.convert("RGB")
        w, h = rgb.size
        border = []
        step = max(1, min(w, h) // 100)
        for x in range(0, w, step):
            border += [rgb.getpixel((x, 0)), rgb.getpixel((x, h - 1))]
        for y in range(0, h, step):
            border += [rgb.getpixel((0, y)), rgb.getpixel((w - 1, y))]
        bg = tuple(int(sum(c[i] for c in border) / len(border)) for i in range(3))
        threshold = float(op.get("threshold", 28))
        feather = max(1.0, float(op.get("feather", 18)))
        alpha = Image.new("L", (w, h), 255)
        ap = alpha.load(); px = rgb.load()
        for y in range(h):
            for x in range(w):
                c = px[x, y]
                d = math.sqrt(sum((c[i] - bg[i]) ** 2 for i in range(3)))
                ap[x, y] = int(max(0, min(255, (d - threshold) * 255 / feather)))
        src.putalpha(alpha.filter(ImageFilter.GaussianBlur(float(op.get("edge_blur", 0.8)))))
        return src, "border-color-mask"


def locate_text_box(image_path: Path, text: str):
    """Locate a complete OCR phrase, allowing punctuation and split words."""
    try:
        import pytesseract
        data = pytesseract.image_to_data(str(image_path), output_type=pytesseract.Output.DICT, config="--psm 6")
        wanted = normalized_words(text)
        if not wanted:
            return None
        rows = {}
        for i, raw in enumerate(data.get("text", [])):
            words = normalized_words(raw)
            try:
                confidence = float(data.get("conf", [0] * len(data["text"]))[i])
            except Exception:
                confidence = 0
            if not words or confidence < 0:
                continue
            key = (data.get("block_num", [0])[i], data.get("par_num", [0])[i], data.get("line_num", [0])[i])
            rows.setdefault(key, []).append({
                "words": words, "left": int(data["left"][i]), "top": int(data["top"][i]),
                "width": int(data["width"][i]), "height": int(data["height"][i]),
            })
        # Match a contiguous sequence on a line. OCR normally returns one token
        # per item, but each item may normalize to multiple words.
        for items in rows.values():
            flat = []
            for item in items:
                for word in item["words"]:
                    flat.append((word, item))
            for start in range(len(flat)):
                if [x[0] for x in flat[start:start + len(wanted)]] != wanted:
                    continue
                matched = [x[1] for x in flat[start:start + len(wanted)]]
                left = min(x["left"] for x in matched); top = min(x["top"] for x in matched)
                right = max(x["left"] + x["width"] for x in matched)
                bottom = max(x["top"] + x["height"] for x in matched)
                return [left, top, right - left, bottom - top]
    except Exception:
        return None
    return None


def surrounding_color(im: Image.Image, box, distance=3):
    """Estimate a local solid background from a ring around a text box."""
    x, y, w, h = box
    rgb = im.convert("RGB")
    left, top = max(0, x - distance), max(0, y - distance)
    right, bottom = min(rgb.width - 1, x + w + distance), min(rgb.height - 1, y + h + distance)
    pixels = []
    for xx in range(left, right + 1):
        pixels.extend((rgb.getpixel((xx, top)), rgb.getpixel((xx, bottom))))
    for yy in range(top, bottom + 1):
        pixels.extend((rgb.getpixel((left, yy)), rgb.getpixel((right, yy))))
    if not pixels:
        return (255, 255, 255, 255)
    values = [sorted(p[i] for p in pixels)[len(pixels) // 2] for i in range(3)]
    return tuple(values) + (255,)


def parse_position(op, base_size, item_size=(0, 0)):
    bw, bh = base_size; iw, ih = item_size
    pos = str(op.get("position", "top-left")).lower()
    margin = int(op.get("margin", 20))
    presets = {
        "top-left": (margin, margin), "top-right": (bw - iw - margin, margin),
        "bottom-left": (margin, bh - ih - margin), "bottom-right": (bw - iw - margin, bh - ih - margin),
        "center": ((bw - iw) // 2, (bh - ih) // 2),
    }
    return int(op.get("x", presets.get(pos, (margin, margin))[0])), int(op.get("y", presets.get(pos, (margin, margin))[1]))


def apply_operation(im: Image.Image, op: dict, root: Path, source_path: Path):
    kind = str(op.get("type") or op.get("op") or "").strip().lower().replace("-", "_")
    if kind == "resize":
        size = fit_size(im.size, op)
        return im.resize(size, Image.Resampling.LANCZOS), {"type": kind, "size": list(size)}
    if kind in ("thumbnail", "fit"):
        out = im.copy(); out.thumbnail((int(op["width"]), int(op["height"])), Image.Resampling.LANCZOS)
        return out, {"type": kind, "size": list(out.size)}
    if kind == "crop":
        if "box" in op:
            box = tuple(map(int, op["box"]))
        else:
            x, y = int(op.get("x", 0)), int(op.get("y", 0))
            box = (x, y, x + int(op["width"]), y + int(op["height"]))
        if box[0] < 0 or box[1] < 0 or box[2] > im.width or box[3] > im.height or box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError("crop box outside image: %r for %r" % (box, im.size))
        return im.crop(box), {"type": kind, "box": list(box)}
    if kind == "rotate":
        degrees = float(op.get("degrees", op.get("angle", 0)))
        return im.rotate(-degrees, expand=bool(op.get("expand", True)), resample=Image.Resampling.BICUBIC), {"type": kind, "degrees": degrees}
    if kind in ("flip_horizontal", "mirror"):
        return ImageOps.mirror(im), {"type": kind}
    if kind == "flip_vertical":
        return ImageOps.flip(im), {"type": kind}
    if kind in ("grayscale", "greyscale"):
        return ImageOps.grayscale(im).convert("RGBA"), {"type": "grayscale"}
    if kind == "blur":
        radius = float(op.get("radius", 4)); return im.filter(ImageFilter.GaussianBlur(radius)), {"type": kind, "radius": radius}
    if kind == "sharpen":
        radius = float(op.get("radius", 2)); percent = int(op.get("percent", 150))
        return im.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=int(op.get("threshold", 3)))), {"type": kind, "radius": radius, "percent": percent}
    if kind in ("brightness", "contrast", "saturation"):
        factor = float(op.get("factor", 1.0))
        cls = {"brightness": ImageEnhance.Brightness, "contrast": ImageEnhance.Contrast, "saturation": ImageEnhance.Color}[kind]
        return cls(im).enhance(factor), {"type": kind, "factor": factor}
    if kind in ("remove_background", "background_remove"):
        out, engine = remove_background(im, op); return out, {"type": "remove_background", "engine": engine}
    if kind in ("add_text", "watermark", "annotate"):
        out = im.convert("RGBA"); draw = ImageDraw.Draw(out)
        text = str(op.get("text", "")); size = int(op.get("font_size", max(14, im.width // 25)))
        font = font_for(size, op.get("font")); box = draw.textbbox((0, 0), text, font=font, stroke_width=int(op.get("stroke_width", 0)))
        x, y = parse_position(op, out.size, (box[2] - box[0], box[3] - box[1]))
        if op.get("background"):
            pad = int(op.get("padding", 6)); draw.rectangle((x-pad, y-pad, x+box[2]-box[0]+pad, y+box[3]-box[1]+pad), fill=rgba(op["background"]))
        draw.text((x, y), text, font=font, fill=rgba(op.get("color", "white")), stroke_width=int(op.get("stroke_width", 0)), stroke_fill=rgba(op.get("stroke_color", "black")))
        return out, {"type": "add_text", "text": text, "position": [x, y]}
    if kind in ("overlay", "composite", "add_image"):
        overlay_path = safe_path(root, op.get("source") or op.get("image"))
        layer = Image.open(overlay_path).convert("RGBA")
        if op.get("width") or op.get("height"):
            layer = layer.resize(fit_size(layer.size, op), Image.Resampling.LANCZOS)
        opacity = float(op.get("opacity", 1.0))
        if opacity < 1:
            layer.putalpha(layer.getchannel("A").point(lambda p: round(p * max(0, opacity))))
        out = im.convert("RGBA"); x, y = parse_position(op, out.size, layer.size); out.alpha_composite(layer, (x, y))
        return out, {"type": "overlay", "source": overlay_path.name, "position": [x, y], "size": list(layer.size)}
    if kind in ("replace_text", "edit_text"):
        out = im.convert("RGBA"); box = op.get("box")
        located_by = "explicit_box"
        if not box and op.get("old_text"):
            box = locate_text_box(source_path, str(op["old_text"])); located_by = "ocr_phrase"
        if not box:
            raise ValueError("replace_text could not locate the complete old_text; provide box [x,y,width,height]")
        x, y, w, h = map(int, box)
        if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > out.width or y + h > out.height:
            raise ValueError("replace_text box outside image")
        text = str(op.get("new_text", op.get("text", ""))).strip()
        if not text:
            raise ValueError("replace_text requires non-empty new_text")
        pad = max(1, int(op.get("padding", max(2, round(h * 0.18)))))
        # Longer replacement text may legitimately need more horizontal room.
        # Keep the anchor fixed and use available line space instead of crushing
        # the font into the width of the old phrase.
        max_right = min(out.width - 1, int(op.get("max_width", out.width - x - pad)) + x)
        clear_right = max(x + w + pad, max_right if len(text) > len(str(op.get("old_text", ""))) else x + w + pad)
        clear_right = min(out.width - 1, clear_right)
        clear = [max(0, x - pad), max(0, y - pad), clear_right, min(out.height - 1, y + h + pad)]
        draw = ImageDraw.Draw(out)
        bg = rgba(op.get("background"), surrounding_color(out, [x, y, w, h], pad + 2))
        draw.rectangle(tuple(clear), fill=bg)
        preferred = int(op.get("font_size", max(8, round(h * 1.15))))
        available_width = max(1, clear[2] - x)
        available_height = max(h + pad * 2, preferred + pad)
        font, size, tw, th = fit_font(draw, text, preferred, available_width, available_height, op.get("font"))
        if tw > available_width:
            raise ValueError("replacement text does not fit available line width; provide a smaller font_size or wider box")
        color = rgba(op.get("color", "black"))
        baseline_y = max(clear[1], y + (h - th) // 2)
        draw.text((x, baseline_y), text, font=font, fill=color)
        return out, {
            "type": "replace_text", "box": [x, y, w, h], "clear_box": clear,
            "new_text": text, "font_size": size, "located_by": located_by,
        }
    if kind in ("strip_metadata", "remove_exif"):
        # copy() preserves decoded pixels but save_image intentionally omits the
        # source EXIF/ICC metadata when writing the new file.
        return im.copy(), {"type": "strip_metadata"}
    raise ValueError("unsupported operation: %s" % kind)


def save_image(im: Image.Image, output: Path, job: dict):
    output.parent.mkdir(parents=True, exist_ok=True)
    ext = output.suffix.lower()
    kwargs = {}
    if ext in (".jpg", ".jpeg"):
        im = im.convert("RGB"); kwargs = {"quality": int(job.get("quality", 92)), "optimize": True, "progressive": True}
    elif ext == ".webp":
        kwargs = {"quality": int(job.get("quality", 90)), "method": 6}
    elif ext == ".png":
        kwargs = {"optimize": True, "compress_level": int(job.get("compress_level", 6))}
    im.save(output, **kwargs)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("job"); ap.add_argument("--workdir", default=".")
    args = ap.parse_args(); root = Path(args.workdir).resolve()
    job_path = safe_path(root, args.job); job = json.loads(job_path.read_text("utf-8"))
    source = safe_path(root, job["source"]); output = safe_path(root, job["output"])
    if source.suffix.lower() not in IMAGE_EXTS or not source.is_file(): raise ValueError("source image not found")
    original = Image.open(source); original.load(); im = original.convert("RGBA")
    applied = []
    for op in job.get("operations", []):
        im, detail = apply_operation(im, op, root, source); applied.append(detail)
    if not applied: raise ValueError("at least one operation is required")
    save_image(im, output, job)
    # Mandatory read-back QA.
    check = Image.open(output); check.load()
    if check.width < 1 or check.height < 1: raise ValueError("invalid output dimensions")
    if output.stat().st_size < 32: raise ValueError("output is unexpectedly empty")
    if any(x["type"] == "remove_background" for x in applied):
        if "A" not in check.getbands(): raise ValueError("background removal output has no alpha channel")
        extrema = check.getchannel("A").getextrema()
        if extrema[0] >= 255: raise ValueError("background removal produced no transparent pixels")
    report = {"ok": True, "source": source.name, "output": output.name, "before": {"size": list(original.size), "mode": original.mode}, "after": {"size": list(check.size), "mode": check.mode, "bytes": output.stat().st_size}, "operations": applied}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    try: main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        raise
