import assert from "node:assert/strict";
import test from "node:test";

import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";
import { findReleasePull } from "./resolve-tag-release-pull.mjs";

const REPO = "octo/rom-weaver";
const TAG_SHA = "c".repeat(40);
const HEAD_SHA = "a".repeat(40);
const RELEASE_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}cli`;

// The merged release pull request 7, as the pulls API reports it.
const releasePull = (overrides = {}) => ({
  number: 7,
  merged: true,
  merge_commit_sha: TAG_SHA,
  head: { sha: HEAD_SHA, ref: RELEASE_BRANCH, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
  ...overrides,
});

// The commit's pulls list omits `merged`; the full pull request is served by number.
const ghFor = (pulls) => (args) => {
  if (args[1] === `repos/${REPO}/commits/${TAG_SHA}/pulls`) return JSON.stringify(pulls.map(({ merged: _merged, ...listed }) => listed));
  const found = pulls.find((pull) => args[1] === `repos/${REPO}/pulls/${pull.number}`);
  if (found) return JSON.stringify(found);
  throw new Error(`unexpected: ${args.join(" ")}`);
};
const find = (pulls) => findReleasePull({ repository: REPO, sha: TAG_SHA, runGh: ghFor(pulls) });
const mainOnly = { pr: "", sha: TAG_SHA };

test("a tag finds the merged release pull request it was cut from", () => {
  assert.deepEqual(find([releasePull()]), { pr: "7", sha: HEAD_SHA });
  assert.deepEqual(find([releasePull({ number: 6, head: { sha: "b".repeat(40), ref: "feature/x", repo: { full_name: REPO } } }), releasePull()]), { pr: "7", sha: HEAD_SHA });
});

test("anything but the merged release pull request leaves runs of main only", () => {
  assert.deepEqual(find([]), mainOnly);
  for (const overrides of [
    { merged: false },
    { merge_commit_sha: "d".repeat(40) },
    { base: { ref: "attacker/base", repo: { full_name: REPO } } },
    { head: { sha: HEAD_SHA, ref: "feature/wasm", repo: { full_name: REPO } } },
    { head: { sha: HEAD_SHA, ref: RELEASE_BRANCH, repo: { full_name: "attacker/rom-weaver" } } },
  ])
    assert.deepEqual(find([releasePull(overrides)]), mainOnly, JSON.stringify(overrides));
});

test("an unreadable pull request is skipped, not trusted", () => {
  const runGh = (args) => {
    if (args[1].endsWith("/pulls")) return JSON.stringify([{ number: 7, merge_commit_sha: TAG_SHA }]);
    throw new Error("HTTP 502");
  };
  assert.deepEqual(findReleasePull({ repository: REPO, sha: TAG_SHA, runGh }), mainOnly);
});
