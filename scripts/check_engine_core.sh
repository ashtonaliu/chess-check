#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cargo test --locked --jobs 1 --manifest-path "$ROOT/engine-core/Cargo.toml" -- --test-threads=1 --nocapture
