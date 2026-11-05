#!/usr/bin/env node

// Finds the merged release pull request whose merge commit a release tag points at, so the tag
// run can reuse that pull request's signed WASM module instead of rebuilding it. Finding one only
// picks candidates: resolve-wasm-run.mjs and fetch-verified-wasm.mjs check the run, the pull
// request, and the signed tree again. With no match the tag run tries main's runs of the commit.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { isReleasePull, readPull } from "./resolve-wasm-run.mjs";

const gh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env }).trim();

// The commit's pull requests list omits `merged`, so each candidate is read in full and checked
// with the same predicate the resolver applies.
export function findReleasePull({ repository, sha, env = process.env, runGh = (args) => gh(args, env) }) {
  const pulls = JSON.parse(runGh(["api", `repos/${repository}/commits/${sha}/pulls`]) || "[]") ?? [];
  for (const { number } of pulls.filter((pull) => pull?.merge_commit_sha === sha)) {
    const pull = readPull({ repository, prNumber: number, runGh });
    if (pull?.merge_commit_sha === sha && isReleasePull(pull, { repository, prNumber: number, sha: pull.head?.sha })) return { pr: String(number), sha: pull.head.sha };
  }
  return { pr: "", sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_REPOSITORY || !process.env.TARGET_SHA) throw new Error("GITHUB_REPOSITORY and TARGET_SHA are required");
    const { pr, sha } = findReleasePull({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.TARGET_SHA });
    process.stdout.write(pr ? `release pull request #${pr} at ${sha}\n` : `no merged release pull request for ${sha} - runs of main only\n`);
    const outputs = `pr=${pr}\nsha=${sha}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
    else process.stdout.write(outputs);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
