import assert from "node:assert/strict";
import test from "node:test";

import { findPriorGreenSha, priorGreenRuns, testedShaFromArtifacts } from "./prior-green-run.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const run = (id, created, extra = {}) => ({
  id,
  conclusion: "success",
  created_at: created,
  pull_requests: [{ number: 7 }],
  head_repository: { full_name: "o/r" },
  ...extra,
});

test("the tested commit is read from a marker artifact name", () => {
  assert.equal(testedShaFromArtifacts([{ name: `ci-tested-${SHA_A}` }]), SHA_A);
  assert.equal(
    testedShaFromArtifacts([{ name: "identify-data" }, { name: `ci-tested-${SHA_B}` }]),
    SHA_B,
  );
});

test("expired, malformed, and missing markers yield no commit", () => {
  assert.equal(testedShaFromArtifacts([]), "");
  assert.equal(testedShaFromArtifacts([{ name: `ci-tested-${SHA_A}`, expired: true }]), "");
  assert.equal(testedShaFromArtifacts([{ name: "ci-tested-main" }]), "");
  assert.equal(testedShaFromArtifacts([{ name: `ci-tested-${SHA_A}0` }]), "");
});

test("only other green runs of this pull request qualify, newest first", () => {
  const runs = [
    run(1, "2026-01-01T00:00:00Z"),
    run(2, "2026-01-03T00:00:00Z"),
    run(3, "2026-01-04T00:00:00Z", { conclusion: "failure" }),
    run(4, "2026-01-05T00:00:00Z", { pull_requests: [{ number: 8 }] }),
    run(5, "2026-01-06T00:00:00Z", { pull_requests: [] }),
    run(6, "2026-01-07T00:00:00Z"),
    run(7, "2026-01-08T00:00:00Z", { head_repository: { full_name: "fork/r" } }),
  ];
  const ids = priorGreenRuns(runs, { prNumber: 7, currentRunId: 6, repo: "o/r" }).map(({ id }) => id);
  assert.deepEqual(ids, [2, 1]);
});

test("the search falls back to an older run when the newest has no marker", async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.includes("/workflows/ci.yml/runs?")) {
      assert.match(path, /event=pull_request/u);
      assert.match(path, /branch=fix%2Fx/u);
      return { workflow_runs: [run(10, "2026-01-02T00:00:00Z"), run(9, "2026-01-01T00:00:00Z")] };
    }
    return path.endsWith("/runs/10/artifacts")
      ? { artifacts: [{ name: "identify-data" }] }
      : { artifacts: [{ name: `ci-tested-${SHA_A}` }] };
  };
  const sha = await findPriorGreenSha({
    api,
    repo: "o/r",
    prNumber: 7,
    headRef: "fix/x",
    currentRunId: 11,
  });
  assert.equal(sha, SHA_A);
  assert.equal(calls.length, 3);
});

test("no qualifying run yields no commit", async () => {
  const api = async () => ({ workflow_runs: [] });
  assert.equal(
    await findPriorGreenSha({ api, repo: "o/r", prNumber: 7, headRef: "x", currentRunId: 1 }),
    "",
  );
});
