import assert from "node:assert/strict";
import test from "node:test";

import { classifyChanges } from "./classify-changes.mjs";

const classify = (...paths) => Object.fromEntries(Object.entries(classifyChanges(paths)).map(([key, value]) => [key, String(value)]));

test("documentation changes skip compiled stacks", () => assert.deepEqual(classify("README.md", "docs/development/ci.md"), { rust: "false", webapp: "false", security: "false", docker_cli: "false", docker_webapp: "false", repo_lint: "true", full: "false" }));
test("usage guide changes build the webapp", () => assert.equal(classify("docs/usage/apply-rom-patches.md").webapp, "true"));
test("every published guide builds the webapp, whatever folder it sits in", () => {
  for (const path of ["docs/hosting/cli.md", "docs/legal/privacy.md", "docs/development/ARCHITECTURE.md"]) {
    assert.equal(classify(path).webapp, "true", `${path} is a published route`);
  }
});
test("unpublished maintainer docs do not build the webapp", () =>
  assert.equal(classify("docs/development/performance.md").webapp, "false"));
test("webapp changes reuse wasm and skip Rust", () => assert.equal(classify("packages/rom-weaver-webapp/src/index.tsx").webapp, "true"));
test("Docker changes select only the affected images", () => {
  assert.equal(classify("Dockerfile").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_webapp, "true");
  assert.equal(classify(".dockerignore").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_cli, "false");
});

// The shared build/tag path. An edit here that breaks an image would otherwise
// only surface at the release that publishes it.
test("the shared Docker actions select both images", () => {
  for (const path of [".github/actions/docker-build-arch/action.yml", ".github/actions/docker-manifest/action.yml"]) {
    const result = classify(path);
    assert.equal(result.docker_cli, "true", path);
    assert.equal(result.docker_webapp, "true", path);
  }
  // A composite action that builds no image selects no image. (`wasm-cache` and
  // `setup-build-env` are no counter-example - they select `full`, so they
  // select everything.)
  assert.equal(classify(".github/actions/deploy-webapp-pages/action.yml").docker_cli, "false");
});
// The wasm cache key excludes these same trees, so selecting the webapp stack
// for them can only ever buy a cache hit plus four browser jobs that cannot
// observe the edit. `.github/actions/wasm-cache` owns the authoritative list.
test("Rust test-only changes select nothing but Rust", () => {
  for (const path of [
    "crates/rom-weaver-cli/tests/cli_smoke/apply.rs",
    "crates/rom-weaver-core/src/test_support.rs",
    "crates/rom-weaver-patches/benches/xdelta.rs",
    "crates/rom-weaver-containers/examples/probe.rs",
  ]) {
    assert.deepEqual(classify(path), { rust: "true", webapp: "false", security: "false", docker_cli: "false", docker_webapp: "false", repo_lint: "false", full: "false" }, path);
  }
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
    "crates/rom-weaver-core/src/lib.rs",
    "packages/rom-weaver-webapp/src/index.tsx",
    "install.ps1",
    ".github/cli-platforms.json",
  ]) {
    assert.equal(classify(path).repo_lint, "false", path);
  }
  for (const path of ["README.md", "docs/development/ci.md", ".github/ISSUE_TEMPLATE/bug.md"]) {
    assert.equal(classify(path).repo_lint, "true", path);
  }
});
test("native package changes build every CLI platform", () => {
  // The shared build action is a composite action, so it also selects the
  // plumbing lint; the target list beside it is data nothing lints.
  for (const [path, repoLint] of [
    ["packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json", "false"],
    ["scripts/verify-cli-platform.mjs", "true"],
    [".github/cli-platforms.json", "false"],
    [".github/actions/build-cli-platform/action.yml", "true"],
  ]) {
    assert.deepEqual(classify(path), { rust: "true", webapp: "true", security: "false", docker_cli: "false", docker_webapp: "false", repo_lint: repoLint, full: "false" }, path);
  }
});

test("dependency and CI changes select their broader checks", () => {
  assert.deepEqual(classify("Cargo.lock"), { rust: "true", webapp: "true", security: "true", docker_cli: "true", docker_webapp: "false", repo_lint: "false", full: "false" });
  for (const path of [".github/workflows/ci.yml", "scripts/ci/ensure-cloudflare-assets-cache-rule.mjs", "scripts/ci/mise-disable-tools.mjs", "scripts/ci/resolve-wasm-run.mjs"]) {
    assert.deepEqual(classify(path), { rust: "true", webapp: "true", security: "true", docker_cli: "true", docker_webapp: "true", repo_lint: "true", full: "true" }, path);
  }
});

test("the dependency policy moved under .config/", () => assert.equal(classify(".config/deny.toml").rust, "true"));
