import assert from "node:assert/strict";
import test from "node:test";

import { classifyChanges } from "./classify-changes.mjs";

const classify = (...paths) => Object.fromEntries(Object.entries(classifyChanges(paths)).map(([key, value]) => [key, String(value)]));

test("documentation changes skip compiled stacks", () => assert.deepEqual(classify("README.md", "docs/ci.md"), { rust: "false", webapp: "false", security: "false", docker_cli: "false", docker_webapp: "false", repo_lint: "false", full: "false" }));
test("webapp changes reuse wasm and skip Rust", () => assert.equal(classify("packages/rom-weaver-webapp/src/index.tsx").webapp, "true"));
test("Docker changes select only the affected images", () => {
  assert.equal(classify("Dockerfile").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_webapp, "true");
  assert.equal(classify(".dockerignore").docker_cli, "true");
});
test("Rust test-only changes select Rust alone", () => {
  assert.equal(classify("crates/rom-weaver-cli/tests/cli_smoke/apply.rs").webapp, "false");
  assert.equal(classify("crates/rom-weaver-containers/src/chd/tests.rs").webapp, "false");
  // Nested test modules too: the shell globs this replaced matched across `/`.
  assert.equal(classify("crates/rom-weaver-containers/src/chd/decode/test_frames.rs").webapp, "false");
  assert.equal(classify("crates/rom-weaver-containers/src/chd/decode/frames.rs").webapp, "true", "non-test sources still drive the release stacks");
});

test("plumbing lint runs only for the file kinds it lints", () => {
  for (const path of [
    ".github/workflows/codeql.yml",
    // Nested `.github` YAML: the shell `case` glob this replaced matched
    // across `/`, so keep matching at any depth.
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/actions/wasm-cache/action.yml",
    "scripts/setup-worktree.sh",
    "scripts/warn-only.mjs",
    "packages/rom-weaver-webapp/Dockerfile",
    ".config/hadolint.yaml",
  ]) {
    assert.equal(classify(path).repo_lint, "true", path);
  }
  for (const path of [
    "README.md",
    "docs/ci.md",
    "crates/rom-weaver-core/src/lib.rs",
    "packages/rom-weaver-webapp/src/index.tsx",
    "install.ps1",
    ".github/cli-platforms.json",
    ".github/ISSUE_TEMPLATE/bug.md",
  ]) {
    assert.equal(classify(path).repo_lint, "false", path);
  }
});
test("native package and Node script changes select the release stacks", () => {
  assert.equal(classify("packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json").rust, "true");
  assert.equal(classify("scripts/ci/classify-changes.mjs").full, "true");
});
test("dependency and workflow changes select their broader checks", () => {
  assert.equal(classify("Cargo.lock").security, "true");
  assert.equal(classify(".github/workflows/ci.yml").full, "true");
});
