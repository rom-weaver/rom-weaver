#!/usr/bin/env node

// Shared entrypoint wrapper for the repository's task scripts.
//
// The bash these replaced failed with a single diagnostic line; an uncaught
// exception in Node prints a stack trace instead, which buries the message in
// noise that is never actionable for a task script. Child processes launched
// with stdio: "inherit" have already printed their own error by the time this
// runs, so the wrapper adds one line and the exit status - nothing more.

import process from "node:process";

export function runMain(body) {
  try {
    const result = body();
    if (typeof result === "number") process.exitCode = result;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = typeof error.code === "number" ? error.code : 1;
  }
}
