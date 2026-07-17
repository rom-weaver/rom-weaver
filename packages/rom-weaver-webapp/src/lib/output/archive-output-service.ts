import {
  createCompressionProgressLabel,
  getProgressEventPercent,
  getProgressEventThreadCount,
  isCompressionWriteTelemetryProgress,
} from "../../presentation/workflow-presentation.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { ArchiveEntryInput } from "../../types/runtime.ts";
import type { CreateWorkflowDeps, PatchFileInstance, SharedProgressEventLike } from "../../types/workflow-internal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type {
  ApplyWorkflowOptions,
  CompressionEntryInput,
  CreateWorkflowOptions,
  JsonValue,
  PublicOutput,
  SevenZipZstdCompressionOptions,
} from "../../types/workflow-runtime-types.ts";
import { resolveCompressionLevels } from "../compression/compression-settings.ts";
import { type ArchiveCompressionFormat, isArchiveCompressionFormat } from "../compression/container-format-registry.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { getPatchFileBytes, getPatchFileExternalSource } from "../input/binary-service.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";

type ArchiveOutputCompression = ArchiveCompressionFormat | "none";
type ArchiveCreateCompression = Exclude<ArchiveOutputCompression, "none">;
type ArchiveOutputOptions = Partial<ApplyWorkflowOptions & CreateWorkflowOptions>;
type ArchiveOutputContainerSettings = NonNullable<NonNullable<ArchiveOutputOptions["output"]>["container"]> &
  Record<string, unknown>;
type ArchiveCompressionOverrides = Pick<SevenZipZstdCompressionOptions, "zipCodec" | "zipLevel">;
type ArchiveOutputEntry = { entry: ArchiveEntryInput; size: number };
type CompressionTrace<TValue> = (
  operation: () => Promise<TValue>,
  details: () => Record<string, unknown>,
) => Promise<TValue>;
type ArchiveTrace = (message: string, details: Record<string, unknown>) => void;

const ZIP_COMPRESSED_EXTENSION_REGEX = /\.zip$/i;
const SEVEN_ZIP_EXTENSION_REGEX = /\.7z$/i;

const getArchiveOutputCompression = (
  value: string | number | boolean | null | undefined,
  workflowLabel: string,
): ArchiveOutputCompression => {
  const compression = OutputCompressionManager.normalizeOutputCompression(value || "none");
  if (compression !== "none" && !isArchiveCompressionFormat(compression)) {
    throw new Error(`Unsupported ${workflowLabel} output compression: ${compression}`);
  }
  return compression;
};

const hasArchiveFileName = (fileName: string, compression: string) =>
  compression === "zip" ? ZIP_COMPRESSED_EXTENSION_REGEX.test(fileName) : SEVEN_ZIP_EXTENSION_REGEX.test(fileName);

const getOutputName = (options: ArchiveOutputOptions | undefined) =>
  typeof options?.output?.outputName === "string" ? options.output.outputName.trim() : "";

const getCompressionProfile = (options: ArchiveOutputOptions | undefined) =>
  options?.output?.container?.profile || "max";
const getContainerSettings = (options: ArchiveOutputOptions | undefined): ArchiveOutputContainerSettings =>
  options?.output?.container || {};
const getWorkerThreads = (options: ArchiveOutputOptions | undefined) => options?.workers?.threads;
const getLogLevel = (options: ArchiveOutputOptions | undefined) => options?.logging?.level;
const getArchiveProgressReporter =
  (compression: ArchiveCreateCompression, options: ArchiveOutputOptions | undefined) =>
  (progress: SharedProgressEventLike) => {
    if (isCompressionWriteTelemetryProgress(progress)) return;
    const formatLabel = compression === "zip" ? "ZIP" : "7z";
    const outputName = getOutputName(options);
    const progressDetails =
      progress.details && typeof progress.details === "object" && !Array.isArray(progress.details)
        ? (progress.details as Record<string, JsonValue>)
        : {};
    reportProgress(options, {
      details: {
        ...(progress as Record<string, JsonValue>),
        ...progressDetails,
        runtimeStage: progressDetails.runtimeStage || progress.stage,
        stage: "compress",
      },
      label: createCompressionProgressLabel({
        formatLabel,
        label: outputName ? `Compressing ${outputName} to ${formatLabel}` : `Compressing to ${formatLabel}`,
        // actual threads the runtime reported using (not the requested budget)
        threads: getProgressEventThreadCount(progress),
      }),
      percent: getProgressEventPercent(progress),
      stage: "output",
    });
  };

