#!/usr/bin/env node

// Turns the pushed range into the `changes` job's per-stack outputs.
//
// Fails open in both directions - a manual dispatch and an unreachable base
// both classify everything - because under-selecting silently skips a stack the
// change actually touched, while over-selecting only costs CI minutes.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

import { runMain } from "../run-main.mjs";
import { classifyChanges, formatChanges } from "./classify-changes.mjs";

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
  const paths = changedPaths({
    eventName: process.env.EVENT_NAME,
    baseSha: process.env.BASE_SHA,
    headSha: process.env.HEAD_SHA,
  });
  if (paths)
    process.stdout.write(`changed paths:\n${paths.length ? paths.join("\n") : "(none)"}\n`);
  const output = formatChanges(
    classifyChanges(paths ?? [], paths === null, process.env.EVENT_NAME),
  );
  process.stdout.write(output);
  appendFileSync(process.env.GITHUB_OUTPUT, output);
});
