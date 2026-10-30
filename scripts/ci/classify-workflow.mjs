#!/usr/bin/env node

// Manual dispatches, pushes (to main and release tags), and unavailable base commits MUST select every stack to preserve CI coverage.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";
import {
  canReuseArmDockerWasm,
  classifyChanges,
  coverageTiers,
  formatChanges,
  narrowSelection,
  scheduledSelection,
} from "./classify-changes.mjs";
import { isReleasePullRequest } from "./release-pr.mjs";

const EMPTY_SHA = "0".repeat(40);

function changedPaths({ eventName, baseSha, headSha, quiet = false }) {
  if (eventName === "workflow_dispatch" || eventName === "push") return null;
  if (!baseSha || baseSha === EMPTY_SHA) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", "--no-renames", baseSha, headSha], {
      encoding: "utf8",
      maxBuffer: Infinity,
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    if (!quiet) process.stdout.write(`base ${baseSha} is unreachable; classifying everything\n`);
    return null;
  }
}

// Null when no earlier green run applies; the caller then selects from the full diff.
function priorGreenPaths({ eventName, headSha }) {
  const priorSha = process.env.PRIOR_GREEN_SHA;
  if (eventName !== "pull_request" || !priorSha) return null;
  const paths = changedPaths({ eventName, baseSha: priorSha, headSha, quiet: true });
  if (paths === null) {
    process.stdout.write(`earlier green run ${priorSha} is unreachable; using the full diff\n`);
    return null;
  }
  process.stdout.write(
    `paths changed since the earlier green run ${priorSha}:\n${paths.length ? paths.join("\n") : "(none)"}\n`,
  );
  return paths;
}

runMain(() => {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const eventName = process.env.EVENT_NAME;
  const headRef = process.env.HEAD_REF;
  const releasePullRequest = isReleasePullRequest(eventName, headRef);
  if (releasePullRequest)
    process.stdout.write(`${headRef} is the release pull request; classifying everything\n`);
  const paths = changedPaths({
    eventName,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
  });
  if (paths)
    process.stdout.write(`changed paths:\n${paths.length ? paths.join("\n") : "(none)"}\n`);
  const { fullMatrix, fullNative } = coverageTiers(eventName, headRef);
  // An earlier green run of this pull request already tested everything that
  // has not changed since, so a job runs only when the pull request diff and the
  // change since that run both select it. The raw diff above still decides
  // cache eligibility, which looks at the whole pull request.
  const whole = classifyChanges(paths ?? [], paths === null, eventName, headRef);
  const sincePaths = paths && priorGreenPaths({ eventName, headSha: process.env.HEAD_SHA });
  const changes = sincePaths
    ? narrowSelection(whole, classifyChanges(sincePaths, false, eventName, headRef))
    : whole;
  const output = `${formatChanges(
    eventName === "schedule" ? scheduledSelection(changes) : changes,
  )}full_matrix=${fullMatrix}\nfull_native=${fullNative}\ndocker_arm_wasm_cache=${canReuseArmDockerWasm(paths)}\n`;
  process.stdout.write(output);
  appendFileSync(process.env.GITHUB_OUTPUT, output);
});
