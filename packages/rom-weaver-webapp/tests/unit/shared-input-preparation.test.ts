import { describe, expect, it, vi } from "vitest";
import { attachPatchFileCleanup, createOutputFile, getPatchFileCleanup } from "../../src/lib/input/binary-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { shouldIdentifySource, skipSourceIdentification } from "../../src/lib/input/input-identification-policy.ts";
import { SharedInputPreparationCache } from "../../src/lib/workflow/shared-input-preparation.ts";

const createAssets = (names: string[], cleanups: Array<() => Promise<void> | void>, sidecar = false): InputAsset[] =>
  names.map((name, index) => {
    const file = createOutputFile(new Uint8Array([index]), name);
    attachPatchFileCleanup(file, cleanups[index]);
    return {
      checksums: { crc32: "00" },
      file,
      fileName: name,
      id: `asset-${index}`,
      kind: "rom",
      patchable: true,
      size: 1,
      ...(sidecar ? { sidecarPatches: [{ file, parentCompressions: [] }] } : {}),
    };
  });

const release = async (assets: InputAsset[]) => {
  for (const asset of assets) await getPatchFileCleanup(asset.file)?.();
};

describe("SharedInputPreparationCache", () => {
  it("deletes the prepared copy only after the last holder releases it", async () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const cleanup = vi.fn(async () => undefined);
    const first = cache.adopt(source, "k", createAssets(["rom.bin"], [cleanup]));
    const second = cache.lease(source, "k");
    expect(second).not.toBeNull();

    await release(first);
    expect(cleanup).not.toHaveBeenCalled();
    await release(second as InputAsset[]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("hands each holder its own asset objects", () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const first = cache.adopt(source, "k", createAssets(["rom.bin"], [vi.fn(async () => undefined)]));
    const second = cache.lease(source, "k") as InputAsset[];

    (first[0] as InputAsset).checksums = { crc32: "ff" };
    expect(second[0]?.checksums).toEqual({ crc32: "00" });
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.file).not.toBe(first[0]?.file);
  });

  it("keeps the metadata and precomputed state ingest attached to the prepared file", () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const assets = createAssets(["rom.bin"], [vi.fn(async () => undefined)]);
    const prepared = (assets[0] as InputAsset).file as Record<string, unknown>;
    const identification = { matches: [], status: "unavailable" };
    const identifyRetry = Promise.resolve(true);
    Object.assign(prepared, {
      checksums: { crc32: "a", md5: "b", sha1: "c" },
      checksumVariants: [{ label: "headerless" }],
      identification,
      identifyRetry,
      metadata: { cueText: "FILE", format: "GD-ROM" },
      romType: "gba",
      _precomputedChecksumMs: 7,
    });
    skipSourceIdentification(prepared);

    for (const held of [cache.adopt(source, "k", assets), cache.lease(source, "k") as InputAsset[]]) {
      const file = (held[0] as InputAsset).file as Record<string, unknown>;
      expect(file).toMatchObject({
        checksums: { crc32: "a", md5: "b", sha1: "c" },
        checksumVariants: [{ label: "headerless" }],
        identification,
        identifyRetry,
        metadata: { cueText: "FILE", format: "GD-ROM" },
        romType: "gba",
        _precomputedChecksumMs: 7,
      });
      expect(shouldIdentifySource(file)).toBe(false);
    }
  });

  it("does not lease an entry after any of its assets was fully released", async () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const cleanups = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    const held = cache.adopt(source, "k", createAssets(["a.bin", "b.bin"], cleanups));

    await getPatchFileCleanup((held[0] as InputAsset).file)?.();
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
    expect(cache.lease(source, "k")).toBeNull();
    expect(cleanups[1]).not.toHaveBeenCalled();
    await getPatchFileCleanup((held[1] as InputAsset).file)?.();
    expect(cleanups[1]).toHaveBeenCalledTimes(1);
  });

  it("counts a release once even when it is invoked repeatedly", async () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const cleanup = vi.fn(async () => undefined);
    const first = cache.adopt(source, "k", createAssets(["rom.bin"], [cleanup]));
    const second = cache.lease(source, "k") as InputAsset[];

    await release(first);
    await release(first);
    expect(cleanup).not.toHaveBeenCalled();
    await release(second);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps the first preparation and releases a duplicate that finished later", async () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    const winner = vi.fn(async () => undefined);
    const loser = vi.fn(async () => undefined);
    const first = cache.adopt(source, "k", createAssets(["rom.bin"], [winner]));
    const second = cache.adopt(source, "k", createAssets(["rom.bin"], [loser]));

    await vi.waitFor(() => expect(loser).toHaveBeenCalledTimes(1));
    expect(winner).not.toHaveBeenCalled();
    await release(first);
    await release(second);
    expect(winner).toHaveBeenCalledTimes(1);
  });

  it("keys by source object and key, and does not share assets that carry sidecar patches", () => {
    const cache = new SharedInputPreparationCache();
    const source = {};
    cache.adopt(source, "k", createAssets(["rom.bin"], [vi.fn(async () => undefined)]));
    expect(cache.lease(source, "other")).toBeNull();
    expect(cache.lease({}, "k")).toBeNull();

    const withSidecar = createAssets(["rom.bin"], [vi.fn(async () => undefined)], true);
    expect(cache.adopt({}, "k", withSidecar)).toBe(withSidecar);
    expect(cache.lease("not-an-object", "k")).toBeNull();
  });
});
