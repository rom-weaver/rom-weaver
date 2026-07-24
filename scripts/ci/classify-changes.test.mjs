import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "classify-changes.sh");
const classify = (...paths) =>
  Object.fromEntries(
    execFileSync(script, { encoding: "utf8", input: `${paths.join("\n")}\n` })
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );

test("documentation changes skip compiled stacks", () => {
  assert.deepEqual(classify("README.md", "docs/ci.md"), {
    rust: "false",
    webapp: "false",
    security: "false",
    docker_cli: "false",
    docker_webapp: "false",
    repo_lint: "false",
    full: "false",
  });
});

test("webapp changes reuse wasm and skip Rust", () => {
  assert.deepEqual(classify("packages/rom-weaver-webapp/src/index.tsx"), {
    rust: "false",
    webapp: "true",
    security: "false",
    docker_cli: "false",
    docker_webapp: "false",
    repo_lint: "false",
    full: "false",
  });
});

test("Docker changes select only the affected images", () => {
  assert.deepEqual(classify("Dockerfile"), {
    rust: "false",
    webapp: "false",
    security: "false",
    docker_cli: "true",
    docker_webapp: "false",
    repo_lint: "true",
    full: "false",
  });
  assert.deepEqual(classify("packages/rom-weaver-webapp/Dockerfile"), {
    rust: "false",
    webapp: "true",
    security: "false",
    docker_cli: "false",
    docker_webapp: "true",
    repo_lint: "true",
    full: "false",
  });
  assert.deepEqual(classify(".dockerignore"), {
    rust: "false",
    webapp: "true",
    security: "false",
    docker_cli: "true",
    docker_webapp: "true",
    repo_lint: "false",
    full: "false",
  });
});

test("Rust and vendored C changes build the CLI image", () => {
  for (const path of [
    "crates/rom-weaver-core/src/lib.rs",
    "crates/rom-weaver-containers/vendor/libarchive/archive_read.c",
  ]) {
    assert.deepEqual(classify(path), {
      rust: "true",
      webapp: "true",
      security: "false",
      docker_cli: "true",
      docker_webapp: "false",
      repo_lint: "false",
      full: "false",
    });
  }
});

// The wasm cache key excludes these same trees, so selecting the webapp stack
// for them can only ever buy a cache hit plus four browser jobs that cannot
// observe the edit. `.github/actions/wasm-cache` owns the authoritative list.
test("Rust test-only changes select Rust alone", () => {
  for (const path of [
    "crates/rom-weaver-cli/tests/cli_smoke/apply.rs",
    "crates/rom-weaver-core/src/test_support.rs",
    "crates/rom-weaver-patches/benches/xdelta.rs",
    "crates/rom-weaver-containers/examples/probe.rs",
  ]) {
    assert.deepEqual(classify(path), {
      rust: "true",
      webapp: "false",
      security: "false",
      docker_cli: "false",
      docker_webapp: "false",
      repo_lint: "false",
      full: "false",
    });
  }
});

test("plumbing lint runs only for the file kinds it lints", () => {
  for (const path of [
    ".github/workflows/codeql.yml",
    ".github/actions/wasm-cache/action.yml",
    "scripts/setup-worktree.sh",
    "packages/rom-weaver-webapp/Dockerfile",
    ".config/hadolint.yaml",
  ]) {
    assert.equal(classify(path).repo_lint, "true", path);
  }
  for (const path of [
    "README.md",
    "crates/rom-weaver-core/src/lib.rs",
    "packages/rom-weaver-webapp/src/index.tsx",
    "install.ps1",
    ".github/cli-platforms.json",
    ".github/ISSUE_TEMPLATE/bug.md",
  ]) {
    assert.equal(classify(path).repo_lint, "false", path);
  }
});

test("native package changes build every CLI platform", () => {
  // The shared build action is a composite action, so it also selects the
  // plumbing lint; the target list beside it is data nothing lints.
  for (const [path, repoLint] of [
    ["packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json", "false"],
    ["scripts/verify-cli-platform.mjs", "false"],
    [".github/cli-platforms.json", "false"],
    [".github/actions/build-cli-platform/action.yml", "true"],
  ]) {
    assert.deepEqual(classify(path), {
      rust: "true",
      webapp: "true",
      security: "false",
      docker_cli: "false",
      docker_webapp: "false",
      repo_lint: repoLint,
      full: "false",
    });
  }
});

test("dependency and CI changes select their broader checks", () => {
  assert.deepEqual(classify("Cargo.lock"), {
    rust: "true",
    webapp: "true",
    security: "true",
    docker_cli: "true",
    docker_webapp: "false",
    repo_lint: "false",
    full: "false",
  });
  for (const path of [
    ".github/workflows/ci.yml",
    "scripts/ci/ensure-cloudflare-assets-cache-rule.sh",
    "scripts/ci/mise-disable-tools.sh",
    "scripts/ci/resolve-wasm-run.sh",
  ]) {
    assert.deepEqual(classify(path), {
      rust: "true",
      webapp: "true",
      security: "true",
      docker_cli: "true",
      docker_webapp: "true",
      repo_lint: "true",
      full: "true",
    });
  }
});
