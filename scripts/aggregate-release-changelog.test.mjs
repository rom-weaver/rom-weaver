import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregatePrereleaseChangelog,
  replaceReleasePullRequestNotes,
} from "./aggregate-release-changelog.mjs";

const changelog = `# Changelog

## [0.6.0](https://github.com/example/project/compare/v0.6.0-alpha.2...v0.6.0) (2026-07-19)

### Bug Fixes

* fix after alpha

## [0.6.0-alpha.2](https://github.com/example/project/compare/v0.6.0-alpha.1...v0.6.0-alpha.2) (2026-07-18)

### Features

* second feature

## [0.6.0-alpha.1](https://github.com/example/project/compare/v0.5.0...v0.6.0-alpha.1) (2026-07-17)

### Features

* first feature

## [0.5.0](https://github.com/example/project/compare/v0.4.0...v0.5.0) (2026-07-01)

### Features

* previous feature
`;

test("aggregates same-version prerelease sections into the stable section", () => {
  const result = aggregatePrereleaseChangelog(changelog, "0.6.0");

  assert.equal(result.changed, true);
  assert.match(result.changelog, /compare\/v0\.5\.0\.\.\.v0\.6\.0/);
  assert.doesNotMatch(result.changelog, /0\.6\.0-alpha/);
  assert.match(result.changelog, /\* fix after alpha/);
  assert.match(result.changelog, /\* second feature/);
  assert.match(result.changelog, /\* first feature/);
  assert.equal((result.changelog.match(/\* first feature/g) || []).length, 1);
});

test("does not aggregate a prerelease release PR", () => {
  const result = aggregatePrereleaseChangelog(changelog, "0.6.0-alpha.2");

  assert.equal(result.changed, false);
  assert.equal(result.changelog, changelog);
});

test("replaces only the release notes in a Release Please PR body", () => {
  const body = `:robot: I have created a release *beep* *boop*
---

## [0.6.0](https://github.com/example/project/compare/v0.6.0-alpha.2...v0.6.0)

old notes

---
This PR was generated with Release Please.`;
  const updated = replaceReleasePullRequestNotes(body, "## [0.6.0]\n\nfull notes");

  assert.match(updated, /full notes/);
  assert.doesNotMatch(updated, /old notes/);
  assert.match(updated, /This PR was generated with Release Please/);
});
