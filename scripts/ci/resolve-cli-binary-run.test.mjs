import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactName } from "./cli-release-binary.mjs";
import { latestReleaseRun, main, planReuse } from "./resolve-cli-binary-run.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const REPOSITORY = "rom-weaver/rom-weaver";
const SHA = "a".repeat(40);
const matrix = [{ package: "linux-x64-gnu" }, { package: "darwin-x64" }];
const run = (overrides = {}) => ({
  id: 100,
  head_sha: SHA,
  event: "pull_request",
  conclusion: "success",
  path: ".github/workflows/ci.yml",
  head_repository: { full_name: REPOSITORY },
  head_branch: `${RELEASE_PR_BRANCH_PREFIX}cli`,
  created_at: "2026-10-28T04:33:27Z",
  html_url: "https://example.test/runs/100",
  ...overrides,
});
const fakeGh = (runs, artifacts) => (args) => JSON.stringify(args[1].includes("/artifacts") ? { artifacts } : { workflow_runs: runs });
const artifact = (name, expired = false) => ({ name, expired });

test("marks each platform whose CLI binary the release pull request run uploaded", () => {
  const result = planReuse({
    repository: REPOSITORY,
    sha: SHA,
    matrix,
    runGh: fakeGh([run()], [artifact(artifactName("linux-x64-gnu")), artifact(artifactName("darwin-x64"), true), artifact("wasm-prod")]),
  });
  assert.deepEqual(result.matrix, [
    { package: "linux-x64-gnu", ci_run_id: "100" },
    { package: "darwin-x64", ci_run_id: "" },
  ]);
});

test("only a successful ci.yml pull request run of this repository's release branch counts", () => {
  const pick = (overrides) => latestReleaseRun([run(overrides)], { repository: REPOSITORY, sha: SHA });
  assert.equal(pick({}).id, 100);
  assert.equal(pick({ conclusion: "failure" }), null);
  assert.equal(pick({ event: "push" }), null);
  assert.equal(pick({ path: ".github/workflows/release.yml" }), null);
  assert.equal(pick({ head_sha: "b".repeat(40) }), null);
  assert.equal(pick({ head_branch: "feature/perf" }), null);
  assert.equal(pick({ head_repository: { full_name: "someone/rom-weaver" } }), null, "a fork's branch with the release prefix");
  assert.equal(latestReleaseRun([run({ id: 1 }), run({ id: 2, created_at: "2026-10-28T05:00:00Z" })], { repository: REPOSITORY, sha: SHA }).id, 2);
});

test("a missing head commit, run, or artifact leaves every platform to build", () => {
  const none = [{ package: "linux-x64-gnu", ci_run_id: "" }, { package: "darwin-x64", ci_run_id: "" }];
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: "", matrix, runGh: fakeGh([], []) }).matrix, none);
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, matrix, runGh: fakeGh([], []) }).matrix, none);
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, matrix, runGh: fakeGh([run()], []) }).matrix, none);
});

test("a failing lookup is reported and never fails the release", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-resolve-cli-"));
  try {
    const output = join(directory, "output");
    writeFileSync(output, "");
    const result = main({ MATRIX: JSON.stringify(matrix), GITHUB_REPOSITORY: REPOSITORY, ARTIFACT_SHA: SHA, GITHUB_OUTPUT: output }, () => {
      throw new Error("HTTP 500");
    });
    assert.match(result.reason, /lookup failed: HTTP 500/);
    assert.equal(readFileSync(output, "utf8"), `matrix=${JSON.stringify(matrix.map((platform) => ({ ...platform, ci_run_id: "" })))}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
