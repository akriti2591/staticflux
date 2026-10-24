#!/usr/bin/env bash
# Runs every S5 measurement and writes results/<test>.json. Extra args go to the runner (e.g. --real-gpu --headed).
#   bash scripts/run-all.sh                    # cloud/headless defaults (SwiftShader, select-only drift)
#   bash scripts/run-all.sh --real-gpu --headed   # owner machine (real GPU; drift presents on the GPU)
set -uo pipefail
cd "$(dirname "$0")/.."
export NODE_PATH=${NODE_PATH:-/opt/node-tools/node_modules}
mkdir -p results
RUN="node scripts/run.cjs ."
REAL=0; for a in "$@"; do [ "$a" = --real-gpu ] && REAL=1; done
if [ $REAL = 1 ]; then FR=300; GPUSEC=60; PRESENT=gpu; else FR=30; GPUSEC=10; PRESENT=select; fi
$RUN "web/index.html?test=probe" --timeout=60 "$@" > results/probe.json
$RUN "web/index.html?test=decode&reps=3&frames=300" --timeout=900 "$@" > results/decode.json
$RUN "web/index.html?test=composite&frames=$FR" --timeout=3600 "$@" > results/composite.json
$RUN "web/index.html?test=seek&n=150" --timeout=3600 "$@" > results/seek.json
$RUN "web/index.html?test=export&seconds=60&gpuSeconds=$GPUSEC&codecs=vp9,av1,h264" --timeout=7200 "$@" > results/export.json
$RUN "web/index.html?test=drift&dur=60&present=gpu" --timeout=300 "$@" > results/drift-60-gpu.json
$RUN "web/index.html?test=drift&dur=598&present=$PRESENT" --timeout=900 "$@" > results/drift-600-$PRESENT.json
echo "done: results/*.json"
