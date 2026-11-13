#!/usr/bin/env bash
# Build the Chrome extension into extension/ (load it unpacked from there) and
# zip it into dist/chess-check-extension.zip for the Chrome Web Store.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/web" && npm run build:ext >/dev/null)
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/chess-check-extension.zip"
(cd "$ROOT/extension" && zip -qr "$ROOT/dist/chess-check-extension.zip" manifest.json sidepanel.html style.css icons dist engine)
echo "Built extension/ and dist/chess-check-extension.zip ($(du -h "$ROOT/dist/chess-check-extension.zip" | cut -f1))"
