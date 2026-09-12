#!/usr/bin/env node

// Task scripts report one error line; child processes with inherited stdio
// supply their own diagnostics.

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
