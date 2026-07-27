#!/bin/sh
# Build and install JWasm, the MASM-compatible assembler that turns the vendored
# LZMA SDK's x86-64 decode loop (Asm/x86/LzmaDecOpt.asm) into an object file.
#
# Without it crates/rom-weaver-containers/libarchive/build.rs falls back to the
# SDK's portable C decode loop, which is no faster than liblzma's - so every
# x86-64 build path that ships a binary wants this on PATH first. The build
# never fails over its absence; it only gets slower.
#
# JWasm rather than asmc or uasm: it is plain C that builds anywhere in seconds,
# where asmc is written in assembly (so it only bootstraps on an x86 host) and
# uasm's tree does not compile on a current Unix host. All three emit the same
# object; see docs/vendor-code.md.
#
#   scripts/install-jwasm.sh [prefix]      # default prefix /usr/local/bin
#
# Needs git and a C compiler. No-op when a jwasm is already on PATH.
set -eu

JWASM_REPO="https://github.com/Baron-von-Riedesel/JWasm.git"
# Pinned release tag. v2.20 and v2.21pre1 assemble LzmaDecOpt.asm to a
# byte-identical object, so this is a stability choice, not a behaviour one.
JWASM_REF="v2.20"

prefix="${1:-/usr/local/bin}"

if command -v jwasm >/dev/null 2>&1; then
  echo "install-jwasm: jwasm already on PATH ($(command -v jwasm))"
  exit 0
fi

workdir="$(mktemp -d)"
# The checkout is throwaway; the only artifact that outlives it is the binary.
trap 'rm -rf "$workdir"' EXIT

git clone --quiet --depth 1 --branch "$JWASM_REF" "$JWASM_REPO" "$workdir/jwasm"
make -C "$workdir/jwasm" -f GccUnix.mak -j"$(nproc 2>/dev/null || echo 2)" >/dev/null

mkdir -p "$prefix"
install -m 0755 "$workdir/jwasm/build/GccUnixR/jwasm" "$prefix/jwasm"
echo "install-jwasm: installed $JWASM_REF to $prefix/jwasm"
