#!/usr/bin/env bash
# Generates all S5 test media locally with ffmpeg (synthetic: testsrc2 + noise + beeps). No downloads.
# Output goes to ./media (gitignored). Every frame carries a 16-bit barcode of its frame index in the
# top-left 16x(48x48) px block (white = 1, bit 0 leftmost) so the browser can verify exact seeks and A/V
# alignment from pixels, not from timestamps. Audio: 1 kHz beep, 40 ms, at every whole second; the video
# frame at every whole second has a white "flash" square at (1500,800).
#   bash scripts/gen-media.sh          # all (≈ 4-8 min on 4 cores)
#   bash scripts/gen-media.sh quick    # skip the 10-minute clip
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p media
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf

barcode() { # $1 = number of bits
  local f="drawbox=x=0:y=0:w=$((48*$1)):h=48:color=black:t=fill"
  for ((k=0;k<$1;k++)); do
    f="$f,drawbox=x=$((k*48+4)):y=4:w=40:h=40:color=white:t=fill:enable='eq(mod(floor(n/$((1<<k))),2),1)'"
  done
  echo "$f"
}
BC=$(barcode 16)
FLASH="drawbox=x=1500:y=800:w=200:h=200:color=white:t=fill:enable='eq(mod(n,30),0)'"
LABEL() { echo "drawtext=fontfile=$FONT:text='$1 f%{n} t%{pts\\:hms}':x=40:y=980:fontsize=56:fontcolor=white:box=1:boxcolor=black@0.6"; }
BEEP="aevalsrc='if(lt(mod(t,1),0.04),0.5*sin(2*PI*1000*t),0)|if(lt(mod(t,1),0.04),0.5*sin(2*PI*1000*t),0)':s=48000"
X264="-c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -b:v 8M -maxrate 10M -bufsize 10M -g 15 -keyint_min 15 -sc_threshold 0 -bf 2"

# Three 60 s 1080p30 layers, 0.5 s GOP (proxy-shaped), different hues, film-grain noise so bitrate is realistic.
for i in 0 1 2; do
  hue=$((i*120))
  [ -f media/layer$i.mp4 ] || ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=s=1920x1080:r=30:d=60" -f lavfi -i "$BEEP" -t 60 \
    -vf "hue=h=$hue,noise=alls=10:allf=t,$BC,$FLASH,$(LABEL L$i)" \
    $X264 -c:a libopus -b:a 128k -shortest -movflags +faststart media/layer$i.mp4
  echo "media/layer$i.mp4"
done

# 540p proxies of the same layers (fallback "decode ceiling → 540p preview proxies by policy").
for i in 0 1 2; do
  [ -f media/layer${i}_540p.mp4 ] || ffmpeg -hide_banner -loglevel error -y -i media/layer$i.mp4 \
    -vf scale=960:540:flags=neighbor -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 2M -g 15 -keyint_min 15 -sc_threshold 0 -bf 2 \
    -c:a copy media/layer${i}_540p.mp4
  echo "media/layer${i}_540p.mp4"
done

# 10 s VP9 and AV1 1080p30 versions of layer0 for codec decode-throughput comparison.
[ -f media/layer0_vp9.webm ] || ffmpeg -hide_banner -loglevel error -y -i media/layer0.mp4 -t 10 -an \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 8M -g 15 media/layer0_vp9.webm
echo media/layer0_vp9.webm
[ -f media/layer0_av1.mp4 ] || ffmpeg -hide_banner -loglevel error -y -i media/layer0.mp4 -t 10 -an \
  -c:v libsvtav1 -preset 10 -b:v 6M -g 15 media/layer0_av1.mp4
echo media/layer0_av1.mp4

[ "${1:-}" = quick ] && exit 0
# 10-minute 1080p30 A/V clip: barcode + flash every second, beep every second (Opus 48 kHz stereo in MP4).
[ -f media/long10.mp4 ] || ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=1920x1080:r=30:d=600" -f lavfi -i "$BEEP" -t 600 \
  -vf "$BC,$FLASH,$(LABEL LONG)" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 4M -g 15 -keyint_min 15 -sc_threshold 0 \
  -c:a libopus -b:a 128k -shortest -movflags +faststart media/long10.mp4
echo media/long10.mp4
