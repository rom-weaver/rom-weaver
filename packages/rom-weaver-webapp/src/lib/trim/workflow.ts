import { getPrimaryInputAsset } from "../../lib/input/input-assets.ts";
import { prepareInputAssets } from "../../lib/input/input-preparation-service.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import { getNamedSourceSize } from "../../storage/shared/binary/source-file-utils.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { SourceRef } from "../../types/source.ts";
import type { ArchiveOutputSettings } from "../../types/workflow-compression.ts";
import type { PatchFileInstance } from "../../types/workflow-internal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { TrimInput, TrimResult, TrimWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import {
  isArchiveCompressionFormat,
  isRomSpecificCompressionFormat,
} from "../compression/container-format-registry.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { COMPRESSION_DEFAULTS } from "../compression/compression-metadata.ts";
import { hasArchiveFileName } from "../output/archive-output-service.ts";
import {
  createSingleFileRomSpecificOutput,
  getRustOutputExportOptions,
  shouldUseRustOutputExport,
} from "../output/output-build-service.ts";
import { getCompressedOutputFileName, getCompressionIntermediateFileName } from "../output/output-files.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { getWorkflowSourceFileName, shouldPrepareWorkflowSource } from "../workflow/source-preparation.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";
import { getChdAutoCreateMode } from "../input/rom-specific-file-utils.ts";
import { getPatchFileCleanup, getPatchFileExternalSource } from "../input/binary-service.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";

