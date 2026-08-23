import { describe, expect, it, vi } from "vitest";
import { preparePackagedRom } from "../../src/public/react/bundle-export.tsx";

const createCompressionOutput = () => ({
  path: "/work/compressed-rom",
  vfs: { normalizePath: (path: string) => path },
});

const prepare = async ({
  originalName,
  recommendedFormat,
  romFileName = "game.iso",
  bundleRom = true,
}: {
  originalName: string;
  recommendedFormat?: string;
  romFileName?: string;
  bundleRom?: boolean;
}) => {
  const source = { fileName: romFileName };
  const originalSource = { name: originalName };
  const create = vi.fn().mockResolvedValue({ output: createCompressionOutput() });
  const progress = vi.fn();
  const compressedRomOutputs: never[] = [];
  const rom = {
    fileName: romFileName,
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
