#!/usr/bin/env node

// The `plumbing` aggregate. One call per selection flag rather than one for the
// job, because these jobs do not share a single flag; every group is checked
// even after one fails, so a run reports all of its problems at once.

import process from "node:process";

import { runMain } from "../run-main.mjs";
import { assertJobs } from "./assert-jobs.mjs";

runMain(() => {
  const groups = [
    [process.env.REPO_LINT_SELECTED, [`repo-lint=${process.env.REPO_LINT_RESULT}`]],
    [process.env.DOCKER_SELECTED, [`docker=${process.env.DOCKER_RESULT}`]],
    [process.env.WASM_SELECTED, [`wasm=${process.env.WASM_RESULT}`]],
    [
      process.env.DOCKER_PREBUILT_SELECTED,
      [`docker-prebuilt=${process.env.DOCKER_PREBUILT_RESULT}`],
    ],
  ];
  let status = 0;
  for (const [selected, dependencies] of groups) {
    const result = assertJobs(process.env.CHANGES_RESULT, selected, dependencies);
    if (result.output.length) process.stdout.write(`${result.output.join("\n")}\n`);
    if (result.failed) status = 1;
  }
  return status;
});
