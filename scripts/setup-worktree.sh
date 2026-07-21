#!/usr/bin/env bash
# Prepare a fresh git worktree for development and browser tests.
#
# Installs package dependencies and copies built WASM artifacts. A real
# `npm ci` is required because mirrored node_modules stalls Vitest browser mode.
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

echo "setup-worktree: done for $worktree_dir"
