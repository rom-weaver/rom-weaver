#!/usr/bin/env bash
# Prepare a fresh git worktree for development and browser tests.
#
# Installs package dependencies, copies built WASM artifacts, and links the
# populated libarchive submodule from main. A real `npm ci` is required because
# mirrored node_modules stalls Vitest browser mode.
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

# Fresh worktrees leave the libarchive gitlink empty; link the populated main
# copy to avoid rebuilding it. Re-runs preserve existing data.
vendor_submodules=(libarchive)

echo "setup-worktree: link vendor submodules from main checkout"
for submodule in "${vendor_submodules[@]}"; do
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

# Hide expected gitlink-to-symlink typechanges only in this worktree; the main
# checkout must still report real pointer changes. Use remove-worktree.sh
# because Git requires force for worktrees containing submodules.
echo "setup-worktree: silence vendor typechange noise (worktree-scoped)"
git config extensions.worktreeConfig true
for submodule in "${vendor_submodules[@]}"; do
  git config --worktree "submodule.vendor/$submodule.ignore" all
done

echo "setup-worktree: done for $worktree_dir"
