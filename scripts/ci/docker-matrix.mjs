#!/usr/bin/env node

// The image table lives here rather than in the `docker` job because a matrix
// can only be fed by an upstream job's output.

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runMain } from "../run-main.mjs";

// One leg per image *per architecture*, each on a runner of that architecture.
// Building arm64 under QEMU on an amd64 runner took 81 minutes for the CLI
// image and just over two hours for the webapp's source build; natively they
// are roughly five and nine. See docs/development/ci.md ("Docker images").
const ARCHES = [
  { arch: "amd64", runner: "ubuntu-24.04" },
  { arch: "arm64", runner: "ubuntu-24.04-arm" },
];

const IMAGES = [
  { selector: "CLI_SELECTED", arm64Selector: "CLI_ARM64", name: "CLI", image: "rom-weaver-cli", file: "Dockerfile" },
  { selector: "WEBAPP_SELECTED", arm64Selector: "WEBAPP_ARM64", name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile" },
];

// A leg no selector asked for has to be absent from the matrix rather than
// started and skipped - that is the whole saving - so the architecture list is
// resolved per image here rather than by a step the leg itself runs.
//
// `classify-changes.mjs` decides when an image's arm64 half is wanted, and it is
// the half that has to stay honest: it sets the flag for every event except a
// pull request, so the narrowing this reads can only ever apply to one.
export function planLegs(env = process.env) {
  const legs = [];
  for (const { selector, arm64Selector, ...image } of IMAGES) {
    if (env[selector] !== "true") continue;
    const arches =
      env[arm64Selector] === "true" ? ARCHES : ARCHES.filter(({ arch }) => arch !== "arm64");
    for (const arch of arches) legs.push({ ...image, ...arch });
  }
  return legs;
}

export function main() {
  const matrix = JSON.stringify(planLegs());
  process.stdout.write(`Docker legs: ${matrix}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}

// Guarded so the unit test can import `planLegs` without planning a matrix out
// of the test runner's own environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(main);
