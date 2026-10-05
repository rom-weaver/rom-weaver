import test from "node:test";
import assert from "node:assert/strict";
import { inspectChange, syntaxSignals } from "./quality-guardrails.mjs";

for (const source of [
  'test.only("x", () => {});',
  'test["only"]("x",()=>{});',
  'describe.only.each([])("x",()=>{});',
  'fit("x",()=>{});',
]) {
  test(`focused tests rejected: ${source}`, () =>
    assert.ok(inspectChange("test.ts", "", source).some((f) => f.severity === "error")));
}
test("comments and strings are not executable focus", () =>
  assert.deepEqual(syntaxSignals("test.ts", '// test.only("x")\nconst x="test.only()"'), []));
test("skip needs meaningful adjacent reason", () => {
  assert.equal(inspectChange("test.ts", "", 'test.skip("x",()=>{})')[0].severity, "error");
  assert.equal(
    inspectChange(
      "test.ts",
      "",
      '// quality-reason: browser feature unavailable on this target\ntest.skip("x",()=>{})',
    )[0].severity,
    "review",
  );
  assert.equal(
    inspectChange("test.ts", "", '// quality-reason: x\ntest.skip("x",()=>{})')[0].severity,
    "error",
  );
});
test("Rust ignore and directives require reasons", () => {
  assert.equal(inspectChange("test.rs", "", "#[ignore]\nfn x() {}")[0].severity, "error");
  assert.equal(
    inspectChange("test.rs", "", '#[ignore = "requires external hardware"]\nfn x() {}')[0].severity,
    "review",
  );
  assert.equal(
    inspectChange("test.ts", "", "// eslint-disable-next-line no-alert\nalert(1)")[0].severity,
    "error",
  );
});
test("unchanged suppression is not new", () =>
  assert.deepEqual(inspectChange("test.ts", 'test.skip("x",()=>{})', 'test.skip("x",()=>{})'), []));
test("duplicate existing suppression cannot bypass", () =>
  assert.equal(
    inspectChange("test.ts", 'test.skip("x",()=>{})', 'test.skip("x",()=>{});test.skip("x",()=>{})')
      .length,
    1,
  ));
test("removed assertions produce review rather than false failure", () =>
  assert.equal(inspectChange("test.rs", "assert_eq!(a,b);", "")[0].severity, "review"));
for (const path of [
  ".github/workflows/ci.yml",
  ".config/mise.toml",
  "performance-budgets.json",
  "a.snapshots.json",
  "scripts/quality-guardrails.mjs",
  "mutants.toml",
  "test/fixtures/a.bin",
  "vitest.config.ts",
]) {
  test(`verification edits surfaced: ${path}`, () =>
    assert.ok(
      inspectChange(path, "const old = 1;", "const next = 2;").some(
        (f) => f.kind === "verification-change",
      ),
    ));
}
test("removing suppression reason fails", () => {
  const after = 'test.skip("x",()=>{})';
  assert.equal(
    inspectChange(
      "test.ts",
      "// quality-reason: unavailable hardware integration\n" + after,
      after,
    )[0].severity,
    "error",
  );
});
test("malformed syntax cannot bypass inspection", () =>
  assert.throws(() => syntaxSignals("test.ts", "test.only("), /Cannot analyze/));
test("configuration analysis identifies numeric policy and expanded exclusions", () => {
  const findings = inspectChange(
    "coverage.json",
    '{"threshold":90,"exclude":["vendor"]}',
    '{"threshold":70,"exclude":["vendor","src"]}',
  );
  assert.ok(findings.some((f) => f.kind === "numeric-policy-change"));
  assert.ok(findings.some((f) => f.kind === "exclusion-added"));
});
for (const source of [
  'test.todo("pending")',
  'test.skipIf(true)("x",()=>{})',
  'test.runIf(false)("x",()=>{})',
  'test("x", {skip: true}, ()=>{})',
  'test("x", {only: true}, ()=>{})',
  'import {test as check} from "node:test";check.only("x",()=>{})',
]) {
  test(`extended test selection: ${source}`, () =>
    assert.ok(inspectChange("test.ts", "", source).some((f) => f.severity === "error")));
}
test("business only and skip properties do not suppress tests", () =>
  assert.deepEqual(
    syntaxSignals("business.ts", "const result = customer.only(); pager.skip(2);"),
    [],
  ));
