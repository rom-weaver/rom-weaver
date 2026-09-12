#!/bin/sh
# Build the MASM-compatible assembler for the LZMA SDK's x86-64 decoder.
# The decoder build uses portable C when no supported assembler is available.
#
# Usage: scripts/install-jwasm.sh [prefix] (default /usr/local/bin)
# Requires git, make, and a C compiler; see docs/development/vendor-code.md.
set -eu

JWASM_REPO="https://github.com/Baron-von-Riedesel/JWasm.git"
# Pin the assembler source for reproducible installation.
JWASM_REF="v2.20"

prefix="${1:-/usr/local/bin}"

if command -v jwasm >/dev/null 2>&1; then
  echo "install-jwasm: jwasm already on PATH ($(command -v jwasm))"
  exit 0
fi

workdir="$(mktemp -d)"
# The checkout is throwaway; the only artifact that outlives it is the binary.
trap 'rm -rf "$workdir"' EXIT

if git clone --quiet --depth 1 --branch "$JWASM_REF" "$JWASM_REPO" "$workdir/jwasm" \
    && make -C "$workdir/jwasm" -f GccUnix.mak -j"$(nproc 2>/dev/null || echo 2)" >/dev/null \
    && mkdir -p "$prefix" \
    && install -m 0755 "$workdir/jwasm/build/GccUnixR/jwasm" "$prefix/jwasm"; then
  echo "install-jwasm: installed $JWASM_REF to $prefix/jwasm"
else
  echo "install-jwasm: warning: install failed; continuing with the portable C decoder" >&2
fi
