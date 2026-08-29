#!/usr/bin/env node

// Where Cargo actually writes build output.
//
// Any script that reads a Cargo-produced artifact MUST resolve its path through
// here instead of joining "target" onto the repository root: a shared
// CARGO_TARGET_DIR (one target directory for several worktrees) then moves the
// artifact out from under the hardcoded path and the script fails after a
// successful build. Directories the scripts themselves own - staged identify
// data, the parity workspace, the license bundle - are not Cargo output and
// stay where they are.
//
// Cargo resolves a relative CARGO_TARGET_DIR against the current directory, and
// prefers it over build.target-dir (whose env spelling is
// CARGO_BUILD_TARGET_DIR), so this mirrors both rules.

import { resolve } from "node:path";
import process from "node:process";

export function cargoTargetDir(root, env = process.env, cwd = process.cwd()) {
  const configured = env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR;
  return configured ? resolve(cwd, configured) : resolve(root, "target");
}
