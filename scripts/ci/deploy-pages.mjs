#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const extractPagesUrl = (output) =>
  [...output.matchAll(/https:\/\/[a-z0-9.-]+\.pages\.dev/g)].at(-1)?.[0] || "";

export function deployPages({
  project,
  branch,
  commitHash,
  root = process.cwd(),
  directory = "dist",
  workingDirectory = "packages/rom-weaver-webapp",
  outputFile = process.env.GITHUB_OUTPUT,
} = {}) {
  const cwd = resolve(root, workingDirectory);
  // maxBuffer is lifted because spawnSync KILLS the child once the default
  // 1 MiB is exceeded - on a deploy that means a half-uploaded site, not just a
  // truncated log.
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "wrangler@4",
      "pages",
      "deploy",
      directory,
      `--project-name=${project}`,
      `--branch=${branch}`,
      `--commit-hash=${commitHash}`,
    ],
    { cwd, encoding: "utf8", maxBuffer: Infinity },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(`wrangler exited with status ${result.status}`);
  const url = extractPagesUrl(output);
  if (!url) throw new Error("Cloudflare Pages deploy produced no pages.dev URL");
  if (outputFile) appendFileSync(outputFile, `url=${url}\n`);
  process.stdout.write(`deployed to ${url}\n`);
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    deployPages({
      project: process.env.PROJECT,
      branch: process.env.BRANCH,
      commitHash: process.env.PAGES_COMMIT_HASH || process.env.GITHUB_SHA,
      directory: process.env.PAGES_DIRECTORY || undefined,
      workingDirectory: process.env.PAGES_WORKING_DIRECTORY || undefined,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
