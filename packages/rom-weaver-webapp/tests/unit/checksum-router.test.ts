import { describe, expect, it } from "vitest";

import {
  buildPackFilter,
  encodeChecksumRouter,
  parseChecksumRouter,
  routeChecksums,
} from "../../src/lib/identify/checksum-router.mjs";

const hex = (algorithm: "crc32" | "md5" | "sha1", seed: number) => {
  const length = algorithm === "crc32" ? 8 : algorithm === "md5" ? 32 : 40;
  return seed
    .toString(16)
    .padStart(4, "0")
    .repeat(length / 4)
    .slice(0, length);
};

const key = (algorithm: "crc32" | "md5" | "sha1", seed: number) => ({ algorithm, hex: hex(algorithm, seed) });

const SHARED = key("md5", 0x4242);
const GB_KEYS = [key("crc32", 1), key("md5", 2), key("sha1", 3), SHARED];
const GBA_KEYS = [key("crc32", 11), key("md5", 12), key("sha1", 13), SHARED];
const EMPTY_SLUG = "sega-32x";

const router = () =>
  parseChecksumRouter(
    encodeChecksumRouter([
      buildPackFilter("nintendo-game-boy", GB_KEYS),
      buildPackFilter("nintendo-game-boy-advance", GBA_KEYS),
      buildPackFilter(EMPTY_SLUG, []),
    ]),
  );

describe("checksum router", () => {
  it("routes every key to the pack that holds it", () => {
    const parsed = router();
    for (const { hex: digest } of GB_KEYS) expect(routeChecksums(parsed, [digest])).toContain("nintendo-game-boy");
    for (const { hex: digest } of GBA_KEYS) {
      expect(routeChecksums(parsed, [digest])).toContain("nintendo-game-boy-advance");
    }
  });

  it("routes a key held by two packs to both", () => {
    expect(routeChecksums(router(), [SHARED.hex]).sort()).toEqual(["nintendo-game-boy", "nintendo-game-boy-advance"]);
  });

  it("never routes to a pack that holds no keys", () => {
    const parsed = router();
    const digests = [...GB_KEYS, ...GBA_KEYS, key("crc32", 999)].map(({ hex: digest }) => digest);
    for (const digest of digests) expect(routeChecksums(parsed, [digest])).not.toContain(EMPTY_SLUG);
  });

  it("routes an absent key of each algorithm to nothing beyond a false positive", () => {
    const parsed = router();
    const known = new Set(["nintendo-game-boy", "nintendo-game-boy-advance"]);
    for (const algorithm of ["crc32", "md5", "sha1"] as const) {
      for (let seed = 0x900; seed < 0x920; seed += 1) {
        // A binary fuse filter answers "maybe" for about 1 in 256 absent keys,
        // so only the slug set may be asserted, never a miss.
        for (const slug of routeChecksums(parsed, [hex(algorithm, seed)])) expect(known.has(slug)).toBe(true);
      }
    }
  });

  it("ignores a digest whose length matches no algorithm", () => {
    expect(routeChecksums(router(), ["abc", ""])).toEqual([]);
  });

  it("builds the same bytes from the same keys", () => {
    expect(encodeChecksumRouter([buildPackFilter("a", GB_KEYS)])).toEqual(
      encodeChecksumRouter([buildPackFilter("a", GB_KEYS)]),
    );
  });

  it("rejects corrupt magic, truncated bytes, trailing bytes, and a bad segment layout", () => {
    const bytes = encodeChecksumRouter([buildPackFilter("nintendo-game-boy", GB_KEYS)]);
    const badMagic = bytes.slice();
    badMagic[0] = 0;
    expect(() => parseChecksumRouter(badMagic)).toThrow(/bad magic/u);
    expect(() => parseChecksumRouter(bytes.slice(0, bytes.length - 4))).toThrow(/checksum router is invalid/u);
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes, 0);
    expect(() => parseChecksumRouter(trailing)).toThrow(/trailing bytes/u);

    // segmentLength sits after the magic, pack count, slug header, key count and seed.
    const badLayout = bytes.slice();
    const slugLength = new DataView(badLayout.buffer, badLayout.byteOffset).getUint16(12, true);
    const segmentLengthOffset = 14 + slugLength + 4 + 8;
    new DataView(badLayout.buffer, badLayout.byteOffset).setUint32(segmentLengthOffset, 3, true);
    expect(() => parseChecksumRouter(badLayout)).toThrow(/segment length/u);
    const bigSegments = bytes.slice();
    new DataView(bigSegments.buffer, bigSegments.byteOffset).setUint32(segmentLengthOffset + 4, 1 << 20, true);
    expect(() => parseChecksumRouter(bigSegments)).toThrow(/segment layout/u);
  });
});
