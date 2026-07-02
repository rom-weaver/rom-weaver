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
    expect(asset?.checksums).toEqual({ crc32: "deadbeef" });
    expect(asset?.checksumVariants[0]?.id).toBe("raw");
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
  });
});
