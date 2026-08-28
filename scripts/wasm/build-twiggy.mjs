#!/usr/bin/env node

// Unoptimized, symbol-rich module for twiggy size analysis. The debug/strip
// overrides live in the `build-wasm-twiggy` mise task.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { runMain } from "../run-main.mjs";

const TARGET = "wasm32-wasip1-threads";

runMain(() => {
  const root = process.env.MISE_PROJECT_ROOT || process.cwd();
  const outDir = resolve(process.env.ROM_WEAVER_WASM_TWIGGY_OUT_DIR || join(root, "target/wasm-twiggy"));
  mkdirSync(outDir, { recursive: true });
  execFileSync("cargo", ["build", "-p", "rom-weaver-cli", "--no-default-features", "--features", "wasm-app", "--example", "rom-weaver-app", "--profile", "wasm-release", "--target", TARGET], { stdio: "inherit" });
  const artifact = join(outDir, "rom-weaver-app.wasm");
  cpSync(join(root, "target", TARGET, "wasm-release", "examples", "rom-weaver-app.wasm"), artifact);
  process.stdout.write(`twiggy-ready artifact: ${artifact}\nrun: twiggy top -n 80 ${artifact}\n`);
});
