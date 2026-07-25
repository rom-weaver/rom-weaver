#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function runWarnOnly(label, command, env = process.env) {
  // maxBuffer is lifted because an advisory report against a large lockfile
  // comfortably exceeds Node's 1 MiB default, and past that spawnSync kills the
  // child and truncates - losing exactly the report this wrapper exists to
  // surface. Unlike the shell's `2>&1` the two streams arrive on separate
  // pipes, so each is complete but they are no longer interleaved with one
  // another; stderr is appended after stdout.
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env, maxBuffer: Infinity });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.error) {
    process.stdout.write(`::warning title=${label}::could not run (${result.error.message})\n`);
    return 0;
  }
  if (result.status === 0) return 0;
  process.stdout.write(`::warning title=${label}::reported findings (exit ${result.status}) - see the job summary\n`);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `### ⚠️ ${label}\n\n\`\`\`\n${output}\`\`\`\n`);
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length < 2) {
    process.stderr.write("usage: node scripts/warn-only.mjs <label> <command> [args...]\n");
    return 2;
  }
  return runWarnOnly(argv[0], argv.slice(1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
