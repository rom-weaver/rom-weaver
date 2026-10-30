import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertJobs } from "./assert-jobs.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const windowsJob = workflow.match(/^  rust-windows:\n([\s\S]*?)(?=^  [\w-]+:)/m)[1];
const condition = windowsJob.match(/    if: >-\n([\s\S]*?)(?=^    \w)/m)[1].trim();

for (const [name, rust, fullNative, refType, expected] of [
  ["Rust pull request", "true", "false", "branch", false],
  ["Rust main push", "true", "false", "branch", false],
  ["Rust full native run", "true", "true", "branch", true],
  ["non-Rust full native run", "false", "true", "branch", false],
  ["non-Rust pull request", "false", "false", "branch", false],
  ["tag", "true", "true", "tag", false],
]) {
  test(`Windows selection: ${name}`, () => {
    assert.equal(
      runInNewContext(condition, {
        github: { ref_type: refType },
        needs: { changes: { outputs: { rust, full_native: fullNative } } },
      }),
      expected,
    );
  });
}

test("Windows results are enforced with the full native jobs, not the ordinary Rust group", () => {
  const rustGroup = workflow.match(/- name: Verify Rust jobs\n([\s\S]*?)(?=\n      - name:)/)[1];
  assert.doesNotMatch(rustGroup, /needs\.rust-windows\.result/);
  const fullGroup = workflow.match(
    /- name: Verify full native jobs\n([\s\S]*?)(?=\n      - name:|^  [\w-]+:)/m,
  )[1];
  const jobs = [...fullGroup.matchAll(/'([\w-]+)=\$\{\{ needs\.([\w-]+)\.result \}\}'/g)];
  assert.ok(jobs.some(([, job, dependency]) => job === "rust-windows" && dependency === job));
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const dependencies = jobs.map(
      ([, job]) => `${job}=${job === "rust-windows" ? result : "success"}`,
    );
    assert.equal(assertJobs("success", "true", dependencies).failed, result !== "success");
  }
});
