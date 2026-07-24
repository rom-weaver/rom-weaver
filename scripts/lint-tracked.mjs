#!/usr/bin/env node

// Run a linter over every tracked file matching the given pathspecs, minus the
// vendored trees. One implementation for the shellcheck and hadolint tasks,
// which are the same three moves: resolve the exclusions, bail out cleanly when
// nothing matches, then feed the file list to the tool.
//
// usage: node scripts/lint-tracked.mjs <pathspec>... -- <command>...
//   node scripts/lint-tracked.mjs '*.sh' -- shellcheck -x -P SCRIPTDIR
//
// git ls-files rather than a find walk: it skips node_modules for free, and only
// tracked files are ours to fix.

import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { vendoredExclusions } from "./vendored-pathspecs.mjs";

// Conservative fraction of ARG_MAX, which is 256 KiB on macOS and 2 MiB on
// Linux. Replaces the `xargs -0` the shell version piped through; without the
// split, a broad pathspec fails with E2BIG instead of linting.
const MAX_ARG_BYTES = 100_000;

export function chunkArguments(files, fixedBytes = 0, limit = MAX_ARG_BYTES) {
  const chunks = [];
  let current = [];
  let size = fixedBytes;
  for (const file of files) {
    const cost = Buffer.byteLength(file) + 1;
    if (current.length && size + cost > limit) {
      chunks.push(current);
      current = [];
      size = fixedBytes;
    }
    current.push(file);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function trackedFiles(root, patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns, ...vendoredExclusions()], { cwd: root, maxBuffer: Infinity })
    .toString()
    .split("\0")
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2), root = fileURLToPath(new URL("..", import.meta.url))) {
  const separator = argv.indexOf("--");
  if (separator <= 0 || separator === argv.length - 1) {
    process.stderr.write("usage: node scripts/lint-tracked.mjs <pathspec>... -- <command>...\n");
    return 2;
  }
  const patterns = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const files = trackedFiles(root, patterns);
  if (!files.length) {
    process.stderr.write(`${command[0]}: no tracked files matching ${patterns.join(" ")}\n`);
    return 0;
  }
  const fixedBytes = command.reduce((total, argument) => total + Buffer.byteLength(argument) + 1, 0);
  let status = 0;
  // Every chunk runs even after a failure, so one bad file cannot hide the
  // findings in the rest - the same thing xargs did.
  for (const chunk of chunkArguments(files, fixedBytes)) {
    status = (spawnSync(command[0], [...command.slice(1), ...chunk], { cwd: root, stdio: "inherit" }).status ?? 1) || status;
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
