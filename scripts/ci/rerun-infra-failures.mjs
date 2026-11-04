#!/usr/bin/env node

// Reruns a failed workflow run once when one of its jobs died to runner
// infrastructure instead of its own steps.

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";

// GitHub writes these annotations when the runner itself is lost. A job that
// ran its steps and failed never carries them, so a real failure is not retried.
export const INFRA_MESSAGES = [
  /was not acquired by Runner/i,
  /lost communication with the server/i,
  /received a shutdown signal/i,
];

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

export const isInfraMessage = (message) =>
  typeof message === "string" && INFRA_MESSAGES.some((pattern) => pattern.test(message));

async function listJobs(api, repo, runId, attempt) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = await api(
      `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...body.jobs);
    if (!body.jobs.length || jobs.length >= body.total_count) return jobs;
  }
}

// Returns each failed job with the infrastructure annotation that explains it.
export async function findInfraFailures({ api, repo, runId, attempt }) {
  const found = [];
  for (const job of await listJobs(api, repo, runId, attempt)) {
    if (!FAILED_CONCLUSIONS.has(job.conclusion)) continue;
    const annotations = await api(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`);
    const match = annotations.find(
      (annotation) => isInfraMessage(annotation.message) || isInfraMessage(annotation.title),
    );
    if (match) found.push({ job: job.name, message: match.message ?? match.title });
  }
  return found;
}

export async function rerunInfraFailures({
  env = process.env,
  api = createGitHubApi({
    token: env.GH_TOKEN ?? env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
    name: "rerun-infra-failures",
  }).api,
  logger = process.stdout,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const runId = env.RUN_ID;
  const attempt = Number(env.RUN_ATTEMPT);
  if (!repo || !/^\d+$/.test(runId ?? "") || !Number.isInteger(attempt)) {
    throw new Error("GITHUB_REPOSITORY, RUN_ID, and RUN_ATTEMPT are required");
  }

  // A second failure is the verdict; a rerun that fails again MUST NOT loop.
  if (attempt !== 1) {
    logger.write(`run ${runId} is attempt ${attempt}; not rerunning\n`);
    return { rerun: false, failures: [] };
  }

  const failures = await findInfraFailures({ api, repo, runId, attempt });
  if (!failures.length) {
    logger.write(`run ${runId} has no infrastructure failure; not rerunning\n`);
    return { rerun: false, failures };
  }

  await api(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" });
  const lines = failures.map(({ job, message }) => `- ${job}: ${message}`);
  logger.write(`reran failed jobs of run ${runId} after infrastructure failures:\n${lines.join("\n")}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Reran run ${runId}\n\nInfrastructure failures:\n\n${lines.join("\n")}\n`,
    );
  }
  return { rerun: true, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await rerunInfraFailures();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
