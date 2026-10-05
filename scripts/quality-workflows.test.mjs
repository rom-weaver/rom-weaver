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
test("nightly and manual analysis runs use the selected source revision", () => {
  for (const name of ["quality-fast", "quality-analysis", "quality-reference"]) {
    assert.ok(ci.jobs[name].if.includes("github.event_name == 'schedule'"));
    assert.ok(ci.jobs[name].if.includes("github.event_name == 'workflow_dispatch'"));
    assert.ok(!ci.jobs[name].if.includes("github.event_name == 'pull_request'"));
    assert.ok(!ci.jobs[name].if.includes("github.event_name == 'push'"));
  }
  const checkout = ci.jobs["quality-analysis"].steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha || github.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(ci.jobs.changes.outputs.last_nightly_sha, "${{ steps.last-nightly.outputs.sha }}");
  assert.ok(
    ci.jobs.changes.steps
      .find((step) => step.id === "last-nightly")
      .if.includes("github.event_name == 'workflow_dispatch'"),
  );
  assert.ok(ci.jobs["quality-fast"].needs.includes("changes"));
  const guardrails = ci.jobs["quality-fast"].steps.find((step) => step.id === "guardrails");
  assert.ok(guardrails.env.QUALITY_BASE.includes("needs.changes.outputs.last_nightly_sha"));
  assert.ok(guardrails.run.includes('git rev-parse HEAD^'));
  assert.ok(ci.jobs["quality-analysis"].needs.includes("changes"));
  const mutation = ci.jobs["quality-analysis"].steps.find((step) => step.id === "mutation");
  assert.ok(mutation.env.QUALITY_BASE.includes("needs.changes.outputs.last_nightly_sha"));
});
test("per-change Rust checks do not require the nightly quality jobs", () => {
  assert.ok(ci.jobs.rust.needs.includes("quality-fast"));
  assert.ok(ci.jobs.rust.needs.includes("quality-reference"));
  const fast = ci.jobs.rust.steps.find((step) => step.name === "Verify required quality checks");
  assert.ok(fast.if.includes("github.event_name == 'schedule'"));
  assert.ok(fast.if.includes("github.event_name == 'workflow_dispatch'"));
  const reference = ci.jobs.rust.steps.find((step) => step.name === "Verify selected pinned reference");
  assert.ok(reference.if.includes("github.event_name == 'schedule'"));
  assert.ok(reference.if.includes("github.event_name == 'workflow_dispatch'"));
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
test("nightly and deep quality lanes remain bounded and upload artifacts", () => {
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
  assert.deepEqual(deep.on.schedule, [{ cron: "17 7 * * 1" }]);
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

test("architecture inspection generates locale imports before walking the complete graph", () => {
  const steps = ci.jobs["quality-fast"].steps;
  const compile = steps.findIndex(
    (s) => s.run === "npm --prefix packages/rom-weaver-webapp run i18n:compile",
  );
  const architecture = steps.findIndex((s) => s.id === "architecture");
  assert.ok(compile >= 0 && compile < architecture);
  assert.equal(steps[compile]["continue-on-error"], undefined);
});
