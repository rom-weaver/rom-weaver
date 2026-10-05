import assert from "node:assert/strict";
import test from "node:test";
import { FUZZ_TARGETS, fuzzPlan, runFuzz } from "./quality-fuzz.mjs";
import fs from "node:fs";
import path from "node:path";
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
test("failed or timed-out runs cannot reuse stale successes or mark unexecuted targets passed", (context) => {
  const parent = path.resolve(".agent/quality-fuzz-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(
    runFuzz(["smoke"], () => ({ status: 0 }), root),
    0,
  );
  let calls = 0;
  assert.equal(
    runFuzz(
      ["smoke"],
      () => {
        calls++;
        return { status: 77 };
      },
      root,
    ),
    77,
  );
  assert.equal(calls, 1);
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(root, `.agent/quality-fuzz/${name}.json`)));
  assert.equal(read("ips_apply").status, 77);
  assert.equal(read("iso9660").status, null);
  assert.equal(read("iso9660").error, "not executed");
  assert.equal(
    runFuzz(["smoke", "dcp_zip"], () => ({ status: 0, error: new Error("timeout") }), root),
    1,
  );
  assert.equal(read("dcp_zip").error, "timeout");
  assert.equal(fs.existsSync(path.join(root, ".agent/quality-fuzz/ips_apply.json")), false);
});
test("deep fuzzing is bounded and targeted runs never silently skip unknown targets", () => {
  assert.equal(fuzzPlan("deep", "ips_apply")[0].seconds, 900);
  assert.throws(() => fuzzPlan("other"), /mode/);
  assert.throws(() => fuzzPlan("smoke", "not_a_target"), /Unknown/);
});

test("smoke includes production bundle graph validation and owned binary metadata", () => {
  for (const target of ["bundle_parse", "dcp_zip", "iso9660"]) {
    assert.ok(FUZZ_TARGETS.includes(target));
    assert.equal(fuzzPlan("smoke", target)[0].name, target);
  }
});
