#!/usr/bin/env node

// Scripts that read Cargo artifacts MUST respect the target-directory override.
// Each checkout MUST use its own target directory to avoid stale build output.

import { resolve } from "node:path";
import process from "node:process";

export function cargoTargetDir(root, env = process.env, cwd = process.cwd()) {
  // Cargo resolves relative overrides against cwd and prefers CARGO_TARGET_DIR.
  const configured = env.CARGO_TARGET_DIR || env.CARGO_BUILD_TARGET_DIR;
  return configured ? resolve(cwd, configured) : resolve(root, "target");
}
