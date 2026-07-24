#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREADING_HEADER="$SCRIPT_DIR/wasi-liblzma-threading.h"
COMPILER="${WASI_CLANG:-clang}"
SYSROOT="${WASI_SYSROOT:-}"

extra=()
for arg in "$@"; do
  case "$arg" in
    *liblzma-sys*|xz/src/*|*/xz/src/*)
      extra=(-D_WASI_EMULATED_SIGNAL -include "$THREADING_HEADER")
      break
      ;;
  esac
done

source "$SCRIPT_DIR/wasm32-wasip1-threads-common.sh"

exec "$COMPILER" "${base[@]}" "${extra[@]}" "${normalized[@]}"
