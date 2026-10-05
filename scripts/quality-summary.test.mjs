import assert from "node:assert/strict";
import test from "node:test";
import { renderSignals } from "./quality-summary.mjs";
test("summary keeps independent failures and non-execution explicit", () => {
  const summary = renderSignals(
    { fuzz: "failure", Miri: "not-run", architecture: "success", mutation: "cancelled" },
    {
      guardrails: {
        findings: [{ severity: "review", path: "oracle.bin", line: 0, kind: "oracle-change" }],
      },
    },
  );
  assert.match(summary, /fuzz \| failed/);
  assert.match(summary, /Miri \| not measured/);
  assert.match(summary, /mutation \| incomplete/);
  assert.match(summary, /1 require review/);
  assert.match(summary, /oracle.bin:0/);
  assert.throws(() => renderSignals({ fuzz: "caught" }), /Unknown outcome/);
});
test("coverage, discovered targets, fuzz and actual resource failures stay separate", () => {
  const summary = renderSignals(
    { "runtime-resource-invariants": "failure" },
    {
      coverage: {
        covered: ["a:1"],
        uncovered: ["a:2"],
        notMeasured: ["a:3"],
        branches: { covered: [], uncovered: ["a:2:0:0"], unknown: [], recordsAvailable: true },
      },
      selection: {
        suites: [{ name: "examples", targets: 2, passed: 15, failed: 0, ignored: 1, filtered: 0 }],
        doctests: { instrumented: false },
      },
      fuzz: [{ target: "dcp_zip", status: 77, seed: 1, seconds: 15, error: null }],
      reference: [
        { archiveFormat: "zip", status: "passed", referenceTool: "Zip 3.0", archiveSha256: "abc" },
      ],
      runtime: {
        browser: {
          numPassedTests: 1,
          numFailedTests: 1,
          numPendingTests: 0,
          testResults: [
            {
              assertionResults: [
                {
                  status: "failed",
                  fullName: "cancel removes output",
                  failureMessages: ["live handles=1"],
                },
              ],
            },
          ],
        },
      },
    },
  );
  assert.match(summary, /1 zero-hit; 1 not measured/);
  assert.match(summary, /Uncovered changed line: a:2/);
  assert.match(summary, /2 targets executed; 15 passed; 1 ignored/);
  assert.match(summary, /Doctests instrumented=false/);
  assert.match(summary, /Fuzz dcp_zip: exit=77/);
  assert.match(summary, /Pinned reference zip: passed/);
  assert.match(summary, /Runtime invariant failure: cancel removes output: live handles=1/);
});
