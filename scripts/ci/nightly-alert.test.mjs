import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  ALERT_AUTHOR,
  ALERT_LABEL,
  ALERT_TITLE,
  failedJobNames,
  failureText,
  failedJobsOrNone,
  isNewestNightly,
  listRunJobs,
  nightlyOutcome,
  reconcile,
} from "./nightly-alert.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const ci = load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const alertJob = ci.jobs["nightly-alert"];

const repo = "owner/repo";
const run = {
  runUrl: "https://github.com/owner/repo/actions/runs/42",
  sha: "0123456789abcdef0123456789abcdef01234567",
  repoUrl: "https://github.com/owner/repo",
};

// An in-memory slice of the issues API: just enough to see which issues exist after a call.
function fakeGitHub({ issues = [], labels = [], labelCreateFails = false } = {}) {
  const state = {
    issues: issues.map((issue) => ({ labels: [], comments: [], user: { login: ALERT_AUTHOR }, ...issue })),
    labels: [...labels],
    calls: [],
  };
  let nextNumber = Math.max(100, ...state.issues.map((issue) => issue.number)) + 1;
  const api = async (path, { method = "GET", body, allow404 = false } = {}) => {
    state.calls.push(`${method} ${path}`);
    let match;
    if (method === "GET" && (match = path.match(/\/labels\/(.+)$/u))) {
      return state.labels.includes(decodeURIComponent(match[1])) ? { name: match[1] } : allow404 ? null : fail(path);
    }
    if (method === "POST" && path.endsWith("/labels")) {
      if (labelCreateFails) throw new Error("403 forbidden");
      state.labels.push(body.name);
      return { name: body.name };
    }
    if (method === "POST" && path.endsWith("/issues")) {
      const issue = {
        number: nextNumber++,
        state: "open",
        title: body.title,
        body: body.body,
        labels: body.labels.map((name) => ({ name })),
        user: { login: ALERT_AUTHOR },
        comments: [],
      };
      state.issues.push(issue);
      return issue;
    }
    if ((match = path.match(/\/issues\/(\d+)\/comments$/u))) {
      state.issues.find((issue) => issue.number === Number(match[1])).comments.push(body.body);
      return {};
    }
    if (method === "PATCH" && (match = path.match(/\/issues\/(\d+)$/u))) {
      Object.assign(state.issues.find((issue) => issue.number === Number(match[1])), body);
      return {};
    }
    return fail(`${method} ${path}`);
  };
  const paginate = async (path) => {
    state.calls.push(`GET ${path} (every page)`);
    assert.match(path, /[?&]state=open(&|$)/u, "only open issues are listed");
    return state.issues.filter((issue) => (issue.state ?? "open") === "open");
  };
  state.api = api;
  state.paginate = paginate;
  return state;
}
const fail = (what) => {
  throw new Error(`unexpected request: ${what}`);
};
const open = (state) => state.issues.filter((issue) => (issue.state ?? "open") === "open");
const call = (state, outcome, failed = ["Rust (host)"], warn) =>
  reconcile({ api: state.api, paginate: state.paginate, repo, outcome, run, failed, warn });

test("the outcome comes from the jobs the alert waits on", () => {
  assert.equal(nightlyOutcome({ gate: { result: "failure" } }), "failing");
  assert.equal(nightlyOutcome({ gate: { result: "success" } }), "recovered");
  assert.equal(nightlyOutcome({ gate: { result: "skipped" } }), "recovered");
  assert.equal(nightlyOutcome({ gate: { result: "cancelled" } }), "unknown");
  assert.throws(() => nightlyOutcome({}));
});

test("a failing nightly opens one issue naming the run, the commit, and the failed jobs", async () => {
  const state = fakeGitHub();
  await call(state, "failing", ["Rust (host)", "Quality signal (fuzz)"]);
  assert.equal(open(state).length, 1);
  const [issue] = state.issues;
  assert.equal(issue.title, ALERT_TITLE);
  assert.deepEqual(issue.labels, [{ name: ALERT_LABEL }]);
  assert.deepEqual(state.labels, [ALERT_LABEL], "a missing label is created by the workflow");
  for (const text of [run.runUrl, run.sha.slice(0, 12), "- Rust (host)", "- Quality signal (fuzz)"]) {
    assert.ok(issue.body.includes(text), text);
  }
});

