import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { qualityPlan } from "./quality-plan.mjs";
import { classifyChanges } from "./ci/classify-changes.mjs";
test("selection plumbing and shared manifests fail open to every assurance lane", () => {
  for (const path of [
    "Cargo.lock",
    ".cargo/config.toml",
    ".config/mise.toml",
    ".github/workflows/quality-deep.yml",
    ".github/workflows/ci.yml",
    "scripts/quality-plan.mjs",
  ])
    assert.deepEqual(qualityPlan([path]), ["mutation", "fuzz", "reference"], path);
  assert.deepEqual(qualityPlan([], true), ["mutation", "fuzz", "reference"]);
});
test("relevant source, fixture, and target changes cannot evade a lane", () => {
  assert.deepEqual(qualityPlan(["crates/rom-weaver-patches/src/bps.rs"]), ["mutation", "fuzz"]);
  assert.deepEqual(qualityPlan(["crates/rom-weaver-containers/src/handlers/zip.rs"]), [
    "fuzz",
    "reference",
  ]);
  assert.deepEqual(qualityPlan(["fuzz/fuzz_targets/ips.rs"]), ["fuzz"]);
  assert.deepEqual(qualityPlan(["tests/fixtures/quality-reference/manifest.json"]), ["reference"]);
  assert.deepEqual(qualityPlan(["README.md"]), []);
});
test("main classifier selects lint for every owned checker and workflow", () => {
  for (const path of [
    "scripts/quality-plan.mjs",
    "scripts/quality-plan.test.mjs",
    ".github/workflows/quality-deep.yml",
  ])
    assert.equal(classifyChanges([path], false, "pull_request").repo_lint, true, path);
});
test("the CLI lists non-ASCII names and both paths of a moved file", () => {
  const repo = mkdtempSync(join(tmpdir(), "quality-plan-"));
  try {
    // Hooks export GIT_DIR, and CI sets GITHUB_OUTPUT; neither may reach the CLI.
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") && key !== "GITHUB_OUTPUT")),
      GIT_AUTHOR_NAME: "ci",
      GIT_AUTHOR_EMAIL: "ci@example.com",
      GIT_COMMITTER_NAME: "ci",
      GIT_COMMITTER_EMAIL: "ci@example.com",
    };
    const git = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env });
    mkdirSync(join(repo, "crates/rom-weaver-patches/src"), { recursive: true });
    mkdirSync(join(repo, "packages/rom-weaver-webapp/src"), { recursive: true });
    writeFileSync(join(repo, "crates/rom-weaver-patches/src/lib.rs"), "pub fn apply() {}\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("branch", "base");
    writeFileSync(join(repo, "packages/rom-weaver-webapp/src/näme.ts"), "export {};\n");
    git("mv", "crates/rom-weaver-patches/src/lib.rs", "notes-lib.rs");
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const script = fileURLToPath(new URL("./quality-plan.mjs", import.meta.url));
    const { paths } = JSON.parse(execFileSync(process.execPath, [script, "base"], { cwd: repo, encoding: "utf8", env }));
    assert.deepEqual(paths.toSorted(), [
      "crates/rom-weaver-patches/src/lib.rs",
      "notes-lib.rs",
      "packages/rom-weaver-webapp/src/näme.ts",
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
