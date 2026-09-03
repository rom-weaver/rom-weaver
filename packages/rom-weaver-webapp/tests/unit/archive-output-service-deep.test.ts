import { describe, expect, it, vi } from "vitest";

import type { PatchFileInstance } from "../../src/lib/input/binary-service.ts";
import {
  createArchiveEntryInputFromPatchFile,
  createArchiveOutput,
  createArchivePatchFileOutput,
  createPatchFileFromRuntimeOutput,
  createSingleFileArchiveOutput,
  getArchiveOutputCompression,
  hasArchiveFileName,
} from "../../src/lib/output/archive-output-service.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const makeFile = (
  fileName: string,
  bytes = new Uint8Array([1, 2, 3]),
  extras: Record<string, unknown> = {},
): PatchFileInstance =>
  ({
    _u8array: bytes,
    fileName,
    fileSize: bytes.byteLength,
    ...extras,
  }) as unknown as PatchFileInstance;

const makeRuntime = (output: unknown = { fileName: "archive.zip", size: 8 }) => {
  const create = vi.fn(async (request: Record<string, unknown>) => {
    const options = request.options as { onProgress?: (progress: unknown) => void };
    options.onProgress?.({ details: { effective_threads: 3 }, percent: 25, stage: "compress" });
    options.onProgress?.({ details: { telemetry: "write" }, percent: null, stage: "write" });
    return output;
  });
  return { create, runtime: { compression: { create } } as unknown as WorkflowRuntime };
};

