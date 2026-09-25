#!/bin/sh
# Muxes out/frames/*.jpg and out/audio.wav into out/asist-promo.mp4, in a form X accepts: H.264 High, yuv420p,
# AAC and the index at the front. The loudness is -20 LUFS, quieter than the usual -16, so the video stays calm.
# Usage: sh scripts/encode.sh [audio.wav] [output.mp4]
set -e
cd "$(dirname "$0")/.."
audio="${1:-out/audio.wav}"
output="${2:-out/asist-promo.mp4}"
ffmpeg -y -loglevel error -framerate 30 -i out/frames/f%05d.jpg -i "$audio" \
  -c:v libx264 -preset slow -crf 17 -profile:v high -pix_fmt yuv420p -r 30 \
  -af "loudnorm=I=-20:TP=-2:LRA=11" -c:a aac -b:a 192k -ar 48000 \
  -shortest -movflags +faststart "$output"
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of compact "$output"
