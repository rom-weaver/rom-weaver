#!/usr/bin/env bash
# Print the WASI SDK root, or nothing if none is found.
#
# Resolution order (first hit wins):
#   1. $WASI_SDK_PATH, if it already points at a real directory (CI sets this).
#   2. /opt/wasi-sdk
#   3. /opt/homebrew/opt/wasi-sdk
#   4. newest ~/.local/toolchains/wasi-sdk-*
#
# The WASI SDK is intentionally NOT a mise [tools] entry: pinning it would put its
# clang on PATH and break the libarchive-sys bindgen on macOS (see .mise.toml).
#
# This is consumed by mise's `[env]` block (see .mise.toml), which derives the
# sysroot and tool paths from the printed root. It must always exit 0 so a missing
# SDK never breaks mise for non-wasm commands; the build tasks fail later with a
# clear message if the toolchain is absent.
set -uo pipefail

if [[ -n "${WASI_SDK_PATH:-}" && -d "${WASI_SDK_PATH}" ]]; then
  printf '%s' "$WASI_SDK_PATH"
  exit 0
fi

for candidate in /opt/wasi-sdk /opt/homebrew/opt/wasi-sdk; do
  if [[ -d "$candidate" ]]; then
    printf '%s' "$candidate"
    exit 0
  fi
done

newest_local="$(
  find "$HOME/.local/toolchains" -maxdepth 1 -type d -name 'wasi-sdk-*' 2>/dev/null \
    | sort -V \
    | tail -n 1
)"
if [[ -n "$newest_local" ]]; then
  printf '%s' "$newest_local"
fi

exit 0
