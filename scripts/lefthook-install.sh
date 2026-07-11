#!/usr/bin/env sh
# Install lefthook git hooks, but ONLY from the main checkout.
#
# Why the guard: git worktrees share one hooks directory (the common git dir's
# `.git/hooks`), so a single installed hook serves every worktree. `lefthook
# install` bakes the absolute path of the node_modules it was run from into that
# shared hook. If `npm ci` runs the `prepare` lifecycle inside a worktree (e.g.
# scripts/setup-worktree.sh), it rewrites the shared hook to point at that
# transient worktree's binary - so commits from main and every other worktree
# start shelling into a sibling worktree that may later be removed.
#
# Running install only from the main checkout keeps the baked path stable
# (main's node_modules always exists); worktrees inherit the shared hook for
# free. Re-runnable; no-op outside a git work tree.
set -eu

# Outside a git work tree (e.g. installed as a dependency, or a tarball build),
# there is nothing to install into - skip quietly.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

common_dir="$(git rev-parse --git-common-dir)"
main_dir="$(cd "$common_dir/.." && pwd)"
worktree_dir="$(git rev-parse --show-toplevel)"

if [ "$main_dir" != "$worktree_dir" ]; then
  echo "lefthook-install: in a worktree - skipping install (shared hooks come from the main checkout)"
  exit 0
fi

lefthook install
