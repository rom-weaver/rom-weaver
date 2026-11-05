import assert from "node:assert/strict";
import test from "node:test";

import { A11Y_STEP, planPrePush, pushedCommits, WEBAPP_BUNDLE_STEPS } from "./pre-push.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ZERO = "0".repeat(40);

test("pushed commits come from git's stdin lines, without deletions", () => {
  const stdin = [
    `refs/heads/feat ${HEAD} refs/heads/feat ${ZERO}`,
    `(delete) ${ZERO} refs/heads/gone ${OTHER}`,
    "",
    "garbage",
  ].join("\n");
  assert.deepEqual(pushedCommits(stdin), { refs: 2, commits: [HEAD] });
  assert.deepEqual(pushedCommits(""), { refs: 0, commits: [] });
});

test("webapp and published-doc changes run the bundle checks", () => {
  for (const path of ["packages/rom-weaver-webapp/src/app.tsx", "crates/rom-weaver-core/src/lib.rs"]) {
    const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: [path] });
    assert.deepEqual(plan.steps, WEBAPP_BUNDLE_STEPS, path);
  }
});

test("changes CI's webapp build ignores skip the checks", () => {
  const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: ["docs/development/commits.md"] });
  assert.deepEqual(plan.steps, []);
  assert.match(plan.reason, /no webapp/);
  assert.deepEqual(planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: [] }).steps, []);
});

test("the browser reminder follows CI's pull-request selection", () => {
  const pushed = { refs: 1, commits: [HEAD] };
  const docs = planPrePush({ pushed, head: HEAD, changedPaths: ["docs/faq.md"], e2e: true });
  assert.deepEqual(docs.steps, WEBAPP_BUNDLE_STEPS);
  assert.equal(docs.browser, false);
  assert.equal(planPrePush({ pushed, head: HEAD, changedPaths: ["packages/rom-weaver-webapp/src/app.tsx"] }).browser, true);
});

test("an unresolved base runs every check", () => {
  assert.deepEqual(planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: undefined }).steps, WEBAPP_BUNDLE_STEPS);
});

test("pushes the working tree cannot represent skip the checks", () => {
  const webapp = ["packages/rom-weaver-webapp/src/app.tsx"];
  assert.match(planPrePush({ pushed: { refs: 1, commits: [] }, head: HEAD, changedPaths: webapp }).reason, /deletes/);
  assert.match(planPrePush({ pushed: pushedCommits("garbage\n"), head: HEAD, changedPaths: webapp }).reason, /no pushed refs/);
  assert.match(planPrePush({ pushed: { refs: 1, commits: [OTHER] }, head: HEAD, changedPaths: webapp }).reason, /HEAD is not/);
  assert.deepEqual(planPrePush({ pushed: { refs: 2, commits: [OTHER, HEAD] }, head: HEAD, changedPaths: webapp }).steps, WEBAPP_BUNDLE_STEPS);
});

test("accessibility E2E is opt-in and reuses the checked bundle", () => {
  const changedPaths = ["packages/rom-weaver-webapp/src/app.tsx"];
  const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths, e2e: true });
  assert.equal(plan.browser, true);
  assert.deepEqual(plan.steps, [...WEBAPP_BUNDLE_STEPS, A11Y_STEP]);
  assert.equal(A11Y_STEP.env.ROM_WEAVER_E2E_USE_PREBUILT_DIST, "1");
  assert.equal(A11Y_STEP.env.ROM_WEAVER_CHANNEL, WEBAPP_BUNDLE_STEPS[1].env.ROM_WEAVER_CHANNEL);
});
