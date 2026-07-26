#!/usr/bin/env node

// The image table lives here rather than in the `docker` job because a matrix
// can only be fed by an upstream job's output.

import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";

runMain(() => {
  const legs = [];
  const source = process.env.SOURCE_BUILD === "true";
  if (process.env.CLI_SELECTED === "true") legs.push({ name: "CLI", image: "rom-weaver-cli", file: "Dockerfile", source });
  if (process.env.WEBAPP_SELECTED === "true" && source) {
    legs.push({ name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile", source });
  }
  const matrix = JSON.stringify(legs);
  process.stdout.write(`Docker legs: ${matrix}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
});
