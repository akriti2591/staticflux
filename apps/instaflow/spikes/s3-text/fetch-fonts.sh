#!/usr/bin/env bash
# Downloads the open-licensed test fonts (all SIL OFL 1.1) into fonts/. ~34 MB, not committed.
set -euo pipefail
cd "$(dirname "$0")/fonts"
B=https://raw.githubusercontent.com/google/fonts/main/ofl
get() { [ -s "$2" ] || curl -sS -fL -o "$2" "$B/$1"; }
get "notosans/NotoSans%5Bwdth,wght%5D.ttf" NotoSans.ttf                       # Latin/Greek/Cyrillic (+ Devanagari!)
get "notosansarabic/NotoSansArabic%5Bwdth,wght%5D.ttf" NotoSansArabic.ttf
get "notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf" NotoSansDevanagari.ttf
get "notosansjp/NotoSansJP%5Bwght%5D.ttf" NotoSansJP.ttf
get "notosanskr/NotoSansKR%5Bwght%5D.ttf" NotoSansKR.ttf
get "notosans/OFL.txt" OFL.txt
# Noto Color Emoji (OFL 1.1, CBDT bitmaps): from the Debian package if present, else google/fonts
if [ ! -s NotoColorEmoji.ttf ]; then
  if [ -f /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf ]; then cp /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf .
  else get "notocoloremoji/NotoColorEmoji-Regular.ttf" NotoColorEmoji.ttf; fi
fi
ls -la
