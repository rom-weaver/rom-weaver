#!/usr/bin/env bash
# Benchmark RVZ compression: rom-weaver (native rust, nod as a library) vs dolphin-tool.
#
# Both tools compress the same raw ISO to RVZ with matched parameters
# (codec=zstd, level=5, block=128 KiB) so the comparison isolates pipeline
# throughput rather than codec/level differences.
#
# Usage:
#   scripts/bench-rvz-compress.sh [ISO] [LEVEL] [BLOCK]
#
# Defaults target the Luigi's Mansion fixture extracted under ~/Downloads/weaver/bench.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ROM_WEAVER_BIN:-$ROOT/target/release/rom-weaver}"
DOLPHIN="${DOLPHIN_TOOL_BIN:-$(command -v dolphin-tool || true)}"

DEFAULT_ISO="$HOME/Downloads/weaver/bench/luigi.iso"
ISO="${1:-$DEFAULT_ISO}"
# zstd "max" level (matches rom-weaver's `max` profile and dolphin's -l 22).
LEVEL="${2:-22}"
BLOCK="${3:-131072}"
THREADS="${THREADS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"

WORK="$(dirname "$ISO")"
RW_OUT="$WORK/rom-weaver.rvz"
DT_OUT="$WORK/dolphin.rvz"
DT_USER="$WORK/.dolphin-user"

[ -x "$BIN" ] || { echo "rom-weaver binary not found at $BIN (build with: cargo build --release -p rom-weaver-cli)"; exit 1; }
[ -f "$ISO" ] || { echo "input ISO not found: $ISO"; exit 1; }

iso_bytes=$(stat -f%z "$ISO" 2>/dev/null || stat -c%s "$ISO")
echo "input        : $ISO ($((iso_bytes / 1024 / 1024)) MiB)"
echo "params       : codec=zstd level=$LEVEL block=$BLOCK threads=$THREADS"
echo "rom-weaver   : $BIN"
echo "dolphin-tool : ${DOLPHIN:-<not found>}"
echo

# hyperfine runs each command string through a shell, so paths are wrapped in double
# quotes to survive the apostrophe in the fixture name.
RW_CMD="\"$BIN\" compress \"$ISO\" --format rvz --output \"$RW_OUT\" --codec zstd:$LEVEL --threads $THREADS --no-progress"

HF_ARGS=(--warmup 1 --runs 3 --command-name "rom-weaver" --prepare "rm -f \"$RW_OUT\"" "$RW_CMD")

if [ -n "$DOLPHIN" ]; then
  mkdir -p "$DT_USER"
  DT_CMD="\"$DOLPHIN\" convert -u \"$DT_USER\" -i \"$ISO\" -o \"$DT_OUT\" -f rvz -c zstd -l $LEVEL -b $BLOCK"
  HF_ARGS+=(--command-name "dolphin-tool" --prepare "rm -f \"$DT_OUT\"" "$DT_CMD")
fi

hyperfine "${HF_ARGS[@]}"

echo
echo "=== output sizes ==="
size_of() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }
ratio() { awk "BEGIN{printf \"%.2f%%\", ($1/$iso_bytes)*100}"; }
if [ -f "$RW_OUT" ]; then
  rw=$(size_of "$RW_OUT"); echo "rom-weaver   : $rw bytes ($(ratio "$rw") of input)"
fi
if [ -f "$DT_OUT" ]; then
  dt=$(size_of "$DT_OUT"); echo "dolphin-tool : $dt bytes ($(ratio "$dt") of input)"
fi
