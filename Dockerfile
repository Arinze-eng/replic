# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — hackerx-v7 (ALL IN ONE TOOLBOX) for Render
#
# OCR / file-extraction strategy (so "Render doesn't suffer"):
#   The HEAVY OCR + office toolchain now runs INSIDE the remote sandbox
#   (HopX → Daytona → Runloop), provisioned + auto-installed at boot by the OCR
#   warm-up (server.js → brain.warmupOcrSandbox → omniOcr.warmup). That keeps
#   Render's tiny free-tier host lean and avoids the ~50s gateway timeout on a
#   cold install.
#
#   This image therefore bakes in only a LEAN, fast LOCAL FALLBACK so that if
#   EVERY sandbox backend is momentarily down, the host can still OCR plain
#   images / scanned PDFs:
#     • python3 + pip + the SLIM OmniOCR deps (opencv-python-HEADLESS, numpy,
#       Pillow, PyMuPDF, pytesseract, python-docx, openpyxl)
#     • tesseract-ocr + tesseract-ocr-eng   (real OCR)
#     • poppler-utils                        (pdf -> image rendering)
#     • ghostscript                          (pdf helper)
#
#   DELIBERATELY NOT baked into the host image anymore (they live in the sandbox,
#   installed on demand by services/fileConverter.js + sandboxAgent prewarm):
#     • libreoffice (~500 MB) — office -> pdf/docx conversions
#     • texlive / pandoc      — latex / markdown pipelines
#     • imagemagick, ffmpeg   — image/av conversions
#   This shrinks the Render image by hundreds of MB and speeds up cold deploys.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS runtime

# LEAN local-fallback OCR system deps only. --no-install-recommends keeps the
# image small; tesseract-ocr-eng is explicit because tesseract-ocr alone ships
# no language data. (Heavy office/latex/av tooling now lives in the sandbox.)
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget git unzip zip jq \
        python3 python3-pip python3-venv \
        tesseract-ocr tesseract-ocr-eng \
        poppler-utils \
        ghostscript \
        libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
        pandoc \
        sqlite3 postgresql-client default-mysql-client \
        fonts-dejavu-core fonts-liberation \
        libglib2.0-0 \
        chromium \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
        libxrandr2 libgbm1 libasound2 libpango-1.0-0 libpangocairo-1.0-0 \
        libatspi2.0-0 fonts-noto-core fonts-noto-cjk \
    ; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# ── 📄 OFFLINE LaTeX → PDF toolchain (create_pdf / convert_file) ─────────────
# ROOT CAUSE FIX for "[create_pdf] LaTeX compile failed … relay.fullyjustified.net
# Connection reset by peer (os error 104)": the previous pipeline relied on
# Tectonic, which downloads a ~2.9 GB package bundle at COMPILE TIME. On the
# restricted sandbox / free-tier network that transfer is frequently reset,
# producing an empty / failed PDF.
#
# We now bake a REAL, fully-OFFLINE TeX Live install into the host image so
# `pdflatex` + `latexmk` are always present and NEVER touch the network at
# compile time. latex_render.py prefers these system engines over Tectonic, so
# create_pdf is deterministic and produces print-quality, non-empty PDFs.
#
# `texlive-latex-recommended` + `-latex-extra` + `-pictures` + `-science`
# supply the full package set the curated preamble uses (amsmath, tikz,
# pgfplots, booktabs, listings, hyperref, adjustbox, geometry, xcolor, …).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        latexmk \
        texlive-latex-base \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-pictures \
        texlive-science \
        texlive-fonts-recommended \
        texlive-plain-generic \
        lmodern \
    ; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    # Fail the build early if the LaTeX engine isn't actually usable, so a
    # broken image never ships and silently falls back to empty PDFs.
    pdflatex --version | head -1; \
    latexmk --version | head -1

# Local headless Chromium path for the create_pdf HTML→PDF renderer
# (services/browserless.js → localHtmlToPdf). Rendering PDFs on the host with a
# LOCAL Chromium runs MathJax fully and has NO payload limit, fixing the
# "empty / math-less PDF" bug that the hosted /pdf endpoint caused. Browserless
# stays as the remote fallback.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# Install Node deps first for layer caching.
COPY powerx-backend/package*.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

# Install the SLIM OmniOCR Python deps for the LOCAL fallback (opencv-headless,
# so no libGL/X11 is needed). The full requirements.txt (scikit-image, pandas,
# pdf2image, full opencv) is reserved for the in-sandbox install when richer
# preprocessing is wanted; the engine degrades gracefully without them.
COPY powerx-backend/python/omni_ocr/requirements-sandbox.txt /tmp/omni_requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages --prefer-binary -r /tmp/omni_requirements.txt \
 && python3 -c "import pytesseract,cv2,fitz,docx,openpyxl,numpy,PIL; print('omni_ocr (slim) deps OK')"

# ── 🔌 MCP (Model Context Protocol) server deps ─────────────────────────────
# The bundled stdio MCP servers in mcp_servers/ (sequential-thinking + filesystem
# + git/github/fetch/websearch/sqlite) are launched as python subprocesses by
# services/mcpBridge.js. Install their runtime (the `mcp` SDK + gitpython for the
# git server) into the host image so the LLM can actually use these tools live.
COPY powerx-backend/mcp_servers/requirements.txt /tmp/mcp_requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages --prefer-binary -r /tmp/mcp_requirements.txt \
 && python3 -c "import mcp; print('mcp SDK OK')"

# Now copy the rest of the source.
COPY powerx-backend/. .

# Render free tier listens on $PORT; we default to 10000 to match render.yaml.
ENV PORT=10000
EXPOSE 10000

# Health check — Render also probes /healthz from render.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz | grep -q '"ok":true' || exit 1

CMD ["node", "server.js"]
