#!/usr/bin/env bash
# Prepare a fresh git worktree for development and browser tests.
#
# Installs package dependencies and copies the built WASM artifacts plus the
# generated attribution bundle. A real `npm ci` is required because mirrored
# node_modules stalls Vitest browser mode.
#
# Keep Cargo target directories worktree-local; sharing them breaks CMake-built
# WASM dependencies such as libarchive.
#
# Usage (from inside the worktree):  scripts/setup-worktree.sh
# Re-runnable.
set -euo pipefail

main_dir="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
worktree_dir="$(git rev-parse --show-toplevel)"
if [ "$main_dir" = "$worktree_dir" ]; then
  echo "setup-worktree: run this from inside a worktree, not the main checkout" >&2
  exit 1
fi

echo "setup-worktree: npm ci (root)"
npm ci --no-audit --no-fund --prefix "$worktree_dir"

echo "setup-worktree: npm ci (packages/rom-weaver-webapp)"
npm ci --no-audit --no-fund --prefix "$worktree_dir/packages/rom-weaver-webapp"

wasm_src="$main_dir/packages/rom-weaver-webapp/src/wasm"
wasm_dst="$worktree_dir/packages/rom-weaver-webapp/src/wasm"
for artifact in rom-weaver-app.wasm rom-weaver-app.wasm.br; do
  if [ -f "$wasm_src/$artifact" ]; then
    cp "$wasm_src/$artifact" "$wasm_dst/$artifact"
    echo "  copied $artifact from main checkout"
  fi
done

# The attribution bundle is gitignored but not optional: rom-weaver-static-assets
# hard-fails `vite build` when either is missing, so without these a fresh
# worktree can lint and test but never produce a bundle. Regenerate with
# `mise run licenses` if the main checkout has not built them either.
if [ -f "$wasm_src/NOTICE" ]; then
  cp "$wasm_src/NOTICE" "$wasm_dst/NOTICE"
  echo "  copied NOTICE from main checkout"
fi
if [ -d "$wasm_src/third_party" ]; then
  # cp expands the generator's hardlinks into full copies; the build re-collapses
  # them (dedupeTree) before they ship, so only this scratch copy is inflated.
  rm -rf "$wasm_dst/third_party"
  cp -R "$wasm_src/third_party" "$wasm_dst/third_party"
  echo "  copied third_party/ from main checkout"
fi

echo "setup-worktree: done for $worktree_dir"
