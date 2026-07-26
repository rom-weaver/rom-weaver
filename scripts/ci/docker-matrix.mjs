#!/usr/bin/env node

// The image table lives here rather than in the `docker` job because a matrix
// can only be fed by an upstream job's output.

import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";

// One leg per image *per architecture*, each on a runner of that architecture.
// Building arm64 under QEMU on an amd64 runner took 81 minutes for the CLI
// image and just over two hours for the webapp's source build; natively they
// are roughly five and nine. See docs/ci.md ("Docker images").
const ARCHES = [
  { arch: "amd64", runner: "ubuntu-24.04" },
  { arch: "arm64", runner: "ubuntu-24.04-arm" },
];

const IMAGES = [
  { selector: "CLI_SELECTED", name: "CLI", image: "rom-weaver-cli", file: "Dockerfile" },
  { selector: "WEBAPP_SELECTED", name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile" },
];

runMain(() => {
  const legs = [];
  for (const { selector, ...image } of IMAGES) {
    if (process.env[selector] !== "true") continue;
    for (const arch of ARCHES) legs.push({ ...image, ...arch });
  }
  const matrix = JSON.stringify(legs);
  process.stdout.write(`Docker legs: ${matrix}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
});
