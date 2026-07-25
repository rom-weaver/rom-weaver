# Agent instructions

## Worktrees

This repository has no Git submodules; every vendored source is committed
in-tree, so a linked worktree is complete as soon as it is created.

Before cleanup, verify the worktree has no real changes, then use the repository
helper:

```bash
node scripts/remove-worktree.mjs .worktrees/<name>
```

The helper refuses to remove a worktree with tracked or untracked changes.
