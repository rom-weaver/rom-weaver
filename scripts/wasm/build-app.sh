#!/usr/bin/env bash
# Shared build body for the `build-wasm` (dev) and `build-wasm-prod` (CI/release)
# mise tasks. Both tasks set the release `-O3 -flto` CFLAGS in [env] and then
# delegate here; prod adds the wasm-opt + brotli tail.
#
# Mode is selected by the first argument (default: dev):
#   build-app.sh        # dev: build + cp + strip + sync
#   build-app.sh prod   # prod: build + cp + wasm-opt + strip + brotli + sync
#
# Reads MISE_PROJECT_ROOT and the WASI_* toolchain vars from the [env] block in
# .mise.toml. Honors ROM_WEAVER_WASM_OUT_DIR (output dir) and, in prod mode,
# BROTLI_QUALITY (defaults to 11).
set -euo pipefail

mode="${1:-dev}"
case "$mode" in
  dev|prod) ;;
  *)
    echo "usage: build-app.sh [dev|prod]" >&2
    exit 2
    ;;
esac

target="wasm32-wasip1-threads"
out_dir="${ROM_WEAVER_WASM_OUT_DIR:-$MISE_PROJECT_ROOT/packages/rom-weaver-webapp/src/wasm}"
pkg_dir="$MISE_PROJECT_ROOT/packages/rom-weaver-webapp/src/wasm"
artifact="$out_dir/rom-weaver-app.wasm"
built_artifact="$MISE_PROJECT_ROOT/target/$target/wasm-release/rom-weaver-app.wasm"
prod_fingerprint_file="$artifact.prod.sha256"

command -v cargo >/dev/null || { echo "missing command: cargo" >&2; exit 1; }
if [[ "$mode" == "prod" ]]; then
  command -v brotli >/dev/null || { echo "missing command: brotli" >&2; exit 1; }
fi
[[ -x "$WASI_CLANG" ]] || { echo "missing WASI toolchain: $WASI_CLANG (install WASI SDK)" >&2; exit 1; }
[[ -d "$WASI_SYSROOT" ]] || { echo "missing WASI sysroot: $WASI_SYSROOT" >&2; exit 1; }

mkdir -p "$out_dir"

echo "building $target -> $artifact"
cargo build -p rom-weaver-app --bin rom-weaver-app --profile wasm-release --target "$target"

if [[ "$mode" == "prod" ]]; then
  command -v wasm-opt >/dev/null || { echo "missing command: wasm-opt (install via mise or brew install binaryen)" >&2; exit 1; }
  prod_fingerprint="$(
    node "$MISE_PROJECT_ROOT/scripts/wasm/wasm-prod-fingerprint.mjs" \
      "$built_artifact" \
      "$MISE_PROJECT_ROOT/scripts/wasm/build-app.sh" \
      "${BROTLI_QUALITY:-11}" \
      "$(wasm-opt --version 2>&1)" \
      "$("$WASI_STRIP" --version 2>&1)" \
      "$(brotli --version 2>&1)"
  )"
  if [[ "${ROM_WEAVER_WASM_FORCE:-0}" != "1" \
    && -f "$artifact" \
    && -f "$artifact.br" \
    && -f "$prod_fingerprint_file" \
    && "$(<"$prod_fingerprint_file")" == "$prod_fingerprint" ]]; then
    echo "production WASM inputs unchanged; skipping wasm-opt and brotli"
  else
    rm -f "$prod_fingerprint_file"
    cp "$built_artifact" "$artifact"
    wasm-opt -O4 --strip-debug --strip-dwarf \
      --enable-bulk-memory --enable-bulk-memory-opt --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext --enable-reference-types \
      --enable-simd --enable-threads \
      -o "$artifact.opt" "$artifact"
    mv "$artifact.opt" "$artifact"
    "$WASI_STRIP" "$artifact"
    brotli --force --quality="${BROTLI_QUALITY:-11}" --output="$artifact.br" "$artifact"
    printf '%s\n' "$prod_fingerprint" > "$prod_fingerprint_file"
  fi
else
  rm -f "$artifact.br" "$prod_fingerprint_file"
  cp "$built_artifact" "$artifact"
  "$WASI_STRIP" "$artifact"
fi

# Sync into the npm package only when built to a separate output directory.
if [[ "$out_dir" != "$pkg_dir" ]]; then
  node "$MISE_PROJECT_ROOT/packages/rom-weaver-webapp/scripts/sync-dist.mjs" "$out_dir"
fi

if [[ "$mode" == "prod" ]]; then
  echo "artifacts written to $out_dir (rom-weaver-app.wasm, rom-weaver-app.wasm.br)"
else
  echo "artifact written to $out_dir/rom-weaver-app.wasm"
fi
