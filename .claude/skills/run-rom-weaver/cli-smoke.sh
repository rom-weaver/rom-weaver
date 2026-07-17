#!/usr/bin/env bash
# rom-weaver native CLI smoke - exercises probe/list/checksum/extract/compress
# and a full patch-apply round-trip against committed fixtures, asserting the
# patched output matches the known-good target CRC32.
#
# Usage (from repo root):
#   cargo build -p rom-weaver-cli --release      # if target/release/rom-weaver is missing
#   .claude/skills/run-rom-weaver/cli-smoke.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN="${RW_BIN:-$REPO/target/release/rom-weaver}"
[ -x "$BIN" ] || BIN="$REPO/target/debug/rom-weaver"
[ -x "$BIN" ] || { echo "no rom-weaver binary; run: cargo build -p rom-weaver-cli --release"; exit 1; }

FIX="$REPO/tests/fixtures"
ARC="$REPO/packages/rom-weaver-webapp/tests/fixtures/archives"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "bin: $BIN"

echo "== list ==" ;     "$BIN" list "$ARC/one-rom.zip"
echo "== checksum ==" ; "$BIN" checksum --algo crc32 "$FIX/vcdiff/secondary-source.bin"
echo "== extract ==" ;  "$BIN" extract "$ARC/one-rom.zip" --out-dir "$TMP/ex" --checksum-rom crc32
echo "== compress ==" ; "$BIN" compress "$FIX/vcdiff/secondary-source.bin" --output "$TMP/out.7z"

echo "== patch apply (xdelta round-trip) =="
"$BIN" patch apply \
  --input "$FIX/vcdiff/secondary-source.bin" \
  --patch "$FIX/vcdiff/secondary-djw.xdelta" \
  --output "$TMP/patched.bin" --no-compress
GOT="$("$BIN" checksum --algo crc32 "$TMP/patched.bin" | awk '/CRC32/{print $2}')"
WANT="$("$BIN" checksum --algo crc32 "$FIX/vcdiff/secondary-target.bin" | awk '/CRC32/{print $2}')"
echo "patched CRC32=$GOT  target CRC32=$WANT"
[ "$GOT" = "$WANT" ] || { echo "FAIL: patched output != target"; exit 1; }
echo "OK: CLI smoke passed (patch round-trip matches target $WANT)"
