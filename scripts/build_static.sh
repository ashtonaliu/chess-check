#!/usr/bin/env bash
# Build the static (snapshot) demo into site/ for GitHub Pages.
# Expects web/dist/main.js (npm run build), web/snapshot/analysis.json and
# web/example_report.json (scripts/make_snapshot.py).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${REPO_URL:-https://github.com/ashtonaliu/weakness-finder}"
OUT="$ROOT/site"
rm -rf "$OUT" && mkdir -p "$OUT"
cp "$ROOT/web/style.css" "$OUT/"
cp -R "$ROOT/web/dist" "$OUT/dist"
cp "$ROOT/web/snapshot/analysis.json" "$OUT/analysis.json"
cp "$ROOT/web/example_report.json" "$OUT/example_report.json"
# relative paths (Pages serves under /weakness-finder/) + snapshot config.
# ?v=<commit> makes browsers fetch new assets right after a deploy instead of
# serving a cached main.js for up to 10 minutes (GitHub Pages: max-age=600).
VER="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
sed -e "s#href=\"/static/style.css\"#href=\"style.css?v=${VER}\"#" \
    -e "s#src=\"/static/dist/main.js\"#src=\"dist/main.js?v=${VER}\"#" \
    -e "s#<script src=\"dist/main.js?v=${VER}\"#<script>window.WF_STATIC={analysis:\"analysis.json\",report:\"example_report.json\",repo:\"${REPO_URL}\",browser:true};</script>\n  <script src=\"dist/main.js?v=${VER}\"#" \
    "$ROOT/web/index.html" > "$OUT/index.html"
grep -q 'WF_STATIC' "$OUT/index.html" || { echo "snapshot config not injected" >&2; exit 1; }
touch "$OUT/.nojekyll"
echo "Built static site in $OUT"
