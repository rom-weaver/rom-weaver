#!/usr/bin/env node

// release-please names its pull request branch
// `release-please--branches--<base>--components--<component>`; ours is always
// based on main, and the component varies (`cli` today).
//
// Matching the branch rather than the `autorelease: pending` label is
// deliberate: the label is only readable through an API call, which needs a
// token and can fail, while the head ref arrives in the event payload and is
// already what `.github/workflows/release.yml` keys its own release-pull-request
// jobs off. Whatever the branch protection or the classifier decides from it, it
// decides offline.
export const RELEASE_PR_BRANCH_PREFIX = "release-please--branches--main--components--";

// The release pull request is main's tree plus version strings, and merging it
// is what ships. Narrowing it the way an ordinary pull request is narrowed would
// give the shipping commit less coverage than the commit it was cut from, so it
// is treated as a push to main everywhere CI narrows on the event name.
export function isReleasePullRequest(eventName, headRef) {
  return eventName === "pull_request" && Boolean(headRef?.startsWith(RELEASE_PR_BRANCH_PREFIX));
}
