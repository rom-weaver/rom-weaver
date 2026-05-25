#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM_PACKAGE_DIR="$ROOT_DIR/packages/rom-weaver-wasm"
DEFAULT_OUT_DIR="$WASM_PACKAGE_DIR"
OUT_DIR="${1:-${ROM_WEAVER_WASM_OUT_DIR:-$DEFAULT_OUT_DIR}}"
RUNTIME_UTILS_SOURCE="$ROOT_DIR/scripts/wasm/rom-weaver-runtime-utils.mjs"
BROWSER_OPFS_API_SOURCE="$ROOT_DIR/scripts/wasm/rom-weaver-browser-opfs-api.mjs"
BROWSER_WASI_THREAD_WORKER_SOURCE="$ROOT_DIR/scripts/wasm/workers/browser-wasi-thread-worker.mjs"
JS_API_README="$ROOT_DIR/scripts/wasm/README.md"
WASM_NPM_PACKAGE_SYNC="$ROOT_DIR/packages/rom-weaver-wasm/scripts/sync-dist.mjs"
PTHREAD_COUNT="${PTHREAD_COUNT:-4}"
SYNC_WASM_PACKAGE="${SYNC_WASM_PACKAGE:-0}"
ALLOW_REPO_OUTPUT="${ALLOW_REPO_OUTPUT:-0}"

if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$PWD/$OUT_DIR"
fi

