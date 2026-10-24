import { describe, expect, it, vi } from "vitest";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import {
  type ComputedChecksums,
  resolveWeaveRomAsset,
  verifyWeaveRom,
} from "../../src/lib/workflow/apply-weave-rom-check.ts";

const asset = (overrides: Partial<InputAsset>): InputAsset =>
  ({
    fileName: "game.bin",
    file: {},
    id: "rom",
    kind: "rom",
    patchable: true,
    size: 16,
    ...overrides,
  }) as InputAsset;

const rom = asset({ checksums: { crc32: "11111111", sha1: "aaaa" } });
const track = asset({
  checksums: { crc32: "22222222" },
  file: {} as InputAsset["file"],
  id: "track",
  member: "track02.bin",
  patchable: false,
});

describe("resolveWeaveRomAsset", () => {
  it("uses the rom.member asset, else the primary input asset", () => {
    expect(resolveWeaveRomAsset([track, rom], undefined)).toBe(rom);
    expect(resolveWeaveRomAsset([rom, track], "track02.bin")).toBe(track);
    expect(resolveWeaveRomAsset([rom, track], "track09.bin")).toBeUndefined();
  });

  it("treats a bare file as the rom.member a weave names", () => {
    expect(resolveWeaveRomAsset([rom], "track02.bin")).toBe(rom);
  });
});

