#!/usr/bin/env bash
# Build the Chrome extension into extension/, copy it unpacked to
# dist/chess-check-extension (load either one with Load unpacked; reload it in
# chrome://extensions after each build), and zip it into
# dist/chess-check-extension.zip for the Chrome Web Store. An unpacked install can then be reloaded
# without chrome://extensions: on a Chess.com tab, run
#   window.postMessage({ type: "chess-check:dev-reload" })
# and reload the tab (background.ts only honors this for unpacked installs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$ROOT/web" && npm run build:ext >/dev/null)
# the build time, which an unpacked (developer) install shows on the cube's host element
printf '{"built":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/extension/dist/build.json"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/chess-check-extension.zip"
(cd "$ROOT/extension" && zip -qr "$ROOT/dist/chess-check-extension.zip" manifest.json offscreen.html icons dist engine)
rm -rf "$ROOT/dist/chess-check-extension"
mkdir -p "$ROOT/dist/chess-check-extension"
(cd "$ROOT/extension" && cp -R manifest.json offscreen.html icons dist engine "$ROOT/dist/chess-check-extension/")
echo "Built extension/, dist/chess-check-extension/ and dist/chess-check-extension.zip ($(du -h "$ROOT/dist/chess-check-extension.zip" | cut -f1))"
