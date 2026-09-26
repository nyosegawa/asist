#!/bin/sh
# Muxes out/video.mp4 (render.mjs) and out/audio.wav (audio.py) into out/asist-launch-video.mp4, in a form
# that X and YouTube accept: H.264 High, yuv420p, AAC and the index at the front. The loudness is -20 LUFS,
# which keeps the video calm.
# Usage: sh scripts/encode.sh [video.mp4] [audio.wav] [output.mp4]
set -e
cd "$(dirname "$0")/.."
video="${1:-out/video.mp4}"
audio="${2:-out/audio.wav}"
output="${3:-out/asist-launch-video.mp4}"
# The frames come from JPEG, which ffmpeg decodes as full-range BT.601; they are converted to the limited
# range and BT.709 that players and X's transcoder expect for HD video.
ffmpeg -y -loglevel error -i "$video" -i "$audio" \
  -vf "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p" \
  -c:v libx264 -preset slow -crf 17 -profile:v high -pix_fmt yuv420p -r 30 \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -af "loudnorm=I=-20:TP=-2:LRA=11" -c:a aac -b:a 192k -ar 48000 \
  -shortest -movflags +faststart "$output"
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate -of compact "$output"
