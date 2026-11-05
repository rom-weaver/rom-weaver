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
const PR = "1661";
const pull = (number = 1661, base = "main", repository = REPOSITORY) => ({ number, base: { ref: base, repo: { url: `https://api.github.com/repos/${repository}` } } });
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
  pull_requests: [pull()],
  ...overrides,
});
const fakeGh = (runs, artifacts) => (args) => JSON.stringify(args[1].includes("/artifacts") ? { artifacts } : { workflow_runs: runs });
const artifact = (name, expired = false) => ({ name, expired });

test("marks each platform whose CLI binary the release pull request run uploaded", () => {
  const result = planReuse({
    repository: REPOSITORY,
    sha: SHA,
    pullRequest: PR,
    matrix,
    runGh: fakeGh([run()], [artifact(artifactName("linux-x64-gnu")), artifact(artifactName("darwin-x64"), true), artifact("wasm-prod")]),
  });
  assert.deepEqual(result.matrix, [
    { package: "linux-x64-gnu", ci_run_id: "100" },
    { package: "darwin-x64", ci_run_id: "" },
  ]);
});

test("only a successful ci.yml run of the merged release pull request into main counts", () => {
  const pick = (overrides) => latestReleaseRun([run(overrides)], { repository: REPOSITORY, sha: SHA, pullRequest: PR });
  assert.equal(pick({}).id, 100);
  assert.equal(pick({ conclusion: "failure" }), null);
  assert.equal(pick({ event: "push" }), null);
  assert.equal(pick({ path: ".github/workflows/release.yml" }), null);
  assert.equal(pick({ head_sha: "b".repeat(40) }), null);
  assert.equal(pick({ head_branch: "feature/perf" }), null);
  assert.equal(pick({ head_repository: { full_name: "someone/rom-weaver" } }), null, "a fork's branch with the release prefix");
  assert.equal(pick({ path: ".github/workflows/ci.yml-x.yml" }), null, "a workflow whose path only starts with ci.yml");
  // Another pull request can share the release head commit and branch while targeting a base whose
  // ci.yml its author wrote; the number and base tell them apart.
  assert.equal(pick({ pull_requests: [pull(1700)] }), null, "another pull request with the same head");
  assert.equal(pick({ pull_requests: [pull(1661, "evil-base")] }), null, "the release head opened into another base");
  assert.equal(pick({ pull_requests: [pull(1661, "main", "someone/rom-weaver")] }), null, "a base in another repository");
  assert.equal(pick({ pull_requests: [] }), null, "a run with no pull request");
  assert.equal(pick({ pull_requests: [pull(1700), pull(1661)] }).id, 100);
  assert.equal(latestReleaseRun([run({ id: 1 }), run({ id: 2, created_at: "2026-10-28T05:00:00Z" })], { repository: REPOSITORY, sha: SHA, pullRequest: PR }).id, 2);
});

test("a missing head commit, pull request, run, or artifact leaves every platform to build", () => {
  const none = [{ package: "linux-x64-gnu", ci_run_id: "" }, { package: "darwin-x64", ci_run_id: "" }];
  const everything = fakeGh([run()], [artifact(artifactName("linux-x64-gnu")), artifact(artifactName("darwin-x64"))]);
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: "", pullRequest: PR, matrix, runGh: fakeGh([], []) }).matrix, none);
  for (const pullRequest of [undefined, "", "0", "1661/merge"])
    assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest, matrix, runGh: everything }).matrix, none, String(pullRequest));
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest: PR, matrix, runGh: fakeGh([], []) }).matrix, none);
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest: PR, matrix, runGh: fakeGh([run()], []) }).matrix, none);
});

test("a failing lookup is reported and never fails the release", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-resolve-cli-"));
  try {
    const output = join(directory, "output");
    writeFileSync(output, "");
    const result = main({ MATRIX: JSON.stringify(matrix), GITHUB_REPOSITORY: REPOSITORY, ARTIFACT_SHA: SHA, ARTIFACT_PR: PR, GITHUB_OUTPUT: output }, () => {
      throw new Error("HTTP 500");
    });
    assert.match(result.reason, /lookup failed: HTTP 500/);
    assert.equal(readFileSync(output, "utf8"), `matrix=${JSON.stringify(matrix.map((platform) => ({ ...platform, ci_run_id: "" })))}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
