import type { CompressionExtractResult, PublicOutput } from "../../types/workflow-runtime.ts";
import type { RuntimeWorkerOutput, WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { getArchiveEntryArrayBuffer, getArchiveEntryUint8Array } from "./source-normalization.ts";

type SevenZipZstdCreateRequest = Extract<
  Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0],
  { entries: unknown }
>;

const getWorkerOutputBlob = (result: RuntimeWorkerOutput) => result.file || result.blob || result.patchFile;

const getWorkerOutputFileName = (result: RuntimeWorkerOutput, fallbackFileName: string) =>
  result.outputRef?.fileName || result.fileName || result.patchFileName || fallbackFileName;

const getWorkerOutputFilePath = (result: RuntimeWorkerOutput) =>
  result.outputRef?.filePath || result.filePath || result.patchFilePath;

const attachDiscOutputMetadata = <TOutput extends PublicOutput>(
  output: TOutput,
  metadata: {
    chdCuePath?: string;
  },
) => Object.assign(output, metadata);

const normalizeCompressionWorkerEntries = (entries: SevenZipZstdCreateRequest["entries"]) =>
  entries.map((entry) => ({
    arrayBuffer: entry.arrayBuffer || getArchiveEntryArrayBuffer(entry.data),
    file: entry.file,
    fileName: entry.fileName || entry.filename || entry.name,
    filename: entry.filename || entry.fileName || entry.name,
    filePath: entry.filePath,
    lastModified: entry.lastModified || entry.mtime,
    name: entry.name || entry.fileName || entry.filename,
    text: entry.text,
    u8array: entry.u8array || getArchiveEntryUint8Array(entry.data),
  }));

const isCueOutput = (output: PublicOutput) => /\.cue$/i.test(output.fileName || output.path || "");

const createCompressionExtractResult = (outputs: CompressionExtractResult["outputs"]): CompressionExtractResult => ({
  entries: outputs.map((output) => ({
    fileName: output.fileName,
    filename: output.fileName,
    size: output.size,
  })),
  output: (outputs.find((output) => !isCueOutput(output)) || outputs[0]) as CompressionExtractResult["output"],
  outputs,
});

export {
  attachDiscOutputMetadata,
  createCompressionExtractResult,
  getWorkerOutputBlob,
  getWorkerOutputFileName,
  getWorkerOutputFilePath,
  normalizeCompressionWorkerEntries,
};
