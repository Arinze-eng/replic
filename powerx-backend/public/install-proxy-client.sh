#!/bin/sh
set -eu

REPO="erebe/wstunnel"
DEST="${WSTUNNEL_INSTALL_DIR:-$HOME/.local/bin}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux|darwin) ;;
  *) echo "Unsupported operating system: $OS" >&2; echo "Download wstunnel from https://github.com/$REPO/releases" >&2; exit 1 ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; echo "Download wstunnel from https://github.com/$REPO/releases" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
API="https://api.github.com/repos/$REPO/releases/latest"
URL="$(curl -fsSL "$API" | grep -Eo "https://[^\" ]+_${OS}_${ARCH}\\.tar\\.gz" | head -1)"
[ -n "$URL" ] || { echo "No compatible wstunnel release found." >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
curl -fsSL --retry 4 --retry-delay 2 "$URL" | tar -xz -C "$TMP" wstunnel
install -m 0755 "$TMP/wstunnel" "$DEST/wstunnel"
printf 'Installed wstunnel at %s/wstunnel\n' "$DEST"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) printf 'Add this directory to PATH if needed:\n  export PATH="%s:$PATH"\n' "$DEST" ;;
esac
