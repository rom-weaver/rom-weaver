#!/usr/bin/env node

// Names the tree an earlier green run of this pull request tested, so the
// classifier can select only what changed since. Every failure here MUST leave
// the output empty: the classifier then diffs against the pull request base, as
// it did before this existed.
//
// A pull request run tests the merge commit `github.sha`, which the REST API
// does not report (a run's `head_sha` is the branch tip). Each pull request run
// therefore uploads a tiny artifact whose name carries that SHA, and this script
// reads the name without downloading anything.
//
// Required env:
//   GH_TOKEN            token with actions:read
//   GITHUB_REPOSITORY   owner/repo
//   PR_NUMBER           pull request number
//   HEAD_REF            pull request branch
//   GITHUB_RUN_ID       current run, never its own baseline
//   GITHUB_OUTPUT       receives `sha=<40 hex>` or `sha=`

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";

export const TESTED_ARTIFACT_PREFIX = "ci-tested-";
const TESTED_ARTIFACT = new RegExp(`^${TESTED_ARTIFACT_PREFIX}([0-9a-f]{40})$`);

// Newest green runs to inspect. One is normally enough; the rest cover a run
// whose artifact expired or was never uploaded.
const MAX_RUNS_INSPECTED = 5;

export function testedShaFromArtifacts(artifacts) {
  for (const artifact of artifacts) {
    if (artifact.expired) continue;
    const match = TESTED_ARTIFACT.exec(artifact.name);
    if (match) return match[1];
  }
  return "";
}

// Runs from a fork carry no `pull_requests` entry, and a fork runs its own copy
// of the workflow, so a run counts only when its head lives in this repository.
export function priorGreenRuns(runs, { prNumber, currentRunId, repo }) {
  return runs
    .filter(
      (run) =>
        String(run.id) !== String(currentRunId) &&
        run.conclusion === "success" &&
        run.head_repository?.full_name === repo &&
        run.pull_requests?.some((pull) => String(pull.number) === String(prNumber)),
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAX_RUNS_INSPECTED);
}

export async function findPriorGreenSha({ api, repo, prNumber, headRef, currentRunId }) {
  const query = new URLSearchParams({
    event: "pull_request",
    status: "success",
    branch: headRef,
    per_page: "30",
  });
  const { workflow_runs: runs = [] } = await api(
    `/repos/${repo}/actions/workflows/ci.yml/runs?${query}`,
  );
  for (const run of priorGreenRuns(runs, { prNumber, currentRunId, repo })) {
    const { artifacts = [] } = await api(`/repos/${repo}/actions/runs/${run.id}/artifacts`);
    const sha = testedShaFromArtifacts(artifacts);
    if (sha) return sha;
  }
  return "";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_REF, GITHUB_RUN_ID, GITHUB_OUTPUT } =
    process.env;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  let sha = "";
  try {
    const { api } = createGitHubApi({ token: GH_TOKEN, apiUrl, name: "prior-green-run" });
    sha = await findPriorGreenSha({
      api,
      repo: GITHUB_REPOSITORY,
      prNumber: PR_NUMBER,
      headRef: HEAD_REF,
      currentRunId: GITHUB_RUN_ID,
    });
  } catch (error) {
    process.stdout.write(`::warning::no earlier green run used: ${error.message}\n`);
  }
  process.stdout.write(sha ? `earlier green run tested ${sha}\n` : "no earlier green run\n");
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `sha=${sha}\n`);
}
