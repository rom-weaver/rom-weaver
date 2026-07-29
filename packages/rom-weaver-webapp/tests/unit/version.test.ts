import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getChangelog } from "../../scripts/version.mjs";

const packageVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .version as string;

describe("getChangelog", () => {
  it("embeds the current release notes only for release builds", () => {
    const releaseEntry = getChangelog(1, packageVersion)[0];
    expect(releaseEntry?.release).toMatchObject({
      url: `https://github.com/rom-weaver/rom-weaver/releases/tag/v${packageVersion}`,
      version: packageVersion,
    });
    expect(releaseEntry?.release?.html).toContain("<h3>Features</h3>");
    expect(getChangelog(1)[0]).not.toHaveProperty("release");
  });
});
