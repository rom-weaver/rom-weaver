#!/usr/bin/env node

// Keeps one tracking issue in step with the scheduled CI run: a failing nightly opens it or comments
// on the open one, and a passing nightly comments "recovered" and closes it. A second issue tracks the
// advisory `Quality signal` jobs the same way, because they never fail the run. The workflow runs this
// only on the `schedule` event, after the gate and those jobs.
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

// The title and author are the lookup key: they work before the label exists, and the label is only
// a convenience for filtering. Never retitle the issue without changing this.
export const ALERT_TITLE = "Nightly CI is failing on main";
export const ALERT_AUTHOR = "github-actions[bot]";
export const ALERT_LABEL = "nightly-ci-failure";
const WORKFLOW_FILE = "ci.yml";
const LABEL_COLOR = "d73a4a";
const LABEL_DESCRIPTION = "Opened and closed by the scheduled CI run";

// The job that runs this script is still in progress while it reads the run's jobs, and the gate
// only reports the failures of the jobs it waits on, which the list already names.
const UNLISTED_JOBS = new Set(["Nightly alert", "CI gate"]);

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

// The advisory jobs are `continue-on-error`, so the run stays green when one fails. A job that hits
// its timeout reports `cancelled`, which counts here: a lane that never finishes is the problem.
const ADVISORY_NEEDS = new Set(["quality-analysis"]);
const ADVISORY_JOB_PREFIX = "Quality signal (";
const ADVISORY_BAD_CONCLUSIONS = new Set([...FAILED_CONCLUSIONS, "cancelled"]);

// `failing` when any job the alert waits on failed, `recovered` when all of them passed or were
// skipped, and `unknown` for a cancelled run, which says nothing about the code.
export function nightlyOutcome(needs) {
  const results = Object.entries(needs)
    .filter(([name]) => !ADVISORY_NEEDS.has(name))
    .map(([, need]) => need.result);
  if (results.length === 0) throw new Error("the alert job has no needs to judge");
  if (results.includes("failure")) return "failing";
  if (results.every((result) => result === "success" || result === "skipped")) return "recovered";
  return "unknown";
}

const advisoryJobs = (jobs) => jobs.filter((job) => job.name.startsWith(ADVISORY_JOB_PREFIX));

// `failing` when any advisory job failed or was cancelled, `recovered` when at least one passed and
// none failed, and `unknown` when none ran (a night with no Rust input change).
export function advisoryOutcome(jobs) {
  const signals = advisoryJobs(jobs);
  if (signals.some((job) => ADVISORY_BAD_CONCLUSIONS.has(job.conclusion))) return "failing";
  return signals.some((job) => job.conclusion === "success") ? "recovered" : "unknown";
}

export function advisoryJobLines(jobs) {
  return advisoryJobs(jobs)
    .filter((job) => ADVISORY_BAD_CONCLUSIONS.has(job.conclusion))
    .map((job) => `${job.name}: ${job.conclusion}`);
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
  return `${runLine({ runUrl, sha, repoUrl })}\n\nFailed jobs (advisory jobs that do not fail the run may appear; jobs still running do not):\n${jobs}`;
}

export function openingText(run) {
  return `The scheduled CI run failed. Later failing nightlies comment here; the issue closes when a nightly passes.\n\n${failureText(run)}`;
}

export function recoveryText(run) {
  return `Recovered: the scheduled CI run passed.\n\n${runLine(run)}`;
}

export const ADVISORY_TITLE = "Nightly advisory quality jobs are not passing";
export const ADVISORY_LABEL = "nightly-quality-advisory";
const ADVISORY_LABEL_DESCRIPTION = "Opened and closed by the scheduled CI run for advisory quality jobs";

export function advisoryFailureText({ runUrl, sha, repoUrl, failed }) {
  return `${runLine({ runUrl, sha, repoUrl })}\n\nAdvisory jobs that did not pass (they do not fail the nightly; \`cancelled\` means the job hit its timeout):\n${failed.map((line) => `- ${line}`).join("\n")}`;
}

// The two issues share one lifecycle and differ only in how they are found and worded.
const NIGHTLY_TRACKER = {
  title: ALERT_TITLE,
  label: ALERT_LABEL,
  labelDescription: LABEL_DESCRIPTION,
  opening: openingText,
  failure: failureText,
  recovery: recoveryText,
};
const ADVISORY_TRACKER = {
  title: ADVISORY_TITLE,
  label: ADVISORY_LABEL,
  labelDescription: ADVISORY_LABEL_DESCRIPTION,
  opening: (run) =>
    `An advisory quality job in the scheduled CI run did not pass. Later nightlies comment here; the issue closes when they pass.\n\n${advisoryFailureText(run)}`,
  failure: advisoryFailureText,
  recovery: (run) => `Recovered: the advisory quality jobs in the scheduled CI run passed.\n\n${runLine(run)}`,
};

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

// The job names only add detail, so a failed lookup must not keep a red nightly from being reported.
export async function failedJobsOrNone({ api, repo, runId, warn }) {
  try {
    return failedJobNames(await listRunJobs({ api, repo, runId }));
  } catch (error) {
    warn(`listing the run's jobs failed; reporting without them: ${error.message}`);
    return [];
  }
}

// A re-run of an older scheduled run keeps the `schedule` event, so without this a passing re-run of
// last week's nightly would close the issue while today's is still red. A re-attempt of the newest
// run keeps its id and still counts.
export async function newestNightlyId({ api, repo, branch }) {
  const response = await api(
    `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=schedule&branch=${encodeURIComponent(branch)}&per_page=1`,
  );
  return response.workflow_runs[0]?.id;
}

