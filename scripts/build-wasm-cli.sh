#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/dist/wasm}"
JS_API_SOURCE="$ROOT_DIR/scripts/wasm/rom-weaver-wasi-api.mjs"
ZENFS_API_SOURCE="$ROOT_DIR/scripts/wasm/rom-weaver-zenfs-api.mjs"
JS_API_README="$ROOT_DIR/scripts/wasm/README.md"
WASM_NPM_PACKAGE_SYNC="$ROOT_DIR/packages/rom-weaver-wasm/scripts/sync-dist.mjs"
PTHREAD_COUNT="${PTHREAD_COUNT:-16}"

WASI_SYSROOT="${WASI_SYSROOT:-/opt/homebrew/opt/wasi-libc/share/wasi-sysroot}"
WASI_CLANG="${WASI_CLANG:-/opt/homebrew/opt/llvm/bin/clang}"
WASI_CLANGXX="${WASI_CLANGXX:-/opt/homebrew/opt/llvm/bin/clang++}"
WASI_AR="${WASI_AR:-/opt/homebrew/opt/llvm/bin/llvm-ar}"
WASI_RANLIB="${WASI_RANLIB:-/opt/homebrew/opt/llvm/bin/llvm-ranlib}"
WASI_STRIP="${WASI_STRIP:-/opt/homebrew/opt/llvm/bin/llvm-strip}"
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

export CC_wasm32_wasip1_threads="$WASI_CLANG --sysroot=$WASI_SYSROOT"
export CXX_wasm32_wasip1_threads="$WASI_CLANGXX --sysroot=$WASI_SYSROOT"
export AR_wasm32_wasip1_threads="$WASI_AR"
export RANLIB_wasm32_wasip1_threads="$WASI_RANLIB"

NON_THREADED_RUSTFLAGS="-C target-feature=+bulk-memory,+mutable-globals,+sign-ext,+reference-types"
THREADED_RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+sign-ext,+reference-types"

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

  if [[ "$SKIP_WASM_OPT" != "1" ]] && command -v wasm-opt >/dev/null 2>&1; then
    local optimized="${artifact}.opt"
    wasm-opt -O3 --strip-debug --strip-dwarf -o "$optimized" "$artifact"
    mv "$optimized" "$artifact"
  fi

  "$WASI_STRIP" "$artifact"
  brotli --force --quality="$BROTLI_QUALITY" --output="${artifact}.br" "$artifact"
}

build_target "wasm32-wasip1" "rom-weaver-cli.wasm" "$NON_THREADED_RUSTFLAGS"
build_target "wasm32-wasip1-threads" "rom-weaver-cli-threaded.wasm" "$THREADED_RUSTFLAGS"

postprocess_artifact "$OUT_DIR/rom-weaver-cli.wasm"
postprocess_artifact "$OUT_DIR/rom-weaver-cli-threaded.wasm"

if [[ -f "$JS_API_SOURCE" ]]; then
  cp "$JS_API_SOURCE" "$OUT_DIR/rom-weaver-wasi-api.mjs"
fi

if [[ -f "$ZENFS_API_SOURCE" ]]; then
  cp "$ZENFS_API_SOURCE" "$OUT_DIR/rom-weaver-zenfs-api.mjs"
fi

if [[ -f "$JS_API_README" ]]; then
  cp "$JS_API_README" "$OUT_DIR/README.md"
fi

cat > "$OUT_DIR/threaded.args" <<ARGS
--threads ${PTHREAD_COUNT}
ARGS

if [[ -f "$WASM_NPM_PACKAGE_SYNC" ]]; then
  if command -v node >/dev/null 2>&1; then
    node "$WASM_NPM_PACKAGE_SYNC"
  else
    echo "warning: skipping npm package sync; node is not available" >&2
  fi
fi

echo "artifacts written to ${OUT_DIR}"
echo "compressed artifacts: rom-weaver-cli.wasm.br rom-weaver-cli-threaded.wasm.br"
echo "threaded cli args file: threaded.args"
echo "auto threads: host OS/runtime detection with fallback 4"
echo "force thread count: pass --threads ${PTHREAD_COUNT}"