case "$OUT_DIR" in
  "$ROOT_DIR"|"$ROOT_DIR"/*)
    if [[ "$OUT_DIR" != "$WASM_PACKAGE_DIR" \
      && "$OUT_DIR" != "$WASM_PACKAGE_DIR"/* \
      && "$ALLOW_REPO_OUTPUT" != "1" ]]; then
      echo "refusing repo output directory: $OUT_DIR" >&2
      echo "set ALLOW_REPO_OUTPUT=1 to override" >&2
      exit 1
    fi
    ;;
esac

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
  WASI_STRIP="${WASI_STRIP:-$WASI_SDK_PATH/bin/llvm-strip}"
else
  WASI_SYSROOT="${WASI_SYSROOT:-/opt/homebrew/opt/wasi-libc/share/wasi-sysroot}"
  WASI_CLANG="${WASI_CLANG:-/opt/homebrew/opt/llvm/bin/clang}"
  WASI_CLANGXX="${WASI_CLANGXX:-/opt/homebrew/opt/llvm/bin/clang++}"
  WASI_AR="${WASI_AR:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
  WASI_RANLIB="${WASI_RANLIB:-/opt/homebrew/opt/llvm/bin/llvm-ranlib}"
  WASI_STRIP="${WASI_STRIP:-/opt/homebrew/opt/llvm/bin/llvm-strip}"
fi
BROTLI_QUALITY="${BROTLI_QUALITY:-11}"
SKIP_WASM_OPT="${SKIP_WASM_OPT:-0}"

require_executable() {
  local path="$1"
  if [[ ! -x "$path" ]]; then
    echo "missing executable: $path" >&2
    exit 1
  fi
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing command: $name" >&2
    exit 1
  fi
}

require_command cargo
require_command brotli
require_executable "$WASI_CLANG"
require_executable "$WASI_CLANGXX"
require_executable "$WASI_AR"
require_executable "$WASI_RANLIB"
require_executable "$WASI_STRIP"
if [[ ! -d "$WASI_SYSROOT" ]]; then
  echo "missing WASI sysroot: $WASI_SYSROOT" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

export CC_wasm32_wasip1="$WASI_CLANG --sysroot=$WASI_SYSROOT"
export CXX_wasm32_wasip1="$WASI_CLANGXX --sysroot=$WASI_SYSROOT"
export AR_wasm32_wasip1="$WASI_AR"
export RANLIB_wasm32_wasip1="$WASI_RANLIB"

export WASI_CLANG
export CC_wasm32_wasip1_threads="$ROOT_DIR/scripts/wasm/wasm32-wasip1-threads-cc.sh"
export CXX_wasm32_wasip1_threads="$WASI_CLANGXX --sysroot=$WASI_SYSROOT"
export AR_wasm32_wasip1_threads="$WASI_AR"
export RANLIB_wasm32_wasip1_threads="$WASI_RANLIB"
export WASI_SYSROOT
WASI_THREADS_CFLAGS="-matomics -mbulk-memory"
export CFLAGS_wasm32_wasip1_threads="${CFLAGS_wasm32_wasip1_threads:-} ${WASI_THREADS_CFLAGS}"
export CXXFLAGS_wasm32_wasip1_threads="${CXXFLAGS_wasm32_wasip1_threads:-} ${WASI_THREADS_CFLAGS}"

NON_THREADED_RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+reference-types"
THREADED_RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+sign-ext,+reference-types"
THREADED_RUSTFLAGS+=" -C link-arg=--export=malloc -C link-arg=--export=free"
THREADED_RUSTFLAGS+=" -C linker-plugin-lto=no"

WASI_CXX_DIR="${WASI_CXX_DIR:-$WASI_SYSROOT/lib/wasm32-wasip1/noeh}"
WASI_CXX_THREADS_DIR="${WASI_CXX_THREADS_DIR:-$WASI_SYSROOT/lib/wasm32-wasip1-threads/noeh}"
if [[ -d "$WASI_CXX_DIR" ]]; then
  NON_THREADED_RUSTFLAGS+=" -L native=$WASI_CXX_DIR"
fi
if [[ -d "$WASI_CXX_THREADS_DIR" ]]; then
  THREADED_RUSTFLAGS+=" -L native=$WASI_CXX_THREADS_DIR"
fi

build_target() {
  local target="$1"
  local output_name="$2"
  local rustflags="$3"
  local target_upper
  target_upper="$(echo "$target" | tr '-' '_' | tr '[:lower:]' '[:upper:]')"

  echo "building ${target} -> ${output_name}"
  (
    cd "$ROOT_DIR"
    env "CARGO_TARGET_${target_upper}_RUSTFLAGS=${rustflags}" \
      cargo build \
      -p rom-weaver-cli \
      --bin rom-weaver \
      --profile wasm-release \
      --target "$target"
  )

  cp \
    "$ROOT_DIR/target/${target}/wasm-release/rom-weaver.wasm" \
    "$OUT_DIR/${output_name}"
}

postprocess_artifact() {
  local artifact="$1"
  local artifact_kind="${2:-non-threaded}"

  if [[ "$SKIP_WASM_OPT" != "1" ]] && command -v wasm-opt >/dev/null 2>&1; then
    local optimized="${artifact}.opt"
    local -a wasm_opt_flags=(
      --enable-bulk-memory
      --enable-bulk-memory-opt
      --enable-mutable-globals
      --enable-nontrapping-float-to-int
      --enable-sign-ext
      --enable-reference-types
    )
    if [[ "$artifact_kind" == "threaded" ]]; then
      wasm_opt_flags+=(--enable-threads)
    fi
    wasm-opt \
      -O3 \
      --strip-debug \
      --strip-dwarf \
      "${wasm_opt_flags[@]}" \
      -o "$optimized" \
      "$artifact"
    mv "$optimized" "$artifact"
  fi

  "$WASI_STRIP" "$artifact"
  brotli --force --quality="$BROTLI_QUALITY" --output="${artifact}.br" "$artifact"
}

build_target "wasm32-wasip1" "rom-weaver-cli.wasm" "$NON_THREADED_RUSTFLAGS"
build_target "wasm32-wasip1-threads" "rom-weaver-cli-threaded.wasm" "$THREADED_RUSTFLAGS"

postprocess_artifact "$OUT_DIR/rom-weaver-cli.wasm" "non-threaded"
postprocess_artifact "$OUT_DIR/rom-weaver-cli-threaded.wasm" "threaded"

if [[ "$OUT_DIR" == "$WASM_PACKAGE_DIR" ]]; then
  mkdir -p "$OUT_DIR/src/workers"
  if [[ -f "$RUNTIME_UTILS_SOURCE" ]]; then
    cp "$RUNTIME_UTILS_SOURCE" "$OUT_DIR/src/rom-weaver-runtime-utils.mjs"
  fi
  if [[ -f "$BROWSER_OPFS_API_SOURCE" ]]; then
    cp "$BROWSER_OPFS_API_SOURCE" "$OUT_DIR/src/rom-weaver-browser-opfs-api.mjs"
  fi
  if [[ -f "$BROWSER_WASI_THREAD_WORKER_SOURCE" ]]; then
    cp "$BROWSER_WASI_THREAD_WORKER_SOURCE" "$OUT_DIR/src/workers/browser-wasi-thread-worker.mjs"
  fi
else
  mkdir -p "$OUT_DIR/workers"
  if [[ -f "$RUNTIME_UTILS_SOURCE" ]]; then
    cp "$RUNTIME_UTILS_SOURCE" "$OUT_DIR/rom-weaver-runtime-utils.mjs"
  fi
  if [[ -f "$BROWSER_OPFS_API_SOURCE" ]]; then
    cp "$BROWSER_OPFS_API_SOURCE" "$OUT_DIR/rom-weaver-browser-opfs-api.mjs"
  fi
  if [[ -f "$BROWSER_WASI_THREAD_WORKER_SOURCE" ]]; then
    cp "$BROWSER_WASI_THREAD_WORKER_SOURCE" "$OUT_DIR/workers/browser-wasi-thread-worker.mjs"
  fi

  if [[ -f "$JS_API_README" ]]; then
    cp "$JS_API_README" "$OUT_DIR/README.md"
  fi
fi

cat > "$OUT_DIR/threaded.args" <<ARGS
--threads ${PTHREAD_COUNT}
ARGS

if [[ "$SYNC_WASM_PACKAGE" == "1" ]]; then
  if [[ "$OUT_DIR" == "$WASM_PACKAGE_DIR" ]]; then
    echo "package sync: skipped (output directory is already packages/rom-weaver-wasm)"
  elif [[ -f "$WASM_NPM_PACKAGE_SYNC" ]]; then
    if command -v node >/dev/null 2>&1; then
      node "$WASM_NPM_PACKAGE_SYNC" "$OUT_DIR"
    else
      echo "warning: skipping npm package sync; node is not available" >&2
    fi
  fi
fi

echo "artifacts written to ${OUT_DIR}"
echo "compressed artifacts: rom-weaver-cli.wasm.br rom-weaver-cli-threaded.wasm.br"
echo "threaded cli args file: threaded.args"
echo "auto threads: fixed default 4"
echo "force thread count: pass --threads ${PTHREAD_COUNT}"
if [[ "$SYNC_WASM_PACKAGE" != "1" ]]; then
  echo "package sync: disabled (set SYNC_WASM_PACKAGE=1 to sync package artifacts)"
fi
