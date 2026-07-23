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
    full: "false",
  });
  assert.deepEqual(classify("packages/rom-weaver-webapp/Dockerfile"), {
    rust: "false",
    webapp: "true",
    security: "false",
    docker_cli: "false",
    docker_webapp: "true",
    full: "false",
  });
  assert.deepEqual(classify(".dockerignore"), {
    rust: "false",
    webapp: "true",
    security: "false",
    docker_cli: "true",
    docker_webapp: "true",
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
      full: "false",
    });
  }
});

test("native package changes build every CLI platform", () => {
  for (const path of [
    "packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json",
    "scripts/verify-cli-platform.mjs",
  ]) {
    assert.deepEqual(classify(path), {
      rust: "true",
      webapp: "true",
      security: "false",
      docker_cli: "false",
      docker_webapp: "false",
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
      full: "true",
    });
  }
});