test("a later failing nightly comments on the open issue instead of opening another", async () => {
  const state = fakeGitHub({
    labels: [ALERT_LABEL],
    issues: [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }] }],
  });
  const summary = await call(state, "failing", ["Rust (host)"]);
  assert.equal(summary, "commented on #7");
  assert.equal(state.issues.length, 1);
  assert.equal(state.issues[0].comments.length, 1);
  for (const text of [run.runUrl, run.sha, "- Rust (host)"]) {
    assert.ok(state.issues[0].comments[0].includes(text), text);
  }
  assert.ok(!state.calls.some((entry) => entry.startsWith("POST") && entry.endsWith("/issues")));
});

test("the issue is found by title when the label does not exist or could not be created", async () => {
  const titled = fakeGitHub({ issues: [{ number: 9, state: "open", title: ALERT_TITLE }] });
  await call(titled, "failing");
  assert.equal(titled.issues[0].comments.length, 1);

  const warnings = [];
  const unlabelled = fakeGitHub({ labelCreateFails: true });
  await call(unlabelled, "failing", [], (message) => warnings.push(message));
  assert.equal(open(unlabelled).length, 1);
  assert.deepEqual(unlabelled.issues[0].labels, []);
  assert.equal(warnings.length, 1);
  await call(unlabelled, "failing");
  assert.equal(unlabelled.issues.length, 1, "the title still finds it on the next failure");
});

test("unrelated issues and pull requests are never touched", async () => {
  const state = fakeGitHub({
    issues: [
      { number: 3, state: "open", title: "Some bug" },
      { number: 4, state: "open", title: ALERT_TITLE, pull_request: {} },
      { number: 5, state: "open", title: "Docs link broken", labels: [{ name: ALERT_LABEL }] },
      { number: 6, state: "open", title: ALERT_TITLE, user: { login: "someone" } },
    ],
  });
  await call(state, "failing");
  for (const issue of state.issues.slice(0, 4)) assert.deepEqual(issue.comments, []);
  assert.equal(state.issues.length, 5);
  await call(state, "recovered");
  for (const issue of state.issues.slice(0, 4)) assert.equal(issue.state, "open");
});

test("a passing nightly comments recovered and closes the issue", async () => {
  const state = fakeGitHub({ issues: [{ number: 7, state: "open", title: ALERT_TITLE }] });
  assert.equal(await call(state, "recovered", []), "closed #7");
  assert.equal(state.issues[0].state, "closed");
  assert.equal(state.issues[0].state_reason, "completed");
  assert.match(state.issues[0].comments[0], /^Recovered/u);
  assert.ok(state.issues[0].comments[0].includes(run.runUrl));
});

test("a passing nightly with no open issue does nothing", async () => {
  const state = fakeGitHub();
  await call(state, "recovered");
  assert.deepEqual(state.calls.filter((entry) => !entry.startsWith("GET")), []);
});

test("a cancelled nightly changes nothing", async () => {
  const state = fakeGitHub({ issues: [{ number: 7, state: "open", title: ALERT_TITLE }] });
  await call(state, "unknown");
  assert.equal(state.issues[0].state, "open");
  assert.deepEqual(state.issues[0].comments, []);
  assert.deepEqual(state.calls, []);
});

test("stray duplicates collapse onto the oldest open issue", async () => {
  const state = fakeGitHub({
    issues: [
      { number: 12, state: "open", title: ALERT_TITLE },
      { number: 8, state: "open", title: ALERT_TITLE },
    ],
  });
  await call(state, "failing");
  const byNumber = Object.fromEntries(state.issues.map((issue) => [issue.number, issue]));
  assert.equal(byNumber[8].comments.length, 1);
  assert.equal(byNumber[12].state, "closed");
  assert.equal(open(state).length, 1);
});

