#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap_tools.sh — WormGPT Agent Sandbox Tool Bootstrapper
#
# Installs security pentest tools on-demand inside the sandbox. Called by the
# agent worker when it first needs nmap/sqlmap/gobuster/nuclei/etc.
#
# Idempotent: each tool is installed only if not already present.
# Quiet: all output is suppressed except errors.
# Fast: parallel package installs where possible.
# ─────────────────────────────────────────────────────────────────────────────
set -e

export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-y -qq -o=Dpkg::Use-Pty=0"

# ── System packages (apt) ──────────────────────────────────────────────────
install_apt() {
    local TOOL="$1"
    if command -v "$TOOL" >/dev/null 2>&1; then
        return 0  # already installed
    fi
    echo "[bootstrap] installing $TOOL..."
    apt-get update -qq 2>/dev/null
    apt-get install $APT_OPTS "$TOOL" 2>&1 | tail -1
    echo "[bootstrap] $TOOL: $(command -v "$TOOL")"
}

# ── Python packages (pip) ──────────────────────────────────────────────────
install_pip() {
    local PKG="$1"
    if python3 -c "import $PKG" 2>/dev/null; then
        return 0
    fi
    echo "[bootstrap] pip install $PKG..."
    pip install "$PKG" 2>&1 | tail -1
}

# ── Go tools ───────────────────────────────────────────────────────────────
install_go_tool() {
    local TOOL="$1"  # e.g. "nuclei"
    local PKG="$2"   # e.g. "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
    if command -v "$TOOL" >/dev/null 2>&1; then
        return 0
    fi
    echo "[bootstrap] go install $TOOL..."
    go install -v "$PKG" 2>&1 | tail -1
    # nuclei needs template download
    if [ "$TOOL" = "nuclei" ]; then
        nuclei -update-templates 2>&1 | tail -1
    fi
}

# ── Main ───────────────────────────────────────────────────────────────────
echo "[bootstrap] WormGPT sandbox tool bootstrapper starting..."

# Phase 1: Core pentest tools (parallel-friendly apt packages)
TOOLS_APT="nmap gobuster whatweb whois dnsutils openssl sqlmap nikto exiftool"
for tool in $TOOLS_APT; do
    install_apt "$tool" &
done
wait

# Phase 2: Python tools
install_pip "httpx"
install_pip "jwt"

# Phase 3: Go tools (nuclei)
if command -v go >/dev/null 2>&1; then
    install_go_tool "nuclei" "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest" || echo "[bootstrap] nuclei install skipped (no Go toolchain)"
else
    echo "[bootstrap] Go not installed — skipping nuclei"
fi

# ── Phase 3b: 🖼️ IMAGE-EDITING TOOLCHAIN (ImageMagick + FFmpeg + Pillow + OpenCV + rembg) ─
# Powers precise, deterministic image editing in the sandbox: resize, crop,
# blur, rotate/transform, format-convert, watermark, and AI background removal.
# Installed on-demand (idempotent) so it never slows a non-image task.
install_image_toolchain() {
    echo "[bootstrap] 🖼️  installing image toolchain (ImageMagick, FFmpeg, Pillow, OpenCV, rembg)..."
    # System binaries: ImageMagick ('convert'/'magick') + FFmpeg + libGL for OpenCV.
    apt-get update -qq 2>/dev/null || true
    for b in imagemagick ffmpeg libgl1 libglib2.0-0; do
        dpkg -s "$b" >/dev/null 2>&1 || apt-get install $APT_OPTS "$b" 2>&1 | tail -1
    done
    # Python imaging stack. pip first (most reliable), PEP-668 safe.
    for pkg in Pillow numpy opencv-python-headless; do
        python3 -c "import ${pkg/opencv-python-headless/cv2}" 2>/dev/null && continue
        python3 -c "import ${pkg/Pillow/PIL}" 2>/dev/null && continue
        pip install --break-system-packages -q "$pkg" 2>&1 | tail -1 \
          || pip install -q "$pkg" 2>&1 | tail -1
    done
    # rembg (AI background removal) — pull the onnxruntime CPU build it needs.
    if ! python3 -c "import rembg" 2>/dev/null; then
        pip install --break-system-packages -q "rembg[cpu]" onnxruntime 2>&1 | tail -1 \
          || pip install -q "rembg[cpu]" onnxruntime 2>&1 | tail -1 \
          || echo "[bootstrap] rembg optional install skipped"
    fi
    echo "[bootstrap] 🖼️  image toolchain verify:"
    for t in convert ffmpeg; do
        command -v "$t" >/dev/null 2>&1 && echo "  ✅ $t: $(command -v $t)" || echo "  ⚠️  $t: NOT FOUND"
    done
    python3 - <<'PY' 2>/dev/null || true
mods = []
for m, imp in [("Pillow","PIL"),("numpy","numpy"),("OpenCV","cv2"),("rembg","rembg")]:
    try:
        __import__(imp); mods.append("✅ "+m)
    except Exception:
        mods.append("⚠️  "+m+" (missing)")
print("  " + "  ".join(mods))
PY
}
# Only run the image phase when explicitly requested (BOOTSTRAP_IMAGE=1) so the
# default pentest bootstrap stays fast. The agent sets this before image tasks.
if [ "${BOOTSTRAP_IMAGE:-0}" = "1" ]; then
    install_image_toolchain
fi


# Phase 4: Verify installations
echo "[bootstrap] verifying installations..."
for tool in nmap gobuster whatweb sqlmap nikto exiftool; do
    if command -v "$tool" >/dev/null 2>&1; then
        echo "  ✅ $tool: $(command -v "$tool")"
    else
        echo "  ⚠️  $tool: NOT FOUND (may need manual install)"
    fi
done

# Phase 5: Enterprise Tool Registry bootstrap
echo "[bootstrap] setting up enterprise tool registry..."
TOOLS_DIR="$HOME/agent/tools"
REGISTRY="$HOME/agent/tool_registry.py"
if [ -f "$REGISTRY" ]; then
    echo "[bootstrap] tool registry found at $REGISTRY"
    # Verify tools are loadable
    python3 "$REGISTRY" 2>/dev/null | head -5
    echo "[bootstrap] tool registry ready"
fi
# Also copy to work dir so the agent worker can use it
if [ -f "$REGISTRY" ] && [ -d "$HOME/work" ]; then
    cp "$REGISTRY" "$HOME/work/.tool_registry.py" 2>/dev/null
    [ -d "$TOOLS_DIR" ] && cp -r "$TOOLS_DIR" "$HOME/work/.tools/" 2>/dev/null
fi

echo "[bootstrap] complete."
