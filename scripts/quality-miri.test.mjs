import assert from "node:assert/strict";
import test from "node:test";
import { miriPlan, selectedMiriTests } from "./quality-miri.mjs";
test("Miri cannot be green after zero tests or benchmarks only", () => {
  assert.throws(() => selectedMiriTests("0 tests, 0 benchmarks"), /no tests/);
  assert.throws(() => selectedMiriTests("measure: benchmark"), /no tests/);
  assert.deepEqual(selectedMiriTests("io::tests::chunk_planner: test\n1 test, 0 benchmarks"), [
    "io::tests::chunk_planner",
  ]);
});
test("Miri uses two fixed seeds and excludes platform/FFI-heavy execution", () => {
  const plan = miriPlan();
  assert.deepEqual([...new Set(plan.map(({ seed }) => seed))], [0, 1]);
  assert.equal(plan.length, 4);
  for (const { args } of plan)
    assert.ok(args.includes("rom-weaver-core") && args.includes("--lib"));
});
