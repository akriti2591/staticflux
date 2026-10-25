#!/usr/bin/env bash
# Build all spike Wasm modules and put the served ones in web/pkg/.
# Base flags = research/03 §2.2: release, opt-level=z, lto, codegen-units=1, panic=abort, strip.
# Variants (served as ?variant=<name>):
#   gpu          opt-level=z, no SIMD               (size baseline, same as research/03)
#   gpu_simd     opt-level=z, +simd128
#   gpu_o3_simd  opt-level=3, +simd128              (speed)
#   cpu          vello_cpu reference + SVG writer + SSIM, opt-level=3 +simd128 (served)
#   cpu_z        same, opt-level=z, no SIMD (size only)
# Set FAST=1 to build only gpu + cpu.
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
FEAT="--enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types --enable-multivalue --enable-mutable-globals --enable-simd"
mkdir -p web/pkg build/raw build/bindgen

# build <out-name> <crate> <profile> <simd 0|1> <wasm-opt level> [features]
build() {
  local name=$1 crate=$2 profile=$3 simd=$4 olevel=$5 feats=${6:-}
  local tdir=target-$profile-simd$simd
  local flags=""; [ "$simd" = 1 ] && flags="-C target-feature=+simd128"
  (cd rust && RUSTFLAGS="$flags" cargo build --profile $profile --target wasm32-unknown-unknown -p $crate --target-dir $tdir ${feats:+--features $feats})
  local pdir=$profile; [ "$profile" = release ] || true
  cp rust/$tdir/wasm32-unknown-unknown/$pdir/$crate.wasm build/raw/$name.cargo.wasm
  "$BINDGEN" --target web --no-typescript --out-dir build/bindgen --out-name $name build/raw/$name.cargo.wasm
  "$WASMOPT" $olevel $FEAT build/bindgen/${name}_bg.wasm -o build/bindgen/${name}_bg.opt.wasm
  cp build/bindgen/$name.js web/pkg/$name.js
  cp build/bindgen/${name}_bg.opt.wasm web/pkg/${name}_bg.wasm
}

build gpu gpu release 0 -Oz
build cpu cpu release-o3 1 -O3
if [ "${FAST:-0}" != 1 ]; then
  build gpu_simd gpu release 1 -Oz
  build gpu_o3_simd gpu release-o3 1 -O3
  build cpu_z cpu release 0 -Oz
  build gpu_text gpu release 0 -Oz text     # size only: vello_gpu `text` feature on
fi
node scripts/sizes.mjs
