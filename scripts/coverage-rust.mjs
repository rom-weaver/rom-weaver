#!/usr/bin/env node

// Collect once with --no-report, then emit both formats from the same profdata.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { runMain } from "./run-main.mjs";

runMain(() => {
  const output = resolve(join(process.env.MISE_PROJECT_ROOT || process.cwd(), "dist/coverage/rust"));
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const run = (args) => execFileSync("cargo", ["llvm-cov", ...args], { stdio: "inherit" });
  run(["clean", "--workspace"]);
  run(["--workspace", "--no-report"]);
  run(["report", "--html", "--output-dir", output]);
  run(["report", "--lcov", "--output-path", join(output, "lcov.info")]);
});
