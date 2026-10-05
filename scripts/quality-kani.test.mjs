import assert from "node:assert/strict";
import test from "node:test";
import { kaniSummary, KANI_ARGS } from "./quality-kani.mjs";
test("Kani requires proof evidence instead of compilation/setup success", () => {
  assert.throws(() => kaniSummary("Compiled successfully", 0), /no proof evidence/);
  assert.equal(kaniSummary("VERIFICATION:- SUCCESSFUL", 0).verified, true);
  assert.equal(kaniSummary("VERIFICATION:- FAILED", 1).verified, false);
  assert.equal(kaniSummary("VERIFICATION:- SUCCESSFUL", 1).verified, false);
});
test("Kani checks the owned production planner harness with explicit bounds", () => {
  assert.ok(KANI_ARGS.includes("fuzz/proofs/Cargo.toml"));
  assert.ok(KANI_ARGS.includes("full_range_single_chunk"));
  const summary = kaniSummary("VERIFICATION:- SUCCESSFUL", 0);
  assert.match(summary.assumptions, /full u64/);
  assert.equal(summary.unwind, 3);
});
