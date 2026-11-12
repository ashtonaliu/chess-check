#!/usr/bin/env bash
# Build the static (snapshot) demo into site/ for GitHub Pages.
# Expects web/dist/main.js (npm run build), web/snapshot/analysis.json and
# web/example_report.json (scripts/make_snapshot.py).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${REPO_URL:-https://github.com/ashtonaliu/weakness-finder}"
OUT="$ROOT/site"
rm -rf "$OUT" && mkdir -p "$OUT/dist"
cp "$ROOT/web/style.css" "$OUT/"
cp "$ROOT/web/dist/main.js" "$OUT/dist/"
cp "$ROOT/web/snapshot/analysis.json" "$OUT/analysis.json"
cp "$ROOT/web/example_report.json" "$OUT/example_report.json"
# relative paths (Pages serves under /weakness-finder/) + snapshot config
sed -e 's#href="/static/style.css"#href="style.css"#' \
    -e 's#src="/static/dist/main.js"#src="dist/main.js"#' \
    -e "s#<script src=\"dist/main.js\"#<script>window.WF_STATIC={analysis:\"analysis.json\",report:\"example_report.json\",repo:\"${REPO_URL}\"};</script>\n  <script src=\"dist/main.js\"#" \
    "$ROOT/web/index.html" > "$OUT/index.html"
grep -q 'WF_STATIC' "$OUT/index.html" || { echo "snapshot config not injected" >&2; exit 1; }
touch "$OUT/.nojekyll"
echo "Built static site in $OUT"
