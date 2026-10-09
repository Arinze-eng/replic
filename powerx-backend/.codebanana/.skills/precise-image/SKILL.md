---
name: precise-image
description: |
  Deterministic, pixel-precise image & media editing INSIDE the sandbox using
  ImageMagick + Pillow + OpenCV + rembg + FFmpeg. Use this for EXACT, reliable
  edits that AI diffusion models can't guarantee: resize, crop, rotate/transform,
  blur/sharpen, recolor, grayscale, format-convert, watermark/annotate, compose,
  background removal, thumbnails, EXIF strip, adding/positioning source images,
  and replacing text in known/OCR-located regions.
  Triggers:
  - "resize / crop / rotate / flip / blur / sharpen this image"
  - "remove the background", "make it transparent PNG"
  - "convert to jpg/webp/png/pdf", "compress this image"
  - "add text/watermark/logo to the image", "make a thumbnail"
  - "turn this image into a video", "extract a frame"
  - any EXACT/precise image manipulation where dimensions or pixels matter
---

# Precise Image Editing (sandbox toolchain)

You do REAL, deterministic image editing in the sandbox — not a diffusion guess.
For every image-editing request, use THIS skill and the deterministic `edit_image`
tool. `edit_image` no longer uses generative AI: it executes explicit operations
inside the selected sandbox and validates the output before delivery. If a request
would require inventing pixels, require a source image/mask/coordinates instead
of silently switching to an AI image editor.

## 0) ALWAYS: install the toolchain first (idempotent, verified)

Your FIRST `run_code` (bash) step for any image task:

```bash
set -e
export DEBIAN_FRONTEND=noninteractive
# System binaries
command -v convert >/dev/null 2>&1 || command -v magick >/dev/null 2>&1 || \
  { sudo apt-get update -qq 2>/dev/null || apt-get update -qq; \
    (sudo apt-get install -y -qq imagemagick ffmpeg libgl1 libglib2.0-0 2>&1 || \
     apt-get install -y -qq imagemagick ffmpeg libgl1 libglib2.0-0 2>&1) | tail -2; }
command -v ffmpeg >/dev/null 2>&1 || (apt-get install -y -qq ffmpeg 2>&1 | tail -1)
# Python stack (pip first — PEP-668 safe)
python3 - <<'PY' 2>/dev/null || pip install --break-system-packages -q Pillow numpy opencv-python-headless 2>&1 | tail -1
import PIL, numpy, cv2
PY
python3 -c "import rembg" 2>/dev/null || \
  pip install --break-system-packages -q "rembg[cpu]" onnxruntime 2>&1 | tail -1 || true
# Verify
echo "convert: $(command -v convert || command -v magick || echo MISSING)"
echo "ffmpeg:  $(command -v ffmpeg || echo MISSING)"
python3 -c "import PIL,numpy,cv2;print('PIL',PIL.__version__,'cv2',cv2.__version__)"
python3 -c "import rembg;print('rembg ok')" 2>/dev/null || echo "rembg optional-missing"
```

Rules:
- NEVER say a tool is missing — install it (apt → pip → build). Tools persist in the session.
- If `apt` needs root and you're not root, prefix `sudo`. On Novita/HopX/Daytona you are root.
- `convert` may be `magick` on newer ImageMagick 7 — try both.

## 1) Operation cookbook (VERIFIED commands — copy exactly)

Assume the user's image is at `input.png` (use the actual attached filename).
Always write results with a descriptive name and let the runtime deliver them.

