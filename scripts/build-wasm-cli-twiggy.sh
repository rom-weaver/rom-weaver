#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROM_WEAVER_WASM_TWIGGY_OUT_DIR:-$ROOT_DIR/target/wasm-twiggy}}"

if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$PWD/$OUT_DIR"
fi

mkdir -p "$OUT_DIR"

env \
  ALLOW_REPO_OUTPUT=1 \
  CARGO_PROFILE_WASM_RELEASE_STRIP=none \
  CARGO_PROFILE_WASM_RELEASE_DEBUG=true \
  SKIP_WASM_OPT="${SKIP_WASM_OPT:-1}" \
  SKIP_BROTLI=1 \
  SKIP_WASI_STRIP=1 \
  "$ROOT_DIR/scripts/build-wasm-cli.sh" \
  "$OUT_DIR"

echo "twiggy-ready artifacts written to ${OUT_DIR}"
echo "run: twiggy top -n 80 ${OUT_DIR}/rom-weaver-cli.wasm"
echo "run: twiggy monos -n 80 ${OUT_DIR}/rom-weaver-cli-threaded.wasm"
