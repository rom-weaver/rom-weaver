#!/usr/bin/env node

import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Both streams down ONE descriptor, which is what `2>&1` actually is: piping
// them separately keeps each complete but reorders the report, so an advisory
// and the line naming the package it belongs to can end up paragraphs apart.
// A file also has no maxBuffer, so a large report cannot be truncated - or,
// worse, have its child killed mid-write for exceeding the pipe budget.
export function captureCombined(command, env) {
  const directory = mkdtempSync(join(os.tmpdir(), "rom-weaver-warn-only-"));
  const path = join(directory, "output");
  let fd = openSync(path, "w");
  try {
    const result = spawnSync(command[0], command.slice(1), { env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    fd = null;
    return { result, output: readFileSync(path, "utf8") };
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runWarnOnly(label, command, env = process.env, capture = captureCombined) {
  const { result, output } = capture(command, env);
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
