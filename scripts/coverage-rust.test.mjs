import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { collectCoverage, testCounts } from "./coverage-rust.mjs";

const log = "test result: ok. 3 passed; 0 failed; 2 ignored; 0 measured; 1 filtered out";
test("coverage includes feature gated examples, accumulates profiles and records ignored tests", (t) => {
  const parent = resolve(".agent/quality-signals");
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(`${parent}/coverage-test-`);
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const calls = [];
  collectCoverage(output, (args) => {
    assert.ok(
      !(args.includes("--no-clean") && args.includes("--no-report")),
      "pinned cargo-llvm-cov rejects this combination",
    );
    calls.push(args);
    return log;
  });
  assert.ok(
    calls.some(
      (args) =>
        args.includes("typescript-types,wasm-app") &&
        args.includes("rom-weaver-app") &&
        args.includes("rom-weaver-typegen"),
    ),
  );
  assert.equal(calls.filter((args) => args.includes("--no-report")).length, 2);
  assert.equal(calls.filter((args) => args[0] === "llvm-cov" && args[1] === "clean").length, 1);
  const report = JSON.parse(readFileSync(`${output}/selection.json`));
  assert.equal(report.suites[1].ignored, 2);
  assert.equal(report.doctests.instrumented, false);
});
test("zero discovered tests cannot turn the coverage lane green", () => {
  assert.equal(testCounts("running 0 tests").targets, 0);
  assert.equal(testCounts(log).filtered, 1);
});

test("branch mode instruments every selected test run rather than just relabeling reports", (t) => {
  const parent = resolve(".agent/quality-signals");
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(`${parent}/coverage-branch-test-`);
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const calls = [];
  collectCoverage(
    output,
    (args) => {
      calls.push(args);
      return log;
    },
    { branch: true },
  );
  assert.equal(
    calls.filter((args) => args.includes("--no-report") && args.includes("--branch")).length,
    2,
  );
  assert.equal(
    JSON.parse(readFileSync(`${output}/selection.json`)).branchCoverage,
    "nightly Rust branch instrumentation",
  );
});
