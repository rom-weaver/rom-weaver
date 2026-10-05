import assert from "node:assert/strict";
import test from "node:test";
import { addedLines, diffCoverage } from "./quality-diff-coverage.mjs";
const diff =
  "--- a/crates/sample.rs\n+++ b/crates/sample.rs\n@@ -1,2 +1,3 @@\n+covered\n+uncovered\n+unmeasured\n";
test("webapp-relative LCOV preserves measured lines and branches", () => {
  const file = "packages/rom-weaver-webapp/src/lib/activity-store.ts";
  const result = diffCoverage(`+++ b/${file}\n@@ -20,2 +20,2 @@\n+covered\n+uncovered\n`, [
    "SF:src/lib/activity-store.ts\nDA:20,1\nDA:21,0\nBRDA:20,0,0,1\nBRDA:20,0,1,0\n",
  ]);
  assert.deepEqual(result.covered, [`${file}:20`]);
  assert.deepEqual(result.uncovered, [`${file}:21`]);
  assert.deepEqual(result.notMeasured, []);
  assert.deepEqual(result.branches.covered, [`${file}:20:0:0`]);
  assert.deepEqual(result.branches.uncovered, [`${file}:20:0:1`]);
});
test("diff coverage keeps missing instrumentation distinct from zero hits", () => {
  assert.deepEqual(
    [...addedLines(diff)],
    ["crates/sample.rs:1", "crates/sample.rs:2", "crates/sample.rs:3"],
  );
  assert.deepEqual(diffCoverage(diff, ["SF:crates/sample.rs\nDA:1,4\nDA:2,0\n"]), {
    covered: ["crates/sample.rs:1"],
    uncovered: ["crates/sample.rs:2"],
    notMeasured: ["crates/sample.rs:3"],
    branches: { covered: [], uncovered: [], unknown: [], recordsAvailable: false },
  });
});
test("deletions and multiple hunks do not shift changed line locations", () => {
  assert.deepEqual(
    [...addedLines("+++ b/a.rs\n@@ -8,2 +8,1 @@\n-old\n-old\n+new\n@@ -20 +19 @@\n-old\n+new\n")],
    ["a.rs:8", "a.rs:19"],
  );
});

test("decision evidence distinguishes zero hits and unevaluated branches", () => {
  const report = "SF:crates/sample.rs\nDA:1,4\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nBRDA:2,0,0,-\n";
  const result = diffCoverage(diff, [report]);
  assert.deepEqual(result.branches, {
    covered: ["crates/sample.rs:1:0:0"],
    uncovered: ["crates/sample.rs:1:0:1"],
    unknown: ["crates/sample.rs:2:0:0"],
    recordsAvailable: true,
  });
});

test("mnemonic and absent Git prefixes cannot silently hide changed lines", () => {
  for (const prefix of ["b/", "w/", "i/", "", "c/"]) {
    assert.deepEqual(
      [...addedLines(`+++ ${prefix}crates/sample.rs\n@@ -1 +1 @@\n+changed\n`)],
      ["crates/sample.rs:1"],
    );
  }
  assert.throws(() => addedLines('+++ "b/quoted\\tpath.rs"\n'), /not measured/);
});
