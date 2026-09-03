import { describe, expect, it } from "vitest";
import {
  parseIdentifyCommandResult,
  parseIngestResult,
  parsePatchDescriptor,
} from "../../src/lib/runtime/ingest-result.ts";

const richMatch = {
  algorithm: "sha1",
  alternate_names: ["Alias", 42, ""],
  database: "game.pack",
  disc_number: 2,
  dump_tags: ["verified", null, ""],
  expected_components: [
    {},
    {
      crc32: "aabbccdd",
      filename: "track.bin",
      hash_scope: "payload",
      md5: "0123456789abcdef0123456789abcdef",
      ordinal: 1,
      role: "track",
      sha1: "0123456789012345678901234567890123456789",
      sha256: "0123456789012345678901234567890123456789012345678901234567890123",
      size: 128,
    },
  ],
  game_id: "SLUS-12345",
  language: "en",
  legacy_variant: true,
  name: "Example Game",
  parent: "Example Series",
  platform: "PlayStation",
  provenance: [{ source: "redump", source_commit: "abc", source_name: "Redump", source_url: "https://redump.org" }],
  region: "USA",
  revision: "1.1",
  variant: "redump",
};

describe("ingest result rich wire fields", () => {
  it("parses every optional identify match and evidence extension", () => {
    const parsed = parseIngestResult({
      ingest: {
        assets: [
          {
            checksum_variants: [{ checksums: { CRC32: "AABBCCDD" }, id: "raw", label: "Raw" }],
            checksums: { CRC32: "AABBCCDD", EMPTY: "", MD5: "0123456789abcdef0123456789abcdef" },
            copied_in_place: false,
            file_name: "game.bin",
            identification: {
              condition: "unsupported_media_profile",
              database: {
                canonicalization_profile: "redump-v2",
                pack_format: "RWFP1",
                source: "redump",
              },
              evidence: {
                layout_matched: true,
                missing: ["track 2", 8],
                required_components_matched: 1,
                required_components_total: 2,
                unexpected: ["bonus"],
              },
              hint: "Use a supported dump",
              matches: [richMatch],
              platform_candidates: [
                { confidence: "high", evidence: { kind: "header_magic", value: "PS-X EXE" }, platform: "PlayStation" },
                { confidence: "low", evidence: { kind: "serial" }, platform: "Other" },
                { confidence: "none", evidence: {}, platform: "" },
              ],
              quality: "partial",
              status: "matched",
            },
            kind: "track",
            path: "/work/game.bin",
            platform: "PlayStation",
            recommended_format: "chd",
            size_bytes: 128,
          },
        ],
        is_rom: true,
        kind: "rom",
        patches: [
          {
            file_name: "update.ips",
            filename_checksums: { CRC32: "FFEEDDCC" },
            format: "IPS",
            is_valid_patch: false,
            leaf_path: "/work/update.ips",
            minimum_source_size: 64,
            patch_crc32: 123,
            record_count: 4,
            sidecar_order: 1,
            size_bytes: 16,
            source_crc32: 456,
            source_identification: { matches: [], status: "unknown" },
            source_size: 128,
            source_checksum_variants: [{ SHA1: "0123456789012345678901234567890123456789" }, { empty: "" }],
            target_crc32: 789,
            target_size: 256,
            filename_size: 8,
          },
        ],
        source_file_name: "game.zip",
      },
    });

    expect(parsed).toMatchObject({
      isRom: true,
      kind: "rom",
      sourceFileName: "game.zip",
      patches: [
        {
          filenameSize: 8,
          minimumSourceSize: 64,
          patchCrc32: 123,
          recordCount: 4,
          sidecarOrder: 1,
          sourceCrc32: 456,
          sourceSize: 128,
          targetCrc32: 789,
          targetSize: 256,
        },
      ],
    });
    expect(parsed?.assets[0]).toMatchObject({
      checksumVariants: [{ checksums: { crc32: "aabbccdd" }, id: "raw", label: "Raw" }],
      checksums: { crc32: "AABBCCDD", md5: "0123456789abcdef0123456789abcdef" },
      fileName: "game.bin",
      recommendedFormat: "chd",
    });
    expect(parsed?.assets[0]?.identification).toMatchObject({
      condition: "unsupported_media_profile",
      database: { canonicalizationProfile: "redump-v2", packFormat: "RWFP1", source: "redump" },
      evidence: {
        layoutMatched: true,
        missing: ["track 2"],
        requiredComponentsMatched: 1,
        requiredComponentsTotal: 2,
        unexpected: ["bonus"],
      },
      hint: "Use a supported dump",
      platformCandidates: [
        { confidence: "high", evidence: "header_magic: PS-X EXE", platform: "PlayStation" },
        { confidence: "low", evidence: "serial", platform: "Other" },
      ],
      quality: "partial",
    });
    expect(parsed?.assets[0]?.identification?.matches[0]).toMatchObject({
      alternateNames: ["Alias"],
      discNumber: 2,
      dumpTags: ["verified"],
      expectedComponents: [
        {
          crc32: "aabbccdd",
          filename: "track.bin",
          hashScope: "payload",
          ordinal: 1,
          role: "track",
          size: 128,
        },
      ],
      gameId: "SLUS-12345",
      language: "en",
      legacyVariant: true,
      parent: "Example Series",
      provenance: [{ source: "redump", sourceCommit: "abc", sourceName: "Redump" }],
      region: "USA",
      revision: "1.1",
    });
  });

  it("parses identify command results and rejects invalid lookup cardinality", () => {
    const details = {
      identify: {
        checksum_variants: [{ checksums: { SHA1: "ABC" }, id: "headerless", label: "Headerless" }],
        checksums: { CRC32: "AABBCCDD" },
        input: "game.gba",
        matches: [richMatch, { ...richMatch, name: "Other Game" }],
        status: "ambiguous",
      },
    };
    expect(parseIdentifyCommandResult(details)).toMatchObject({
      checksumVariants: [{ checksums: { sha1: "abc" }, id: "headerless", label: "Headerless" }],
      checksums: { crc32: "AABBCCDD" },
      input: "game.gba",
      matches: [{ name: "Example Game" }, { name: "Other Game" }],
      status: "ambiguous",
    });
    expect(parseIdentifyCommandResult({ identify: { matches: [], status: "invalid" } })).toBeUndefined();
    expect(
      parseIngestResult({ ingest: { assets: [], kind: "rom", matches: [], patches: [], status: "matched" } }),
    ).toMatchObject({
      assets: [],
      kind: "rom",
      patches: [],
    });
  });

  it("drops malformed patch descriptors and preserves valid descriptor defaults", () => {
    expect(parsePatchDescriptor(undefined)).toBeUndefined();
    expect(parsePatchDescriptor({ leaf_path: "" })).toBeUndefined();
    expect(parsePatchDescriptor({ leaf_path: "/work/fallback.ips" })).toEqual({
      fileName: "/work/fallback.ips",
      filenameChecksums: {},
      format: "unknown",
      isValidPatch: false,
      leafPath: "/work/fallback.ips",
      sizeBytes: 0,
    });
  });
});
