#!/usr/bin/env bash
# Full S2 matrix (10k gestures each). Serial on purpose: timings are CPU-sensitive.
#   scripts/matrix.sh [outdir] [extra harness flags...]     e.g. scripts/matrix.sh results/realgpu --real-gpu --headed
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-results/full}; shift || true
mkdir -p "$OUT"
G=${GESTURES:-10000}
run() { local name=$1 q=$2; shift 2; bash scripts/run.sh "_tmp_$name" "$q" "$@" && mv "results/_tmp_$name.json" "$OUT/$name.json" && mv "results/_tmp_$name.stderr.log" "$OUT/$name.stderr.log"; }
E='present=eager&eagerDelay=1'
for gfx in ${GFX:-none 2d webgpu}; do
  for mode in split fast colo; do
    run "$gfx-$mode-raf"   "gestures=$G&mode=$mode&gfx=$gfx" "$@"
    run "$gfx-$mode-eager" "gestures=$G&mode=$mode&gfx=$gfx&$E" "$@"
  done
done
# repeats (seeds 2, 3) of the no-raster runs for spread
for seed in 2 3; do for mode in split fast colo; do
  run "none-$mode-eager-s$seed" "gestures=$G&mode=$mode&gfx=none&$E&seed=$seed" "$@"
  run "none-$mode-raf-s$seed"   "gestures=$G&mode=$mode&gfx=none&seed=$seed" "$@"
done; done
# busy editor (8 ms per batch): where the camera fast path / co-location matter
for mode in split fast colo; do
  run "busy8-$mode-eager" "gestures=2000&mode=$mode&gfx=none&$E&editorLoad=8" "$@"
done
node scripts/summarize.mjs "$OUT"/*.json > "$OUT/SUMMARY.txt"