test("failed job names skip passing jobs, the gate, and the alert job itself", () => {
  assert.deepEqual(
    failedJobNames([
      { name: "CI gate", conclusion: "failure" },
      { name: "Rust (host)", conclusion: "failure" },
      { name: "CLI (linux)", conclusion: "success" },
      { name: "Security", conclusion: "timed_out" },
      { name: "Docs", conclusion: "skipped" },
      { name: "Nightly alert", conclusion: "failure" },
      { name: "Running", conclusion: null },
    ]),
    ["Rust (host)", "Security"],
  );
});

test("every page of the run's jobs is read", async () => {
  const pages = [
    { total_count: 3, jobs: [{ name: "a" }, { name: "b" }] },
    { total_count: 3, jobs: [{ name: "c" }] },
  ];
  const seen = [];
  const jobs = await listRunJobs({
    api: async (path) => {
      seen.push(path);
      return pages[seen.length - 1];
    },
    repo,
    runId: 42,
  });
  assert.deepEqual(jobs.map((job) => job.name), ["a", "b", "c"]);
  assert.ok(seen[1].includes("page=2"));
});

test("a failed job lookup still reports the failure, without names", async () => {
  const warnings = [];
  const failed = await failedJobsOrNone({
    api: async () => {
      throw new Error("502 bad gateway");
    },
    repo,
    runId: 42,
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(failed, []);
  assert.match(warnings[0], /502 bad gateway/u);
  assert.match(reconcileText(failed), /none reported/u);
});
const reconcileText = (failed) => failureText({ ...run, failed });

test("only the newest scheduled run acts on the issue", async () => {
  const seen = [];
  const api = (id) => async (path) => {
    seen.push(path);
    return { workflow_runs: id === undefined ? [] : [{ id }] };
  };
  assert.equal(await isNewestNightly({ api: api(42), repo, runId: "42" }), true);
  assert.equal(await isNewestNightly({ api: api(43), repo, runId: "42" }), false, "a re-run of an older night");
  assert.equal(await isNewestNightly({ api: api(undefined), repo, runId: "42" }), false);
  assert.match(seen[0], /\/actions\/workflows\/ci\.yml\/runs\?event=schedule&branch=main&per_page=1$/u);
});

test("a failed write stops the alert, and the next night converges", async () => {
  const state = fakeGitHub({
    issues: [
      { number: 7, state: "open", title: ALERT_TITLE },
      { number: 9, state: "open", title: ALERT_TITLE },
    ],
  });
  const api = state.api;
  state.api = async (path, options) => {
    if (options?.method === "PATCH") throw new Error("500 server error");
    return api(path, options);
  };
  await assert.rejects(call(state, "recovered"), /500 server error/u);
  assert.equal(open(state).length, 2, "nothing was closed");
  state.api = api;
  await call(state, "recovered");
  assert.equal(open(state).length, 0);
});

// GitHub expressions in these conditions are also valid JavaScript.
const evaluate = (expression, event, cancelled = false) =>
  runInNewContext(expression, { github: { event_name: event }, cancelled: () => cancelled });
const condition = (job) => job.if.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");

test("the alert job runs only on the schedule event", () => {
  const expression = condition(alertJob);
  assert.equal(evaluate(expression, "schedule"), true);
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    assert.equal(evaluate(expression, event), false, event);
  }
  assert.equal(evaluate(expression, "schedule", true), false, "a cancelled run raises no alert");
  assert.ok(ci.on.schedule, "the nightly trigger exists");
  assert.equal(alertJob.needs, "gate", "the alert runs after the gate");
});

test("no job but the alert job can write issues", () => {
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.deepEqual(alertJob.permissions, { contents: "read", actions: "read", issues: "write" });
  for (const [name, job] of Object.entries(ci.jobs)) {
    if (name !== "nightly-alert") assert.notEqual(job.permissions?.issues, "write", name);
  }
});

test("the alert job runs the script with the needs context and a read-only checkout", () => {
  const [checkout, alert] = alertJob.steps;
  assert.equal(checkout.with["sparse-checkout"], "scripts/ci");
  assert.equal(alert.run, "node scripts/ci/nightly-alert.mjs");
  assert.equal(alert.env.NEEDS_JSON, "${{ toJSON(needs) }}");
  assert.equal(alert.env.GH_TOKEN, "${{ github.token }}");
});
