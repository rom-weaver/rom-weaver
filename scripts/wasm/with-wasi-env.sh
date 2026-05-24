#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WASI_SDK_PATH="${WASI_SDK_PATH:-}"
if [[ -z "$WASI_SDK_PATH" ]]; then
  if [[ -d "/opt/wasi-sdk" ]]; then
    WASI_SDK_PATH="/opt/wasi-sdk"
  elif [[ -d "/opt/homebrew/opt/wasi-sdk" ]]; then
    WASI_SDK_PATH="/opt/homebrew/opt/wasi-sdk"
  elif [[ -d "$HOME/.local/toolchains" ]]; then
    LOCAL_WASI_SDK_PATH="$(
      find "$HOME/.local/toolchains" -maxdepth 1 -type d -name 'wasi-sdk-*' 2>/dev/null \
        | sort -V \
        | tail -n 1
    )"
    if [[ -n "$LOCAL_WASI_SDK_PATH" ]]; then
      WASI_SDK_PATH="$LOCAL_WASI_SDK_PATH"
    fi
  fi
fi

if [[ -n "$WASI_SDK_PATH" ]]; then
  WASI_SYSROOT="${WASI_SYSROOT:-$WASI_SDK_PATH/share/wasi-sysroot}"
  WASI_CLANG="${WASI_CLANG:-$WASI_SDK_PATH/bin/clang}"
  WASI_CLANGXX="${WASI_CLANGXX:-$WASI_SDK_PATH/bin/clang++}"
  WASI_AR="${WASI_AR:-$WASI_SDK_PATH/bin/llvm-ar}"
  WASI_RANLIB="${WASI_RANLIB:-$WASI_SDK_PATH/bin/llvm-ranlib}"
else
  WASI_SYSROOT="${WASI_SYSROOT:-/opt/homebrew/opt/wasi-libc/share/wasi-sysroot}"
  WASI_CLANG="${WASI_CLANG:-/opt/homebrew/opt/llvm/bin/clang}"
  WASI_CLANGXX="${WASI_CLANGXX:-/opt/homebrew/opt/llvm/bin/clang++}"
  WASI_AR="${WASI_AR:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
  WASI_RANLIB="${WASI_RANLIB:-/opt/homebrew/opt/llvm/bin/llvm-ranlib}"
fi

require_executable() {
  local path="$1"
  if [[ ! -x "$path" ]]; then
    echo "missing executable: $path" >&2
    exit 1
  fi
}

require_executable "$WASI_CLANG"
require_executable "$WASI_CLANGXX"
require_executable "$WASI_AR"
require_executable "$WASI_RANLIB"
if [[ ! -d "$WASI_SYSROOT" ]]; then
  echo "missing WASI sysroot: $WASI_SYSROOT" >&2
  exit 1
fi

export WASI_CLANG
export WASI_SYSROOT

export CC_wasm32_wasip1="$WASI_CLANG --sysroot=$WASI_SYSROOT"
export CXX_wasm32_wasip1="$WASI_CLANGXX --sysroot=$WASI_SYSROOT"
export AR_wasm32_wasip1="$WASI_AR"
export RANLIB_wasm32_wasip1="$WASI_RANLIB"

export CC_wasm32_wasip1_threads="$ROOT_DIR/scripts/wasm/wasm32-wasip1-threads-cc.sh"
export CXX_wasm32_wasip1_threads="$WASI_CLANGXX --sysroot=$WASI_SYSROOT"
export AR_wasm32_wasip1_threads="$WASI_AR"
export RANLIB_wasm32_wasip1_threads="$WASI_RANLIB"

WASI_THREADS_CFLAGS="-matomics -mbulk-memory"
export CFLAGS_wasm32_wasip1_threads="${CFLAGS_wasm32_wasip1_threads:-} ${WASI_THREADS_CFLAGS}"
export CXXFLAGS_wasm32_wasip1_threads="${CXXFLAGS_wasm32_wasip1_threads:-} ${WASI_THREADS_CFLAGS}"

if [[ $# -eq 0 ]]; then
  cat <<EOF
WASI env configured:
  WASI_CLANG=$WASI_CLANG
  WASI_SYSROOT=$WASI_SYSROOT

Usage:
  scripts/wasm/with-wasi-env.sh <command> [args...]

Example:
  scripts/wasm/with-wasi-env.sh cargo check -p rom-weaver-containers --target wasm32-wasip1
EOF
  exit 0
fi

exec "$@"
