#!/usr/bin/env bash
# Opt-in build for comparing the Rust classifier with the TypeScript fallback.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/web/rust/tactics"
OUT="$1"
rm -f "$OUT/chess_check_tactics.wasm"
if [[ "${CHESS_CHECK_RUST_TACTICS:-0}" != 1 ]]; then
  exit 0
fi

cargo build --locked --manifest-path "$CRATE/Cargo.toml" --target wasm32-unknown-unknown --release
cp "$CRATE/target/wasm32-unknown-unknown/release/chess_check_tactics.wasm" "$OUT/"
