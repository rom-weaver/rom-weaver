import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createGitHubApi } from "./github-api.mjs";

export async function isPublicationFresh(env, api) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main") return true;
  const base = `/repos/${env.GITHUB_REPOSITORY}/actions`;
  const current = await api(`${base}/runs/${env.GITHUB_RUN_ID}`);
  if (
    !Number.isInteger(current.run_number) ||
    !env.PUBLICATION_JOB_NAME ||
    !env.PUBLICATION_STEP_NAME
  ) {
    throw new Error("publication freshness: missing run number or publication identity");
  }
  // A newer commit MAY select no publisher or fail validation. Only a completed
  // write to this destination supersedes this run; the destination lock prevents races.
  for (let page = 1; ; page++) {
    const result = await api(`${base}/workflows/ci.yml/runs?branch=main&per_page=100&page=${page}`);
    if (!Array.isArray(result.workflow_runs))
      throw new Error("publication freshness: missing workflow runs");
    const newer = result.workflow_runs.filter((run) => run.run_number > current.run_number);
    for (const run of newer) {
      for (let jobsPage = 1; ; jobsPage++) {
        const result = await api(`${base}/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobsPage}`);
        if (!Array.isArray(result.jobs)) throw new Error("publication freshness: missing jobs");
        if (
          result.jobs.some(
            (job) =>
              job.name === env.PUBLICATION_JOB_NAME &&
              job.steps?.some(
                (step) => step.name === env.PUBLICATION_STEP_NAME && step.conclusion === "success",
              ),
          )
        )
          return false;
        if (result.jobs.length < 100) break;
      }
    }
    if (newer.length < result.workflow_runs.length || result.workflow_runs.length < 100)
      return true;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { api } = createGitHubApi({
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    name: "publication-freshness",
  });
  const fresh = await isPublicationFresh(process.env, api);
  appendFileSync(process.env.GITHUB_OUTPUT, `fresh=${fresh}\n`);
  process.stdout.write(
    fresh
      ? "Publication is current or explicitly requested.\n"
      : "Skipping superseded automatic main publication.\n",
  );
}
