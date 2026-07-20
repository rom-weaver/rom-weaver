# Agent instructions

## Worktrees

`vendor/libarchive` is a Git submodule. `scripts/setup-worktree.sh` links its
populated copy from the main checkout into linked worktrees, so Git may show it
as an expected gitlink-to-symlink typechange.

Git refuses to remove any worktree containing submodules, even when it is clean.
Before cleanup, verify the worktree has no real changes, then use the repository
helper:

```bash
scripts/remove-worktree.sh .worktrees/<name>
```

The helper ignores only the expected vendor symlinks, refuses other tracked or
untracked changes, and uses `git worktree remove --force` after that check.
