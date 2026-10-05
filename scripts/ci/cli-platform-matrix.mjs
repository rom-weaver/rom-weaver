#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { coverageTiers } from "./classify-changes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function readPlatformMatrix(file = resolve(repoRoot, ".github/cli-platforms.json")) {
  const matrix = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(matrix) || matrix.length === 0)
    throw new Error(`${file} lists no CLI platforms; refusing to emit an empty matrix`);
  return matrix;
}

// Pull requests and pushes to main build one representative Linux release
// package - the entry marked `"pr": true`. The other eight run on the nightly
// schedule and on the release pull request, before anything can ship; this is
// the `full_native` tier in classify-changes.mjs.
//
// Only `pull_request` and `push` narrow, and an absent EVENT_NAME means the
// full matrix: a caller that does not pass one (the release fan-out's `plan`
// job in npm-publish.yml) can never silently publish a subset.
//
// The release pull request is the exception among pull requests: it is the
// commit that ships, so it builds all nine targets rather than the one target a
// review needs.
export function selectPlatformMatrix(matrix, eventName, headRef = undefined) {
  if (!coverageTiers(eventName, headRef).fullNative) {
    const subset = matrix.filter((platform) => platform.pr === true);
    if (subset.length === 0)
      throw new Error('no CLI platform is marked "pr": true; refusing to emit an empty matrix');
    return subset;
  }
  return matrix;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const matrix = JSON.stringify(
    selectPlatformMatrix(readPlatformMatrix(argv[0]), env.EVENT_NAME, env.HEAD_REF),
  );
  process.stdout.write(`${matrix}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