describe("archive output service boundaries", () => {
  it("normalizes archive choices and recognizes compressed names", () => {
    expect(getArchiveOutputCompression(undefined, "apply")).toBe("none");
    expect(getArchiveOutputCompression("ZIP", "apply")).toBe("zip");
    expect(getArchiveOutputCompression("7z", "create")).toBe("7z");
    expect(() => getArchiveOutputCompression("gzip", "apply")).toThrow("Unsupported output compression: gzip");
    expect(hasArchiveFileName("archive.ZIP", "zip")).toBe(true);
    expect(hasArchiveFileName("archive.7Z", "7z")).toBe(true);
    expect(hasArchiveFileName("archive.zip", "7z")).toBe(false);
  });

  it("maps external, VFS, Blob, and byte-backed patch files into archive entries", () => {
    const external = makeFile("external.bin", new Uint8Array(7), {
      _sourceRef: { fileName: "external.bin", size: 12, source: "/tmp/external.bin" },
    });
    expect(createArchiveEntryInputFromPatchFile(external, "renamed.bin")).toEqual({
      entry: { filename: "renamed.bin", filePath: "/tmp/external.bin" },
      size: 12,
    });

    const vfs = { normalizePath: (path: string) => path };
    const vfsFile = makeFile("vfs.bin", new Uint8Array(4), {
      _sourceRef: { fileName: "vfs.bin", size: 4, source: { path: "/work/vfs.bin", vfs } },
    });
    expect(createArchiveEntryInputFromPatchFile(vfsFile, "vfs-renamed.bin")).toEqual({
      entry: { filename: "vfs-renamed.bin", filePath: "/work/vfs.bin" },
      size: 4,
    });

    const blob = new Blob([new Uint8Array(5)], { type: "application/octet-stream" });
    const blobFile = makeFile("blob.bin", new Uint8Array(2), { _file: blob });
    expect(createArchiveEntryInputFromPatchFile(blobFile, "blob.bin")).toMatchObject({
      entry: { file: blob, filename: "blob.bin" },
      size: 2,
    });

    const byteFile = makeFile("bytes.bin", new Uint8Array([9, 8, 7]));
    expect(createArchiveEntryInputFromPatchFile(byteFile, "bytes.bin")).toEqual({
      entry: { data: new Uint8Array([9, 8, 7]), filename: "bytes.bin" },
      size: 3,
    });
  });

  it("passes compression settings and progress through a runtime create call", async () => {
    const { create, runtime } = makeRuntime({ output: { fileName: "archive.zip", size: 8 } });
    const progress = vi.fn();
    const trace = vi.fn();
    const output = await createArchiveOutput({
      compression: "zip",
      entries: [{ data: new Uint8Array([1]), filename: "game.bin" }],
      options: {
        logging: { level: "debug" },
        output: { container: { profile: "fast", zipCodec: "store" }, outputName: "archive.zip" },
        workers: { threads: 2 },
        onProgress: progress,
      } as never,
      outputName: "archive.zip",
      runtime,
      trace,
    });
    expect(output).toEqual({ fileName: "archive.zip", size: 8 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      entries: [{ fileName: "game.bin", filename: "game.bin", name: "game.bin" }],
      format: "zip",
      options: { outputName: "archive.zip", threads: 2, zipCodec: "store" },
    });
    expect(trace).toHaveBeenCalledWith(
      "output.archive.create",
      expect.objectContaining({ entryFileNames: ["game.bin"] }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ label: expect.stringContaining("Compressing archive.zip") }),
    );
  });

  it("supports wrapped and direct runtime outputs and reports missing capabilities", async () => {
    const wrapped = makeRuntime({ output: { bytes: new Uint8Array([1]), fileName: "wrapped.zip", size: 1 } });
    await expect(
      createArchivePatchFileOutput({
        compression: "zip",
        entries: [{ data: new Uint8Array([1]), filename: "game.bin" }],
        options: undefined,
        outputName: "wrapped.zip",
        runtime: wrapped.runtime,
      }),
    ).resolves.toMatchObject({ fileName: "wrapped.zip" });

    const direct = makeRuntime({ bytes: new Uint8Array([1]), fileName: "direct.zip", size: 1 });
    await expect(
      createArchivePatchFileOutput({
        compression: "7z",
        entries: [{ text: "data", filename: "game.bin" }],
        options: undefined,
        outputName: "direct.7z",
        runtime: direct.runtime,
      }),
    ).resolves.toMatchObject({ fileName: "direct.zip" });

    await expect(
      createArchiveOutput({
        compression: "zip",
        entries: [],
        options: undefined,
        outputName: "missing.zip",
        runtime: { compression: {} } as unknown as WorkflowRuntime,
      }),
    ).rejects.toThrow("Runtime compression create capability is unavailable");
  });

  it("chooses a requested entry name and compressed output name for one file", async () => {
    const { runtime, create } = makeRuntime({ fileName: "renamed.zip", size: 4 });
    const file = makeFile("source.ips");
    const result = await createSingleFileArchiveOutput({
      compression: "zip",
      deps: {
        getPatchFileBytes: (value) => new Uint8Array(value.fileSize),
        hasArchiveFileName,
      },
      entryFile: file,
      entryNameDetailKey: "entryName",
      fallbackEntryName: "patch.bin",
      options: { output: { outputName: "renamed.zip" } } as never,
      runtime,
      trace: async (operation, details) =>
        operation()
          .then((value) => ({ ...details(), value }))
          .then((value) => value.value),
      unsupportedRuntimeMessage: "archive runtime missing",
    });
    expect(result).toEqual({ fileName: "renamed.zip", size: 4 });
    expect(file.fileName).toBe("source.ips");
    expect(create.mock.calls[0]?.[0]).toMatchObject({ options: { outputName: "renamed.zip" } });
  });

  it("creates lazy files for VFS outputs and materializes direct Blob outputs", async () => {
    const vfs = {
      normalizePath: (path: string) => path,
      read: vi.fn(async () => 0),
    };
    const output = {
      fileName: "vfs.zip",
      path: "/work/vfs.zip",
      size: 12,
      vfs,
    };
    const lazy = await createPatchFileFromRuntimeOutput(output as never, "fallback.zip");
    expect(lazy.fileName).toBe("vfs.zip");
    expect((lazy as unknown as { _lazyExternalSource?: boolean })._lazyExternalSource).toBe(true);

    const blob = new Blob([new Uint8Array([1, 2])]);
    const direct = await createPatchFileFromRuntimeOutput(
      { fileName: "blob.zip", size: 2, blob } as never,
      "fallback.zip",
    );
    expect(direct.fileName).toBe("blob.zip");
    expect(direct.fileSize).toBe(2);
  });
});
