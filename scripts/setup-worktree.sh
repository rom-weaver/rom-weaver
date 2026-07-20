#!/usr/bin/env bash
# Prepare a fresh git worktree for development and browser tests.
#
# History: this script used to mirror the main checkout's node_modules into the
# worktree (third-party deps symlinked, workspace deps copied as symlinks).
# That mirror silently stalls vitest browser mode - the node-side module
# runner never dispatches test files, with no error - so worktrees needed a
# manual `npm ci` before browser tests anyway. With the wasm package merged
# into rom-weaver-webapp there is a single package install, and npm's cache
# makes a real `npm ci` take seconds, so the mirror is gone.
#
# This script:
#   - runs `npm ci` at the repo root and in packages/rom-weaver-webapp
#   - copies the built wasm artifacts from the main checkout (if present) so
#     browser tests and the dev server work without a local wasm build
#   - links vendor/* submodules (nod, libarchive) from the main checkout so the
#     fork-tracked / cmake-built C deps need no re-init or rebuild
#
# The cargo target dir is NOT handled here - keep a worktree-local target;
# sharing main's target breaks cmake-built wasm C deps like libarchive.
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

# vendor/* submodules are gitlinks: a fresh worktree leaves them empty. Building
# them here is slow (libarchive is a cmake C build) and nod is a source-refresh
# checkout,
# so mirror the already-populated copies from the main checkout via symlink.
# Re-runnable: skip when already a symlink, and only link an empty worktree copy
# against a populated main copy.
echo "setup-worktree: link vendor submodules from main checkout"
for submodule in nod libarchive; do
  worktree_vendor="$worktree_dir/vendor/$submodule"
  main_vendor="$main_dir/vendor/$submodule"
  if [ -L "$worktree_vendor" ]; then
    continue
  fi
  if [ -d "$main_vendor" ] && [ -n "$(ls -A "$main_vendor" 2>/dev/null)" ]; then
    if [ -z "$(ls -A "$worktree_vendor" 2>/dev/null)" ]; then
      rmdir "$worktree_vendor" 2>/dev/null || true
      ln -s "$main_vendor" "$worktree_vendor"
      echo "  linked vendor/$submodule"
    fi
  else
    echo "  skip vendor/$submodule: main checkout copy is missing or empty" >&2
  fi
done

# The vendor symlinks above make git report each submodule as a gitlink->symlink
# typechange ("T"), which is phantom noise. Silence it PER WORKTREE (not in
# .gitmodules) so the main checkout still surfaces real submodule pointer bumps
# in `git status`. Git still requires `--force` to remove any worktree containing
# submodules; use scripts/remove-worktree.sh for a dirty-worktree guard.
echo "setup-worktree: silence vendor typechange noise (worktree-scoped)"
git config extensions.worktreeConfig true
for submodule in nod libarchive; do
  git config --worktree "submodule.vendor/$submodule.ignore" all
done

echo "setup-worktree: done for $worktree_dir"
