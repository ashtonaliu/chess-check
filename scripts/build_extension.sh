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
OUT="$ROOT/dist/chess-check-extension"
rm -rf "$OUT"
mkdir -p "$OUT/engine" "$OUT/licenses"
(cd "$ROOT/extension" && cp -R manifest.json offscreen.html icons dist THIRD_PARTY_NOTICES.txt "$OUT/")
(cd "$ROOT/extension/engine" && cp stockfish-19-lite-single.{js,wasm} tacticsWorker.js engine_core.js engine_core_bg.wasm "$OUT/engine/")
cp "$ROOT/web/node_modules/stockfish/Copying.txt" "$OUT/licenses/Stockfish-GPL-3.0.txt"
cp "$ROOT/web/node_modules/chess.js/LICENSE" "$OUT/licenses/chess.js-BSD-2-Clause.txt"
rm -f "$OUT.zip"
(cd "$OUT" && zip -qr "$OUT.zip" manifest.json offscreen.html icons dist engine licenses THIRD_PARTY_NOTICES.txt)
echo "Built extension/, dist/chess-check-extension/ and dist/chess-check-extension.zip ($(du -h "$ROOT/dist/chess-check-extension.zip" | cut -f1))"
