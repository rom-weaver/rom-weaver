#!/usr/bin/env bash
# Shared body for the `build-wasm` and `build-wasm-prod` mise tasks; production
# adds wasm-opt and Brotli.
#
# Mode is selected by the first argument (default: dev):
#   build-app.sh        # dev: build + cp + strip + sync
#   build-app.sh prod   # prod: build + cp + wasm-opt + strip + brotli + sync
#
# Reads MISE_PROJECT_ROOT and WASI_* from .config/mise.toml. Honors
# ROM_WEAVER_WASM_OUT_DIR and, in production, BROTLI_QUALITY and
# ROM_WEAVER_WASM_NO_BROTLI.
#
# ROM_WEAVER_WASM_NO_BROTLI=1 skips the `.br` sibling for hosts such as
# Cloudflare Pages that recompress the raw WASM. The Docker image still needs
# the sibling for `compression-static`.
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
[[ -x "$WASI_CLANG" ]] || { echo "missing WASI toolchain: $WASI_CLANG (install WASI SDK)" >&2; exit 1; }
[[ -d "$WASI_SYSROOT" ]] || { echo "missing WASI sysroot: $WASI_SYSROOT" >&2; exit 1; }

mkdir -p "$out_dir"

echo "building $target -> $artifact"
cargo build -p rom-weaver-cli --features wasm-app --bin rom-weaver-app --profile wasm-release --target "$target"

if [[ "$mode" == "prod" ]]; then
  command -v wasm-opt >/dev/null || { echo "missing command: wasm-opt (install via mise or brew install binaryen)" >&2; exit 1; }
  # Part of the fingerprint: switching Node (and so libbrotli) must invalidate a
  # cached `.br`, exactly as a `brotli` CLI upgrade used to.
  brotli_version="node-zlib libbrotli $(node -p 'process.versions.brotli')"
  want_brotli=1
  if [[ "${ROM_WEAVER_WASM_NO_BROTLI:-0}" == "1" ]]; then
    want_brotli=0
    # Drop any sibling from an earlier brotli-producing build up front: it is
    # stale against whatever this run emits, and the cache-hit path below would
    # otherwise leave it in place for sws.toml to serve in preference to the
    # real wasm.
    rm -f "$artifact.br"
  fi
  prod_fingerprint="$(
    node "$MISE_PROJECT_ROOT/scripts/wasm/wasm-prod-fingerprint.mjs" \
      "$built_artifact" \
      "$MISE_PROJECT_ROOT/scripts/wasm/build-app.sh" \
      "${BROTLI_QUALITY:-11}" \
      "$(wasm-opt --version 2>&1)" \
      "$("$WASI_STRIP" --version 2>&1)" \
      "$brotli_version"
  )"
  # The `.br` is only a required input to the cache check when we were asked to
  # produce one; otherwise its absence is the expected state, not a stale build.
  brotli_artifact_ok=1
  if [[ "$want_brotli" == "1" && ! -f "$artifact.br" ]]; then
    brotli_artifact_ok=0
  fi
  if [[ "${ROM_WEAVER_WASM_FORCE:-0}" != "1" \
    && -f "$artifact" \
    && "$brotli_artifact_ok" == "1" \
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
    if [[ "$want_brotli" == "1" ]]; then
      node "$MISE_PROJECT_ROOT/scripts/wasm/brotli-compress.mjs" \
        "$artifact" "$artifact.br" "${BROTLI_QUALITY:-11}"
    else
      echo "ROM_WEAVER_WASM_NO_BROTLI=1; skipping .br sibling (host compresses on the fly)"
    fi
    printf '%s\n' "$prod_fingerprint" > "$prod_fingerprint_file"
  fi
else
  rm -f "$artifact.br" "$prod_fingerprint_file"
  cp "$built_artifact" "$artifact"
  "$WASI_STRIP" "$artifact"
fi

# Generate the attribution bundle beside every build artifact. The webapp build
# emits the same bundle into its final dist root, and native package preparation
# does the equivalent for CLI packages.
node "$MISE_PROJECT_ROOT/scripts/gen-third-party-licenses.mjs" "$out_dir"

# Sync into the npm package only when built to a separate output directory.
if [[ "$out_dir" != "$pkg_dir" ]]; then
  node "$MISE_PROJECT_ROOT/packages/rom-weaver-webapp/scripts/sync-dist.mjs" "$out_dir"
fi

if [[ "$mode" == "prod" && "${want_brotli:-1}" == "1" ]]; then
  echo "artifacts written to $out_dir (rom-weaver-app.wasm, rom-weaver-app.wasm.br)"
else
  echo "artifact written to $out_dir/rom-weaver-app.wasm"
fi
