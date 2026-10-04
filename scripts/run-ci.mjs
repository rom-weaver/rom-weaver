#!/usr/bin/env node

// The webapp half of `mise run ci`; the Rust and lint halves are the task's
// `depends` list.

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runMain } from "./run-main.mjs";

const WEBAPP = ["--prefix", "packages/rom-weaver-webapp"];

const runNpm = (args, environment = {}) =>
  execFileSync("npm", args, { stdio: "inherit", env: { ...process.env, ...environment } });

export function runCi(run = runNpm) {
  run([...WEBAPP, "run", "lint"]);
  run(["test"]);
  run([...WEBAPP, "run", "test:scripts"]);
  run([...WEBAPP, "run", "test:unit"]);
  run([...WEBAPP, "run", "build"], { ROM_WEAVER_CHANNEL: "prod" });
  run([...WEBAPP, "run", "check:size"]);
  run([...WEBAPP, "run", "test:browser:wasm"]);
  run([...WEBAPP, "run", "test:browser"]);
  run([...WEBAPP, "run", "test:e2e:webapp"], {
    ROM_WEAVER_CHANNEL: "prod",
    ROM_WEAVER_E2E_USE_PREBUILT_DIST: "1",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(() => runCi());
}
