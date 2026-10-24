#!/usr/bin/env bash
# fast iteration: rebuild only the gpu module (no wasm-opt)
set -euo pipefail
cd "$(dirname "$0")/.."
(cd rust && cargo build --release --target wasm32-unknown-unknown -p gpu)
.tools/bin/wasm-bindgen --target web --no-typescript --out-dir web/pkg --out-name gpu rust/target/wasm32-unknown-unknown/release/gpu.wasm
