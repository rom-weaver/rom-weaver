import { describe, expect, it } from "vitest";
import {
  normalizePlatformAlias,
  parseIdentifyCatalog,
  resolveCatalogPlatform,
} from "../../src/lib/identify/identify-catalog.ts";

const CATALOG = {
  format: "rom-weaver-identify-catalog-v1",
  generated: { opengoodRevision: "abc123" },
  platforms: [
    {
      aliases: ["playstation", "psx", "ps1", "sony playstation"],
      canonicalPlatform: "Sony PlayStation",
      mediaProfiles: ["redump-cd-track-v1"],
      packFormat: "RWFP2",
      packSha256: "f".repeat(64),
      packSlug: "sony-playstation",
      source: "redump",
    },
    {
      aliases: ["sega mega drive genesis", "genesis", "mega drive"],
      canonicalPlatform: "Sega Mega Drive _ Genesis",
      mediaProfiles: ["opengood-cartridge-v1"],
      packFormat: "RWFP1",
      packSha256: "a".repeat(64),
      packSlug: "sega-mega-drive-genesis",
      source: "opengood",
    },
  ],
};

describe("normalizePlatformAlias", () => {
  it("lowercases, collapses non-alphanumerics, and trims", () => {
    expect(normalizePlatformAlias("  Sega Mega Drive _ Genesis!! ")).toBe("sega mega drive genesis");
    expect(normalizePlatformAlias("PS--1")).toBe("ps 1");
  });
});

describe("parseIdentifyCatalog", () => {
  it("parses a v1 catalog", () => {
    const catalog = parseIdentifyCatalog(CATALOG);
    expect(catalog?.platforms).toHaveLength(2);
    expect(catalog?.platforms[0]?.source).toBe("redump");
  });

  it("rejects an unknown format and malformed platform entries", () => {
    expect(parseIdentifyCatalog({ format: "nope", platforms: [] })).toBeUndefined();
    const catalog = parseIdentifyCatalog({
      format: "rom-weaver-identify-catalog-v1",
      platforms: [{ canonicalPlatform: "X" }, CATALOG.platforms[0]],
    });
    expect(catalog?.platforms).toHaveLength(1);
  });

  it("fails closed on a Redump entry without a verifiable packSha256", () => {
    const redump = { ...CATALOG.platforms[0] };
    const catalog = parseIdentifyCatalog({
      format: "rom-weaver-identify-catalog-v1",
      platforms: [
        { ...redump, packSha256: "" },
        { ...redump, packSlug: "other", packSha256: "not-hex" },
        CATALOG.platforms[1],
      ],
    });
    // Only the OpenGood entry survives. The app must not fetch unverifiable Redump packs.
    expect(catalog?.platforms.map((platform) => platform.packSlug)).toEqual(["sega-mega-drive-genesis"]);
  });
});

describe("resolveCatalogPlatform", () => {
  const catalog = parseIdentifyCatalog(CATALOG);

  it("resolves the canonical name, aliases, and loose formatting case-insensitively", () => {
    for (const name of ["Sony PlayStation", "PSX", "PS1", "sony_playstation"]) {
      expect(resolveCatalogPlatform(catalog, name)?.packSlug).toBe("sony-playstation");
    }
    expect(resolveCatalogPlatform(catalog, "GENESIS")?.packSlug).toBe("sega-mega-drive-genesis");
  });

  it("returns undefined for unknown names and a missing catalog", () => {
    expect(resolveCatalogPlatform(catalog, "Amiga CD32")).toBeUndefined();
    expect(resolveCatalogPlatform(undefined, "psx")).toBeUndefined();
    expect(resolveCatalogPlatform(catalog, "  ")).toBeUndefined();
  });
});
