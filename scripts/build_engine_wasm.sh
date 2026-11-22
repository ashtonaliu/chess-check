#!/usr/bin/env bash
# Build the extension's self-contained wasm-bindgen module. The generated files
# are Web-target ES modules so Chrome and the Node parity tests use identical bits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/extension/engine}"
CARGO_DIR="$ROOT/engine-core/target"
if ! command -v cargo >/dev/null && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
version=0.2.130
if ! command -v wasm-bindgen >/dev/null || [ "$(wasm-bindgen --version)" != "wasm-bindgen $version" ]; then
  echo "Install wasm-bindgen-cli $version before building the extension." >&2
  exit 1
fi
mkdir -p "$OUT"
CARGO_TARGET_DIR="$CARGO_DIR" cargo build --locked --manifest-path "$ROOT/engine-core/Cargo.toml" \
  --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir "$OUT" \
  "$CARGO_DIR/wasm32-unknown-unknown/release/engine_core.wasm"
