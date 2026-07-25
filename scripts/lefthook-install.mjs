#!/usr/bin/env node

// Installs the git hooks, but only from the main checkout: linked worktrees
// share its hook directory, so installing from one would race the other.

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { runMain } from "./run-main.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

runMain(() => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    // Installing from a tarball rather than a clone is normal, not an error.
    return 0;
  }
  const mainDir = dirname(resolve(process.cwd(), git(["rev-parse", "--git-common-dir"])));
  if (mainDir !== git(["rev-parse", "--show-toplevel"])) {
    process.stdout.write("lefthook-install: in a worktree - skipping install (shared hooks come from the main checkout)\n");
    return 0;
  }
  execFileSync("lefthook", ["install"], { cwd: mainDir, stdio: "inherit" });
  return 0;
});
