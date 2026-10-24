#!/usr/bin/env bash
# Build all spike Wasm modules (release, opt-level=z, lto, panic=abort, strip — same as research/03 §2.2),
# run wasm-bindgen (--target web) and wasm-opt -Oz, and put the served modules in web/pkg/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BINDGEN=${WASM_BINDGEN:-$ROOT/.tools/bin/wasm-bindgen}
if [ ! -x "$BINDGEN" ]; then
  echo "installing wasm-bindgen-cli 0.2.129 into .tools/ (must match the wasm-bindgen crate)"
  cargo install wasm-bindgen-cli --version 0.2.129 --locked --root "$ROOT/.tools"
fi
[ -x node_modules/.bin/wasm-opt ] || npm install --no-audit --no-fund
WASMOPT="$ROOT/node_modules/.bin/wasm-opt"
FEAT="--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types --enable-multivalue --enable-mutable-globals"
T=rust/target/wasm32-unknown-unknown/release
mkdir -p web/pkg build/raw
(cd rust && cargo build --release --target wasm32-unknown-unknown -p gpu -p cpu)
cp $T/gpu.wasm build/raw/gpu.cargo.wasm
cp $T/cpu.wasm build/raw/cpu.cargo.wasm
# size variant: vello_gpu with its `text` (glyph) feature on
if [ "${WITH_TEXT_VARIANT:-1}" = 1 ]; then
  (cd rust && cargo build --release --target wasm32-unknown-unknown -p gpu --features text --target-dir target-text)
  cp rust/target-text/wasm32-unknown-unknown/release/gpu.wasm build/raw/gpu_text.cargo.wasm
fi
for m in gpu cpu; do
  "$BINDGEN" --target web --no-typescript --out-dir build/bindgen --out-name $m build/raw/$m.cargo.wasm
  "$WASMOPT" -Oz $FEAT build/bindgen/${m}_bg.wasm -o build/bindgen/${m}_bg.opt.wasm
  cp build/bindgen/$m.js web/pkg/$m.js
  cp build/bindgen/${m}_bg.opt.wasm web/pkg/${m}_bg.wasm
done
echo "built: $(ls -la web/pkg)"
