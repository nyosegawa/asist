#!/bin/sh
# Builds asist-mic, the macOS helper that captures microphone input through voice processing.
# It ships for Apple Silicon on macOS 14 and later, and a helper older than its source is rebuilt.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0
if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-native-mic: swiftc not found; install Xcode Command Line Tools before building" >&2
  exit 1
fi

src="resources/native/asist-mic.swift"
out="resources/native/asist-mic"
if [ -f "$out" ] && [ ! "$src" -nt "$out" ] && [ ! "$0" -nt "$out" ]; then
  exit 0
fi

echo "build-native-mic: compiling $out" >&2
# The target matches what electron-builder.yml supports, whatever SDK or Rosetta environment this runs in.
swiftc -target arm64-apple-macosx14.0 -O -o "$out" "$src"
