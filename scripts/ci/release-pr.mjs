#!/usr/bin/env node

// The head ref identifies release pull requests without a token or label API request.
// This prefix MUST match the workflows that test it in an expression: release.yml, codeql.yml,
// parity.yml, and ci.yml's last-nightly step (release-pr-workflows.test.mjs checks them). Every
// other ci.yml job reads the `release_pr` output of `changes`, which classify-workflow.mjs sets.
export const RELEASE_PR_BRANCH_PREFIX = "release-please--branches--main--components--";

// Release pull requests MUST receive the full CI matrix because merging them starts publication.
// The match ignores case because the `startsWith` of a workflow expression does.
export function isReleasePullRequest(eventName, headRef) {
  return (
    eventName === "pull_request" &&
    Boolean(headRef?.toLowerCase().startsWith(RELEASE_PR_BRANCH_PREFIX))
  );
}
