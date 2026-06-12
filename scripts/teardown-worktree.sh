#!/usr/bin/env bash
# Tear down a development git worktree created with setup-worktree.sh.
#
# Why this exists: the worktree's vendored submodules (vendor/libarchive,
# vendor/nod) — whether real checkouts or symlinks into the main checkout — make
# `git worktree remove` fail with "working trees containing submodules cannot be
# moved or removed", forcing a manual rm + `worktree prune` dance every time.
# This script clears the submodule working trees first (discovered from
# .gitmodules, so it keeps working if the set changes) and then removes the
# worktree cleanly. Everything is local: no fetch/push/force-push.
#
# It refuses to run if the worktree has uncommitted changes other than the
# disposable vendor/* submodule symlinks, so it can't silently destroy work.
# Pass --force to skip that guard (and force the removal) when you know the tree
# is disposable.
#
# Usage:
#   scripts/teardown-worktree.sh [--force] [worktree-path]
#     (no path => the worktree you're currently inside)
# Run from the main checkout or from inside the worktree; either works.
set -euo pipefail

force=0
target_arg=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) target_arg="$arg" ;;
  esac
done

# Resolve the worktree to tear down and its main checkout.
if [ -n "$target_arg" ]; then
  worktree_dir="$(cd "$target_arg" && git rev-parse --show-toplevel)"
else
  worktree_dir="$(git rev-parse --show-toplevel)"
fi
main_dir="$(cd "$(git -C "$worktree_dir" rev-parse --git-common-dir)/.." && pwd)"

if [ "$main_dir" = "$worktree_dir" ]; then
  echo "teardown-worktree: '$worktree_dir' is the main checkout, not a worktree" >&2
  exit 1
fi

branch="$(git -C "$worktree_dir" rev-parse --abbrev-ref HEAD)"

# Safety: anything dirty beyond the vendor/* submodule symlinks is real work.
if [ "$force" -ne 1 ]; then
  remaining="$(git -C "$worktree_dir" status --porcelain \
    | grep -vE 'vendor/(libarchive|nod)$' || true)"
  if [ -n "$remaining" ]; then
    echo "teardown-worktree: refusing — uncommitted changes in $worktree_dir:" >&2
    echo "$remaining" >&2
    echo "Commit/stash them, or re-run with --force if they are disposable." >&2
    exit 1
  fi
fi

# Clear submodule working trees so `git worktree remove` does not balk. Paths come
# from .gitmodules so new submodules are handled automatically; rm -rf covers both
# the symlink case (setup-worktree links them from the main checkout) and a real
# checked-out submodule.
submodule_paths="$(git -C "$worktree_dir" config --file "$main_dir/.gitmodules" \
  --get-regexp 'submodule\..*\.path$' 2>/dev/null | awk '{print $2}' || true)"
for sm in $submodule_paths; do
  [ -n "$sm" ] || continue
  if [ -e "$worktree_dir/$sm" ] || [ -L "$worktree_dir/$sm" ]; then
    # `:?` aborts rather than ever letting an empty var expand to a path near /.
    rm -rf "${worktree_dir:?}/${sm:?}"
    echo "  cleared submodule path $sm"
  fi
done

# Remove the worktree from the main checkout (you cannot remove the one you stand
# in, so always drive it from main_dir). Try a clean removal first; fall back to
# --force, which is safe here because the guard above verified the tree is clean.
if [ "$force" -eq 1 ]; then
  git -C "$main_dir" worktree remove --force "$worktree_dir"
else
  git -C "$main_dir" worktree remove "$worktree_dir" \
    || git -C "$main_dir" worktree remove --force "$worktree_dir"
fi
git -C "$main_dir" worktree prune
echo "teardown-worktree: removed $worktree_dir"

# Delete the branch only if it is fully merged (-d refuses otherwise and when it is
# checked out elsewhere). Never force-delete — unmerged work stays put.
if git -C "$main_dir" branch -d "$branch" 2>/dev/null; then
  echo "teardown-worktree: deleted merged branch $branch"
else
  echo "teardown-worktree: kept branch $branch (not merged, or checked out elsewhere)"
fi
