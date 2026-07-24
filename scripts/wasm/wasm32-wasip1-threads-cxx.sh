#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPILER="${WASI_CLANGXX:-clang++}"
SYSROOT="${WASI_SYSROOT:-}"

source "$SCRIPT_DIR/wasm32-wasip1-threads-common.sh"

exec "$COMPILER" "${base[@]}" "${normalized[@]}"
