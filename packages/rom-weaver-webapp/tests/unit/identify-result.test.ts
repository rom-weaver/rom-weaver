import { describe, expect, it } from "vitest";
import { parseIdentifyResult } from "../../src/lib/runtime/identify-result.ts";

describe("parseIdentifyResult", () => {
  it("rejects a missing or malformed payload", () => {
    expect(parseIdentifyResult(undefined)).toBeUndefined();
    expect(parseIdentifyResult({})).toBeUndefined();
    expect(parseIdentifyResult({ identify: { input: "game.nes", status: "invalid" } })).toBeUndefined();
  });

  it("normalizes a matched title and checksum variants", () => {
    expect(
      parseIdentifyResult({
        identify: {
          checksum_variants: [
            {
              checksums: { CRC32: "deadbeef", SHA1: "a".repeat(40) },
              id: "raw",
              label: "Raw",
            },
          ],
          checksums: { CRC32: "deadbeef" },
          detected_platform: "Nintendo Entertainment System",
          input: "/work/game.nes",
          matches: [
            {
              algorithm: "crc32",
              database: "nintendo-entertainment-system.pack",
              name: "Game (USA) [!]",
              platform: "Nintendo Entertainment System",
              variant: "raw",
            },
          ],
          status: "matched",
        },
      }),
    ).toEqual({
      checksumVariants: [
        {
          checksums: { crc32: "deadbeef", sha1: "a".repeat(40) },
          id: "raw",
          label: "Raw",
        },
      ],
      checksums: { crc32: "deadbeef" },
      detectedPlatform: "Nintendo Entertainment System",
      input: "/work/game.nes",
      matches: [
        {
          algorithm: "crc32",
          database: "nintendo-entertainment-system.pack",
          name: "Game (USA) [!]",
          platform: "Nintendo Entertainment System",
          variant: "raw",
        },
      ],
      status: "matched",
    });
  });

  it("keeps a valid unknown result without matches", () => {
    expect(
      parseIdentifyResult({
        identify: {
          checksum_variants: [],
          checksums: {},
          input: "unknown.bin",
          matches: [],
          status: "unknown",
        },
      }),
    ).toMatchObject({ input: "unknown.bin", matches: [], status: "unknown" });
  });
});
