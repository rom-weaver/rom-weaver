#!/usr/bin/env bash
# Remove a linked worktree, including this repo's submodule-backed vendor links.
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

status="$(git -C "$worktree_dir" status --porcelain=v1 --untracked-files=all)"
real_status=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  path="${line:3}"
  case "$path" in
    vendor/libarchive)
      if [ -L "$worktree_dir/$path" ]; then
        continue
      fi
      ;;
  esac
  real_status+="$line\n"
done <<< "$status"

if [ -n "$real_status" ]; then
  echo "remove-worktree: refusing to remove dirty worktree: $worktree_dir" >&2
  printf '%b' "$real_status" >&2
  exit 1
fi

git worktree remove --force "$worktree_dir"
