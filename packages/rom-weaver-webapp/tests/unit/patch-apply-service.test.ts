import { describe, expect, it, vi } from "vitest";
import {
  attachIngestPatchRequirements,
  getPatchProbeRequirements,
  inheritIngestPatchRequirements,
  parsePatchForApply,
  patchProbeRequirementsFromDescriptor,
  resolvePatchTargets,
} from "../../src/lib/apply/patch-apply-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { createLazyExternalPatchFile } from "../../src/lib/input/binary-service.ts";

const asset = (id: string, fileName: string, member?: string): InputAsset =>
  ({
    file: { fileName, fileSize: 1 },
    fileName,
    id,
    ...(member ? { member } : {}),
    kind: "rom",
    patchable: true,
    size: 1,
  }) as unknown as InputAsset;

const patch = (matches: string[]) => ({
  apply: vi.fn(),
  validateSourceAsync: vi.fn(async (file: { fileName: string }) => matches.includes(file.fileName)),
});

describe("resolvePatchTargets checksum auto-targeting", () => {
  it("selects the only matching patchable input", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["second.bin"])], undefined)).resolves.toEqual([second]);
  });

  it("rejects an ambiguous checksum match", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["first.bin", "second.bin"])], undefined)).rejects.toThrow(
      "matches multiple inputs",
    );
  });

  it("rejects when no input matches", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch([])], undefined)).rejects.toThrow(
      "does not match exactly one input",
    );
  });

  it("routes an imported ROM member to the exact asset", async () => {
    const first = asset("first", "track01.bin", "disc-a:1");
    const second = asset("second", "track02.bin", "disc-a:2");
    await expect(
      resolvePatchTargets([first, second], [patch([])], undefined, [{ rom: true, member: "disc-a:2" }], ["patch-a"]),
    ).resolves.toEqual([second]);
  });

  it("does not guess a duplicate basename for a nested member", async () => {
    const first = asset("first", "track.bin", "disc-a/track.bin");
    const second = asset("second", "track.bin", "disc-b/track.bin");
    await expect(
      resolvePatchTargets([first, second], [patch([])], undefined, [{ rom: true, member: "disc-b/track.bin" }]),
    ).resolves.toEqual([second]);
  });

  it("routes a named patch input to the producer's ROM target", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    const patches = [patch(["first.bin"]), patch([])];
    await expect(
      resolvePatchTargets(
        [first, second],
        patches,
        undefined,
        [{ rom: true }, { patch: "patch-a" }],
        ["patch-a", "patch-b"],
      ),
    ).resolves.toEqual([first, first]);
  });

  it("routes a producer target with its producer despite a different fixed input", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    const patches = [patch(["first.bin"]), patch(["second.bin"])];
    await expect(
      resolvePatchTargets(
        [first, second],
        patches,
        undefined,
        [{ rom: true }, { member: "second.bin", rom: true }],
        ["patch-a", "patch-b"],
        [undefined, { member: "generated/first.bin", patch: "patch-a" }],
      ),
    ).resolves.toEqual([first, first]);
  });

  it("rejects a generated-track read that targets a different track", async () => {
    const first = asset("first", "track01.bin", "disc/track01.bin");
    const second = asset("second", "track02.bin", "disc/track02.bin");
    first.kind = "track";
    second.kind = "track";
    await expect(
      resolvePatchTargets(
        [first, second],
        [patch([]), patch([])],
        undefined,
        [undefined, { patch: "patch-a" }],
        ["patch-a", "patch-b"],
        [
          { member: "disc/track01.bin", rom: true },
          { member: "disc/track02.bin", rom: true },
        ],
      ),
    ).rejects.toThrow("source track disc/track01.bin and target track disc/track02.bin are different");
  });

  it("rejects a plain ROM member read that targets a different member", async () => {
    const first = asset("first", "a.bin", "pack/a.bin");
    const second = asset("second", "b.bin", "pack/b.bin");
    await expect(
      resolvePatchTargets(
        [first, second],
        [patch([])],
        undefined,
        [{ member: "pack/a.bin", rom: true }],
        ["patch-b"],
        [{ member: "pack/b.bin", rom: true }],
      ),
    ).rejects.toThrow("source member pack/a.bin and target member pack/b.bin are different");
  });

  it("rejects a fixed ROM track read that targets a different track", async () => {
    const first = asset("first", "track01.bin", "disc/track01.bin");
    const second = asset("second", "track02.bin", "disc/track02.bin");
    first.kind = "track";
    second.kind = "track";
    await expect(
      resolvePatchTargets(
        [first, second],
        [patch([])],
        undefined,
        [{ member: "disc/track01.bin", rom: true }],
        ["patch-b"],
        [{ member: "disc/track02.bin", rom: true }],
      ),
    ).rejects.toThrow("source track disc/track01.bin and target track disc/track02.bin are different");
  });

  it("blocks a named patch input when its producer is unavailable", async () => {
    const first = asset("first", "first.bin");
    await expect(
      resolvePatchTargets([first], [patch([])], undefined, [{ patch: "missing" }], ["patch-b"]),
    ).rejects.toThrow("input producer is unavailable");
  });
});

describe("bundle patch requirements", () => {
  it("reuses requirements after a bundle file is wrapped", async () => {
    const source = {};
    const wrapped = createLazyExternalPatchFile("patch.ips", { filePath: "/work/patch.ips", size: 18 });
    attachIngestPatchRequirements(
      source,
      patchProbeRequirementsFromDescriptor({ fileName: "patch.ips", format: "ips", sizeBytes: 18 }),
    );
    inheritIngestPatchRequirements(source, wrapped);
    const ingest = vi.fn();

    const parsed = await parsePatchForApply(wrapped as never, { ingest: { run: ingest } } as never);

    expect(getPatchProbeRequirements(parsed)).toMatchObject({ format: "IPS" });
    expect(ingest).not.toHaveBeenCalled();
  });

  it("parses a bare patch without loading ROM identify data", async () => {
    const ingest = vi.fn().mockResolvedValue({
      result: {
        patches: [{ fileName: "patch.ips", format: "ips", sizeBytes: 18 }],
      },
    });

    const patchFile = createLazyExternalPatchFile("patch.ips", { filePath: "/work/patch.ips", size: 18 });

    await parsePatchForApply(patchFile, { ingest: { run: ingest } } as never);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ identify: false }));
  });
});
