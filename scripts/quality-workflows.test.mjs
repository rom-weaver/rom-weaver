import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const ci = load(readFileSync(".github/workflows/ci.yml", "utf8"));
const deep = load(readFileSync(".github/workflows/quality-deep.yml", "utf8"));
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
