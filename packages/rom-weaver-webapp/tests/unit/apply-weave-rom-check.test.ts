import { describe, expect, it, vi } from "vitest";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { resolveWeaveRomAsset, verifyWeaveRom } from "../../src/lib/workflow/apply-weave-rom-check.ts";

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
    expect(resolveWeaveRomAsset([rom], "track09.bin")).toBeUndefined();
  });
});

describe("verifyWeaveRom", () => {
  it("compares rom.checks with the member the weave names", async () => {
    const compute = vi.fn(async () => ({}));
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
    const compute = vi.fn(async () => ({ sha256: "BEEF" }));
    const computed = new WeakMap<object, Record<string, string>>();
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
    const compute = vi.fn(async () => ({ sha256: "beef" }));
    await expect(
      verifyWeaveRom({ checks: "crc32=99999999,sha256=beef" }, [rom], new WeakMap(), compute),
    ).resolves.toMatchObject({ status: "mismatch" });
    expect(compute).not.toHaveBeenCalled();
  });

  it("fails verification for an algorithm that cannot be computed", async () => {
    const verdict = await verifyWeaveRom({ checks: "crc32=11111111,blake9=00" }, [rom], new WeakMap(), async () => ({
      blake9: "",
    }));
    expect(verdict).toMatchObject({ missing: ["blake9"], status: "mismatch" });
    expect(verdict.message).toBe(
      "The weave's ROM blake9 checksum cannot be computed here, so the ROM cannot be verified",
    );
  });
});
