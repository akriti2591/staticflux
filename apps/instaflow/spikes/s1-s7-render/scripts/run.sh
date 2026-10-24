#!/usr/bin/env bash
# Run the S1/S7 page in Chromium via the shared harness and split the JSON + screenshots.
#   scripts/run.sh [name] [extra harness flags...]       e.g. scripts/run.sh run1
#   QUERY='count=10000&frames=120' scripts/run.sh realgpu --real-gpu --headed
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${1:-run}; shift || true
export NODE_PATH=${NODE_PATH:-/opt/node-tools/node_modules}
mkdir -p results/$NAME
PAGE="index.html${QUERY:+?$QUERY}"
node scripts/serve-and-run-angle.cjs web "$PAGE" --timeout=1800 "$@" > results/$NAME/raw.json 2> results/$NAME/stderr.log
node scripts/split-result.mjs results/$NAME/raw.json results/$NAME
rm results/$NAME/raw.json
