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

// src/chd (the folded rom-weaver-chd crate, never in this guard's scope) uses
// the cfg pair for its decode heap-pregrow, which enables threaded wasm rather
// than suppressing it. browser-format-matrix.ts legitimately declares per-format
// `threads: 1` expectations.
const GUARDS = [
  {
    prefix: "crates/rom-weaver-containers/src",
    pattern: /wasm_threaded_runtime_.*is_unstable|target_family = "wasm", rom_weaver_wasi_threads/,
    excluded: (file) => file.includes("/chd/"),
    message: "container handlers should not suppress threaded WASM execution",
  },
  {
    prefix: "packages/rom-weaver-webapp/src",
    pattern: /threads:\s*1(?:[^0-9]|$)|toThreadArg\([^)]*,\s*["']1["']\)/,
    excluded: (file) => file.endsWith("browser-format-matrix.ts"),
    message: "browser runtime should not force single-threaded execution",
  },
];

export function checkThreadGuards(root = process.cwd()) {
  return GUARDS.map((guard) => ({ ...guard, hits: matches(root, guard.prefix, guard.pattern, guard.excluded) })).filter((guard) => guard.hits.length);
}

export function main(root = process.cwd()) {
  const failed = checkThreadGuards(root);
  for (const guard of failed) {
    process.stdout.write(`${guard.hits.join("\n")}\n`);
    process.stderr.write(`${guard.message}\n`);
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