describe("verifyWeaveRom", () => {
  it("compares rom.checks with the member the weave names", async () => {
    const compute = vi.fn(async () => ({ checksums: {} }));
    const assets = [rom, track];
    await expect(
      verifyWeaveRom({ checks: "crc32=22222222", member: "track02.bin" }, assets, new WeakMap(), compute),
    ).resolves.toMatchObject({ assetId: "track", status: "match" });
    await expect(
      verifyWeaveRom({ checks: "crc32=11111111", member: "track02.bin" }, assets, new WeakMap(), compute),
    ).resolves.toMatchObject({ assetId: "track", status: "mismatch" });
    await expect(
      verifyWeaveRom({ checks: "crc32=22222222", member: "track09.bin" }, assets, new WeakMap(), compute),
    ).resolves.toMatchObject({ message: expect.stringContaining("track09.bin"), status: "mismatch" });
    expect(compute).not.toHaveBeenCalled();
  });

  it("hashes declared algorithms staging did not compute, once per file", async () => {
    const compute = vi.fn(async () => ({ checksums: { sha256: "BEEF" } }));
    const computed = new WeakMap<object, ComputedChecksums>();
    await expect(verifyWeaveRom({ checks: "sha256=beef" }, [rom], computed, compute)).resolves.toMatchObject({
      missing: [],
      status: "match",
    });
    await expect(verifyWeaveRom({ checks: "sha256=cafe" }, [rom], computed, compute)).resolves.toMatchObject({
      status: "mismatch",
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith(rom, ["sha256"]);
  });

  it("does not compute when a staged checksum already mismatches", async () => {
    const compute = vi.fn(async () => ({ checksums: { sha256: "beef" } }));
    await expect(
      verifyWeaveRom({ checks: "crc32=99999999,sha256=beef" }, [rom], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "mismatch" });
    expect(compute).not.toHaveBeenCalled();
  });

  it("rethrows a transient hashing failure without caching, so a retry hashes again", async () => {
    const computed = new WeakMap<object, ComputedChecksums>();
    const compute = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker crashed"))
      .mockResolvedValueOnce({ checksums: { sha256: "beef" } });
    await expect(verifyWeaveRom({ checks: "sha256=beef" }, [rom], computed, compute)).rejects.toThrow("worker crashed");
    await expect(verifyWeaveRom({ checks: "sha256=beef" }, [rom], computed, compute)).resolves.toMatchObject({
      status: "match",
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("fails verification for an algorithm that cannot be computed", async () => {
    const verdict = await verifyWeaveRom({ checks: "crc32=11111111,blake9=00" }, [rom], new WeakMap(), async () => ({
      checksums: { blake9: "" },
    }));
    expect(verdict).toMatchObject({ missing: ["blake9"], status: "mismatch" });
    expect(verdict.message).toBe(
      "The weave's ROM blake9 checksum cannot be computed here, so the ROM cannot be verified",
    );
  });

  // A weave recorded from the headerless .sfc or the big-endian .z64 still accepts the user's
  // headered or byte-swapped dump through the staged checksum variants.
  const headered = asset({
    checksumVariants: [
      { checksums: { crc32: "33333333", sha1: "cccc" }, id: "base", label: "Original" },
      {
        applyCompatibility: { removeHeader: true, strip_header: true },
        checksums: { crc32: "44444444", sha1: "dddd" },
        id: "remove-header",
        label: "Header removed",
        transforms: { removeHeader: { strippedBytes: 512 } },
      },
      {
        applyCompatibility: { fixChecksum: true },
        checksums: { crc32: "55555555", sha1: "eeee" },
        id: "fix-header",
        label: "Header fixed",
      },
    ],
    checksums: { crc32: "33333333", sha1: "cccc" },
    size: 1024 + 512,
  });
  const byteSwapped = asset({
    checksumVariants: [
      {
        applyCompatibility: { n64ByteOrder: "z64", n64_byte_order: "z64" },
        checksums: { crc32: "66666666" },
        id: "n64-byte-order:z64",
        label: "N64 byte order: z64",
      },
    ],
    checksums: { crc32: "77777777" },
    size: 4096,
  });

  it("accepts a header-stripped or N64 byte-order variant when the raw file does not match", async () => {
    const compute = vi.fn(async () => ({ checksums: {} }));
    await expect(
      verifyWeaveRom({ checks: "crc32=44444444,sha1=dddd,size=1024" }, [headered], new WeakMap(), compute),
    ).resolves.toEqual({ assetId: "rom", missing: [], status: "match", variant: "remove-header" });
    await expect(
      verifyWeaveRom({ checks: "crc32=66666666,size=4096" }, [byteSwapped], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "match", variant: "n64-byte-order:z64" });
    // The raw file still matches on its own, with no variant.
    await expect(
      verifyWeaveRom({ checks: "crc32=33333333,size=1536" }, [headered], new WeakMap(), compute),
    ).resolves.toEqual({ assetId: "rom", missing: [], status: "match" });
  });

  it("rejects a variant that misses the declared size, an undeclared algorithm, or is not a header or byte-order transform", async () => {
    const compute = vi.fn(async () => ({ checksums: {} }));
    // The stripped variant is 1024 bytes, not the headered file's 1536.
    await expect(
      verifyWeaveRom({ checks: "crc32=44444444,size=1536" }, [headered], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "mismatch" });
    // The variant carries no sha256, so it cannot answer every declared algorithm.
    await expect(
      verifyWeaveRom({ checks: "crc32=44444444,sha256=beef" }, [headered], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "mismatch" });
    // A checksum-repair variant changes the ROM's content, so it never stands in for the file.
    await expect(
      verifyWeaveRom({ checks: "crc32=55555555" }, [headered], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "mismatch" });
  });

  it("hashes the variants with an on-demand algorithm once per file when the raw file does not match", async () => {
    const compute = vi.fn(async () => ({
      checksums: { sha256: "0000" },
      variants: [
        { checksums: { sha256: "0000" }, id: "base", label: "Original" },
        { checksums: { sha256: "beef" }, id: "remove-header", label: "Header removed" },
        { checksums: { sha256: "1111" }, id: "fix-header", label: "Header fixed" },
      ],
    }));
    const computed = new WeakMap<object, ComputedChecksums>();
    // The headered raw file fails on size before any hashing; only the variants need sha256.
    await expect(verifyWeaveRom({ checks: "sha256=beef,size=1024" }, [headered], computed, compute)).resolves.toEqual({
      assetId: "rom",
      missing: [],
      status: "match",
      variant: "remove-header",
    });
    await expect(
      verifyWeaveRom({ checks: "sha256=cafe,size=1024" }, [headered], computed, compute),
    ).resolves.toMatchObject({ status: "mismatch" });
    // A checksum-repair variant never stands in for the file, even with a hashed match.
    await expect(verifyWeaveRom({ checks: "sha256=1111" }, [headered], computed, compute)).resolves.toMatchObject({
      status: "mismatch",
    });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledWith(headered, ["sha256"]);
  });

  it("reuses variant hashes from the raw on-demand pass for a same-size byte-swapped dump", async () => {
    const compute = vi.fn(async () => ({
      checksums: { sha256: "0000" },
      variants: [{ checksums: { sha256: "beef" }, id: "n64-byte-order:z64", label: "N64 byte order: z64" }],
    }));
    await expect(
      verifyWeaveRom({ checks: "sha256=beef,size=4096" }, [byteSwapped], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "match", variant: "n64-byte-order:z64" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not rehash variants for an algorithm that could not be computed", async () => {
    const compute = vi.fn(async () => ({ checksums: {} }));
    const computed = new WeakMap<object, ComputedChecksums>();
    for (let pass = 0; pass < 2; pass += 1)
      await expect(
        verifyWeaveRom({ checks: "sha256=beef,size=1024" }, [headered], computed, compute),
      ).resolves.toMatchObject({ status: "mismatch" });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("rethrows a transient variant hashing failure without caching", async () => {
    const computed = new WeakMap<object, ComputedChecksums>();
    const compute = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker crashed"))
      .mockResolvedValueOnce({
        checksums: {},
        variants: [{ checksums: { sha256: "beef" }, id: "remove-header", label: "Header removed" }],
      });
    const expectation = { checks: "sha256=beef,size=1024" };
    await expect(verifyWeaveRom(expectation, [headered], computed, compute)).rejects.toThrow("worker crashed");
    await expect(verifyWeaveRom(expectation, [headered], computed, compute)).resolves.toMatchObject({
      status: "match",
      variant: "remove-header",
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
