import assert from "node:assert/strict";
import test from "node:test";

import { filterWasmCompilerInputTree, isWasmCompilerInput } from "./wasm-compiler-inputs.mjs";

test("selects production compiler inputs and embedded assets", () => {
  for (const path of [
    "crates/example/build.rs",
    "crates/example/src/lib.rs",
    "crates/example/src/embedded.json",
    "crates/example/vendor/data/table.inc",
  ]) {
    assert.equal(isWasmCompilerInput(path), true, path);
  }
});

test("excludes standalone Rust targets", () => {
  for (const path of [
    "crates/example/tests/integration.rs",
    "crates/example/test/fixture.rs",
    "crates/example/examples/probe.rs",
    "crates/example/benches/codec.rs",
    "crates/example/src/test_support.rs",
    "crates/example/src/codec/tests.rs",
  ]) {
    assert.equal(isWasmCompilerInput(path), false, path);
  }
});

test("filters committed Git tree entries with the shared path rules", () => {
  const tree = [
    "100644 blob source\tcrates/example/src/lib.rs",
    "100644 blob asset\tcrates/example/src/embedded.json",
    "100644 blob test\tcrates/example/tests/integration.rs",
    "100644 blob unrelated\tdocs/README.md",
    "",
  ].join("\n");

  assert.equal(
    filterWasmCompilerInputTree(tree),
    [
      "100644 blob source\tcrates/example/src/lib.rs",
      "100644 blob asset\tcrates/example/src/embedded.json",
    ].join("\n"),
  );
});
