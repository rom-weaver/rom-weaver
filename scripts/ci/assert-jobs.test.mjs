import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "assert-jobs.sh");
const assertJobs = (...args) => spawnSync(script, args, { encoding: "utf8" }).status;

test("passes when every dependency succeeded", () => {
  assert.equal(assertJobs("success", "true", "a=success", "b=success"), 0);
});

// The whole reason this script exists: GitHub counts a skipped check as passing,
// so the aggregate has to decide which skips were legitimate.
test("a skip is only acceptable when the group was not selected", () => {
  assert.equal(assertJobs("success", "false", "a=skipped", "b=skipped"), 0);
  assert.equal(assertJobs("success", "true", "a=skipped"), 1);
});

test("fails on any non-success result", () => {
  for (const result of ["failure", "cancelled"]) {
    assert.equal(assertJobs("success", "true", `a=${result}`), 1);
    assert.equal(assertJobs("success", "false", `a=${result}`), 1);
  }
});

// A failed `changes` job leaves the selection outputs empty, which would make
// every downstream skip look legitimate.
test("fails when the changes job itself did not succeed", () => {
  assert.equal(assertJobs("failure", "", "a=skipped"), 1);
});

test("names the offending job so the failure is readable in the log", () => {
  const { stdout } = spawnSync(script, ["success", "true", "webapp-browser=failure"], {
    encoding: "utf8",
  });
  assert.match(stdout, /webapp-browser/);
});

test("rejects a call with no dependencies to check", () => {
  assert.equal(assertJobs("success", "true"), 2);
});
