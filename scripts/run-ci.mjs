#!/usr/bin/env node

// The webapp half of `mise run ci`; the Rust and lint halves are the task's
// `depends` list.

import { execFileSync } from "node:child_process";

import { runMain } from "./run-main.mjs";

const WEBAPP = ["--prefix", "packages/rom-weaver-webapp"];

runMain(() => {
  const run = (args) => execFileSync("npm", args, { stdio: "inherit" });
  run([...WEBAPP, "run", "lint"]);
  run(["test"]);
  run([...WEBAPP, "run", "test:unit"]);
  run([...WEBAPP, "run", "test:browser:wasm"]);
  run([...WEBAPP, "run", "test:browser"]);
  run([...WEBAPP, "run", "test:e2e:webapp"]);
  run([...WEBAPP, "run", "build"]);
});
