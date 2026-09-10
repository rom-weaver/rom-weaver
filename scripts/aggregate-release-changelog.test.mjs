import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregatePrereleaseChangelog,
  highlightsComment,
  highlightsFromComment,
  normalizeHighlights,
  parseReleaseBody,
  renderReleaseBody,
  replaceReleasePullRequestNotes,
} from "./aggregate-release-changelog.mjs";

const changelog = `# Changelog

## [0.6.0](https://github.com/example/project/compare/v0.6.0-alpha.2...v0.6.0) (2026-07-19)

### Bug Fixes

* fix after alpha

## [0.6.0-alpha.2](https://github.com/example/project/compare/v0.6.0-alpha.1...v0.6.0-alpha.2) (2026-07-18)

### Highlights

* alpha two shipped a second feature

### Features

* second feature

## [0.6.0-alpha.1](https://github.com/example/project/compare/v0.5.0...v0.6.0-alpha.1) (2026-07-17)

### Features

* first feature

## [0.5.0](https://github.com/example/project/compare/v0.4.0...v0.5.0) (2026-07-01)

### Features

* previous feature
`;

const release = `# Changelog

## [0.7.3](https://github.com/example/project/compare/v0.7.2...v0.7.3) (2026-07-24)

### Features

* user-facing feature ([#12](https://github.com/example/project/issues/12))

### Internal

* ci-only maintenance

## [0.7.2](https://github.com/example/project/compare/v0.7.1...v0.7.2) (2026-07-23)

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
  assert.match(result.section, /### Highlights\n\n\* alpha two shipped a second feature/);
  assert.match(result.changelog, /\* previous feature\n$/);
});

test("stable highlights replace the ones carried over from prereleases", () => {
  const result = aggregatePrereleaseChangelog(changelog, "0.6.0", "the whole 0.6.0 story");

  assert.match(result.section, /### Highlights\n\n\* the whole 0\.6\.0 story\n/);
  assert.doesNotMatch(result.section, /alpha two shipped/);
});

test("collapses a prerelease section without aggregating anything", () => {
  const result = aggregatePrereleaseChangelog(changelog, "0.6.0-alpha.2");

  assert.equal(result.changed, true);
  assert.match(result.changelog, /## \[0\.6\.0-alpha\.1\]/);
  assert.match(result.section, /<summary>All changes<\/summary>\n\n### Features\n\n\* second feature\n<\/details>/);
  assert.match(result.changelog, /\* first feature\n\n## \[0\.5\.0\]/);
});

test("hides every generated entry behind All changes and nests Internal inside it", () => {
  const result = aggregatePrereleaseChangelog(release, "0.7.3");

  assert.equal(result.changed, true);
  assert.equal(
    result.section,
    `## [0.7.3](https://github.com/example/project/compare/v0.7.2...v0.7.3) (2026-07-24)

<details>
<summary>All changes</summary>

### Features

