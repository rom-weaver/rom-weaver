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
XDELTA_DIR="$ROOT_DIR/vendor/xdelta3-src"

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

if [[ -d "$XDELTA_DIR" ]]; then
  remove_path "$XDELTA_DIR/examples"
  remove_path "$XDELTA_DIR/m4"
  remove_path "$XDELTA_DIR/testing"
  remove_file "$XDELTA_DIR/Makefile.am"
  remove_file "$XDELTA_DIR/badcopy.c"
  remove_file "$XDELTA_DIR/configure.ac"
  remove_file "$XDELTA_DIR/draft-korn-vcdiff.txt"
  remove_file "$XDELTA_DIR/install-sh"
  remove_file "$XDELTA_DIR/linkxd3lib.c"
  remove_file "$XDELTA_DIR/plot.sh"
  remove_file "$XDELTA_DIR/rcs_junk.cc"
  remove_file "$XDELTA_DIR/run_release.sh"
  remove_file "$XDELTA_DIR/xdelta3.1"
  remove_file "$XDELTA_DIR/xdelta3.i"
  remove_file "$XDELTA_DIR/xdelta3.vcxproj"
  remove_file "$XDELTA_DIR/xdelta3.wxi"
  remove_file "$XDELTA_DIR/xdelta3.wxs"
fi

required_xdelta_files=(
  LICENSE
  README.md
  xdelta3.c
  xdelta3.h
  xdelta3-internal.h
  xdelta3-list.h
  xdelta3-hash.h
  xdelta3-cfgs.h
  xdelta3-second.h
  xdelta3-fgk.h
  xdelta3-djw.h
  xdelta3-lzma.h
  xdelta3-main.h
  xdelta3-test.h
  xdelta3-decode.h
  xdelta3-blkcache.h
  xdelta3-merge.h
)

for file in "${required_xdelta_files[@]}"; do
  if [[ -d "$XDELTA_DIR" && ! -f "$XDELTA_DIR/$file" ]]; then
    echo "error: expected $XDELTA_DIR/$file" >&2
    exit 1
  fi
done

if [[ -d "$SEVENZ_DIR" ]]; then
  for file in Cargo.toml LICENSE src/lib.rs; do
    if [[ ! -f "$SEVENZ_DIR/$file" ]]; then
      echo "error: expected $SEVENZ_DIR/$file" >&2
      exit 1
    fi
  done
fi

echo "vendor prune complete"
