#!/bin/sh
# Builds the git that ships inside the app, from the release tarball on kernel.org, into resources/git.
# ASIST only runs local operations (init, commit, worktree, diff, merge), so the transports, Perl,
# Python, Tcl/Tk and translations are left out. RUNTIME_PREFIX makes the tree relocatable: git finds
# libexec/git-core and its templates relative to bin/git, wherever the app is installed.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname)" = "Darwin" ] || exit 0

version="2.55.0"
sha256="457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357"
out="resources/git"
stamp="$out/VERSION"

if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$version" ] && [ ! "$0" -nt "$stamp" ]; then
  exit 0
fi
if ! command -v cc >/dev/null 2>&1; then
  echo "build-git: cc not found; install Xcode Command Line Tools before building" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tarball="$work/git-$version.tar.xz"
echo "build-git: fetching git $version" >&2
curl -fsSL -o "$tarball" "https://www.kernel.org/pub/software/scm/git/git-$version.tar.xz"
echo "$sha256  $tarball" | shasum -a 256 -c - >/dev/null
tar -xJf "$tarball" -C "$work"

echo "build-git: compiling git $version" >&2
# The flags keep the build to the system libraries of macOS 14 and later on Apple Silicon.
flags="prefix=/ RUNTIME_PREFIX=YesPlease NO_GETTEXT=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
  NO_TCLTK=YesPlease NO_CURL=YesPlease NO_EXPAT=YesPlease NO_OPENSSL=YesPlease NO_INSTALL_HARDLINKS=YesPlease \
  SKIP_DASHED_BUILT_INS=YesPlease INSTALL_SYMLINKS=YesPlease \
  CC=cc"
# shellcheck disable=SC2086
make -C "$work/git-$version" -j"$(sysctl -n hw.ncpu)" $flags \
  "CFLAGS=-O2 -target arm64-apple-macosx14.0" "LDFLAGS=-target arm64-apple-macosx14.0" >/dev/null
rm -rf "$out"
# shellcheck disable=SC2086
make -C "$work/git-$version" $flags \
  "CFLAGS=-O2 -target arm64-apple-macosx14.0" "LDFLAGS=-target arm64-apple-macosx14.0" \
  DESTDIR="$PWD/$out" install >/dev/null
# These serve repositories to other machines, manage large ones (scalar) or complete a shell, which ASIST
# never does.
rm -rf "$out/share/perl5" "$out/share/gitweb" "$out/share/bash-completion" "$out/bin/git-shell" "$out/bin/git-cvsserver" "$out/bin/scalar" \
  "$out/libexec/git-core/git-shell" "$out/libexec/git-core/git-cvsserver" "$out/libexec/git-core/scalar" \
  "$out/libexec/git-core/git-daemon" "$out/libexec/git-core/git-http-backend" "$out/libexec/git-core/git-imap-send"
cp "$work/git-$version/COPYING" "$out/COPYING"
echo "$version" > "$stamp"
