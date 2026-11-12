#!/usr/bin/env bash
# Deploy the committed HEAD to a Hugging Face Space (Docker SDK).
#   scripts/deploy_hf.sh <hf-username>/<space-name>
# Needs a prior `hf auth login` with a write token. The Space's README gets the
# YAML header Hugging Face requires; the GitHub README stays unchanged.
set -euo pipefail
SPACE="${1:?usage: scripts/deploy_hf.sh user/space}"
ROOT="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HF_TOKEN="$(python3 -c 'from huggingface_hub import get_token; print(get_token() or "")' 2>/dev/null \
  || "$ROOT/.venv/bin/python" -c 'from huggingface_hub import get_token; print(get_token() or "")')"
[ -n "$HF_TOKEN" ] || { echo "Run 'hf auth login' first." >&2; exit 1; }
git clone -q "https://user:${HF_TOKEN}@huggingface.co/spaces/${SPACE}" "$TMP/space"
# replace the Space's files with this commit's tracked files
find "$TMP/space" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$ROOT" archive HEAD | tar -x -C "$TMP/space"
rm -rf "$TMP/space/.claude"
cat "$ROOT/deploy/hf_space_header.md" "$ROOT/README.md" > "$TMP/space/README.md"
cd "$TMP/space"
git add -A
if git diff --cached --quiet; then echo "Space already up to date."; exit 0; fi
git -c user.name="$(git -C "$ROOT" config user.name || echo deploy)" \
    -c user.email="$(git -C "$ROOT" config user.email || echo deploy@localhost)" \
    commit -qm "Deploy ${SHA}"
git push -q origin HEAD:main
echo "Pushed ${SHA} to https://huggingface.co/spaces/${SPACE}"
