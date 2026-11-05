import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import { artifactName } from "./cli-release-binary.mjs";
import { isReleasePull, latestReleaseRun, main, planReuse } from "./resolve-cli-binary-run.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const REPOSITORY = "rom-weaver/rom-weaver";
const SHA = "a".repeat(40);
const matrix = [{ package: "linux-x64-gnu" }, { package: "darwin-x64" }];
const PR = "1661";
const releasePull = (overrides = {}) => ({
  number: 1661,
  merged: true,
  head: { sha: SHA, ref: `${RELEASE_PR_BRANCH_PREFIX}cli`, repo: { full_name: REPOSITORY } },
  base: { ref: "main", repo: { full_name: REPOSITORY } },
  ...overrides,
});
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
  // GitHub fills this from the pull requests open now; after the merge it names the next one.
  pull_requests: [{ number: 1700 }],
  ...overrides,
});
const fakeGh =
  (runs, artifacts, pull = releasePull()) =>
  (args) => {
    if (args[1].includes("/artifacts")) return JSON.stringify({ artifacts });
    if (args[1] === `repos/${REPOSITORY}/pulls/${PR}`) return JSON.stringify(pull);
    if (args[1].startsWith(`repos/${REPOSITORY}/actions/runs?`)) return JSON.stringify({ workflow_runs: runs });
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
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

test("only a successful ci.yml run of this repository's release branch at the head counts", () => {
  const pick = (overrides) => latestReleaseRun([run(overrides)], { repository: REPOSITORY, sha: SHA });
  assert.equal(pick({}).id, 100, "a run whose pull_requests no longer names the merged pull request");
  assert.equal(pick({ pull_requests: [] }).id, 100);
  assert.equal(pick({ conclusion: "failure" }), null);
  assert.equal(pick({ event: "push" }), null);
  assert.equal(pick({ path: ".github/workflows/release.yml" }), null);
  assert.equal(pick({ head_sha: "b".repeat(40) }), null);
  assert.equal(pick({ head_branch: "feature/perf" }), null);
  assert.equal(pick({ head_repository: { full_name: "someone/rom-weaver" } }), null, "a fork's branch with the release prefix");
  assert.equal(pick({ path: ".github/workflows/ci.yml-x.yml" }), null, "a workflow whose path only starts with ci.yml");
  assert.equal(latestReleaseRun([run({ id: 1 }), run({ id: 2, created_at: "2026-10-28T05:00:00Z" })], { repository: REPOSITORY, sha: SHA }).id, 2);
  const branch = `${RELEASE_PR_BRANCH_PREFIX}cli`;
  const other = run({ id: 3, head_branch: `${RELEASE_PR_BRANCH_PREFIX}other`, created_at: "2026-10-29T00:00:00Z" });
  assert.equal(latestReleaseRun([run(), other], { repository: REPOSITORY, sha: SHA, branch }).id, 100, "a newer run of another release-prefixed branch");
});

test("only the merged release pull request of that head into main enables reuse", () => {
  const is = (overrides) => isReleasePull(releasePull(overrides), { repository: REPOSITORY, sha: SHA });
  assert.equal(is({}), true);
  assert.equal(is({ merged: false }), false, "an open or closed pull request");
  assert.equal(is({ head: { ...releasePull().head, sha: "b".repeat(40) } }), false, "another head commit");
  assert.equal(is({ head: { ...releasePull().head, ref: "feature/perf" } }), false, "not the release branch");
  assert.equal(is({ head: { ...releasePull().head, repo: { full_name: "someone/rom-weaver" } } }), false, "a fork's head");
  assert.equal(is({ head: { ...releasePull().head, repo: null } }), false, "a deleted head repository");
  // Another pull request can share the release head commit and branch while targeting a base whose
  // ci.yml its author wrote.
  assert.equal(is({ base: { ref: "evil-base", repo: { full_name: REPOSITORY } } }), false, "the release head merged into another base");
  assert.equal(is({ base: { ref: "main", repo: { full_name: "someone/rom-weaver" } } }), false, "a base in another repository");
  assert.equal(isReleasePull(null, { repository: REPOSITORY, sha: SHA }), false);

  const everything = [run()];
  const artifacts = [artifact(artifactName("linux-x64-gnu")), artifact(artifactName("darwin-x64"))];
  const none = matrix.map((platform) => ({ ...platform, ci_run_id: "" }));
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest: PR, matrix, runGh: fakeGh(everything, artifacts, releasePull({ merged: false })) }).matrix, none);
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest: PR, matrix, runGh: fakeGh(everything, artifacts) }).matrix, matrix.map((platform) => ({ ...platform, ci_run_id: "100" })));
  // A newer run of another release-prefixed branch with the same head is never the pull request's.
  const otherBranch = run({ id: 200, head_branch: `${RELEASE_PR_BRANCH_PREFIX}other`, created_at: "2026-10-29T00:00:00Z" });
  assert.deepEqual(planReuse({ repository: REPOSITORY, sha: SHA, pullRequest: PR, matrix, runGh: fakeGh([otherBranch, run()], artifacts) }).matrix, matrix.map((platform) => ({ ...platform, ci_run_id: "100" })));
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
    const stdout = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => stdout.push(String(chunk)) > 0;
    let result;
    try {
      result = main({ MATRIX: JSON.stringify(matrix), GITHUB_REPOSITORY: REPOSITORY, ARTIFACT_SHA: SHA, ARTIFACT_PR: PR, GITHUB_OUTPUT: output }, () => {
        throw new Error("HTTP 500");
      });
    } finally {
      process.stdout.write = write;
    }
    assert.match(result.reason, /lookup failed: HTTP 500/);
    assert.ok(stdout.some((line) => line.startsWith("::warning title=CLI binary reuse lookup failed::HTTP 500")), "a broken lookup is visible");
    assert.equal(readFileSync(output, "utf8"), `matrix=${JSON.stringify(matrix.map((platform) => ({ ...platform, ci_run_id: "" })))}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