// Returns the line the job logs. A failed stale-run lookup stops a recovery, because a wrong close
// is the harmful direction, but never stops a failure from being reported.
export async function runAlert({ env, api, paginate, warn, notice }) {
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId, GITHUB_SHA: sha, NEEDS_JSON } = env;
  const repoUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}`;
  const outcome = nightlyOutcome(JSON.parse(NEEDS_JSON));
  if (outcome !== "unknown") {
    let newest;
    try {
      newest = await newestNightlyId({ api, repo, branch: env.GITHUB_REF_NAME ?? "main" });
    } catch (error) {
      if (outcome === "recovered") throw error;
      warn(`finding the newest scheduled run failed; reporting this one: ${error.message}`);
      newest = runId;
    }
    if (String(newest) !== String(runId)) {
      notice(`run ${runId} is not the newest scheduled run (${newest ?? "none listed"}); nothing to do`);
      return `nightly ${outcome}: a newer scheduled run exists; nothing to do`;
    }
  }
  const run = { runUrl: `${repoUrl}/actions/runs/${runId}`, sha, repoUrl };
  const failed = outcome === "failing" ? await failedJobsOrNone({ api, repo, runId, warn }) : [];
  const summary = await reconcile({ api, paginate, repo, outcome, run, failed, warn });
  if (outcome === "unknown") return `nightly ${outcome}: ${summary}`;
  const advisory = await reconcileAdvisory({ api, paginate, repo, runId, run, warn });
  return `nightly ${outcome}: ${summary}${advisory ? `; advisory: ${advisory}` : ""}`;
}

// The advisory lane never changes the nightly's own outcome, and a failed job lookup must not stop
// the alert that already ran: it warns and leaves the advisory issue as it was.
async function reconcileAdvisory({ api, paginate, repo, runId, run, warn }) {
  let jobs;
  try {
    jobs = await listRunJobs({ api, repo, runId });
  } catch (error) {
    warn(`listing the run's jobs failed; leaving the advisory issue as it was: ${error.message}`);
    return undefined;
  }
  const outcome = advisoryOutcome(jobs);
  if (outcome === "unknown") return undefined;
  return reconcile({
    api,
    paginate,
    repo,
    outcome,
    run,
    failed: advisoryJobLines(jobs),
    warn,
    tracker: ADVISORY_TRACKER,
  });
}

// Oldest first, so a stray duplicate never displaces the issue the alerts were already using. The
// issues endpoint also returns pull requests. The label is not a match: a person can put it on any
// issue. Neither is a person's issue with the same title: a passing nightly would close it.
export async function findAlertIssues({ paginate, repo, title = ALERT_TITLE }) {
  const open = await paginate(`/repos/${repo}/issues?state=open`);
  return open
    .filter((issue) => !issue.pull_request && issue.title === title && issue.user?.login === ALERT_AUTHOR)
    .toSorted((left, right) => left.number - right.number);
}

// Best effort: a missing label never stops the alert, because the title finds the issue anyway.
async function ensureLabel({ api, repo, label, description, warn }) {
  try {
    const existing = await api(`/repos/${repo}/labels/${encodeURIComponent(label)}`, {
      allow404: true,
    });
    if (existing) return true;
    await api(`/repos/${repo}/labels`, {
      method: "POST",
      body: { name: label, color: LABEL_COLOR, description },
    });
    return true;
  } catch (error) {
    warn(`creating the ${label} label failed; the issue is found by title: ${error.message}`);
    return false;
  }
}

const comment = (api, repo, issue, body) =>
  api(`/repos/${repo}/issues/${issue.number}/comments`, { method: "POST", body: { body } });

export async function reconcile({
  api,
  paginate,
  repo,
  outcome,
  run,
  failed,
  warn = () => {},
  tracker = NIGHTLY_TRACKER,
}) {
  if (outcome === "unknown") return "the run was neither clearly failing nor passing; nothing to do";
  const [tracking, ...duplicates] = await findAlertIssues({ paginate, repo, title: tracker.title });

  if (outcome === "recovered") {
    for (const issue of [tracking, ...duplicates].filter(Boolean)) {
      await comment(api, repo, issue, tracker.recovery(run));
      await api(`/repos/${repo}/issues/${issue.number}`, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
    }
    return tracking ? `closed #${tracking.number}` : "passing, and no tracking issue is open";
  }

  if (!tracking) {
    const labelled = await ensureLabel({
      api,
      repo,
      label: tracker.label,
      description: tracker.labelDescription,
      warn,
    });
    const created = await api(`/repos/${repo}/issues`, {
      method: "POST",
      body: {
        title: tracker.title,
        body: tracker.opening({ ...run, failed }),
        labels: labelled ? [tracker.label] : [],
      },
    });
    return `opened #${created.number}`;
  }

  await comment(api, repo, tracking, tracker.failure({ ...run, failed }));
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
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const { api, paginate } = createGitHubApi({ token: process.env.GH_TOKEN, apiUrl, name: "nightly-alert" });
  const line = await runAlert({
    env: process.env,
    api,
    paginate,
    warn: (message) => process.stdout.write(`::warning::${message}\n`),
    notice: (message) => process.stdout.write(`::notice::${message}\n`),
  });
  process.stdout.write(`${line}\n`);
}
