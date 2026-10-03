import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const targetSha = "a".repeat(40);
const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const filter = workflow.match(/jq --arg sha "\$TARGET_SHA" -r '([^']+)'/)[1];
const run = (overrides = {}) => ({
  head_branch: "main",
  head_sha: targetSha,
  event: "push",
  created_at: "2026-10-03T00:00:00Z",
  status: "completed",
  conclusion: "success",
  html_url: "https://example.test/run/1",
  ...overrides,
});
const select = (runs) => execFileSync("jq", ["--arg", "sha", targetSha, "-r", filter], {
  input: JSON.stringify({ workflow_runs: runs }),
  encoding: "utf8",
}).replace(/\n$/, "").split("\t");

for (const event of ["push", "workflow_dispatch"]) {
  test(`the release gate accepts ${event} CI on the exact main commit`, () => {
    assert.deepEqual(select([run({ event })]), ["completed", "success", "https://example.test/run/1"]);
  });
}

test("the release gate rejects pull request CI, other branches, and other commits", () => {
  assert.deepEqual(select([
    run({ event: "pull_request" }),
    run({ head_branch: "feature" }),
    run({ head_sha: "b".repeat(40) }),
  ]), ["", "", ""]);
});

test("the latest eligible CI failure or pending run cannot hide behind an earlier success", () => {
  for (const [status, conclusion] of [["completed", "failure"], ["in_progress", null]]) {
    const latest = run({ event: "workflow_dispatch", created_at: "2026-10-03T01:00:00Z", status, conclusion });
    assert.deepEqual(select([latest, run()]), [status, conclusion ?? "", latest.html_url]);
  }
});
