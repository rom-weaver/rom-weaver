#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const files = (root, prefix) =>
  execFileSync("git", ["ls-files", "-z", "--", prefix], { cwd: root, maxBuffer: Infinity }).toString().split("\0").filter(Boolean);

function matches(root, prefix, pattern, excluded = () => false) {
  const result = [];
  for (const file of files(root, prefix)) {
    if (excluded(file)) continue;
    readFileSync(join(root, file), "utf8").split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) result.push(`${file}:${index + 1}:${line}`);
    });
  }
  return result;
}

export function checkThreadGuards(root = process.cwd()) {
  const violations = [
    ...matches(root, "crates/rom-weaver-containers/src", /wasm_threaded_runtime_.*is_unstable|target_family = "wasm", rom_weaver_wasi_threads/, (file) => file.includes("/chd/")),
    ...matches(root, "packages/rom-weaver-webapp/src", /threads:\s*1(?:[^0-9]|$)|toThreadArg\([^)]*,\s*["']1["']\)/, (file) => file.endsWith("browser-format-matrix.ts")),
  ];
  return violations;
}

export function main(root = process.cwd()) {
  const violations = checkThreadGuards(root);
  if (violations.length) {
    process.stdout.write(`${violations.join("\n")}\n`);
    process.stderr.write("threaded WASM execution was suppressed\n");
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
