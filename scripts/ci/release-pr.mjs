#!/usr/bin/env node

// The head ref identifies release pull requests without a token or label API request.
// This prefix MUST match .github/workflows/release.yml.
export const RELEASE_PR_BRANCH_PREFIX = "release-please--branches--main--components--";

// Release pull requests MUST receive the full CI matrix because merging them starts publication.
export function isReleasePullRequest(eventName, headRef) {
  return eventName === "pull_request" && Boolean(headRef?.startsWith(RELEASE_PR_BRANCH_PREFIX));
}
