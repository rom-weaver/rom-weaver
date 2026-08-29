#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREADING_HEADER="$SCRIPT_DIR/wasi-liblzma-threading.h"
COMPILER="${WASI_CLANG:-clang}"
SYSROOT="${WASI_SYSROOT:-}"

# Use ccache when present, plain compiler otherwise - like CC and
# CMAKE_C_COMPILER_LAUNCHER in .config/mise.toml, minus their sccache
# fallback (sccache would miss across target directories anyway).
# CCACHE_BASEDIR/CCACHE_NOHASHDIR from that [env] make the wasm C objects
# replay across target directories and worktrees too.
launcher=()
if command -v ccache >/dev/null 2>&1; then
  launcher=(ccache)
fi

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

exec "${launcher[@]}" "$COMPILER" "${base[@]}" "${extra[@]}" "${normalized[@]}"