* user-facing feature ([#12](https://github.com/example/project/issues/12))

<details>
<summary>Internal</summary>

* ci-only maintenance
</details>
</details>`,
  );
  assert.doesNotMatch(result.section, /^### Internal$/m);
  assert.equal(aggregatePrereleaseChangelog(result.changelog, "0.7.3").changed, false);
});

test("puts highlights first and keeps them on a rerun without new ones", () => {
  const first = aggregatePrereleaseChangelog(release, "0.7.3", "### Highlights\n\n- A big feature (#12)\n\n* Another one\n");

  assert.match(
    first.section,
    /^## \[0\.7\.3\][^\n]*\n\n### Highlights\n\n\* A big feature \(\[#12\]\(https:\/\/github\.com\/example\/project\/issues\/12\)\)\n\* Another one\n\n<details>\n<summary>All changes<\/summary>/,
  );

  const rerun = aggregatePrereleaseChangelog(first.changelog, "0.7.3");
  assert.equal(rerun.changed, false);
  assert.match(rerun.section, /\* Another one/);

  const replaced = aggregatePrereleaseChangelog(first.changelog, "0.7.3", "Only this");
  assert.match(replaced.section, /### Highlights\n\n\* Only this\n\n<details>/);
  assert.doesNotMatch(replaced.section, /Another one/);
});

test("keeps the next release outside the collapsed current section", () => {
  const result = aggregatePrereleaseChangelog(release, "0.7.3");

  assert.match(result.changelog, /<\/details>\n\n## \[0\.7\.2\]/);
  assert.doesNotMatch(result.section, /^## \[0\.7\.2\]/m);
  assert.match(result.changelog, /## \[0\.7\.2\][^\n]*\n\n### Features\n\n\* previous feature\n$/);
});

test("repairs a previously collapsed release boundary", () => {
  const input = `# Changelog

## [0.7.3](https://github.com/example/project/compare/v0.7.2...v0.7.3) (2026-07-24)

<details>
<summary>Internal</summary>

* ci-only maintenance
</details>## [0.7.2](https://github.com/example/project/compare/v0.7.1...v0.7.2) (2026-07-23)

### Features

* previous feature
`;

  const result = aggregatePrereleaseChangelog(input, "0.7.3");

  assert.match(result.changelog, /<\/details>\n\n## \[0\.7\.2\]/);
  assert.match(result.section, /<summary>All changes<\/summary>\n\n<details>\n<summary>Internal<\/summary>/);
  assert.doesNotMatch(result.section, /^## \[0\.7\.2\]/m);
});

test("keeps a breaking-change group visible above the collapsed list", () => {
  const input = `# Changelog

## [0.8.0](https://github.com/example/project/compare/v0.7.3...v0.8.0) (2026-08-01)

### ⚠ BREAKING CHANGES

* **identify:** support only RWFP4 packs

### Features

* **identify:** support only RWFP4 packs
`;

  const result = aggregatePrereleaseChangelog(input, "0.8.0", "Only RWFP4 packs load now (#1)");

  assert.match(
    result.section,
    /### Highlights\n\n\* Only RWFP4[^\n]*\n\n### ⚠ BREAKING CHANGES\n\n\* \*\*identify:\*\* support only RWFP4 packs\n\n<details>\n<summary>All changes<\/summary>\n\n### Features/,
  );
  assert.match(result.changelog, /<\/details>\n$/);
  assert.equal(aggregatePrereleaseChangelog(result.changelog, "0.8.0").changed, false);
});

test("leaves the changelog alone when the version has no section", () => {
  const result = aggregatePrereleaseChangelog(release, "9.9.9", "ignored");

  assert.equal(result.changed, false);
  assert.equal(result.section, "");
});

test("normalizes highlight text into linked bullets", () => {
  assert.deepEqual(normalizeHighlights("", "https://github.com/example/project"), []);
  assert.deepEqual(
    normalizeHighlights("## Highlights\n- one (#7)\n\n  * two\nthree (#8) and (#9)\n", "https://github.com/example/project"),
    [
      "* one ([#7](https://github.com/example/project/issues/7))",
      "* two",
      "* three ([#8](https://github.com/example/project/issues/8)) and ([#9](https://github.com/example/project/issues/9))",
    ],
  );
  assert.deepEqual(normalizeHighlights("one (#7)"), ["* one (#7)"]);
  assert.deepEqual(normalizeHighlights("- same\n* same\n"), ["* same"]);
});

test("round-trips a rendered body through the parser", () => {
  const parsed = parseReleaseBody(`loose line

### Highlights

* top

### Features

* feat

### Internal

* chore
`);
  const rendered = renderReleaseBody(parsed);
  assert.match(rendered, /^### Highlights\n\n\* top\n\n<details>\n<summary>All changes<\/summary>\n\nloose line\n\n### Features/);
  assert.deepEqual(parseReleaseBody(rendered), parsed);
});

test("stores and reads highlights through the pull request comment", () => {
  const comment = highlightsComment(["* one", "* two"]);
  assert.match(comment, /^<!-- release-highlights -->\n_[^\n]+_\n\n### Highlights\n\n\* one\n\* two$/);
  assert.deepEqual(highlightsFromComment(comment), ["* one", "* two"]);
  assert.deepEqual(highlightsFromComment("### Highlights\n\n* not ours"), []);
  assert.deepEqual(highlightsFromComment(undefined), []);
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
