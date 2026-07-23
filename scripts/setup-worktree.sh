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

echo "setup-worktree: npm ci (packages workspace: @rom-weaver/wasm + @rom-weaver/webapp)"
npm ci --no-audit --no-fund --prefix "$worktree_dir/packages"

# The wasm binary is a gitignored build artifact; copy it from the main checkout
# so a fresh worktree can bundle the @rom-weaver/wasm package without a full
# WASI toolchain build. Prefer the current package location, falling back to the
# pre-split webapp path when the main checkout predates the split.
wasm_dst="$worktree_dir/packages/rom-weaver-wasm/src"
mkdir -p "$wasm_dst"
for wasm_src in \
  "$main_dir/packages/rom-weaver-wasm/src" \
  "$main_dir/packages/rom-weaver-webapp/src/wasm"; do
  [ -d "$wasm_src" ] || continue
  for artifact in rom-weaver-app.wasm rom-weaver-app.wasm.br; do
    if [ -f "$wasm_src/$artifact" ]; then
      cp "$wasm_src/$artifact" "$wasm_dst/$artifact"
      echo "  copied $artifact from $wasm_src"
    fi
  done
  break
done

echo "setup-worktree: bundle @rom-weaver/wasm"
node "$worktree_dir/packages/rom-weaver-wasm/scripts/build.mjs"

echo "setup-worktree: done for $worktree_dir"
