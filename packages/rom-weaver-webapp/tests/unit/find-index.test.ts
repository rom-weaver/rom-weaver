import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalizer } from "../../src/presentation/localization/index.ts";
import { createFindIndex, loadIdentifyFindEntries, searchFind } from "../../src/webapp/find-index.ts";

const identifyMocks = vi.hoisted(() => ({
  lookupExpectedRom: vi.fn(),
  searchExpectedRomTitles: vi.fn(),
}));

vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => identifyMocks);

const TABS = [
  { href: "apply-patch", icon: null, id: "patcher", label: "Apply Patch" },
  { href: "bundle", icon: null, id: "bundle", label: "Bundles" },
  { href: "create-patch", icon: null, id: "creator", label: "Create Patch" },
  {
    beta: true,
    group: "tools" as const,
    href: "identify-rom",
    icon: null,
    id: "identify",
    label: "Identify ROM",
    placement: "more" as const,
  },
  { href: "test-rom", icon: null, id: "test", label: "Test ROM" },
  {
    beta: true,
    group: "tools" as const,
    href: "trim-rom",
    icon: null,
    id: "trim",
    label: "Trim ROM",
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

beforeEach(() => {
  identifyMocks.lookupExpectedRom.mockReset();
  identifyMocks.searchExpectedRomTitles.mockReset();
});

describe("createFindIndex", () => {
  it("lists tools then app surfaces for browsing, and every setting for search", () => {
    const index = createFindIndex(sources);
    expect(index.browse.map((entry) => entry.id).slice(0, 7)).toEqual([
      "tool:patcher",
      "tool:bundle",
      "tool:creator",
      "tool:identify",
      "tool:test",
      "tool:trim",
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
    expect(kinds[0]).toBe("tool");
    expect(kinds.at(-1)).toBe("guide");
    expect(kinds.indexOf("setting")).toBeLessThan(kinds.indexOf("guide"));
    const identify = searchFind(index, "identify");
    expect(identify[0]?.entry).toMatchObject({
      id: "tool:identify",
      kind: "tool",
      hint: "Match your ROM’s checksum against the local database to find its exact dump name.",
    });
  });

  it("maps browser and CLI command aliases to the matching tool or guide", () => {
    const index = createFindIndex(sources, GUIDES);
    expect(searchFind(index, "weave")[0]?.entry).toMatchObject({ id: "tool:patcher", href: "apply-patch" });
    expect(searchFind(index, "bundle")[0]?.entry).toMatchObject({
      action: { type: "view", view: "bundle" },
      hint: "Build patch bundles and optionally apply them.",
      href: "bundle",
      id: "tool:bundle",
      label: "Bundle Patches",
    });
    expect(searchFind(index, "patch create")[0]?.entry).toMatchObject({ id: "tool:creator", href: "create-patch" });
    expect(searchFind(index, "play emulator")[0]?.entry).toMatchObject({ id: "tool:test" });
    expect(searchFind(index, "bsdiff")[0]?.entry).toMatchObject({ id: "tool:patcher" });
    expect(searchFind(index, "untrim")[0]?.entry).toMatchObject({
      hint: "The CLI can restore padding; the browser Trim page cannot.",
      href: "/docs/cli-trim",
    });
    const inspect = searchFind(index, "inspect").find((result) => result.entry.id === "guide:cli-probe--inspect");
    expect(inspect?.entry).toMatchObject({
      hint: "The CLI can inspect files and calculate checksums.",
      href: "/docs/identify-and-hash-files",
    });
    expect(inspect?.entry.action).toMatchObject({ type: "view", view: "docs" });
    expect(searchFind(index, "extract")[0]?.entry).toMatchObject({
      hint: "The CLI can extract and compress archives.",
      href: "/docs/work-with-archives",
    });
    expect(searchFind(index, "completions")[0]?.entry).toMatchObject({
      hint: "The CLI reference lists this command.",
      href: "/docs/cli",
    });
  });

  it("keeps CLI guide routes inside the self-hosted app base", () => {
    const index = createFindIndex({ ...sources, baseHref: "https://example.com/rom-weaver/" });
    expect(searchFind(index, "inspect")[0]?.entry.href).toBe("/rom-weaver/docs/identify-and-hash-files");
  });

  it("links a guide hit to the guide with the query highlighted", () => {
    const index = createFindIndex(sources, GUIDES);
    const guide = searchFind(index, "mismatch").find((result) => result.entry.kind === "guide");
    expect(guide?.entry.href).toBe("/docs/fix-checksum-errors?highlight=mismatch");
    expect(guide?.entry.hint).toBe("Fix checksum errors");
  });
});

describe("loadIdentifyFindEntries", () => {
  it("searches titles and opens Identify with the selected title", async () => {
    identifyMocks.searchExpectedRomTitles.mockResolvedValueOnce({
      status: "ok",
      titles: [{ name: "Sonic the Hedgehog", platform: "Sega Genesis", slug: "sega-genesis" }],
    });

    await expect(loadIdentifyFindEntries("sonic", "Identify ROM")).resolves.toEqual([
      expect.objectContaining({
        action: { type: "identify", query: "Sonic the Hedgehog" },
        hint: "Identify ROM · Sega Genesis",
        label: "Sonic the Hedgehog",
      }),
    ]);
    expect(identifyMocks.searchExpectedRomTitles).toHaveBeenCalledWith("sonic", {
      limit: 4,
      signal: undefined,
    });
  });

  it("routes an exact checksum and does not search it as a title", async () => {
    identifyMocks.lookupExpectedRom.mockResolvedValueOnce({
      matches: [{ name: "Super Mario Bros. (World)", platform: "Nintendo - NES" }],
      status: "matched",
    });

    await expect(loadIdentifyFindEntries("3337ec46", "Identify ROM")).resolves.toEqual([
      expect.objectContaining({
        action: { type: "identify", query: "3337ec46" },
        hint: "Identify ROM · Nintendo - NES",
        label: "Super Mario Bros. (World)",
      }),
    ]);
    expect(identifyMocks.lookupExpectedRom).toHaveBeenCalledWith(
      { checksums: { crc32: "3337ec46" } },
      { signal: undefined },
    );
    expect(identifyMocks.searchExpectedRomTitles).not.toHaveBeenCalled();
  });

  it("does not treat an incomplete checksum as a title", async () => {
    await expect(loadIdentifyFindEntries("3337ec460", "Identify ROM")).resolves.toEqual([]);
    expect(identifyMocks.lookupExpectedRom).not.toHaveBeenCalled();
    expect(identifyMocks.searchExpectedRomTitles).not.toHaveBeenCalled();
  });
});
