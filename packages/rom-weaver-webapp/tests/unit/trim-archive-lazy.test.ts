import { describe, expect, it, vi } from "vitest";

import { runTrimWorkflow } from "../../src/lib/trim/workflow.ts";

const source = { fileName: "game.nds", fileSize: 100, getExtension: () => "nds" };

describe("trim archive entry backing", () => {
  it.each(["zip", "7z"] as const)("keeps a large VFS trim output path-backed for %s", async (compression) => {
    const read = vi.fn(() => {
      throw new Error("Trim output must stay on the VFS");
    });
    const getFile = vi.fn(() => {
      throw new Error("Archive input does not need a Blob snapshot");
    });
    const create = vi.fn(async () => ({ fileName: `trimmed.${compression}`, size: 30 }));
    const result = await runTrimWorkflow(
      { source: source as never, options: { output: { compression, outputName: `trimmed.${compression}` } } },
      {
        compression: { create },
        trim: {
          trim: async () => ({
            output: {
              fileName: "trimmed.nds",
              path: "/work/trimmed.nds",
              size: 1_400_000_000,
              vfs: { normalizePath: (path: string) => path, read, getFile },
            },
          }),
        },
      } as never,
    );
    expect(read).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            data: undefined,
            file: undefined,
            filePath: "/work/trimmed.nds",
            fileName: "trimmed.nds",
          }),
        ],
        format: compression,
      }),
    );
    expect(result.sizeSummary).toMatchObject({ rawSize: 1_400_000_000, outputSize: 30 });
  });

  it("keeps an in-memory trim output byte-backed", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const create = vi.fn(async () => ({ fileName: "trimmed.zip", size: 30 }));
    await runTrimWorkflow(
      { source: source as never, options: { output: { compression: "zip", outputName: "trimmed.zip" } } },
      {
        compression: { create },
        trim: { trim: async () => ({ output: { bytes, fileName: "trimmed.nds", size: bytes.byteLength } }) },
      } as never,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ data: bytes, filePath: undefined, fileName: "trimmed.nds" })],
      }),
    );
  });

  it("keeps a Blob trim output lazy", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const arrayBuffer = vi.spyOn(blob, "arrayBuffer");
    const create = vi.fn(async () => ({ fileName: "trimmed.zip", size: 30 }));
    await runTrimWorkflow(
      { source: source as never, options: { output: { compression: "zip", outputName: "trimmed.zip" } } },
      {
        compression: { create },
        trim: { trim: async () => ({ output: { blob, fileName: "trimmed.nds", size: blob.size } }) },
      } as never,
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ data: undefined, file: expect.any(File), fileName: "trimmed.nds" })],
      }),
    );
  });
});
