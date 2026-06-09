import { expect, test, vi } from "vitest";
import { createOutputFile, getPatchFileBytes } from "../../src/lib/input/binary-service.ts";
import {
  createArchiveOutput,
  createArchivePatchFileOutput,
  createSingleFileArchiveOutput,
  getArchiveOutputCompression,
} from "../../src/lib/output/archive-output-service.ts";

const createRuntime = (outputBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])) => {
  const calls = [];
  const runtime = {
    compression: {
      create: vi.fn(async (input) => {
        calls.push(input);
        input.options?.onProgress?.({
          details: { phase: "pack" },
          effective_threads: 1,
          label: "Packing",
          percent: 40,
          stage: "read",
        });
        return {
          output: {
            data: outputBytes,
            fileName: input.options.outputName,
            size: outputBytes.byteLength,
          },
        };
      }),
    },
  };
  return { calls, runtime };
};

test("archive output service normalizes supported archive output compression", () => {
  expect(getArchiveOutputCompression("zip", "test")).toBe("zip");
  expect(getArchiveOutputCompression("7z", "test")).toBe("7z");
  expect(getArchiveOutputCompression("none", "test")).toBe("none");
  expect(() => getArchiveOutputCompression("rvz", "test")).toThrow("Unsupported test output compression: rvz");
});

test("createArchiveOutput builds runtime archive create requests and reports progress", async () => {
  const { calls, runtime } = createRuntime();
  const progress = vi.fn();

  const output = await createArchiveOutput({
    compression: "zip",
    entries: [{ data: new Uint8Array([1, 2, 3]), filename: "inner.bin" }],
    options: {
      onProgress: progress,
      output: {
        container: {
          profile: "fast",
          zipCodec: "store",
          zipLevel: 9,
        },
      },
      workers: { threads: 2 },
    },
    outputName: "bundle.zip",
    runtime,
  });

  expect(output.fileName).toBe("bundle.zip");
  expect(calls).toHaveLength(1);
  expect(calls[0].format).toBe("zip");
  expect(calls[0].entries[0]).toMatchObject({
    fileName: "inner.bin",
    filename: "inner.bin",
    name: "inner.bin",
  });
  expect(calls[0].options).toMatchObject({
    compression: "zip",
    outputName: "bundle.zip",
    workerThreads: 2,
    zipCodec: "store",
    zipLevel: undefined,
  });
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      details: expect.objectContaining({
        phase: "pack",
        runtimeStage: "read",
        stage: "compress",
      }),
      label: "Packing ZIP - 1 thread",
      percent: 40,
      stage: "output",
    }),
  );
});

test("createArchiveOutput uses normalized container codec settings", async () => {
  const { calls, runtime } = createRuntime();

  await createArchiveOutput({
    compression: "zip",
    entries: [{ data: new Uint8Array([1, 2, 3]), filename: "inner.bin" }],
    options: {
      output: {
        container: {
          profile: "max",
          zipCodec: "zstd",
        },
      },
    },
    outputName: "bundle.zip",
    runtime,
  });

  expect(calls[0].options).toMatchObject({
    compressionProfile: "max",
    zipCodec: "zstd",
    zipLevel: 22,
  });
});

test("createSingleFileArchiveOutput derives archive and inner entry names from requested output", async () => {
  const { calls, runtime } = createRuntime();
  const patchFile = createOutputFile(new Uint8Array([1, 2, 3]), "change.ips");

  const output = await createSingleFileArchiveOutput({
    compression: "zip",
    deps: {
      getPatchFileBytes,
      hasArchiveFileName: (fileName, compression) =>
        compression === "zip" ? /\.zip$/i.test(fileName) : /\.7z$/i.test(fileName),
    },
    entryFile: patchFile,
    entryNameDetailKey: "patchEntryName",
    fallbackEntryName: "change.ips",
    options: {
      output: {
        outputName: "custom-name",
      },
    },
    runtime,
    trace: (operation) => operation(),
    unsupportedRuntimeMessage: "missing compression runtime",
  });

  expect(output.fileName).toBe("custom-name.zip");
  expect(calls[0].entries[0]).toMatchObject({
    fileName: "custom-name",
    filename: "custom-name",
  });
});

test("createArchivePatchFileOutput wraps runtime archive output as a patch file", async () => {
  const outputBytes = new Uint8Array([7, 8, 9]);
  const { runtime } = createRuntime(outputBytes);

  const patchFile = await createArchivePatchFileOutput({
    compression: "7z",
    entries: [{ data: new Uint8Array([1]), filename: "entry.bin" }],
    options: undefined,
    outputName: "bundle.7z",
    runtime,
  });

  expect(patchFile.fileName).toBe("bundle.7z");
  expect([...getPatchFileBytes(patchFile)]).toEqual([...outputBytes]);
});