const createArchiveEntryInputFromPatchFile = (file: PatchFileInstance, outputFileName: string): ArchiveOutputEntry => {
  const sourceRef = getPatchFileExternalSource(file, outputFileName);
  if (sourceRef) {
    if (typeof sourceRef.source === "string" && sourceRef.source.trim()) {
      return {
        entry: { filename: outputFileName, filePath: sourceRef.source },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (isVfsFileRef(sourceRef.source)) {
      return {
        entry: { filename: outputFileName, filePath: sourceRef.source.path },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (typeof Blob !== "undefined" && sourceRef.source instanceof Blob) {
      return {
        entry: { file: sourceRef.source, filename: outputFileName },
        size: sourceRef.size || sourceRef.source.size || file.fileSize || 0,
      };
    }
  }

  const data = getPatchFileBytes(file);
  return {
    entry: { data, filename: outputFileName },
    size: data.byteLength,
  };
};

const toRuntimeCompressionEntry = (entry: ArchiveEntryInput): CompressionEntryInput => {
  const fileName = entry.fileName || entry.filename || entry.name || "entry.bin";
  const file =
    entry.file && typeof File === "function"
      ? entry.file instanceof File
        ? entry.file
        : new File([entry.file as BlobPart], fileName, { type: "application/octet-stream" })
      : undefined;
  return {
    arrayBuffer: entry.arrayBuffer,
    data: entry.data,
    file,
    fileName,
    filename: entry.filename || fileName,
    filePath: entry.filePath,
    lastModified: entry.lastModified,
    mtime: entry.mtime,
    name: entry.name || fileName,
    text: entry.text,
    u8array: entry.u8array,
  };
};

const createArchiveOutput = async ({
  compression,
  entries,
  options,
  outputName,
  overrides,
  runtime,
  trace,
  traceCreate,
  unsupportedRuntimeMessage = "Runtime compression create capability is unavailable",
}: {
  compression: ArchiveCreateCompression;
  entries: ArchiveEntryInput[];
  options: ArchiveOutputOptions | undefined;
  outputName: string;
  overrides?: ArchiveCompressionOverrides;
  runtime?: WorkflowRuntime;
  trace?: ArchiveTrace;
  traceCreate?: CompressionTrace<PublicOutput | { output: PublicOutput }>;
  unsupportedRuntimeMessage?: string;
}): Promise<PublicOutput> => {
  const archiveSettings = getContainerSettings(options);
  const levels = resolveCompressionLevels({
    compressionProfile: String(getCompressionProfile(options)),
    sevenZipCodec: archiveSettings.sevenZipCodec as string | null | undefined,
    sevenZipLevel: archiveSettings.sevenZipLevel as string | number | null | undefined,
    zipCodec: archiveSettings.zipCodec as string | null | undefined,
    zipLevel: archiveSettings.zipLevel as string | number | null | undefined,
  });
  const zipCodec = overrides?.zipCodec || levels.zipCodec;
  const zipLevel = overrides?.zipLevel ?? (zipCodec === "store" ? undefined : levels.zipLevel);
  const createArchive = runtime?.compression.create;
  if (!createArchive) throw new Error(unsupportedRuntimeMessage);
  const entryFileNames = entries.map((entry) => entry.filename || entry.fileName || entry.name || "");
  trace?.("output.archive.create", {
    archiveFileName: outputName,
    compression,
    entryFileNames,
    sevenZipCodec: levels.sevenZipCodec,
    sevenZipLevel: levels.sevenZipLevel,
    zipCodec,
    zipLevel,
  });
  const compressionOptions: SevenZipZstdCompressionOptions = {
    compression,
    compressionProfile: levels.compressionProfile as SevenZipZstdCompressionOptions["compressionProfile"],
    logLevel: getLogLevel(options),
    onLog: options?.onLog,
    onProgress: getArchiveProgressReporter(compression, options),
    outputName,
    sevenZipCodec: levels.sevenZipCodec as SevenZipZstdCompressionOptions["sevenZipCodec"],
    sevenZipLevel: levels.sevenZipLevel,
    signal: options?.signal,
    workerThreads: getWorkerThreads(options),
    zipCodec: zipCodec as SevenZipZstdCompressionOptions["zipCodec"],
    zipLevel,
  };
  const operation = () =>
    createArchive({
      entries: entries.map((entry) => toRuntimeCompressionEntry(entry)),
      format: compression,
      options: compressionOptions,
    });
  const compressionResult = traceCreate
    ? await traceCreate(operation, () => ({ compression, entryCount: entries.length, entryFileNames }))
    : await operation();
  if ("output" in compressionResult) return compressionResult.output;
  return compressionResult;
};

const canReusePublicOutputPath = (output: unknown) =>
  !!(
    output &&
    typeof output === "object" &&
    "path" in output &&
    typeof (output as { path?: unknown }).path === "string" &&
    (output as { path: string }).path &&
    "vfs" in output &&
    (output as { vfs?: unknown }).vfs
  );

const createPatchFileFromRuntimeOutput = async (output: PublicOutput, fallbackFileName: string) =>
  createPatchFileFromPublicOutput(
    output,
    fallbackFileName,
    canReusePublicOutputPath(output)
      ? {
          materializeBlob: false,
          preferExternalFilePath: true,
        }
      : undefined,
  );

const createArchivePatchFileOutput = async (
  input: Parameters<typeof createArchiveOutput>[0],
): Promise<PatchFileInstance> => {
  const output = await createArchiveOutput(input);
  return createPatchFileFromRuntimeOutput(output, input.outputName);
};

const createSingleFileArchiveOutput = async ({
  compression,
  deps,
  entryFile,
  entryNameDetailKey,
  fallbackEntryName,
  options,
  runtime,
  trace,
  unsupportedRuntimeMessage,
}: {
  compression: ArchiveCreateCompression;
  deps: Pick<CreateWorkflowDeps, "getPatchFileBytes" | "hasArchiveFileName">;
  entryFile: PatchFileInstance;
  entryNameDetailKey: string;
  fallbackEntryName: string;
  options: ArchiveOutputOptions | undefined;
  runtime: WorkflowRuntime;
  trace: CompressionTrace<PublicOutput | { output: PublicOutput }>;
  unsupportedRuntimeMessage: string;
}): Promise<PublicOutput> => {
  const requestedFileName = getOutputName(options);
  const entryName =
    requestedFileName && !deps.hasArchiveFileName(requestedFileName, compression)
      ? requestedFileName
      : entryFile.fileName || fallbackEntryName;
  entryFile.fileName = entryName;
  const archiveSettings = getContainerSettings(options);
  const compressionSettings = resolveCompressionLevels({
    compressionProfile: String(getCompressionProfile(options)),
    sevenZipCodec: archiveSettings.sevenZipCodec as string | null | undefined,
    sevenZipLevel: archiveSettings.sevenZipLevel as string | number | null | undefined,
    zipCodec: archiveSettings.zipCodec as string | null | undefined,
    zipLevel: archiveSettings.zipLevel as string | number | null | undefined,
  });
  const outputName =
    requestedFileName && deps.hasArchiveFileName(requestedFileName, compression)
      ? requestedFileName
      : OutputCompressionManager.getCompressedFileName({ fileName: entryName }, compression, compressionSettings);
  return createArchiveOutput({
    compression,
    entries: [
      {
        data: deps.getPatchFileBytes(entryFile),
        fileName: entryName,
        filename: entryName,
      },
    ],
    options,
    outputName,
    runtime,
    traceCreate: (operation, details) =>
      trace(operation, () => ({
        ...details(),
        [entryNameDetailKey]: entryName,
      })),
    unsupportedRuntimeMessage,
  });
};

export type { ArchiveCompressionOverrides, ArchiveOutputEntry };
export {
  createArchiveEntryInputFromPatchFile,
  createArchiveOutput,
  createArchivePatchFileOutput,
  createPatchFileFromRuntimeOutput,
  createSingleFileArchiveOutput,
  getArchiveOutputCompression,
  hasArchiveFileName,
};
