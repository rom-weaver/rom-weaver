import assert from "node:assert/strict";
import test from "node:test";

import {
  filterWasmCacheInputTree,
  filterWasmCompilerInputTree,
  isWasmCompilerInput,
} from "./wasm-compiler-inputs.mjs";

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

test("cache inputs exclude standalone script tests and documentation", () => {
  const entries = [
    "scripts/wasm/build-app.mjs",
    "scripts/wasm/wasm32-wasip1-threads-common.sh",
    "scripts/wasm/wasi-liblzma-threading.h",
    "scripts/wasm/new-build-helper.mjs",
    ".github/actions/setup-build-env/action.yml",
    "Cargo.lock",
    ".cargo/config.toml",
    "crates/example/src/lib.rs",
  ].map((path) => `100644 blob retained\t${path}`);
  const excluded = [
    "scripts/wasm/build-app.test.mjs",
    "scripts/wasm/README.md",
    "crates/example/tests/integration.rs",
  ].map((path) => `100644 blob excluded\t${path}`);
  assert.equal(filterWasmCacheInputTree([...entries, ...excluded].join("\n")), entries.join("\n"));
});
