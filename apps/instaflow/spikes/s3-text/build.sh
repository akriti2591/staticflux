#!/usr/bin/env bash
# Builds the Parley wasm in 4 feature variants and reports raw/gzip/brotli sizes (after wasm-opt -Oz).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p web/wasm
OPT=./node_modules/.bin/wasm-opt
for v in base complex outlines complex,outlines; do
  name=${v//,/+}
  feats=""; [ "$v" != base ] && feats="--features $v"
  (cd wasm && cargo build -q --release --target wasm32-unknown-unknown $feats)
  cp wasm/target/wasm32-unknown-unknown/release/s3_text.wasm "web/wasm/s3_text.$name.noopt.wasm"
  $OPT -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
    "web/wasm/s3_text.$name.noopt.wasm" -o "web/wasm/s3_text.$name.wasm"
done
node -e '
const fs=require("fs"),z=require("zlib");
const rows=[];
for (const f of fs.readdirSync("web/wasm").filter(f=>f.endsWith(".wasm")).sort()) {
  const b=fs.readFileSync("web/wasm/"+f);
  const gz=z.gzipSync(b,{level:9}).length, br=z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11,[z.constants.BROTLI_PARAM_LGWIN]:24}}).length;
  rows.push({file:f, raw_KB:+(b.length/1024).toFixed(1), gz_KB:+(gz/1024).toFixed(1), br_KB:+(br/1024).toFixed(1)});
}
console.table(rows); fs.writeFileSync("results/sizes.json", JSON.stringify(rows,null,2));
'