const FILE_EXTENSION_REGEX = /\.([^./\\?#]+)(?:[?#].*)?$/;
type TrimSourceInput = PatchFileInstance | SourceRef;
type OutputCompressionSource = Parameters<typeof OutputCompressionManager.resolveOutputCompression>[0];

const getTrimLogLevel = (options: TrimWorkflowOptions | undefined) => options?.logging?.level;
const getTrimThreads = (options: TrimWorkflowOptions | undefined) => options?.workers?.threads;
const getTrimCompression = (options: TrimWorkflowOptions | undefined) => options?.output?.compression;
const getTrimOutputName = (options: TrimWorkflowOptions | undefined) => options?.output?.outputName;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("trim");

const getTrimOutputCompression = (
  options: TrimWorkflowOptions | undefined,
  source: TrimSourceInput | null | undefined,
): CompressionFormat => {
  const requestedCompression = OutputCompressionManager.normalizeOutputCompression(
    getTrimCompression(options) || "none",
  );
  if (requestedCompression === "auto") {
    const resolvedCompression = OutputCompressionManager.resolveOutputCompression(source as OutputCompressionSource, {
      compressionFormat: "auto",
    });
    return resolvedCompression === "auto" ? "7z" : resolvedCompression;
  }
  return requestedCompression;
};

const getFileNameExtension = (fileName: string) => {
  const match = fileName.match(FILE_EXTENSION_REGEX);
  return match?.[1]?.toLowerCase() || "";
};

const createCompressionSource = (source: TrimSourceInput, fileName: string): PatchFileInstance => {
  if (source && typeof source === "object") {
    const sourceFile = source as PatchFileInstance;
    const getExtension =
      typeof sourceFile.getExtension === "function"
        ? () => sourceFile.getExtension?.() || ""
        : () => getFileNameExtension(fileName);
    return {
      ...(source as unknown as Record<string, unknown>),
      fileName,
      getExtension,
    } as PatchFileInstance;
  }
  return { fileName, getExtension: () => getFileNameExtension(fileName) } as unknown as PatchFileInstance;
};

const getTrimSourceSize = (source: TrimSourceInput) => {
  const record = source && typeof source === "object" ? (source as { fileSize?: unknown }) : null;
  if (typeof record?.fileSize === "number" && Number.isFinite(record.fileSize)) return record.fileSize;
  return getNamedSourceSize(source as SourceRef) ?? undefined;
};

const getTrimExport = (
  options: TrimWorkflowOptions | undefined,
  compression: CompressionFormat,
  source: TrimSourceInput,
  sourceFileName: string,
) => {
  if (compression === "none") return undefined;
  if (!(isArchiveCompressionFormat(compression) || isRomSpecificCompressionFormat(compression))) {
    throw new Error(`Unsupported trim output compression: ${String(compression)}`);
  }
  const container = options?.output?.container || {};
  const compressionSource = createCompressionSource(source, sourceFileName);
  const requestedFileName = String(getTrimOutputName(options) || "").trim() || sourceFileName;
  const archiveEntryName = isArchiveCompressionFormat(compression)
    ? getCompressionIntermediateFileName(requestedFileName, compression, compressionSource)
    : undefined;
  if (!shouldUseRustOutputExport(compression, options, compressionSource)) return undefined;
  const namedExportOptions = getRustOutputExportOptions(compression, options, undefined, archiveEntryName);
  if (compression !== "chd") return namedExportOptions;
  const requestedMode = String(container.chdOutputMode || "auto");
  const mode = requestedMode === "auto" ? getChdAutoCreateMode(compressionSource) : requestedMode;
  const modeExportOptions = getRustOutputExportOptions(compression, options, mode, archiveEntryName);
  const chdCodecs = OutputCompressionManager.getChdCodecsForMode(mode, {
    chdCreateCdCodecs:
      (container.chdCreateCdCodecs as string | null | undefined) || COMPRESSION_DEFAULTS.chdCreateCdCodecs,
    chdCreateDvdCodecs:
      (container.chdCreateDvdCodecs as string | null | undefined) || COMPRESSION_DEFAULTS.chdCreateDvdCodecs,
    compressionProfile: namedExportOptions.level,
  });
  return {
    ...modeExportOptions,
    ...(chdCodecs
      ? {
          codecs: chdCodecs
            .split(",")
            .map((codec) => codec.trim())
            .filter(Boolean),
        }
      : {}),
  };
};

const toTrimPublicOutput = async (file: PatchFileInstance, runtime: WorkflowRuntime) => {
  const fileName = file.fileName || "trimmed.bin";
  const source = getPatchFileExternalSource(file, fileName);
  if (!(source && runtime.output.createSource)) throw new Error(`Trim output is not filesystem-backed: ${fileName}`);
  const output = await runtime.output.createSource(source, fileName);
  const cleanup = getPatchFileCleanup(file);
  if (cleanup) {
    const baseDispose = output.dispose.bind(output);
    const dispose = createCleanupOnce(async () => {
      await baseDispose();
      await Promise.resolve(cleanup());
    });
    output.cleanup = dispose;
    output.dispose = dispose;
  }
  return output;
};

const resolveTrimOutputName = (
  requestedFileName: string,
  compression: CompressionFormat,
  options: TrimWorkflowOptions | undefined,
  source: TrimSourceInput,
  sourceFileName: string,
): string => {
  if (compression === "none") return requestedFileName;
  if (isArchiveCompressionFormat(compression) && hasArchiveFileName(requestedFileName, compression)) {
    return requestedFileName;
  }
  return getCompressedOutputFileName(
    requestedFileName,
    compression,
    (options?.output?.container || {}) as ArchiveOutputSettings,
    createCompressionSource(source, sourceFileName),
  );
};

const runTrimWorkflow = async (input: TrimInput, runtime: WorkflowRuntime): Promise<TrimResult> => {
  const options = input.options || {};
  requireOutputName(options.output?.outputName);

  const prepareTrimSource = (source: SourceRef, selectedArchiveEntry?: string): Promise<TrimSourceInput> => {
    if (!shouldPrepareWorkflowSource(source, options, selectedArchiveEntry)) {
      traceWorkflowStage(options, "stage.skip", "source.prepare", "input", {
        reason: "direct source",
        sourceName: getWorkflowSourceFileName(source, "input.bin"),
      });
      return Promise.resolve(source);
    }
    return traceWorkflowStageBlock(
      options,
      "source.prepare",
      "input",
      () =>
        prepareInputAssets(source, options, 0, runtime, selectedArchiveEntry).then((assets) => {
          const selected = getPrimaryInputAsset(assets);
          if (!selected) throw new Error("Trim source did not contain a trimmable file");
          return selected.file;
        }),
      () => ({
        selectedArchiveEntry,
        sourceName: getWorkflowSourceFileName(source, "input.bin"),
      }),
    );
  };

  const trimCapability = runtime.trim.trim;
  if (!trimCapability) throw new Error("Trimming requires the rom-weaver wasm runtime");

  const source = await prepareTrimSource(input.source, input.selectedSourceEntryName);
  const inputSize = getTrimSourceSize(source);
  const sourceFileName = getWorkflowSourceFileName(source, "trimmed.bin");
  const compressionSource = createCompressionSource(source, sourceFileName);
  const compression = getTrimOutputCompression(options, source);
  const requestedFileName =
    String(getTrimOutputName(options) || "").trim() || getWorkflowSourceFileName(source, "trimmed.bin");
  const outputName = resolveTrimOutputName(requestedFileName, compression, options, source, sourceFileName);
  const outputExport = getTrimExport(options, compression, source, sourceFileName);
  const useLegacyRomSpecificOutput =
    compression !== "none" &&
    isRomSpecificCompressionFormat(compression) &&
    !shouldUseRustOutputExport(compression, options, compressionSource);

  reportProgress(options, {
    label: "Trimming...",
    percent: null,
    stage: "apply",
  });
  const result = await traceWorkflowStageBlock(
    options,
    "trim",
    "output",
    () =>
      trimCapability({
        logLevel: getTrimLogLevel(options),
        onLog: options.onLog,
        onProgress: (progress) =>
          reportProgress(options, {
            label: typeof progress.label === "string" && progress.label ? progress.label : "Trimming...",
            percent: getProgressEventPercent(progress),
            stage: "apply",
          }),
        outputName,
        ...(outputExport ? { export: outputExport } : {}),
        signal: options.signal,
        source: source as SourceRef,
        threads: getTrimThreads(options),
      }),
    () => ({ worker: true }),
  );
  if (useLegacyRomSpecificOutput) {
    const rawFileName = getCompressionIntermediateFileName(requestedFileName, compression, compressionSource, {
      chdOutputMode: String(options.output?.container?.chdOutputMode || "auto"),
    });
    const trimmedFile = await createPatchFileFromPublicOutput(result.output, rawFileName, {
      materializeBlob: false,
      preferExternalFilePath: true,
    });
    trimmedFile.metadata = {
      ...compressionSource.metadata,
      ...trimmedFile.metadata,
    };
    trimmedFile.fileName = rawFileName;
    const compressedFile = await traceWorkflowStageBlock(
      options,
      "compress",
      "output",
      () =>
        createSingleFileRomSpecificOutput({
          compression,
          options,
          outputFile: trimmedFile,
          runtime,
        }),
      () => ({ format: compression, worker: false }),
    );
    if (!compressedFile) throw new Error(`Trim output compression is unavailable: ${compression}`);
    const output = await toTrimPublicOutput(compressedFile, runtime);
    return {
      ...result,
      output,
      sizeSummary: {
        ...result.sizeSummary,
        outputSize: output.size,
        ...(result.sizeSummary?.rawSize === undefined
          ? { rawSize: result.output.size }
          : { rawSize: result.sizeSummary.rawSize }),
      },
    };
  }
  return {
    ...result,
    sizeSummary: {
      ...result.sizeSummary,
      inputSize,
      outputSize: result.sizeSummary?.outputSize ?? result.output.size,
      ...(result.sizeSummary?.rawSize === undefined
        ? compression === "none"
          ? { rawSize: result.sizeSummary?.outputSize ?? result.output.size }
          : {}
        : { rawSize: result.sizeSummary.rawSize }),
    },
  };
};

export { runTrimWorkflow };
