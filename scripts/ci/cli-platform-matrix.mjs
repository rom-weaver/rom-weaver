#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function readPlatformMatrix(file = resolve(repoRoot, ".github/cli-platforms.json")) {
  const matrix = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(matrix) || matrix.length === 0) throw new Error(`${file} lists no CLI platforms; refusing to emit an empty matrix`);
  return matrix;
}

export function main(argv = process.argv.slice(2)) {
  const matrix = JSON.stringify(readPlatformMatrix(argv[0]));
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
