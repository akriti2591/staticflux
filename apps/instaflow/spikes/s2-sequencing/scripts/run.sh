#!/usr/bin/env bash
# Run one S2 configuration through the shared harness and save the JSON result.
#   scripts/run.sh <name> '<query>' [extra harness flags...]
#   scripts/run.sh split-r1 'mode=split&gfx=webgpu'
#   scripts/run.sh gpu-split 'mode=split' --real-gpu --headed      (owner machine)
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=$1; QUERY=${2:-}; shift 2 || true
export NODE_PATH=${NODE_PATH:-/opt/node-tools/node_modules}
mkdir -p results
node ../_harness/serve-and-run.cjs web "index.html${QUERY:+?$QUERY}" --timeout=1200 "$@" > "results/$NAME.json" 2> "results/$NAME.stderr.log" || { echo "FAILED $NAME"; tail -5 "results/$NAME.stderr.log"; exit 1; }
node scripts/summarize.mjs "results/$NAME.json"
