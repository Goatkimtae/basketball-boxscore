#!/bin/sh
# VP9 + Opus in MP4: what headless Chromium can decode (it has no H.264/HEVC). Keep full resolution:
# numbers on shirts are unreadable in 768-px clips.
#   harness/make-clips.sh <input video> <output .mp4> [seconds]
set -e
[ -n "$2" ] || { echo "usage: $0 <input> <output.mp4> [seconds]"; exit 2; }
DUR=""
[ -n "$3" ] && DUR="-t $3"
ffmpeg -v error -y -i "$1" $DUR -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 5M \
  -c:a libopus -b:a 64k -strict -2 -movflags +faststart "$2"
echo "$2"
