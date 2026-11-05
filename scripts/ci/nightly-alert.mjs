#!/usr/bin/env node

// Keeps one tracking issue in step with the scheduled CI run: a failing nightly opens it or comments
// on the open one, and a passing nightly comments "recovered" and closes it. The workflow runs this
// only on the `schedule` event, after the gate.
//
// Required env:
//   GH_TOKEN            token with issues:write and actions:read
//   GITHUB_REPOSITORY   owner/repo
//   GITHUB_RUN_ID       the nightly run
//   GITHUB_SHA          the commit it tested
//   NEEDS_JSON          the `needs` context of the alert job as JSON; each entry has a `result`

import process from "node:process";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";

// The title is the lookup key: it works before the label exists, and the label is only a convenience
// for filtering. Never retitle the issue without changing this.
export const ALERT_TITLE = "Nightly CI is failing on main";
export const ALERT_LABEL = "nightly-ci-failure";
const LABEL_COLOR = "d73a4a";
const LABEL_DESCRIPTION = "Opened and closed by the scheduled CI run";

// The job that runs this script is still in progress while it reads the run's jobs, and the gate
// only reports the failures of the jobs it waits on, which the list already names.
const UNLISTED_JOBS = new Set(["Nightly alert", "CI gate"]);

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

// `failing` when any job the alert waits on failed, `recovered` when all of them passed or were
// skipped, and `unknown` for a cancelled run, which says nothing about the code.
export function nightlyOutcome(needs) {
  const results = Object.values(needs).map((need) => need.result);
  if (results.length === 0) throw new Error("the alert job has no needs to judge");
  if (results.includes("failure")) return "failing";
  if (results.every((result) => result === "success" || result === "skipped")) return "recovered";
  return "unknown";
}

export function failedJobNames(jobs) {
  return jobs
    .filter((job) => FAILED_CONCLUSIONS.has(job.conclusion) && !UNLISTED_JOBS.has(job.name))
    .map((job) => job.name);
}

function runLine({ runUrl, sha, repoUrl }) {
  return `Run: ${runUrl}\nCommit: [\`${sha.slice(0, 12)}\`](${repoUrl}/commit/${sha})`;
}

export function failureText({ runUrl, sha, repoUrl, failed }) {
  const jobs = failed.length === 0 ? "none reported" : failed.map((name) => `- ${name}`).join("\n");
  return `${runLine({ runUrl, sha, repoUrl })}\n\nFailed jobs:\n${jobs}`;
}

export function openingText(run) {
  return `The scheduled CI run failed. Later failing nightlies comment here; the issue closes when a nightly passes.\n\n${failureText(run)}`;
}

export function recoveryText(run) {
  return `Recovered: the scheduled CI run passed.\n\n${runLine(run)}`;
}

// A run's jobs are not a bare array, so the `paginate` helper cannot read them. The total is the
// only reliable page count; a short page is not proof of the last one.
export async function listRunJobs({ api, repo, runId }) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const response = await api(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
    jobs.push(...response.jobs);
    if (response.jobs.length === 0 || jobs.length >= response.total_count) return jobs;
  }
}

// Oldest first, so a stray duplicate never displaces the issue the alerts were already using. The
// issues endpoint also returns pull requests. Only the title matches: a person can put the label on
// any issue, and a passing nightly would close it.
export async function findAlertIssues({ paginate, repo }) {
  const open = await paginate(`/repos/${repo}/issues?state=open`);
  return open
    .filter((issue) => !issue.pull_request && issue.title === ALERT_TITLE)
    .toSorted((left, right) => left.number - right.number);
}

// Best effort: a missing label never stops the alert, because the title finds the issue anyway.
async function ensureLabel({ api, repo, warn }) {
  try {
    const existing = await api(`/repos/${repo}/labels/${encodeURIComponent(ALERT_LABEL)}`, {
      allow404: true,
    });
    if (existing) return true;
    await api(`/repos/${repo}/labels`, {
      method: "POST",
      body: { name: ALERT_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
    });
    return true;
  } catch (error) {
    warn(`creating the ${ALERT_LABEL} label failed; the issue is found by title: ${error.message}`);
    return false;
  }
}

const comment = (api, repo, issue, body) =>
  api(`/repos/${repo}/issues/${issue.number}/comments`, { method: "POST", body: { body } });

export async function reconcile({ api, paginate, repo, outcome, run, failed, warn = () => {} }) {
  if (outcome === "unknown") return "the run was neither clearly failing nor passing; nothing to do";
  const [tracking, ...duplicates] = await findAlertIssues({ paginate, repo });

  if (outcome === "recovered") {
    for (const issue of [tracking, ...duplicates].filter(Boolean)) {
      await comment(api, repo, issue, recoveryText(run));
      await api(`/repos/${repo}/issues/${issue.number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
    }
    return tracking ? `closed #${tracking.number}` : "passing, and no tracking issue is open";
  }

  if (!tracking) {
    const labelled = await ensureLabel({ api, repo, warn });
    const created = await api(`/repos/${repo}/issues`, {
      method: "POST",
      body: {
        title: ALERT_TITLE,
        body: openingText({ ...run, failed }),
        labels: labelled ? [ALERT_LABEL] : [],
      },
    });
    return `opened #${created.number}`;
  }

  await comment(api, repo, tracking, failureText({ ...run, failed }));
  for (const duplicate of duplicates) {
    await comment(api, repo, duplicate, `Duplicate of #${tracking.number}.`);
    await api(`/repos/${repo}/issues/${duplicate.number}`, {
      method: "PATCH",
      body: { state: "closed", state_reason: "not_planned" },
    });
  }
  return `commented on #${tracking.number}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, NEEDS_JSON } = process.env;
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const { api, paginate } = createGitHubApi({ token: GH_TOKEN, apiUrl, name: "nightly-alert" });
  const outcome = nightlyOutcome(JSON.parse(NEEDS_JSON));
  const repoUrl = `${serverUrl}/${GITHUB_REPOSITORY}`;
  const failed =
    outcome === "failing"
      ? failedJobNames(await listRunJobs({ api, repo: GITHUB_REPOSITORY, runId: GITHUB_RUN_ID }))
      : [];
  const summary = await reconcile({
    api,
    paginate,
    repo: GITHUB_REPOSITORY,
    outcome,
    run: { runUrl: `${repoUrl}/actions/runs/${GITHUB_RUN_ID}`, sha: GITHUB_SHA, repoUrl },
    failed,
    warn: (message) => process.stdout.write(`::warning::${message}\n`),
  });
  process.stdout.write(`nightly ${outcome}: ${summary}\n`);
}
