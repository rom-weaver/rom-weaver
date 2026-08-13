import { describe, expect, it } from "vitest";
import { parseIngestResult } from "../../src/lib/runtime/ingest-result.ts";

/**
 * `parseIngestResult` coerces the `details.ingest` wire payload (snake_case, the verbatim
 * `IngestResult` serialization) into the camelCase, `number`-based shape the apply workflow consumes.
 * These cases lock the coercion so the generated-type binding stays a pure type-safety tightening.
 */

describe("parseIngestResult", () => {
  it("returns undefined for a missing or malformed payload", () => {
    expect(parseIngestResult(undefined)).toBeUndefined();
    expect(parseIngestResult({})).toBeUndefined();
    expect(parseIngestResult({ ingest: { kind: "bogus" } })).toBeUndefined();
  });

  it("coerces a ROM source with a checksummed asset", () => {
    const parsed = parseIngestResult({
      ingest: {
        assets: [
          {
            checksum_variants: [{ checksums: { CRC32: "DEADBEEF" }, id: "raw", label: "Raw" }],
            checksums: { CRC32: "deadbeef" },
            copied_in_place: true,
            file_name: "game.gba",
            identification: {
              matches: [
                {
                  algorithm: "sha1",
                  database: "nintendo-game-boy-advance.pack",
                  name: "Game (USA)",
                  platform: "Game Boy Advance",
                  variant: "raw",
                },
              ],
              status: "matched",
            },
            kind: "rom",
            path: "/work/game.gba",
            platform: "Game Boy Advance",
            size_bytes: 4194304,
          },
        ],
        is_rom: true,
        kind: "rom",
        patches: [],
        source_file_name: "game.gba",
      },
    });
    expect(parsed?.kind).toBe("rom");
    expect(parsed?.isRom).toBe(true);
    expect(parsed?.sourceFileName).toBe("game.gba");
    expect(parsed?.assets).toHaveLength(1);
    const asset = parsed?.assets[0];
    expect(asset?.path).toBe("/work/game.gba");
    expect(asset?.fileName).toBe("game.gba");
    expect(asset?.sizeBytes).toBe(4194304);
    expect(asset?.copiedInPlace).toBe(true);
    expect(asset?.kind).toBe("rom");
    expect(asset?.platform).toBe("Game Boy Advance");
    expect(asset?.identification).toEqual({
      matches: [
        {
          algorithm: "sha1",
          database: "nintendo-game-boy-advance.pack",
          name: "Game (USA)",
          platform: "Game Boy Advance",
          variant: "raw",
        },
      ],
      status: "matched",
    });
    expect(asset?.checksums).toEqual({ crc32: "deadbeef" });
    expect(asset?.checksumVariants[0]?.id).toBe("raw");
  });

  it("maps extract_time_ms and disc structure for an extracted nested leaf", () => {
    const parsed = parseIngestResult({
      ingest: {
        assets: [
          {
            checksum_variants: [],
            checksums: { CRC32: "feedface" },
            copied_in_place: false,
            disc_format: "CD-ROM",
            disc_group_id: "disc-1",
            extract_time_ms: 1234,
            file_name: "game (Track 1).bin",
            kind: "bin",
            path: "/work/game (Track 1).bin",
            size_bytes: 734003200,
            track_number: 1,
          },
        ],
        is_rom: true,
        kind: "rom",
        patches: [],
        source_file_name: "game.chd",
      },
    });
    const asset = parsed?.assets[0];
    expect(asset?.copiedInPlace).toBe(false);
    expect(asset?.extractTimeMs).toBe(1234);
    expect(asset?.discFormat).toBe("CD-ROM");
    expect(asset?.discGroupId).toBe("disc-1");
    expect(asset?.trackNumber).toBe(1);
    // No bare-ROM in-place hashing happened, so the checksum sentinel stays absent.
    expect(asset?.checksumMs).toBeUndefined();
  });

  it("keeps valid compact lookup states and drops a malformed state", () => {
    const makeAsset = (path: string, identification: unknown) => ({
      checksum_variants: [],
      checksums: {},
      copied_in_place: true,
      file_name: path,
      identification,
      path: `/work/${path}`,
      size_bytes: 1,
    });
    const match = {
      algorithm: "md5",
      database: "test.pack",
      name: "Test ROM",
      platform: "Test System",
      variant: "raw",
    };
    const parsed = parseIngestResult({
      ingest: {
        assets: [
          makeAsset("unknown.bin", { matches: [], status: "unknown" }),
          makeAsset("ambiguous.bin", { matches: [match, { ...match, name: "Other ROM" }], status: "ambiguous" }),
          makeAsset("malformed.bin", { matches: [match], status: "invalid" }),
        ],
        is_rom: true,
        kind: "rom",
        patches: [],
        source_file_name: "roms.zip",
      },
    });

    expect(parsed?.assets[0]?.identification).toEqual({ matches: [], status: "unknown" });
    expect(parsed?.assets[1]?.identification?.status).toBe("ambiguous");
    expect(parsed?.assets[1]?.identification?.matches).toHaveLength(2);
    expect(parsed?.assets[2]?.identification).toBeUndefined();
  });

  it("coerces a patch source descriptor with embedded metadata", () => {
    const parsed = parseIngestResult({
      ingest: {
        assets: [],
        is_rom: false,
        kind: "patch",
        patches: [
          {
            file_name: "hack.bps",
            filename_checksums: { CRC32: "abcd1234" },
            format: "BPS",
            is_valid_patch: true,
            leaf_path: "/work/hack.bps",
            size_bytes: 2048,
            source_crc32: 305419896,
            source_identification: {
              matches: [
                {
                  algorithm: "crc32",
                  database: "nintendo-game-boy-advance.pack",
                  name: "Game (USA)",
                  platform: "Game Boy Advance",
                  variant: "source",
                },
              ],
              status: "matched",
            },
            source_checksum_variants: [{ MD5: "1234567890abcdef1234567890abcdef" }],
            target_size: 8388608,
          },
        ],
        source_file_name: "hack.bps",
      },
    });
    expect(parsed?.kind).toBe("patch");
    expect(parsed?.isRom).toBe(false);
    expect(parsed?.patches).toHaveLength(1);
    const patch = parsed?.patches[0];
    expect(patch?.leafPath).toBe("/work/hack.bps");
    expect(patch?.fileName).toBe("hack.bps");
    expect(patch?.format).toBe("BPS");
    expect(patch?.isValidPatch).toBe(true);
    expect(patch?.sizeBytes).toBe(2048);
    expect(patch?.sourceCrc32).toBe(305419896);
    expect(patch?.targetSize).toBe(8388608);
    expect(patch?.filenameChecksums).toEqual({ crc32: "abcd1234" });
    expect(patch?.sourceIdentification?.status).toBe("matched");
    expect(patch?.sourceIdentification?.matches[0]?.variant).toBe("source");
    expect(patch?.sourceChecksumVariants).toEqual([{ md5: "1234567890abcdef1234567890abcdef" }]);
  });
});
