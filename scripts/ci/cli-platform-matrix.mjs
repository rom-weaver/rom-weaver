#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PR_PLATFORM_PACKAGES = new Set(["darwin-arm64", "linux-arm64-musl", "linux-x64-gnu", "win32-x64-msvc"]);

export function readPlatformMatrix(file = resolve(repoRoot, ".github/cli-platforms.json"), full = true) {
  const matrix = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(matrix) || matrix.length === 0) throw new Error(`${file} lists no CLI platforms; refusing to emit an empty matrix`);
  const selected = full ? matrix : matrix.filter(({ package: packageName }) => PR_PLATFORM_PACKAGES.has(packageName));
  if (selected.length === 0) throw new Error(`${file} lists no PR CLI platforms; refusing to emit an empty matrix`);
  return selected;
}

export function main(argv = process.argv.slice(2)) {
  const matrix = JSON.stringify(readPlatformMatrix(argv[0], process.env.FULL_MATRIX !== "false"));
  process.stdout.write(`${matrix}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
