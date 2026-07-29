import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getChangelog, readReleaseNotes } from "../../scripts/version.mjs";

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
const issue = (n: number) => `([#${n}](${REPOSITORY_URL}/issues/${n}))`;
const commit = (sha: string) => `([${sha}](${REPOSITORY_URL}/commit/${sha}0000000000000000000000000000000000))`;

// The real CHANGELOG.md is release-please's output and changes every release - a
// patch-only release has no "Features" section, for instance. Content assertions
// go against this fixture; the live file is only checked for shape.
const FIXTURE_CHANGELOG = `# Changelog

## [2.0.0](https://example.com/compare) (2026-07-29)


### ⚠ BREAKING CHANGES

* **bundle:** reset bundle format to v1

### Features

* **webapp:** newest thing ${issue(3)} ${commit("aaaaaaa")}
* unscoped thing ${issue(4)} ${commit("bbbbbbb")}
* **webapp:** raw <img src=x onerror="alert(1)"> markup ${issue(5)} ${commit("ccccccc")}
* **macos:** closes an issue ${issue(6)} ${commit("ddddddd")}, closes [#181](${REPOSITORY_URL}/issues/181)
* **release:** no pull request recorded ${commit("eeeeeee")}

## [1.1.0](https://example.com/compare) (2026-07-01)

### Bug Fixes

* **webapp:** middle thing ${issue(2)} ${commit("fffffff")}

## [1.0.0](https://example.com/compare) (2026-06-01)

### Features

* **webapp:** oldest thing ${issue(1)} ${commit("1111111")}
`;

let fixtureDir = "";
let fixturePath = "";

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-changelog-"));
  fixturePath = path.join(fixtureDir, "CHANGELOG.md");
  fs.writeFileSync(fixturePath, FIXTURE_CHANGELOG);
});

afterAll(() => fs.rmSync(fixtureDir, { force: true, recursive: true }));

const notesFor = (version: string, source = fixturePath) => readReleaseNotes(version, source);

describe("readReleaseNotes", () => {
  it("returns every section from the requested version down, newest first", () => {
    const release = notesFor("2.0.0");
    expect(release?.notes.map((note) => note.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(release?.version).toBe("2.0.0");
    expect(release?.repositoryUrl).toBe(REPOSITORY_URL);
    expect(release?.changelogUrl).toBe(`${REPOSITORY_URL}/blob/main/CHANGELOG.md`);
    expect(release?.truncated).toBe(false);
  });

  it("starts at the requested version rather than the newest one", () => {
    expect(notesFor("1.1.0")?.notes.map((note) => note.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("groups entries under their changelog heading", () => {
    expect(notesFor("2.0.0")?.notes[0]?.groups.map((group) => group.title)).toEqual(["⚠ BREAKING CHANGES", "Features"]);
  });

  it("splits an entry into scope, summary and its pull request", () => {
    const features = notesFor("2.0.0")?.notes[0]?.groups[1];
    expect(features?.entries[0]).toEqual({ pr: "3", scope: "webapp", summary: "newest thing" });
  });

  it("keeps an unscoped entry", () => {
    expect(notesFor("2.0.0")?.notes[0]?.groups[1]?.entries[1]).toEqual({ pr: "4", summary: "unscoped thing" });
  });

  it("carries no markup, so a merged PR title cannot reach the dialog as HTML", () => {
    const entry = notesFor("2.0.0")?.notes[0]?.groups[1]?.entries[2];
    expect(entry?.summary).toBe('raw <img src=x onerror="alert(1)"> markup');
    // Structured strings only - the dialog renders them as text nodes, never as HTML.
    expect(JSON.stringify(notesFor("2.0.0"))).not.toContain("<a ");
  });

  it("drops a trailing `closes` clause from the summary", () => {
    expect(notesFor("2.0.0")?.notes[0]?.groups[1]?.entries[3]).toEqual({
      pr: "6",
      scope: "macos",
      summary: "closes an issue",
    });
  });

  it("falls back to the commit when release-please recorded no pull request", () => {
    expect(notesFor("2.0.0")?.notes[0]?.groups[1]?.entries[4]).toEqual({
      commit: "eeeeeee",
      scope: "release",
      summary: "no pull request recorded",
    });
  });

  it("keeps a link-less breaking-change line", () => {
    expect(notesFor("2.0.0")?.notes[0]?.groups[0]?.entries[0]).toEqual({
      scope: "bundle",
      summary: "reset bundle format to v1",
    });
  });

  it("flags the tail when more sections exist than the cap emits", () => {
    const many = path.join(fixtureDir, "MANY.md");
    const sections = Array.from(
      { length: 8 },
      (_unused, index) => `## [9.0.${7 - index}](https://example.com) (2026-01-01)\n\n### Features\n\n* a change\n`,
    );
    fs.writeFileSync(many, `# Changelog\n\n${sections.join("\n")}`);
    const release = notesFor("9.0.7", many);
    expect(release?.notes).toHaveLength(5);
    expect(release?.truncated).toBe(true);
  });

  it("returns nothing for an unknown or empty version", () => {
    expect(notesFor("9.9.9")).toBeUndefined();
    expect(notesFor("")).toBeUndefined();
  });
});

describe("getChangelog", () => {
  const packageVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    .version as string;

  it("embeds the current release notes only for release builds", () => {
    const releaseEntry = getChangelog(1, packageVersion)[0];
    expect(releaseEntry?.release).toMatchObject({
      changelogUrl: `${REPOSITORY_URL}/blob/main/CHANGELOG.md`,
      repositoryUrl: REPOSITORY_URL,
      version: packageVersion,
    });
    // Shape, not content: which groups a release has depends on its commits.
    expect(releaseEntry?.release?.notes?.[0]?.groups?.[0]?.entries?.[0]?.summary).toBeTruthy();
    expect(getChangelog(1)[0]).not.toHaveProperty("release");
  });

  it("carries the notes on a placeholder entry when no git log is available", () => {
    const entries = getChangelog(1, packageVersion, () => "");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe("");
    expect(entries[0]?.release?.version).toBe(packageVersion);
  });
});
