import assert from "node:assert/strict";
import test from "node:test";
import { FUZZ_TARGETS, fuzzPlan } from "./quality-fuzz.mjs";
test("fuzz smoke selects every owned target with reproducible resource bounds", () => {
  const plan = fuzzPlan("smoke");
  assert.deepEqual(
    plan.map((entry) => entry.name),
    FUZZ_TARGETS,
  );
  for (const { args, seconds } of plan) {
    assert.equal(seconds, 15);
    assert.ok(args.includes("-seed=1"));
    assert.ok(args.includes("-rss_limit_mb=1024"));
    assert.ok(args.includes("-timeout=10"));
    assert.ok(args.some((arg) => arg.startsWith("fuzz/corpus/")));
  }
});
test("deep fuzzing is bounded and targeted runs never silently skip unknown targets", () => {
  assert.equal(fuzzPlan("deep", "ips_apply")[0].seconds, 900);
  assert.throws(() => fuzzPlan("other"), /mode/);
  assert.throws(() => fuzzPlan("smoke", "not_a_target"), /Unknown/);
});
