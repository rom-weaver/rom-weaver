#!/usr/bin/env node

// Reruns a failed workflow run once when one of its jobs died to runner
// infrastructure instead of its own steps.

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";

// GitHub writes these annotations when the runner itself is lost. A job whose
// steps fail normally never carries them. A step that exhausts the runner's
// memory can, so a rerun is no proof the change was innocent: one rerun only.
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
    if (match) {
      found.push({ job: job.name, message: isInfraMessage(match.message) ? match.message : match.title });
    }
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
  const { HEAD_SHA: headSha, HEAD_BRANCH: headBranch } = env;
  if (
    !repo ||
    !/^\d+$/.test(runId ?? "") ||
    !Number.isInteger(attempt) ||
    !/^[0-9a-f]{40}$/.test(headSha ?? "") ||
    !headBranch
  ) {
    throw new Error("GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT, HEAD_SHA, and HEAD_BRANCH are required");
  }

  // A second failure is the verdict; a rerun that fails again MUST NOT loop.
  if (attempt !== 1) {
    logger.write(`run ${runId} is attempt ${attempt}; not rerunning\n`);
    return { rerun: false, failures: [] };
  }

  // A rerun keeps its original ref, so rerunning a replaced commit would cancel
  // the newer commit's run in the same concurrency group.
  const branchPath = headBranch.split("/").map(encodeURIComponent).join("/");
  const ref = await api(`/repos/${repo}/git/ref/heads/${branchPath}`, { allow404: true });
  if (ref?.object?.sha !== headSha) {
    logger.write(`run ${runId} is not the head of ${headBranch}; not rerunning\n`);
    return { rerun: false, failures: [] };
  }

  const failures = await findInfraFailures({ api, repo, runId, attempt });
  if (!failures.length) {
    logger.write(`run ${runId} has no infrastructure failure; not rerunning\n`);
    return { rerun: false, failures };
  }

  // The API helper parses every non-204 body as JSON. An empty body after an
  // accepted rerun MUST NOT turn the accepted request into a red step.
  await api(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: "POST" }).catch(
    (error) => {
      if (!(error instanceof SyntaxError)) throw error;
    },
  );
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
