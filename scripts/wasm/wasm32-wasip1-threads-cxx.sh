#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPILER="${WASI_CLANGXX:-clang++}"
SYSROOT="${WASI_SYSROOT:-}"

# Same compiler-cache policy as CC/CMAKE_C_COMPILER_LAUNCHER in
# .config/mise.toml: use ccache when present, plain compiler otherwise.
# CCACHE_BASEDIR/CCACHE_NOHASHDIR from that [env] make the wasm C objects
# replay across target directories and worktrees too.
launcher=()
if command -v ccache >/dev/null 2>&1; then
  launcher=(ccache)
fi

source "$SCRIPT_DIR/wasm32-wasip1-threads-common.sh"

exec "${launcher[@]}" "$COMPILER" "${base[@]}" "${normalized[@]}"
