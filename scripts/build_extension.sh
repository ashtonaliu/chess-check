#!/usr/bin/env bash
# Build the Chrome extension into extension/ (load it unpacked from there) and
# zip it into dist/weakness-finder-extension.zip for the Chrome Web Store.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/web" && npm run build:ext >/dev/null)
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/weakness-finder-extension.zip"
(cd "$ROOT/extension" && zip -qr "$ROOT/dist/weakness-finder-extension.zip" manifest.json sidepanel.html style.css icons dist engine)
echo "Built extension/ and dist/weakness-finder-extension.zip ($(du -h "$ROOT/dist/weakness-finder-extension.zip" | cut -f1))"
