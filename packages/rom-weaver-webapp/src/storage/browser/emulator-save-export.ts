import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { createEmulatorSaveExport, listEmulatorSaves } from "./emulator-saves.ts";

type EmulatorSaveExport = {
  blob: Blob;
  fileName: string;
};

const getOutput = (result: PublicOutput | { output: PublicOutput }): PublicOutput =>
  "output" in result ? result.output : result;

const getEntryName = (entry: { fileName?: string; filename?: string; name?: string }): string =>
  String(entry.fileName || entry.filename || entry.name || "").trim();

const getCompressedFileName = (fileName: string): string => {
  const normalized = fileName.trim() || "emulator-save.rw-emulator-save.json";
  return normalized.replace(/\.json$/i, ".zip");
};

const readPublicOutputBlob = async (
  runtime: typeof import("../../platform/browser/workflow-runtime.ts").browserRuntime,
  output: PublicOutput,
): Promise<Blob> => {
  try {
    return await runtime.publicOutput.getBlob(output);
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

const compressEmulatorSaveExport = async (source: EmulatorSaveExport): Promise<EmulatorSaveExport> => {
  return compressSaveExports([source], getCompressedFileName(source.fileName));
};

const exportAllEmulatorSaves = async (): Promise<EmulatorSaveExport> => {
  const saves = await listEmulatorSaves();
  if (!saves.length) throw new Error("There are no emulator saves to export.");
  const sources = saves.map((save) => ({
    ...createEmulatorSaveExport(save),
    fileName: `${save.gameId}.rw-emulator-save.json`,
  }));
  return compressSaveExports(sources, "rom-weaver-all-saves.zip");
};

const compressSaveExports = async (sources: EmulatorSaveExport[], outputName: string): Promise<EmulatorSaveExport> => {
  const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("The rom-weaver compression runtime is unavailable.");

  const result = await create({
    entries: await Promise.all(
      sources.map(async (source) => ({
        arrayBuffer: await source.blob.arrayBuffer(),
        fileName: source.fileName,
      })),
    ),
    format: "zip",
    options: {
      outputName,
    },
  });
  const output = getOutput(result);
  return {
    blob: await readPublicOutputBlob(browserRuntime, output),
    fileName: output.fileName || outputName,
  };
};

const extractEmulatorSaveExport = async (source: Blob): Promise<Blob> => {
  const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
  const probe = browserRuntime.compression.probe;
  const extract = browserRuntime.compression.extract;
  if (!(probe && extract)) throw new Error("The rom-weaver archive runtime is unavailable.");

  const probed = await probe({
    format: "zip",
    options: { interactiveSelectionEnabled: false },
    source,
  });
  const entry = probed.entries.find((candidate) => /\.json$/i.test(getEntryName(candidate)));
  const entryName = entry ? getEntryName(entry) : "";
  if (!entryName) throw new Error("The compressed file contains no save export JSON.");

  const result = await extract({
    entries: [entryName],
    format: "zip",
    options: { directExtract: true },
    source,
  });
  const output = result.output || result.outputs[0];
  if (!output) throw new Error("The compressed file contains no extractable save export.");
  return readPublicOutputBlob(browserRuntime, output);
};

export { compressEmulatorSaveExport, exportAllEmulatorSaves, extractEmulatorSaveExport, getCompressedFileName };
