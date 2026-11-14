import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addedLines,
  diffCoverage,
  coverageInputs,
  readCoverageReports,
  parseBranches,
} from "./quality-diff-coverage.mjs";
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

test("webapp-relative browser lines and decisions map to repository diff paths", () => {
  const changed = "+++ b/packages/rom-weaver-webapp/src/index.tsx\n@@ -20 +20 @@\n+changed\n";
  const result = diffCoverage(changed, [
    {
      contents: "SF:src/index.tsx\nDA:20,3\nBRDA:20,0,0,3\nBRDA:20,0,1,0\n",
      sourceRoot: coverageInputs(["main", "--webapp-lcov", "browser.info"]).reports[0].sourceRoot,
    },
  ]);
  assert.deepEqual(result.covered, ["packages/rom-weaver-webapp/src/index.tsx:20"]);
  assert.deepEqual(result.notMeasured, []);
  assert.deepEqual(result.branches.covered, ["packages/rom-weaver-webapp/src/index.tsx:20:0:0"]);
  assert.deepEqual(result.branches.uncovered, ["packages/rom-weaver-webapp/src/index.tsx:20:0:1"]);
});

test("CLI source roots distinguish browser reports and reject missing flag values", () => {
  const plan = coverageInputs(["main", "rust.info", "--webapp-lcov", "browser.info"]);
  assert.equal(plan.base, "main");
  assert.equal(plan.reports[0].sourceRoot, undefined);
  assert.match(plan.reports[1].sourceRoot, /packages\/rom-weaver-webapp$/);
  assert.throws(() => coverageInputs(["main", "--webapp-lcov"]), /LCOV path/);
  assert.throws(() => coverageInputs(["main", "--bogus"]), /LCOV path/);
  assert.throws(() => coverageInputs(["main"]), /Usage/);
});

test("sharded browser directories aggregate every report and reject empty selection", () => {
  const parent = path.resolve(".agent/quality-diff-coverage-tests");
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, "shards-"));
  try {
    for (const [shard, line, hits] of [
      ["a", 1, 2],
      ["b", 2, 0],
    ]) {
      const directory = path.join(scratch, shard);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "lcov.info"), `SF:src/index.tsx\nDA:${line},${hits}\n`);
    }
    const plan = coverageInputs(["main", "--webapp-lcov", scratch]);
    const reports = readCoverageReports(plan.reports);
    assert.equal(reports.length, 2);
    const result = diffCoverage(
      "+++ b/packages/rom-weaver-webapp/src/index.tsx\n@@ -1,2 +1,2 @@\n+first\n+second\n",
      reports,
    );
    assert.deepEqual(result.covered, ["packages/rom-weaver-webapp/src/index.tsx:1"]);
    assert.deepEqual(result.uncovered, ["packages/rom-weaver-webapp/src/index.tsx:2"]);
    fs.rmSync(path.join(scratch, "a"), { recursive: true });
    fs.rmSync(path.join(scratch, "b"), { recursive: true });
    assert.throws(() => readCoverageReports(plan.reports), /No LCOV/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("V8 negative branch counts remain unknown, never covered", () => {
  const result = diffCoverage(
    "+++ b/packages/rom-weaver-webapp/src/decision.ts\n@@ -7 +7 @@\n+decision\n",
    ["SF:src/decision.ts\nDA:7,1\nBRDA:7,0,0,-1\nBRDA:7,0,1,-5\n"],
  );
  assert.deepEqual(result.branches.unknown, [
    "packages/rom-weaver-webapp/src/decision.ts:7:0:0",
    "packages/rom-weaver-webapp/src/decision.ts:7:0:1",
  ]);
  assert.deepEqual(result.branches.covered, []);
  assert.deepEqual(result.branches.uncovered, []);
  assert.throws(() => parseBranches("SF:src/decision.ts\nBRDA:7,0,0,invalid\n"), /Invalid branch/);
});
test("the CLI measures a changed file with a non-ASCII name", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "quality-diff-coverage-"));
  try {
    // Hooks export GIT_DIR, which would point git at this repository.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_AUTHOR_NAME: "ci",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "ci",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    };
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env });
    fs.mkdirSync(path.join(repo, "crates"));
    fs.writeFileSync(path.join(repo, "crates/näme.rs"), "fn a() {}\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    fs.appendFileSync(path.join(repo, "crates/näme.rs"), "fn b() {}\n");
    fs.writeFileSync(path.join(repo, "lcov.info"), "SF:crates/näme.rs\nDA:2,3\nend_of_record\n");
    const script = fileURLToPath(new URL("./quality-diff-coverage.mjs", import.meta.url));
    execFileSync(process.execPath, [script, "HEAD", "lcov.info"], { cwd: repo, env, stdio: "pipe" });
    const { covered } = JSON.parse(fs.readFileSync(path.join(repo, "dist/coverage/changed-lines.json"), "utf8"));
    assert.deepEqual(covered, ["crates/näme.rs:2"]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
