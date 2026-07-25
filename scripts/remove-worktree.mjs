#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function removeWorktree(worktreeDir) {
  if (!worktreeDir) throw Object.assign(new Error("usage: node scripts/remove-worktree.mjs <worktree>"), { code: 2 });
  if (!existsSync(worktreeDir)) throw new Error(`remove-worktree: not a directory: ${worktreeDir}`);
  const resolved = realpathSync(worktreeDir);
  try { execFileSync("git", ["-C", resolved, "rev-parse", "--show-toplevel"], { stdio: "ignore" }); }
  catch { throw new Error(`remove-worktree: not a git worktree: ${resolved}`); }
  const status = execFileSync("git", ["-C", resolved, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (status) throw new Error(`remove-worktree: refusing to remove dirty worktree: ${resolved}\n${status.trimEnd()}`);
  execFileSync("git", ["worktree", "remove", resolved], { stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { removeWorktree(process.argv[2]); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = error.code || 1; }
}
