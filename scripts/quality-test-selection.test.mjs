import assert from "node:assert/strict";
import test from "node:test";
import { checkSelection, checkBrowserSelection } from "./quality-test-selection.mjs";
const metadata = {
  workspace_members: ["cli"],
  packages: [
    {
      id: "cli",
      name: "cli",
      targets: [{ name: "protocol", test: true, "required-features": ["wire"] }],
    },
  ],
};
test("feature-gated target cannot be silently dropped from coverage or normal task", () => {
  const selection = [{ args: ["-p", "cli", "--features", "wire", "--example", "protocol"] }];
  assert.deepEqual(checkSelection(metadata, selection, "cargo test --example protocol"), []);
  assert.equal(checkSelection(metadata, [], "cargo test --example protocol").length, 1);
  assert.equal(checkSelection(metadata, selection, "cargo test --workspace").length, 1);
  assert.equal(
    checkSelection(
      metadata,
      [{ args: ["-p", "cli", "--features", "wrong", "--example", "protocol"] }],
      "--example protocol",
    ).length,
    1,
  );
});
test("browser selections fail closed for empty or changed suite patterns", () => {
  const config = 'coverage: {}, include: ["tests/wasm/*.test.mjs"]';
  assert.deepEqual(checkBrowserSelection(config, "wasm", ["test.mjs"]), []);
  assert.equal(checkBrowserSelection(config, "wasm", []).length, 1);
  assert.equal(
    checkBrowserSelection(config.replace("*.test", "*.bench"), "wasm", ["test.mjs"]).length,
    1,
  );
});
