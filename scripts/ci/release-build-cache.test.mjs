import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { canReuseArmDockerWasm } from "./classify-changes.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

test("ARM pull requests reuse cached WASM only when image plumbing is unchanged", () => {
  const docker = workflow.split("\n  docker:\n")[1].split(/\n  [\w-]+:\n/u)[0];
  const restore = docker.split("      - name: Restore the built wasm module\n")[1].split(/\n      - /u)[0];
  const condition = restore.match(/^        if: (.+)$/mu)?.[1];
  assert.ok(condition);
  assert.match(restore, /save: "false"/u);
  for (const name of ["CLI", "webapp"]) {
    for (const arch of ["amd64", "arm64"]) {
      for (const event of ["pull_request", "push", "schedule", "workflow_dispatch"]) {
        for (const eligible of ["true", "false", ""]) {
          const expected = name === "webapp" && (arch === "amd64" || (event === "pull_request" && eligible === "true"));
          assert.equal(runInNewContext(condition, {
            matrix: { name, arch },
            github: { event_name: event },
            needs: { changes: { outputs: { docker_arm_wasm_cache: eligible } } },
          }), expected);
        }
      }
    }
  }
  assert.match(docker, /steps\.wasm\.outputs\.cache-hit == 'true' && 'WASM=prebuilt' \|\| ''/u);
});

test("image compiler and CI plumbing edits force ARM source builds", () => {
  for (const path of [
    "packages/rom-weaver-webapp/Dockerfile",
    ".dockerignore",
    ".github/workflows/ci.yml",
    ".github/actions/docker-build-arch/action.yml",
    ".github/actions/wasm-cache/action.yml",
  ]) assert.equal(canReuseArmDockerWasm(["CHANGELOG.md", path]), false, path);
  assert.equal(canReuseArmDockerWasm(null), false);
  assert.equal(canReuseArmDockerWasm([]), true);
  assert.equal(canReuseArmDockerWasm(["Cargo.toml", "Cargo.lock", "crates/rom-weaver-cli/Cargo.toml"]), true);
});

test("the raw diff controls cache eligibility even for full release coverage", () => {
  const classifier = readFileSync(new URL("./classify-workflow.mjs", import.meta.url), "utf8");
  assert.match(classifier, /docker_arm_wasm_cache=\$\{canReuseArmDockerWasm\(paths\)\}/u);
  assert.match(workflow, /docker_arm_wasm_cache: \$\{\{ steps\.classify\.outputs\.docker_arm_wasm_cache \}\}/u);
});
