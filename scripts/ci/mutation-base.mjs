#!/usr/bin/env node

// Names the commit the nightly mutation lane diffs against: the head of the newest completed
// scheduled run on main whose mutation job ran. A job that failed or timed out still counts, so one
// slow night does not widen every later diff. A night that skipped the job, or never selected it,
// does not count, so its commits stay in the next diff. Every failure here MUST leave the output
// empty with a warning: the workflow then falls back to the last successful nightly.
//
// Required env:
//   GH_TOKEN            token with actions:read
//   GITHUB_REPOSITORY   owner/repo
//   GITHUB_OUTPUT       receives `mutation_sha=<40 hex>` or `mutation_sha=`

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";
import { listRunJobs } from "./nightly-alert.mjs";

// `quality-analysis` is named `Quality signal (${{ matrix.signal }})` in ci.yml.
export const MUTATION_JOB = "Quality signal (mutation)";

// Newest completed nightlies to inspect. Past them the lane falls back to the last successful
// nightly rather than reading more history on every run.
const MAX_RUNS_INSPECTED = 10;

export async function findMutationBaseSha({ api, repo, branch }) {
  const query = new URLSearchParams({
    event: "schedule",
    status: "completed",
    branch,
    per_page: String(MAX_RUNS_INSPECTED),
  });
  const { workflow_runs: runs } = await api(`/repos/${repo}/actions/workflows/ci.yml/runs?${query}`);
  for (const run of runs) {
    const jobs = await listRunJobs({ api, repo, runId: run.id });
    if (jobs.some((job) => job.name === MUTATION_JOB && job.conclusion !== "skipped")) return run.head_sha;
  }
  return "";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const { api } = createGitHubApi({ token: GH_TOKEN, apiUrl, name: "mutation-base" });
  let sha = "";
  try {
    sha = await findMutationBaseSha({ api, repo: GITHUB_REPOSITORY, branch: "main" });
    process.stdout.write(sha ? `mutation baseline: ${sha}\n` : "no recent nightly ran the mutation lane\n");
  } catch (error) {
    process.stdout.write(`::warning::finding the mutation baseline failed; the lane uses the last successful nightly: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ""}\n`);
  }
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `mutation_sha=${sha}\n`);
}
