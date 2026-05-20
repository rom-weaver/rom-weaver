#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

remove_path() {
  local target="$1"
  if [[ -e "$target" ]]; then
    rm -rf "$target"
  fi
}

remove_file() {
  local target="$1"
  if [[ -f "$target" ]]; then
    rm -f "$target"
  fi
}

SEVENZ_DIR="$ROOT_DIR/vendor/sevenz-rust2-0.20.2"

if [[ -d "$SEVENZ_DIR" ]]; then
  remove_path "$SEVENZ_DIR/.github"
  remove_path "$SEVENZ_DIR/examples"
  remove_path "$SEVENZ_DIR/tests"
  remove_file "$SEVENZ_DIR/.cargo-ok"
  remove_file "$SEVENZ_DIR/.cargo_vcs_info.json"
  remove_file "$SEVENZ_DIR/.gitattributes"
  remove_file "$SEVENZ_DIR/.gitignore"
  remove_file "$SEVENZ_DIR/Cargo.lock"
  remove_file "$SEVENZ_DIR/Cargo.toml.orig"
  remove_file "$SEVENZ_DIR/rustfmt.toml"
fi

if [[ -d "$SEVENZ_DIR" ]]; then
  for file in Cargo.toml LICENSE src/lib.rs; do
    if [[ ! -f "$SEVENZ_DIR/$file" ]]; then
      echo "error: expected $SEVENZ_DIR/$file" >&2
      exit 1
    fi
  done
fi

echo "vendor prune complete"
