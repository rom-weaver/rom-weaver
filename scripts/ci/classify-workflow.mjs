#!/usr/bin/env node

// Manual dispatches and unavailable base commits MUST select every stack to preserve CI coverage.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";
import { classifyChanges, formatChanges } from "./classify-changes.mjs";
import { isReleasePullRequest } from "./release-pr.mjs";

const EMPTY_SHA = "0".repeat(40);

function changedPaths({ eventName, baseSha, headSha }) {
  if (eventName === "workflow_dispatch" || !baseSha || baseSha === EMPTY_SHA) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", baseSha, headSha], {
      encoding: "utf8",
      maxBuffer: Infinity,
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    process.stdout.write(`base ${baseSha} is unreachable; classifying everything\n`);
    return null;
  }
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
  // Event-gated macOS, Windows, arm64 runtime, and prebuilt-image jobs share this full-matrix decision.
  const fullMatrix = eventName !== "pull_request" || releasePullRequest;
  const output = `${formatChanges(
    classifyChanges(paths ?? [], paths === null, eventName, headRef),
  )}full_matrix=${fullMatrix}\n`;
  process.stdout.write(output);
  appendFileSync(process.env.GITHUB_OUTPUT, output);
});