### Pillow (best for resize / crop / blur / format / thumbnail / text)
```python
from PIL import Image, ImageFilter, ImageDraw, ImageFont, ImageOps
im = Image.open("input.png")

# RESIZE (high quality). Keep aspect: give ONE dim, compute the other.
im.resize((320, 240), Image.LANCZOS).save("resized.png")
# CROP: exact pixel box (left, top, right, bottom)
im.crop((100, 100, 500, 500)).save("cropped.png")
# THUMBNAIL (fit within box, keep aspect)
t = im.copy(); t.thumbnail((256, 256), Image.LANCZOS); t.save("thumb.png")
# BLUR (precise Gaussian radius) / SHARPEN
im.filter(ImageFilter.GaussianBlur(8)).save("blurred.png")
im.filter(ImageFilter.UnsharpMask(radius=2, percent=150)).save("sharp.png")
# GRAYSCALE, FLIP, AUTO-CONTRAST
ImageOps.grayscale(im).save("gray.png")
ImageOps.mirror(im).save("flip_h.png"); ImageOps.flip(im).save("flip_v.png")
# FORMAT CONVERT + COMPRESS (control quality/size)
im.convert("RGB").save("out.jpg", quality=85, optimize=True)
im.save("out.webp", quality=80)
# ADD TEXT / WATERMARK
d = ImageDraw.Draw(im)
d.text((20, 20), "WATERMARK", fill=(255,255,255))
im.save("watermarked.png")
```

### OpenCV (best for rotate/affine/perspective, precise numeric transforms)
```python
import cv2, numpy as np
img = cv2.imread("input.png")           # BGR
h, w = img.shape[:2]
# ROTATE by exact degrees around center (keeps size)
M = cv2.getRotationMatrix2D((w/2, h/2), 30, 1.0)
cv2.imwrite("rotated.png", cv2.warpAffine(img, M, (w, h)))
# PERSPECTIVE / straighten (4-point transform) — set src/dst quads
# RESIZE with interpolation control
cv2.imwrite("cv_resize.png", cv2.resize(img, (640,480), interpolation=cv2.INTER_AREA))
```

### ImageMagick (one-liners; great for batch & PDF)
```bash
convert input.png -resize 320x240 resized.png          # or 50%
convert input.png -crop 400x400+100+100 +repage crop.png
convert input.png -rotate 30 rotated.png
convert input.png -blur 0x8 blurred.png
convert input.png -colorspace Gray gray.png
convert *.png output.pdf                                # images -> PDF
convert input.png -quality 82 out.jpg
```

### rembg (segmentation-based BACKGROUND REMOVAL → transparent PNG)
```python
from rembg import remove
from PIL import Image
Image.open("input.png").convert("RGBA")  # ensure RGBA
with open("input.png","rb") as f: data = f.read()
open("nobg.png","wb").write(remove(data))   # transparent-background PNG
```
Fallback if rembg can't install: use OpenCV GrabCut or a chroma/threshold mask.

### FFmpeg (image ↔ video, frame extraction)
```bash
ffmpeg -y -loop 1 -i input.png -t 3 -vf "scale=1280:720" -pix_fmt yuv420p out.mp4
ffmpeg -y -i clip.mp4 -vf "select=eq(n\,0)" -vframes 1 frame.png   # extract a frame
```

## 2) Method — plan, do, VERIFY (mandatory)

1. Identify the source image (attached filename) and the EXACT requested op(s).
2. Install the toolchain (step 0).
3. Prefer one `edit_image` call with an ordered `operations` list; inspect the image
   and calculate exact boxes/coordinates for overlays and text replacement.
4. VERIFY the result programmatically before finishing — re-open it and assert the
   change actually happened:
   ```python
   from PIL import Image
   o = Image.open("resized.png")
   assert o.size == (320,240), o.size          # size assertion
   print("verified", o.size, o.mode)
   ```
   For background removal, assert the output has an alpha channel and some
   transparent pixels. For crop, assert the new dimensions. NEVER claim success
   without this read-back proof.
5. Deliver the output file(s) and state exactly what changed (old→new size, radius, etc.).

## 3) Quality bar
- Preserve everything not asked to change. Use LANCZOS/INTER_AREA for downscale
  (no aliasing), keep aspect ratio unless told otherwise.
- Keep max fidelity: PNG for graphics/transparency, high-quality JPEG/WebP for photos.
- Report the concrete numbers (dimensions, quality, radius, format) in the final message.
