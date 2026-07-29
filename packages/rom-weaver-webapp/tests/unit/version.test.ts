import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getChangelog, renderReleaseSections } from "../../scripts/version.mjs";

// The real CHANGELOG.md is release-please's output and changes every release - a
// patch-only release has no "Features" section, for instance. Content assertions
// go against this fixture; the live file is only checked for shape.
const FIXTURE_CHANGELOG = `# Changelog

## [2.0.0](https://example.com/compare) (2026-07-29)

### Features

* **webapp:** newest thing ([#3](https://github.com/rom-weaver/rom-weaver/issues/3))
* **webapp:** raw <img src=x onerror="alert(1)"> markup

## [1.1.0](https://example.com/compare) (2026-07-01)

### Bug Fixes

* **webapp:** middle thing ([#2](https://github.com/rom-weaver/rom-weaver/issues/2))

## [1.0.0](https://example.com/compare) (2026-06-01)

### Features

* **webapp:** oldest thing ([#1](https://github.com/rom-weaver/rom-weaver/issues/1))
`;

let fixtureDir = "";
let fixturePath = "";

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-changelog-"));
  fixturePath = path.join(fixtureDir, "CHANGELOG.md");
  fs.writeFileSync(fixturePath, FIXTURE_CHANGELOG);
});

afterAll(() => fs.rmSync(fixtureDir, { force: true, recursive: true }));

describe("renderReleaseSections", () => {
  it("returns every section from the requested version down, newest first", () => {
    const release = renderReleaseSections("2.0.0", fixturePath);
    expect(release?.notes.map((note) => note.version)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
    expect(release?.notes[0]?.url).toBe("https://github.com/rom-weaver/rom-weaver/releases/tag/v2.0.0");
    expect(release?.version).toBe("2.0.0");
    expect(release?.changelogUrl).toBe("https://github.com/rom-weaver/rom-weaver/blob/main/CHANGELOG.md");
    expect(release?.truncated).toBe(false);
  });

  it("flags the tail when more sections exist than the cap emits", () => {
    const many = path.join(fixtureDir, "MANY.md");
    const sections = Array.from(
      { length: 6 },
      (_unused, index) => `## [9.0.${5 - index}](https://example.com) (2026-01-01)\n\n* a change\n`,
    );
    fs.writeFileSync(many, `# Changelog\n\n${sections.join("\n")}`);
    const release = renderReleaseSections("9.0.5", many);
    expect(release?.notes).toHaveLength(3);
    expect(release?.truncated).toBe(true);
  });

  it("starts at the requested version rather than the newest one", () => {
    expect(renderReleaseSections("1.1.0", fixturePath)?.notes.map((note) => note.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("escapes raw HTML so a merged PR title cannot inject markup into the dialog", () => {
    const html = renderReleaseSections("2.0.0", fixturePath)?.notes[0]?.html ?? "";
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
  });

  it("opens rendered links in a new tab so the modal does not navigate the app away", () => {
    const html = renderReleaseSections("2.0.0", fixturePath)?.notes[0]?.html ?? "";
    expect(html).toContain('rel="noreferrer" target="_blank"');
  });

  it("returns nothing for an unknown or empty version", () => {
    expect(renderReleaseSections("9.9.9", fixturePath)).toBeUndefined();
    expect(renderReleaseSections("", fixturePath)).toBeUndefined();
  });
});

describe("getChangelog", () => {
  const packageVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
    .version as string;

  it("embeds the current release notes only for release builds", () => {
    const releaseEntry = getChangelog(1, packageVersion)[0];
    expect(releaseEntry?.release).toMatchObject({
      changelogUrl: "https://github.com/rom-weaver/rom-weaver/blob/main/CHANGELOG.md",
      version: packageVersion,
    });
    expect(releaseEntry?.release?.notes?.[0]?.url).toBe(
      `https://github.com/rom-weaver/rom-weaver/releases/tag/v${packageVersion}`,
    );
    // Shape, not content: which sections a release has depends on its commits.
    expect(releaseEntry?.release?.notes?.[0]?.html).toMatch(/<(h3|ul|p)>/);
    expect(getChangelog(1)[0]).not.toHaveProperty("release");
  });

  it("carries the notes on a placeholder entry when no git log is available", () => {
    const entries = getChangelog(1, packageVersion, () => "");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe("");
    expect(entries[0]?.release?.version).toBe(packageVersion);
  });
});
