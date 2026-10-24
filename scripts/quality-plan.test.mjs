import assert from "node:assert/strict";
import test from "node:test";
import { qualityPlan } from "./quality-plan.mjs";
import { classifyChanges } from "./ci/classify-changes.mjs";
test("selection plumbing and shared manifests fail open to every assurance lane", () => {
  for (const path of [
    "Cargo.lock",
    ".cargo/config.toml",
    ".config/mise.toml",
    ".github/workflows/quality-deep.yml",
    ".github/workflows/ci.yml",
    "scripts/quality-plan.mjs",
  ])
    assert.deepEqual(qualityPlan([path]), ["mutation", "fuzz", "reference"], path);
  assert.deepEqual(qualityPlan([], true), ["mutation", "fuzz", "reference"]);
});
test("relevant source, fixture, and target changes cannot evade a lane", () => {
  assert.deepEqual(qualityPlan(["crates/rom-weaver-patches/src/bps.rs"]), ["mutation", "fuzz"]);
  assert.deepEqual(qualityPlan(["crates/rom-weaver-containers/src/handlers/zip.rs"]), [
    "fuzz",
    "reference",
  ]);
  assert.deepEqual(qualityPlan(["fuzz/fuzz_targets/ips.rs"]), ["fuzz"]);
  assert.deepEqual(qualityPlan(["tests/fixtures/quality-reference/manifest.json"]), ["reference"]);
  assert.deepEqual(qualityPlan(["README.md"]), []);
});
test("main classifier selects lint for every owned checker and workflow", () => {
  for (const path of [
    "scripts/quality-plan.mjs",
    "scripts/quality-plan.test.mjs",
    ".github/workflows/quality-deep.yml",
  ])
    assert.equal(classifyChanges([path], false, "pull_request").repo_lint, true, path);
});
