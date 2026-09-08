import { describe, expect, it } from "vitest";
import { createLocalizer } from "../../src/presentation/localization/index.ts";
import { createFindIndex, searchFind } from "../../src/webapp/find-index.ts";

const TABS = [
  { href: "apply", icon: null, id: "patcher", label: "Apply" },
  { href: "create", icon: null, id: "creator", label: "Create" },
  {
    beta: true,
    group: "tools" as const,
    href: "identify",
    icon: null,
    id: "identify",
    label: "Identify",
    placement: "more" as const,
  },
];

const GUIDES = [
  {
    description: "Repair a checksum mismatch",
    label: "Fix checksum errors",
    searchEntries: [{ id: null, label: "Fix checksum errors", text: "A checksum mismatch means the ROM differs" }],
    sections: [],
    slug: "docs/fix-checksum-errors",
    title: "Fix checksum errors",
  },
];

const sources = {
  donateHref: "https://example.com/donate",
  githubHref: "https://example.com/repo",
  localizer: createLocalizer("en"),
  tabs: TABS,
};

describe("createFindIndex", () => {
  it("lists tools then app surfaces for browsing, and every setting for search", () => {
    const index = createFindIndex(sources);
    expect(index.browse.map((entry) => entry.id).slice(0, 4)).toEqual([
      "tool:patcher",
      "tool:creator",
      "tool:identify",
      "app:settings",
    ]);
    expect(index.browse.some((entry) => entry.kind === "setting")).toBe(false);
    expect(index.entries.find((entry) => entry.id === "setting:threads")?.hint).toBe("Settings · Compression");
    expect(index.entries.find((entry) => entry.id === "app:github")?.href).toBe("https://example.com/repo");
  });
});

describe("searchFind", () => {
  it("returns the browse list for an empty query", () => {
    const index = createFindIndex(sources, GUIDES);
    expect(searchFind(index, "  ").map((result) => result.entry.kind)).not.toContain("guide");
  });

  it("ranks tools before settings before guides", () => {
    const index = createFindIndex(sources, GUIDES);
    const kinds = searchFind(index, "checksum").map((result) => result.entry.kind);
    expect(kinds[0]).toBe("setting");
    expect(kinds.at(-1)).toBe("guide");
    expect(kinds.indexOf("setting")).toBeLessThan(kinds.indexOf("guide"));
    const identify = searchFind(index, "identify");
    expect(identify[0]?.entry).toMatchObject({ id: "tool:identify", kind: "tool", hint: "Beta" });
  });

  it("links a guide hit to the guide with the query highlighted", () => {
    const index = createFindIndex(sources, GUIDES);
    const guide = searchFind(index, "mismatch").find((result) => result.entry.kind === "guide");
    expect(guide?.entry.href).toBe("/docs/fix-checksum-errors?highlight=mismatch");
    expect(guide?.entry.hint).toBe("Fix checksum errors");
  });
});
