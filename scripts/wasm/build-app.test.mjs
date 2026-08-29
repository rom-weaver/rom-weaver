import assert from "node:assert/strict";
import test from "node:test";

import { resolveNightlyToolchain } from "./build-app.mjs";

const collect = () => {
  const warnings = [];
  return { warn: (message) => warnings.push(message), warnings };
};

test("no pinned nightly keeps the stable toolchain and stays quiet", () => {
  const { warn, warnings } = collect();
  assert.equal(resolveNightlyToolchain({}, warn), null);
  assert.deepEqual(warnings, []);
});

test("ROM_WEAVER_WASM_STABLE overrides the pinned nightly", () => {
  const { warn, warnings } = collect();
  assert.equal(resolveNightlyToolchain({ ROM_WEAVER_WASM_NIGHTLY: "nightly-2026-08-25", ROM_WEAVER_WASM_STABLE: "1" }, warn), null);
  assert.equal(warnings.length, 1);
});

test("a missing nightly warns and falls back instead of failing", () => {
  const { warn, warnings } = collect();
  assert.equal(resolveNightlyToolchain({ ROM_WEAVER_WASM_NIGHTLY: "nightly-0000-00-00" }, warn), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /falling back to the stable production build/);
});

test("ROM_WEAVER_WASM_REQUIRE_NIGHTLY turns every fallback into an error", () => {
  const { warn } = collect();
  const required = { ROM_WEAVER_WASM_REQUIRE_NIGHTLY: "1" };
  assert.throws(() => resolveNightlyToolchain({ ...required }, warn), /ROM_WEAVER_WASM_NIGHTLY is unset/);
  assert.throws(() => resolveNightlyToolchain({ ...required, ROM_WEAVER_WASM_NIGHTLY: "nightly-0000-00-00" }, warn), /forbids the stable fallback/);
  assert.throws(() => resolveNightlyToolchain({ ...required, ROM_WEAVER_WASM_NIGHTLY: "nightly-2026-08-25", ROM_WEAVER_WASM_STABLE: "1" }, warn), /conflicts/);
});
