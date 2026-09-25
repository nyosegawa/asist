#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname)" = "Darwin" ] || exit 0
src=resources/native/asist-calendar.swift
info=resources/native/calendar-info.plist
out=resources/native/asist-calendar
if [ -f "$out" ] && [ ! "$src" -nt "$out" ] && [ ! "$info" -nt "$out" ] && [ ! "$0" -nt "$out" ]; then exit 0; fi
swiftc -target arm64-apple-macosx14.0 -O -framework EventKit -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$info" -o "$out" "$src"
