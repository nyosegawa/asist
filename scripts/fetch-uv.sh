#!/bin/sh
# Fetches the uv that ships inside the app into resources/uv, pinned to one release and verified by
# sha256. uv builds the Python environments of the local models and downloads the Python they run on.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

version="0.12.18"
sha256="cf40e0c6a202190ccd9e0406dcfdd5b2d6668a9a5c779b17948963df32aafe5b"
out="resources/uv"
stamp="$out/VERSION"

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$version" ] && [ ! "$0" -nt "$stamp" ]; then
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://github.com/astral-sh/uv"
echo "fetch-uv: fetching uv $version" >&2
curl -fsSL -o "$work/uv.tar.gz" "$base/releases/download/$version/uv-aarch64-apple-darwin.tar.gz"
echo "$sha256  $work/uv.tar.gz" | shasum -a 256 -c - >/dev/null
tar -xzf "$work/uv.tar.gz" -C "$work"
# The release archive carries no license text, so it comes from the same tag.
curl -fsSL -o "$work/LICENSE-MIT" "$base/raw/$version/LICENSE-MIT"
curl -fsSL -o "$work/LICENSE-APACHE" "$base/raw/$version/LICENSE-APACHE"
rm -rf "$out"
mkdir -p "$out"
cp "$work/uv-aarch64-apple-darwin/uv" "$work/LICENSE-MIT" "$work/LICENSE-APACHE" "$out/"
echo "$version" > "$stamp"
