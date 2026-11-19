#!/usr/bin/env node

// Manual dispatches, pushes (to main and release tags), and unavailable base commits MUST select every stack to preserve CI coverage.
// The one exception is a push to main whose paths since the last green push are all docs (`docsOnlyPushPaths`).

import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";
import {
  canReuseArmDockerWasm,
  changedPathsBetween,
  classifyChanges,
  coverageTiers,
  formatChanges,
  isDocsOnlyChange,
  narrowSelection,
  scheduledSelection,
} from "./classify-changes.mjs";
import { isReleasePullRequest } from "./release-pr.mjs";

const EMPTY_SHA = "0".repeat(40);

function changedPaths({ baseSha, headSha, quiet = false }) {
  if (!baseSha || baseSha === EMPTY_SHA) return null;
  try {
    return changedPathsBetween(baseSha, headSha);
  } catch {
    if (!quiet) process.stdout.write(`base ${baseSha} is unreachable; classifying everything\n`);
    return null;
  }
}

// Null when no earlier green run applies; the caller then selects from the full diff.
function priorGreenPaths({ eventName, headSha }) {
  const priorSha = process.env.PRIOR_GREEN_SHA;
  if (eventName !== "pull_request" || !priorSha) return null;
  const paths = changedPaths({ baseSha: priorSha, headSha, quiet: true });
  if (paths === null) {
    process.stdout.write(`earlier green run ${priorSha} is unreachable; using the full diff\n`);
    return null;
  }
  process.stdout.write(
    `paths changed since the earlier green run ${priorSha}:\n${paths.length ? paths.join("\n") : "(none)"}\n`,
  );
  return paths;
}

// A push to main is narrowed only against the last green push run, never against
// `github.event.before`: a pending run replaced by a newer push never ran, so
// its changes are not in the newer push's own range. Null selects every stack.
function docsOnlyPushPaths(headSha) {
  const greenSha = process.env.MAIN_GREEN_SHA;
  if (process.env.GITHUB_REF !== "refs/heads/main" || !greenSha) return null;
  const paths = changedPaths({ baseSha: greenSha, headSha });
  return paths && isDocsOnlyChange(paths) ? paths : null;
}

runMain(() => {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const eventName = process.env.EVENT_NAME;
  const headRef = process.env.HEAD_REF;
  const releasePullRequest = isReleasePullRequest(eventName, headRef);
  if (releasePullRequest)
    process.stdout.write(`${headRef} is the release pull request; classifying everything\n`);
  // A push has no pull request base, so only the ARM image decision reads its pushed range
  // (and `docsOnlyPushPaths` its own range, below).
  const rangePaths =
    eventName === "workflow_dispatch"
      ? null
      : changedPaths({
          baseSha: process.env.BASE_SHA,
          headSha: process.env.HEAD_SHA,
          quiet: eventName === "push",
        });
  const paths =
    eventName === "push" ? docsOnlyPushPaths(process.env.HEAD_SHA) : rangePaths;
  if (paths)
    process.stdout.write(`changed paths:\n${paths.length ? paths.join("\n") : "(none)"}\n`);
  const { fullMatrix, fullNative, nightlyChecks, qualitySignals } = coverageTiers(
    eventName,
    headRef,
  );
  // An earlier green run of this pull request already tested everything that
  // has not changed since, so a job runs only when the pull request diff and the
  // change since that run both select it. The raw range still decides
  // cache eligibility, which looks at the whole pull request or push.
  const whole = classifyChanges(paths ?? [], paths === null, eventName, headRef);
  const sincePaths = paths && priorGreenPaths({ eventName, headSha: process.env.HEAD_SHA });
  const changes = sincePaths
    ? narrowSelection(whole, classifyChanges(sincePaths, false, eventName, headRef))
    : whole;
  const output = `${formatChanges(
    eventName === "schedule" ? scheduledSelection(changes) : changes,
  )}full_matrix=${fullMatrix}\nfull_native=${fullNative}\nnightly_checks=${nightlyChecks}\nquality_signals=${qualitySignals}\ndocker_arm_wasm_cache=${canReuseArmDockerWasm(rangePaths, process.env.BASE_SHA, process.env.HEAD_SHA)}\nrelease_pr=${releasePullRequest}\n`;
  process.stdout.write(output);
  appendFileSync(process.env.GITHUB_OUTPUT, output);
});
