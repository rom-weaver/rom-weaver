import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const ci = load(readFileSync(".github/workflows/ci.yml", "utf8"));
const deep = load(readFileSync(".github/workflows/quality-deep.yml", "utf8"));
const coverage = load(readFileSync(".github/workflows/coverage.yml", "utf8"));
const parity = load(readFileSync(".github/workflows/parity.yml", "utf8"));
test("PR analysis checks the source revision so mutation diffs exclude newer base commits", () => {
  const checkout = ci.jobs["quality-analysis"].steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha || github.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
});
test("existing required Rust aggregate cannot skip new fast or selected reference gates", () => {
  assert.ok(ci.jobs.rust.needs.includes("quality-fast"));
  assert.ok(ci.jobs.rust.needs.includes("quality-reference"));
  const fast = ci.jobs.rust.steps.find((step) => step.name === "Verify required quality checks");
  assert.ok(fast.run.includes("'true'"));
  assert.ok(fast.run.includes("needs.quality-fast.result"));
  assert.equal(ci.jobs["quality-fast"]["continue-on-error"], undefined);
  assert.equal(ci.jobs["quality-reference"]["continue-on-error"], undefined);
  assert.equal(ci.jobs["quality-analysis"]["continue-on-error"], true);
});

test("deep browser verification executes real runtime files and uploads failure evidence", () => {
  const job = deep.jobs.browser;
  assert.equal(job.env.ROM_WEAVER_WASM_EXHAUSTIVE, "1");
  assert.ok(job["timeout-minutes"] > 0);
  const runtime = job.steps.find((s) => s.id === "runtime");
  assert.ok(runtime.run.includes("browser-runtime-lifecycle.test.mjs"));
  assert.ok(runtime.run.includes("browser-opfs-many-entries.test.mjs"));
  assert.ok(runtime.run.includes("--reporter=json"));
  assert.ok(job.steps.some((s) => s.run?.includes("runtime-resource-invariants=")));
  assert.ok(job.steps.some((s) => s.with?.["include-hidden-files"] === true));
  assert.ok(
    job.steps.some((s) => s.with?.path?.includes(".vitest/attachments/failure-screenshots")),
  );
  assert.ok(
    deep.jobs.assurance.steps
      .find((s) => s.id === "properties")
      .run.includes("rom-weaver-containers --test behavior_properties"),
  );
});

test("coverage compares supplied base with all four current suite reports", () => {
  assert.equal(coverage.on.workflow_dispatch.inputs.base_ref.default, "main");
  assert.equal(
    coverage.jobs.coverage.steps.find((s) => s.name === "Checkout").with["fetch-depth"],
    0,
  );
  const changed = coverage.jobs.coverage.steps.find((s) => s.id === "changed");
  assert.ok(changed.run.includes("git check-ref-format"));
  assert.ok(changed.run.includes("git rev-parse FETCH_HEAD"));
  for (const suite of ["rust", "react-unit", "react-wasm"])
    assert.ok(changed.run.includes(`dist/coverage/${suite}/lcov.info`));
  assert.ok(changed.run.includes("--webapp-lcov dist/coverage/react-browser "));
  assert.equal((changed.run.match(/--webapp-lcov/g) ?? []).length, 3);
  for (const id of ["rust", "unit", "ui", "wasm"])
    assert.ok(changed.if.includes(`steps.${id}.outcome == 'success'`));
  assert.ok(coverage.jobs.coverage.steps.some((s) => s.run?.includes("changed-coverage=")));
});

test("live upstream parity retains failure and independent reporting", () => {
  const step = parity.jobs.parity.steps.find((s) => s.id === "parity");
  assert.ok(step.run.includes("set -euo pipefail"));
  const failure = spawnSync("bash", ["-c", "set -euo pipefail; false | cat"], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.ok(step.run.includes("node scripts/parity-check.mjs"));
  assert.ok(step.run.includes("tee .agent/quality-signals/live-parity.log"));
  assert.equal(step["continue-on-error"], undefined);
  assert.ok(parity.jobs.parity.steps.some((s) => s.run?.includes("live-upstream-parity=")));
});
test("PR and deep lanes remain independently runnable with bounded execution and artifacts", () => {
  assert.ok(
    ci.jobs["quality-fast"].steps.some((step) =>
      step.run?.includes("quality-trusted-guardrails.mjs"),
    ),
  );
  assert.ok(ci.jobs["quality-analysis"].if.includes("!= '[]'"));
  for (const job of [
    ci.jobs["quality-fast"],
    ci.jobs["quality-reference"],
    ci.jobs["quality-analysis"],
    deep.jobs.assurance,
  ]) {
    assert.ok(job["timeout-minutes"] > 0);
    assert.ok(job.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@")));
  }
  assert.deepEqual(deep.jobs.assurance.strategy.matrix.signal, [
    "mutation",
    "fuzz",
    "sanitizer",
    "miri",
    "kani",
    "properties",
  ]);
  assert.equal(deep.on.pull_request, undefined);
  assert.ok(deep.on.schedule.length > 0);
});

test("quality evidence in hidden scratch directories is uploaded", () => {
  for (const job of [
    ci.jobs["quality-fast"],
    ci.jobs["quality-analysis"],
    ci.jobs["quality-reference"],
    deep.jobs.assurance,
  ]) {
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(upload.with["include-hidden-files"], true);
  }
});
