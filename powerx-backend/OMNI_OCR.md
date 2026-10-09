# Inbound File Pipeline — Sandbox OCR

This document describes how user-submitted files (sent to the WhatsApp / Telegram
bots) are processed into text for the AI (HotBot / Gemini).

## Pipeline overview

When a user sends a file, the agent (`services/agentEngine.js`) routes it through
`services/simpleOcr.js`, which has TWO layers (in priority order):

### 1) Sandbox OCR (primary — when a sandbox is active)

Runs the self-contained Python extractor **`python/ocr_extract.py`** INSIDE the
active sandbox (GitHub Actions runner w/ root, Novita, Daytona, HopX, or the
local host). It installs `tesseract-ocr` + `poppler-utils` + the Python deps on
demand (idempotent, cached per session) and does high-accuracy extraction:

| Input type | How it's handled |
|---|---|
| **Image with text** (screenshot, doc photo, receipt, dense past-questions) | Tesseract with OpenCV preprocessing (upscale → deskew → denoise → adaptive/Otsu threshold) + a **multi-pass PSM strategy** (PSM 6/4/3/11) that keeps the best result. This recovers **ALL** text on a busy page — e.g. a full past-question paper with many questions is transcribed completely, not just one question. |
| **Pure image** (a photo, no real text) | Sandbox reports `has_text:false` → caller sends it to the vision model (Gemini/HotBot) for description. |
| **PDF** | Native text layer via PyMuPDF; image-only / scanned pages are rasterized at ~300 DPI and OCR'd page-by-page (`pymupdf+tesseract`). |
| **DOCX** | python-docx (paragraphs + tables). |
| **XLSX / XLS** | openpyxl (all sheets → CSV-ish text). |

The engine prints ONE JSON object (wrapped in unique sentinels) so the Node
bridge parses it reliably even if apt/pip printed noise around it. It is invoked
in a **single `exec` call** so the (expensive) GitHub-Actions workflow dispatch
is only paid once per file.

### 2) Pure-Node fallback (always available — no sandbox/python needed)

If no sandbox is active (or sandbox OCR returns nothing), documents fall through
to pure-JS extractors already in `package.json`:

| Input type | Engine chain |
|---|---|
| **PDF** | pdf-parse → pdfjs-dist → pdftotext (native text layer) |
| **DOCX** | mammoth |
| **XLSX / XLS** | xlsx (SheetJS) |
| **Image** | returns `ok:false` → caller uses its vision model |

**Every layer degrades gracefully** — sandbox OCR failure (no sandbox, install
error, timeout, bad JSON) silently falls through to the pure-Node/vision path.
The engine NEVER throws to the caller.

## Components

```
python/
└── ocr_extract.py          # self-contained sandbox OCR/extractor (JSON out)

services/simpleOcr.js        # Node bridge: stages + runs the engine in ctx.fsx,
                             # with pure-JS document fallbacks. Drop-in API:
                             #   available, classifyImage, extract, warmup,
                             #   isImageName, isDocName

scripts/test-ocr-gha-live.js     # live test through the real GitHub Actions sandbox
scripts/test-ocr-novita-live.js  # live test through the real Novita sandbox
```

## How it runs

`services/simpleOcr.js` stages `ocr_extract.py` into the sandbox work dir
(`.pxocr/ocr_extract.py`) once per session via `ctx.fsx.uploadBuffer`, uploads
the input file, then runs ONE shell command through `ctx.fsx.sh` that executes
the engine (which self-installs its deps). The result JSON is read back from
stdout.

`ctx.fsx` is the agent's sandbox/host backend (see `makeSandboxFsx` /
`makeLocalFsx` in `agentEngine.js`). It works identically across GitHub Actions,
Novita, Daytona, HopX and the local host.

## Testing

```bash
# Live GitHub Actions sandbox test (dispatches a real CI run):
GITHUB_ACTIONS_TOKEN=ghp_xxx GITHUB_ACTIONS_REPO=owner/runner-repo \
  node scripts/test-ocr-gha-live.js [imagePath] [name]

# Live Novita sandbox test:
NOVITA_SANDBOX_API_KEY=sk_xxx \
  node scripts/test-ocr-novita-live.js [imagePath] [name]
```

Both were verified to install tesseract inside the sandbox and fully transcribe
a dense multi-question exam image (all questions recovered), plus scanned PDFs.

## Public API of `services/simpleOcr.js`

```js
const ocr = require('./services/simpleOcr');

await ocr.available(ctx);                     // always true (fallback exists)
await ocr.classifyImage(ctx, buffer, name);   // { ok, hasText, text, confidence, wordCount, engine }
await ocr.extract(ctx, buffer, name, opts);   // { ok, text, type, confidence, engine, hasText, meta }
await ocr.warmup(ctx);                        // pre-install tools in the sandbox (optional)
ocr.isImageName(name);  ocr.isDocName(name);  // routing helpers
```

Every method resolves to a structured result and never throws — `{ ok:false,
reason }` tells the caller to fall back to the vision/JS engines.
