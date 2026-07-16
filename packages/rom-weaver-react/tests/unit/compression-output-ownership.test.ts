import { expect, test, vi } from "vitest";
import { createPatchFile, getPatchFileCleanup } from "../../src/lib/input/binary-service.ts";
import { resolveArchiveInput } from "../../src/lib/input/input-preparation-archive.ts";
import type { InputPreparationRuntime } from "../../src/lib/input/input-preparation-compression.ts";
import {
  createSharedCompressionRuntime,
  type RomSpecificRuntimeAdapter,
} from "../../src/lib/runtime/workflow-runtime-core.ts";
import { createCompressionExtractResult } from "../../src/lib/runtime/workflow-runtime-worker-helpers.ts";
import type { LargeFileVfs } from "../../src/storage/vfs/types.ts";
import type { PublicOutput } from "../../src/types/workflow-runtime-types.ts";

const testVfs = {
  hostKind: "browser-opfs",
  normalizePath: (path: string) => path,
  rootPath: "/work",
} as unknown as LargeFileVfs;

const createOutput = (fileName: string, path: string) => {
  const dispose = vi.fn(async () => undefined);
  const output = {
    cleanup: dispose,
    dispose,
    fileName,
    path,
    saveAs: vi.fn(async () => undefined),
    size: 1,
    vfs: testVfs,
  } as unknown as PublicOutput;
  return { dispose, output };
};

test("single-output archive preparation transfers omitted sibling cleanup to the retained file", async () => {
  const primary = createOutput("game.bin", "/work/operations/run/game.bin");
  const sibling = createOutput("game.cue", "/work/operations/run/game.cue");
  const runtime = {
    compression: {
      extract: async () => createCompressionExtractResult([primary.output, sibling.output]),
    },
    name: "browser",
    workerIo: {},
  } as unknown as InputPreparationRuntime;
  const archive = await createPatchFile(new Uint8Array([1]), "game.zip");
  archive.fileName = "game.zip";

  const extracted = await resolveArchiveInput(archive, "rom", undefined, runtime);

  expect(extracted.fileName).toBe("game.bin");
  expect(primary.dispose).not.toHaveBeenCalled();
  expect(sibling.dispose).not.toHaveBeenCalled();

  await getPatchFileCleanup(extracted)?.();
  expect(primary.dispose).toHaveBeenCalledTimes(1);
  expect(sibling.dispose).toHaveBeenCalledTimes(1);
});

test("cue-only CHD selection keeps omitted data alive until the retained cue is released", async () => {
  const cue = createOutput("disc.cue", "/work/operations/run/disc.cue");
  const data = createOutput("disc.bin", "/work/operations/run/disc.bin");
  const compression = createSharedCompressionRuntime({}, {
    extractChd: async () => createCompressionExtractResult([cue.output, data.output]),
  } as RomSpecificRuntimeAdapter);
  const extract = compression.extract;
  if (!extract) throw new Error("Compression extraction is unavailable");

  const result = await extract({
    entries: ["renamed.cue"],
    format: "chd",
    source: new Uint8Array([1]),
  });

  expect(result.outputs.map((output) => output.fileName)).toEqual(["renamed.cue"]);
  expect(cue.dispose).not.toHaveBeenCalled();
  expect(data.dispose).not.toHaveBeenCalled();

  await result.output.dispose();
  expect(cue.dispose).toHaveBeenCalledTimes(1);
  expect(data.dispose).toHaveBeenCalledTimes(1);
});
