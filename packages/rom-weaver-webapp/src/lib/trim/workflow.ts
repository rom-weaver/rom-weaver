import { getPatchFileBytes } from "../../lib/input/binary-service.ts";
import { getPrimaryInputAsset } from "../../lib/input/input-assets.ts";
import { prepareInputAssets } from "../../lib/input/input-preparation-service.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import { getNamedSourceSize } from "../../storage/shared/binary/source-file-utils.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { SourceRef } from "../../types/source.ts";
import type { PatchFileInstance } from "../../types/workflow-internal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { TrimInput, TrimResult, TrimWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import {
  isArchiveCompressionFormat,
  isRomSpecificCompressionFormat,
} from "../compression/container-format-registry.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { toPublicOutput } from "../apply/patch-apply-service.ts";
import { createSingleFileArchiveOutput, hasArchiveFileName } from "../output/archive-output-service.ts";
import { createSingleFileRomSpecificOutput } from "../output/output-build-service.ts";
import { getCompressionIntermediateFileName } from "../output/output-files.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import {
  getWorkflowSourceFileName,
  roundElapsedMs,
  shouldPrepareWorkflowSource,
} from "../workflow/source-preparation.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";

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

  const createCompressedTrimOutput = async (
    trimmedFile: PatchFileInstance,
    compression: CompressionFormat,
  ): Promise<TrimResult["output"]> => {
    if (compression === "none") {
      traceWorkflowStage(options, "stage.skip", "compress", "output", { reason: "output compression disabled" });
      return toPublicOutput(trimmedFile, runtime);
    }
    if (isArchiveCompressionFormat(compression)) {
      return createSingleFileArchiveOutput({
        compression,
        deps: { getPatchFileBytes, hasArchiveFileName },
        entryFile: trimmedFile,
        entryNameDetailKey: "trimEntryName",
        fallbackEntryName: trimmedFile.fileName || "trimmed.bin",
        options,
        runtime,
        trace: (operation, details) => traceWorkflowStageBlock(options, "compress", "output", operation, details),
        unsupportedRuntimeMessage: "Trim output compression requires the rom-weaver wasm runtime",
      });
    }
    if (isRomSpecificCompressionFormat(compression)) {
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
        () => ({
          compression,
          trimEntryName: trimmedFile.fileName || "trimmed.bin",
        }),
      );
      if (!compressedFile) throw new Error("Runtime disc compression create capability is unavailable");
      return toPublicOutput(compressedFile, runtime);
    }
    throw new Error(`Unsupported trim output compression: ${String(compression)}`);
  };

  const trimCapability = runtime.trim.trim;
  if (!trimCapability) throw new Error("Trimming requires the rom-weaver wasm runtime");

  const source = await prepareTrimSource(input.source, input.selectedSourceEntryName);
  const inputSize = getTrimSourceSize(source);
  const sourceFileName = getWorkflowSourceFileName(source, "trimmed.bin");
  const compression = getTrimOutputCompression(options, source);
  const requestedFileName =
    String(getTrimOutputName(options) || "").trim() || getWorkflowSourceFileName(source, "trimmed.bin");
  const rawTrimFileName =
    compression === "none"
      ? requestedFileName
      : getCompressionIntermediateFileName(
          requestedFileName,
          compression,
          createCompressionSource(source, sourceFileName),
          {
            chdOutputMode: "auto",
          },
        );

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
        outputName: rawTrimFileName,
        signal: options.signal,
        source: source as SourceRef,
        threads: getTrimThreads(options),
      }),
    () => ({ worker: true }),
  );
  const rawSize = result.sizeSummary?.outputSize ?? result.output.size;
  if (compression === "none") {
    return {
      ...result,
      sizeSummary: {
        ...result.sizeSummary,
        inputSize,
        outputSize: result.output.size,
        rawSize,
      },
    };
  }
  // ROM-specific (disc) compression stages the trimmed output from its VFS path (see
  // createRuntimeSourceFromPatchFile), so keep it lazy and never materialize the (often multi-GiB)
  // trim output on the main thread. Archive compression reads the bytes synchronously and needs them.
  const trimmedFile = await createPatchFileFromPublicOutput(
    result.output,
    rawTrimFileName,
    isRomSpecificCompressionFormat(compression) ? { materializeBlob: false, preferExternalFilePath: true } : undefined,
  );
  const output = await createCompressedTrimOutput(trimmedFile, compression);
  const compressionTimeMs = roundElapsedMs(output?.timing);
  return {
    output,
    sizeSummary: {
      ...result.sizeSummary,
      ...(compressionTimeMs === undefined ? {} : { compressionTimeMs }),
      inputSize,
      outputSize: output.size,
      rawSize: trimmedFile.fileSize,
    },
  };
};

export { runTrimWorkflow };
