#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "syncing crates.io vendored sources"
cargo vendor \
  --manifest-path "$ROOT_DIR/Cargo.toml" \
  --versioned-dirs \
  "$TMP_DIR" \
  >/dev/null

for crate_dir in \
  libflac-sys-0.3.4 \
  sevenz-rust2-0.20.2 \
  zstd-seekable-0.1.23; do
  if [[ ! -d "$TMP_DIR/$crate_dir" ]]; then
    echo "error: missing $crate_dir in cargo vendor output" >&2
    exit 1
  fi

  rm -rf "$ROOT_DIR/vendor/$crate_dir"
  cp -R "$TMP_DIR/$crate_dir" "$ROOT_DIR/vendor/$crate_dir"
  echo "updated vendor/$crate_dir"
done

"$ROOT_DIR/scripts/vendor/prune-vendor.sh"

echo "vendor sync complete"
