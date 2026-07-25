#!/usr/bin/env node

// Translates the composite action's positive `tools:` list into the negative
// MISE_DISABLE_TOOLS list mise actually accepts, for every later step in the job.

import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";
import { disabledTools } from "./mise-disable-tools.mjs";

runMain(() => {
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
  const wanted = (process.env.WANTED || "").split(/\s+/).filter(Boolean);
  const disable = disabledTools(".config/mise.toml", wanted);
  appendFileSync(process.env.GITHUB_ENV, `MISE_DISABLE_TOOLS=${disable}\n`);
  process.stdout.write(`installing: ${wanted.join(" ") || "(every pinned tool)"}\ndisabled:   ${disable || "(none)"}\n`);
});
