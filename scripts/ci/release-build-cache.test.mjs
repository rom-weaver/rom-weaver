import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

test("ARM pull requests reuse main WASM while main and dispatch retain source coverage", () => {
  const docker = workflow.split("\n  docker:\n")[1].split(/\n  [\w-]+:\n/u)[0];
  const restore = docker.split("      - name: Restore the built wasm module\n")[1].split(/\n      - /u)[0];
  const condition = restore.match(/^        if: (.+)$/mu)?.[1];
  assert.ok(condition);
  assert.match(restore, /save: "false"/u);
  for (const name of ["CLI", "webapp"]) {
    for (const arch of ["amd64", "arm64"]) {
      for (const event of ["pull_request", "push", "schedule", "workflow_dispatch"]) {
        const expected = name === "webapp" && (arch === "amd64" || event === "pull_request");
        assert.equal(runInNewContext(condition, { matrix: { name, arch }, github: { event_name: event } }), expected);
      }
    }
  }
  assert.match(docker, /steps\.wasm\.outputs\.cache-hit == 'true' && 'WASM=prebuilt' \|\| ''/u);
});
