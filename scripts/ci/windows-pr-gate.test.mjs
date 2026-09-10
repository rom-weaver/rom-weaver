import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertJobs } from "./assert-jobs.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const windowsJob = workflow.match(/^  rust-windows:\n([\s\S]*?)(?=^  [\w-]+:)/m)[1];
const condition = windowsJob.match(/    if: >-\n([\s\S]*?)(?=^    \w)/m)[1].trim();

for (const [name, rust, fullMatrix, refType, expected] of [
  ["Rust pull request", "true", "false", "branch", true],
  ["Rust main run", "true", "true", "branch", true],
  ["non-Rust pull request", "false", "false", "branch", false],
  ["non-Rust main run", "false", "true", "branch", false],
  ["tag", "true", "true", "tag", false],
]) {
  test(`Windows selection: ${name}`, () => {
    assert.equal(
      runInNewContext(condition, {
        github: { ref_type: refType },
        needs: { changes: { outputs: { rust, full_matrix: fullMatrix } } },
      }),
      expected,
    );
  });
}

test("the required Rust group enforces Windows results on pull requests", () => {
  const rustGroup = workflow.match(/- name: Verify Rust jobs\n([\s\S]*?)(?=\n      - name:)/)[1];
  assert.match(rustGroup, /'\$\{\{ needs\.changes\.outputs\.rust \}\}'/);
  const jobs = [...rustGroup.matchAll(/'([\w-]+)=\$\{\{ needs\.([\w-]+)\.result \}\}'/g)];
  assert.ok(jobs.some(([, job, dependency]) => job === "rust-windows" && dependency === job));
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const dependencies = jobs.map(
      ([, job]) => `${job}=${job === "rust-windows" ? result : "success"}`,
    );
    assert.equal(assertJobs("success", "true", dependencies).failed, result !== "success");
  }
  const fullGroup = workflow.match(/- name: Verify full native jobs\n([\s\S]*?)(?=^  [\w-]+:)/m)[1];
  assert.doesNotMatch(fullGroup, /needs\.rust-windows\.result/);
});
