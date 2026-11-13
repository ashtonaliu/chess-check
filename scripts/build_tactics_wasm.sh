#!/usr/bin/env bash
# Opt-in build for comparing the Rust classifier with the TypeScript fallback.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$1"
build_module() {
  local crate="$ROOT/web/rust/$1"
  local asset="chess_check_$1.wasm"
  if [[ "$2" != 1 ]]; then
    rm -f "$OUT/$asset"
    return
  fi
  cargo build --locked --manifest-path "$crate/Cargo.toml" --target wasm32-unknown-unknown --release
  cp "$crate/target/wasm32-unknown-unknown/release/$asset" "$OUT/"
}

build_module tactics "${CHESS_CHECK_RUST_TACTICS:-0}"
build_module openings "${CHESS_CHECK_RUST_OPENINGS:-0}"
build_module risk "${CHESS_CHECK_RUST_RISK:-0}"
