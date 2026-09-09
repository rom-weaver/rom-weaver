import { describe, expect, it, vi } from "vitest";
import {
  buildBundleExportRows,
  buildBundlePatchInputs,
  preparePackagedRom,
} from "../../src/public/react/bundle-export.tsx";

const createCompressionOutput = () => ({
  path: "/work/compressed-rom",
  vfs: { normalizePath: (path: string) => path },
});

const prepare = async ({
  originalName,
  recommendedFormat,
  romFileName = "game.iso",
  bundleRom = true,
  member,
}: {
  originalName: string;
  recommendedFormat?: string;
  romFileName?: string;
  bundleRom?: boolean;
  member?: string;
}) => {
  const source = { fileName: romFileName };
  const originalSource = { name: originalName };
  const create = vi.fn().mockResolvedValue({ output: createCompressionOutput() });
  const progress = vi.fn();
  const compressedRomOutputs: never[] = [];
  const rom = {
    fileName: romFileName,
    ...(member ? { member } : {}),
    originalSource,
    source,
    ...(recommendedFormat ? { recommendedFormat } : {}),
  };
  const packaged = await preparePackagedRom({
    browserRuntime: { compression: { create } } as never,
    bundleRom,
    compressedRomOutputs,
    rom: rom as never,
    stepProgress: progress,
    wantsBundle: true,
  });
  return { create, originalSource, packaged, progress, source };
};

describe("preparePackagedRom", () => {
  it("compresses a raw ROM to the engine-recommended format", async () => {
    const { create, packaged, progress, source } = await prepare({
      originalName: "game.iso",
      recommendedFormat: "rvz",
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      fileName: "game.iso",
      format: "rvz",
      outputName: "game.rvz",
      source,
    });
    expect(packaged?.fileName).toBe("game.rvz");
    expect(progress).toHaveBeenCalledWith("ROM compression · RVZ");
  });

  it("recompresses a special container when it does not match the recommendation", async () => {
    const { create, originalSource, packaged, source } = await prepare({
      originalName: "game.chd",
      recommendedFormat: "rvz",
    });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ format: "rvz", source });
    expect(packaged?.source).not.toBe(originalSource);
    expect(packaged?.fileName).toBe("game.rvz");
  });

  it("does not treat an RVZ-compatible alias as an RVZ output", async () => {
    const { create, packaged } = await prepare({
      originalName: "game.gcz",
      recommendedFormat: "rvz",
    });

    expect(create).toHaveBeenCalledOnce();
    expect(packaged?.fileName).toBe("game.rvz");
  });

  it("reuses a ROM already in the recommended compressed format", async () => {
    const { create, originalSource, packaged } = await prepare({
      originalName: "game.rvz",
      recommendedFormat: "rvz",
    });

    expect(create).not.toHaveBeenCalled();
    expect(packaged).toEqual({ fileName: "game.rvz", source: originalSource });
  });

  it("uses the metadata-defined Z3DS subtype extension", async () => {
    const { create, packaged } = await prepare({
      originalName: "game.cia",
      recommendedFormat: "z3ds",
      romFileName: "game.cia",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ format: "z3ds", outputName: "game.zcia" });
    expect(packaged?.fileName).toBe("game.zcia");
  });

  it("retains the parent archive for a selected member", async () => {
    const { create, originalSource, packaged } = await prepare({
      originalName: "disc.zip",
      member: "track03.bin",
      recommendedFormat: "chd",
    });
    expect(create).not.toHaveBeenCalled();
    expect(packaged).toEqual({ fileName: "disc.zip", source: originalSource });
  });

  it("requires a complete disc source when including a multi-file disc", async () => {
    await expect(prepare({ originalName: "disc.cue", member: "track03.bin" })).rejects.toThrow(
      "archive containing its descriptor and tracks",
    );
  });

  it("does not prepare a ROM when ROM inclusion is off", async () => {
    const { create, packaged } = await prepare({
      bundleRom: false,
      originalName: "game.iso",
      recommendedFormat: "rvz",
    });

    expect(create).not.toHaveBeenCalled();
    expect(packaged).toBeUndefined();
  });
});

describe("bundle execution targets", () => {
  const patches = ["a.ips", "b.ips", "c.ips"].map((fileName) => ({
    fileName,
    source: { fileName },
    originalSource: { fileName },
  }));
  const rows = (overrides = {}) =>
    buildBundleExportRows({
      patches,
      getPatchIds: () => ["a", "b", "c"],
      getStackItems: () => [],
      bundleMetaById: new Map(),
      disabledPatchIds: new Set<string>(),
      patchBasis: "base",
      ...overrides,
    });

  it("keeps accumulated execution independent of authored base checks", () => {
    const exported = rows();
    expect(exported.map((row) => row.input)).toEqual([undefined, undefined, undefined]);
    expect(buildBundlePatchInputs(patches, exported).map((patch) => patch.input)).toEqual(
      exported.map((row) => row.input),
    );
  });

  it("preserves explicit references without freezing optional accumulated chains", () => {
    const exported = rows({ disabledPatchIds: new Set(["b"]) });
    expect(exported[2]?.input).toBeUndefined();
    const explicit = rows({
      disabledPatchIds: new Set(["b"]),
      bundleMetaById: new Map([["c", { input: { patch: "b" } }]]),
    });
    expect(explicit[2]?.input).toEqual({ patch: "b" });
  });

  it("writes selected-track lanes without freezing optional chains", () => {
    const exported = rows({
      disabledPatchIds: new Set(["b"]),
      patches: patches.map((patch) => ({
        ...patch,
        target: { rom: true, member: "disc/track02.bin" },
      })),
    });
    expect(exported.map((row) => row.input)).toEqual([undefined, undefined, undefined]);
    expect(exported.map((row) => row.target)).toEqual([
      { rom: true, member: "disc/track02.bin" },
      { rom: true, member: "disc/track02.bin" },
      { rom: true, member: "disc/track02.bin" },
    ]);
  });

  it("keeps independent track targets separate within the same ROM", () => {
    const exported = rows({
      patches: patches.map((patch, index) => ({
        ...patch,
        target: { rom: true, member: index === 1 ? "disc/track02.bin" : "disc/track03.bin" },
      })),
    });
    expect(exported.map((row) => row.target)).toEqual([
      { rom: true, member: "disc/track03.bin" },
      { rom: true, member: "disc/track02.bin" },
      { rom: true, member: "disc/track03.bin" },
    ]);
  });

  it("round-trips a producer output member without turning it into a fixed input", () => {
    const exported = rows({
      bundleMetaById: new Map([["c", { target: { member: "generated/track03.bin", patch: "a" } }]]),
    });

    expect(exported[2]).toMatchObject({
      input: undefined,
      target: { member: "generated/track03.bin", patch: "a" },
    });
    expect(buildBundlePatchInputs(patches, exported)[2]).toMatchObject({
      target: { member: "generated/track03.bin", patch: "a" },
    });
  });

  it("preserves byte-size checks in the runtime export", () => {
    const exported = rows({
      bundleMetaById: new Map([
        [
          "a",
          {
            inputChecks: { size: 0 },
            outputChecks: { size: 42 },
          },
        ],
      ]),
    });
    expect(buildBundlePatchInputs(patches, exported)[0]).toMatchObject({
      inputChecks: "size=0",
      outputChecks: "size=42",
    });
  });
});
