import assert from "node:assert/strict";
import test from "node:test";

import { findInfraFailures, isInfraMessage, rerunInfraFailures } from "./rerun-infra-failures.mjs";

const NOT_ACQUIRED = "The job was not acquired by Runner of type hosted even after multiple attempts";

function fakeApi({ jobs, annotations = {}, pageSize = 100 }) {
  const calls = [];
  const api = async (path, { method = "GET" } = {}) => {
    calls.push({ method, path });
    const jobsPage = path.match(/\/attempts\/\d+\/jobs\?per_page=\d+&page=(\d+)/);
    if (jobsPage) {
      const page = Number(jobsPage[1]);
      return { total_count: jobs.length, jobs: jobs.slice((page - 1) * pageSize, page * pageSize) };
    }
    const check = path.match(/\/check-runs\/(\d+)\/annotations/);
    if (check) return annotations[check[1]] ?? [];
    if (method === "POST" && path.endsWith("/rerun-failed-jobs")) return null;
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return { api, calls };
}

const sink = () => {
  const lines = [];
  return { lines, write: (text) => lines.push(text) };
};

const env = { GITHUB_REPOSITORY: "o/r", RUN_ID: "42", RUN_ATTEMPT: "1" };

test("matches only runner-loss messages", () => {
  assert.equal(isInfraMessage(NOT_ACQUIRED), true);
  assert.equal(isInfraMessage("The hosted runner lost communication with the server."), true);
  assert.equal(isInfraMessage("The runner has received a shutdown signal."), true);
  assert.equal(isInfraMessage("Process completed with exit code 1."), false);
  assert.equal(isInfraMessage("assertion failed: left == right"), false);
  assert.equal(isInfraMessage(undefined), false);
});

test("reports each failed job whose annotation names a lost runner", async () => {
  const { api } = fakeApi({
    jobs: [
      { id: 1, name: "WebKit E2E", conclusion: "cancelled" },
      { id: 2, name: "CI gate", conclusion: "failure" },
      { id: 3, name: "lint", conclusion: "success" },
    ],
    annotations: {
      1: [{ message: NOT_ACQUIRED }],
      2: [{ message: "Process completed with exit code 1." }],
      3: [{ message: NOT_ACQUIRED }],
    },
  });
  assert.deepEqual(await findInfraFailures({ api, repo: "o/r", runId: "42", attempt: 1 }), [
    { job: "WebKit E2E", message: NOT_ACQUIRED },
  ]);
});

test("reads every page of jobs", async () => {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    name: `job ${index + 1}`,
    conclusion: "failure",
  }));
  const { api } = fakeApi({ jobs, annotations: { 5: [{ message: NOT_ACQUIRED }] }, pageSize: 2 });
  const failures = await findInfraFailures({ api, repo: "o/r", runId: "42", attempt: 1 });
  assert.deepEqual(failures, [{ job: "job 5", message: NOT_ACQUIRED }]);
});

test("reruns the failed jobs after an infrastructure failure", async () => {
  const { api, calls } = fakeApi({
    jobs: [{ id: 1, name: "WebKit E2E", conclusion: "cancelled" }],
    annotations: { 1: [{ message: NOT_ACQUIRED }] },
  });
  const logger = sink();
  const result = await rerunInfraFailures({ env, api, logger });
  assert.equal(result.rerun, true);
  assert.deepEqual(calls.at(-1), { method: "POST", path: "/repos/o/r/actions/runs/42/rerun-failed-jobs" });
  assert.match(logger.lines.join(""), /WebKit E2E: The job was not acquired/);
});

test("leaves a real failure alone", async () => {
  const { api, calls } = fakeApi({
    jobs: [{ id: 1, name: "tests", conclusion: "failure" }],
    annotations: { 1: [{ message: "Process completed with exit code 1." }] },
  });
  const result = await rerunInfraFailures({ env, api, logger: sink() });
  assert.equal(result.rerun, false);
  assert.ok(calls.every(({ method }) => method === "GET"));
});

test("never reruns after the first attempt", async () => {
  const { api, calls } = fakeApi({ jobs: [] });
  const result = await rerunInfraFailures({ env: { ...env, RUN_ATTEMPT: "2" }, api, logger: sink() });
  assert.equal(result.rerun, false);
  assert.deepEqual(calls, []);
});

test("rejects missing or malformed run identity", async () => {
  const { api } = fakeApi({ jobs: [] });
  for (const bad of [{ RUN_ID: "abc" }, { RUN_ID: undefined }, { RUN_ATTEMPT: "x" }, { GITHUB_REPOSITORY: "" }]) {
    await assert.rejects(rerunInfraFailures({ env: { ...env, ...bad }, api, logger: sink() }), /required/);
  }
});
