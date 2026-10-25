#!/usr/bin/env bash
# Builds instaflow-ime-check.zip: the IME check page with everything it loads, a static server, the automated check
# (auto-check.mjs) and the prompt for an agent with computer use (AGENT-PROMPT.md). Run from the repo root after
# `pnpm build`:   bash apps/instaflow/src/text/ime-check/pack/pack.sh [out-dir]
set -euo pipefail
OUT="${1:-.}"; HERE="apps/instaflow/src/text/ime-check/pack"; TMP="$(mktemp -d)"; Z="$TMP/instaflow-ime-check"
mkdir -p "$Z/web"
for d in packages/core/dist packages/platform/dist packages/surface/dist packages/document/dist apps/instaflow/dist \
         apps/instaflow/engine/dist apps/instaflow/test/fonts apps/instaflow/src/text/ime-check; do
  mkdir -p "$Z/web/$d"; cp -r "$d/." "$Z/web/$d/"
done
M=packages/core/node_modules/mobx/dist/mobx.esm.production.min.js; mkdir -p "$Z/web/$(dirname $M)"; cp -L "$M" "$Z/web/$M"
rm -rf "$Z/web/apps/instaflow/src/text/ime-check/pack" "$Z/web/apps/instaflow/src/text/ime-check/serve.mjs"
find "$Z/web" \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete
cp "$HERE/serve.mjs" "$HERE/auto-check.mjs" "$HERE/AGENT-PROMPT.md" "$HERE/HOW-TO-RUN.txt" "$Z/"
cp "$HERE/package.zip.json" "$Z/package.json"
(cd "$TMP" && zip -qr instaflow-ime-check.zip instaflow-ime-check)
mv "$TMP/instaflow-ime-check.zip" "$OUT/"; rm -rf "$TMP"
echo "$OUT/instaflow-ime-check.zip"
