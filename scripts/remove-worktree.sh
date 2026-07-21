#!/usr/bin/env bash
# Remove a linked worktree, refusing if it still holds uncommitted work.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/remove-worktree.sh <worktree>" >&2
  exit 2
fi

worktree_dir="$1"
if [ ! -d "$worktree_dir" ]; then
  echo "remove-worktree: not a directory: $worktree_dir" >&2
  exit 1
fi

worktree_dir="$(cd "$worktree_dir" && pwd -P)"
if ! git -C "$worktree_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "remove-worktree: not a git worktree: $worktree_dir" >&2
  exit 1
fi

real_status="$(git -C "$worktree_dir" status --porcelain=v1 --untracked-files=all)"

if [ -n "$real_status" ]; then
  echo "remove-worktree: refusing to remove dirty worktree: $worktree_dir" >&2
  printf '%s\n' "$real_status" >&2
  exit 1
fi

git worktree remove "$worktree_dir"
