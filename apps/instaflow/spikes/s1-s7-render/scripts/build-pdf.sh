#!/usr/bin/env bash
# S7 feasibility: krilla compiled to wasm32 (no wasm-bindgen; one extern "C" entry point) — size only.
set -euo pipefail
cd "$(dirname "$0")/.."
FEAT="--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types --enable-multivalue --enable-mutable-globals"
mkdir -p build/pdf
(cd rust && cargo build --release --target wasm32-unknown-unknown -p pdf --target-dir target-pdf)
cp rust/target-pdf/wasm32-unknown-unknown/release/pdf.wasm build/pdf/pdf_images.cargo.wasm
(cd rust && cargo build --release --target wasm32-unknown-unknown -p pdf --features text --target-dir target-pdf-text)
cp rust/target-pdf-text/wasm32-unknown-unknown/release/pdf.wasm build/pdf/pdf_images_text.cargo.wasm
for f in pdf_images pdf_images_text; do node_modules/.bin/wasm-opt -Oz $FEAT build/pdf/$f.cargo.wasm -o build/pdf/$f.opt.wasm; done
node scripts/sizes.mjs | grep -i pdf
