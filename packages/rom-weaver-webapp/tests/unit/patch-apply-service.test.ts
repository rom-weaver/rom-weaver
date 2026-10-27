import { describe, expect, it, vi } from "vitest";
import {
  attachIngestPatchRequirements,
  getPatchProbeRequirements,
  inheritIngestPatchRequirements,
  parsePatchForApply,
  patchProbeRequirementsFromDescriptor,
  resolvePatchTargets,
} from "../../src/lib/apply/patch-apply-service.ts";
import { createBareMemberRule } from "../../src/lib/apply/bare-member-target.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { attachPatchFileSourceRef, createLazyExternalPatchFile } from "../../src/lib/input/binary-service.ts";

const { readPrefix } = vi.hoisted(() => ({ readPrefix: vi.fn(async () => new TextEncoder().encode("PATCHEOF")) }));
vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({ readBrowserOpfsPrefix: readPrefix }));

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

  it("accepts a bare file whose name matches the targeted member", async () => {
    const bare = asset("bare", "romA.bin");
    await expect(
      resolvePatchTargets([bare], [patch([])], undefined, undefined, undefined, [{ rom: true, member: "romA.bin" }]),
    ).resolves.toEqual([bare]);
  });

  it("accepts a bare file whose checks match the targeted member", async () => {
    const bare = { ...asset("bare", "renamed.bin"), checksums: { crc32: "deadbeef" }, size: 16 };
    await expect(
      resolvePatchTargets(
        [bare],
        [patch([])],
        undefined,
        undefined,
        undefined,
        [{ rom: true, member: "romA.bin" }],
        createBareMemberRule([{ checks: "crc32=deadbeef", target: { rom: true, member: "romA.bin" } }]),
      ),
    ).resolves.toEqual([bare]);
  });

  it("rejects a bare file matching neither the member name nor its checks", async () => {
    const bare = { ...asset("bare", "other.bin"), checksums: { crc32: "00000000" } };
    await expect(
      resolvePatchTargets(
        [bare],
        [patch([])],
        undefined,
        undefined,
        undefined,
        [{ rom: true, member: "romA.bin" }],
        createBareMemberRule([{ checks: "crc32=deadbeef", target: { rom: true, member: "romA.bin" } }]),
      ),
    ).rejects.toThrow("neither its file name nor its checks match the member");
  });

  it("refuses to bind one bare file to several distinct members of the same name", async () => {
    const bare = asset("bare", "track.bin");
    await expect(
      resolvePatchTargets([bare], [patch([]), patch([])], undefined, undefined, undefined, [
        { rom: true, member: "disc-a/track.bin" },
        { rom: true, member: "disc-b/track.bin" },
      ]),
    ).rejects.toThrow("matches several weave ROM members (`disc-a/track.bin`, `disc-b/track.bin`)");
  });

  it("refuses a second same-named member when the weave root member is also read by the bare file", async () => {
    const bare = asset("bare", "track.bin");
    await expect(
      resolvePatchTargets(
        [bare],
        [patch([])],
        undefined,
        undefined,
        undefined,
        [{ rom: true, member: "disc-b/track.bin" }],
        createBareMemberRule([{ target: { rom: true, member: "disc-b/track.bin" } }], "disc-a/track.bin"),
      ),
    ).rejects.toThrow("matches several weave ROM members (`disc-a/track.bin`, `disc-b/track.bin`)");
  });

  it("rejects an input member the lone bare file also matches as the root member", async () => {
    const bare = asset("bare", "track.bin");
    await expect(
      resolvePatchTargets(
        [bare],
        [patch([])],
        undefined,
        [{ rom: true, member: "disc-b/track.bin" }],
        undefined,
        [{ rom: true }],
        createBareMemberRule([{ input: { rom: true, member: "disc-b/track.bin" } }], "disc-a/track.bin"),
      ),
    ).rejects.toThrow("matches several weave ROM members (`disc-a/track.bin`, `disc-b/track.bin`)");
  });

  it("rejects an input member a lone archive member does not hold", async () => {
    const only = asset("only", "track.bin", "disc-a/track.bin");
    await expect(
      resolvePatchTargets([only], [patch([])], undefined, [{ rom: true, member: "disc-b/track.bin" }], undefined, [
        { rom: true, member: "disc-a/track.bin" },
      ]),
    ).rejects.toThrow("ROM member was not found: disc-b/track.bin");
  });

  it("lets a lone bare file stand in for the named input member", async () => {
    const bare = asset("bare", "track.bin");
    await expect(
      resolvePatchTargets([bare], [patch([])], undefined, [{ rom: true, member: "disc-a/track.bin" }], undefined, [
        { rom: true },
      ]),
    ).resolves.toEqual([bare]);
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

describe("weave patch requirements", () => {
  it.each([true, false])("validates retained IPS magic with cached requirements (valid=%s)", async (valid) => {
    const source = new File(["PATCHEOF"], "change.ips");
    const readSnapshot = vi.spyOn(source, "slice").mockImplementation(() => {
      throw new DOMException("The object can not be found here.", "NotFoundError");
    });
    const wrapped = createLazyExternalPatchFile("change.ips", { filePath: "/work/retained/change.ips", size: 8 });
    attachPatchFileSourceRef(wrapped, { fileName: source.name, source });
    attachIngestPatchRequirements(wrapped, { format: "IPS" });
    const ingest = vi.fn();
    readPrefix.mockResolvedValueOnce(new TextEncoder().encode(valid ? "PATCHEOF" : "INVALID!"));
    const parsed = await parsePatchForApply(wrapped, { ingest: { run: ingest } } as never);
    if (valid) expect(getPatchProbeRequirements(parsed)).toMatchObject({ format: "IPS" });
    else expect(parsed).toBeNull();
    expect(readPrefix).toHaveBeenLastCalledWith("/work/retained/change.ips", 8);
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("validates cached VFS patch magic through its own backend", async () => {
    const read = vi.fn(async (_path: string, buffer: Uint8Array) => {
      buffer.set(new TextEncoder().encode("INVALID!"));
      return 8;
    });
    const source = { path: "/custom/change.ips", vfs: { read } };
    const wrapped = createLazyExternalPatchFile("change.ips", { filePath: source.path, size: 8 });
    attachPatchFileSourceRef(wrapped, { fileName: "change.ips", source: source as never });
    attachIngestPatchRequirements(wrapped, { format: "IPS" });
    const calls = readPrefix.mock.calls.length;
    expect(await parsePatchForApply(wrapped)).toBeNull();
    expect(read).toHaveBeenCalledWith(source.path, expect.any(Uint8Array), { fileOffset: 0, length: 8 });
    expect(readPrefix.mock.calls.length).toBe(calls);
  });

  it("reuses requirements after a weave file is wrapped", async () => {
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
