import {
  createRomSpecificExtensionRegex,
  ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../../lib/compression/rom-specific-format-support.ts";
import { isArchiveFile } from "../../lib/input/archive-type-utils.ts";
import { getPatchFileBytes } from "../../lib/input/binary-service.ts";
import { classifyPatcherInput, getInputSourceFileName } from "../../lib/input/input-classification.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { DirectSource, SourceRef } from "../../types/source.ts";
import type { CreateWorkflowDeps, PatchFileInstance } from "../../types/workflow-internal.ts";
import type { TrimInput, TrimResult, TrimWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { isRomSpecificCompressionFormat } from "../compression/container-format-registry.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { createWorkflowDeps } from "../create/workflow.ts";
import { createSingleFileArchiveOutput, hasArchiveFileName } from "../output/archive-output-service.ts";
import { createSingleFileRomSpecificOutput } from "../output/output-build-service.ts";
import { getCompressionIntermediateFileName } from "../output/output-files.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";

const ROM_SPECIFIC_INPUT_EXTENSION_REGEX = createRomSpecificExtensionRegex(ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS);
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const FILE_EXTENSION_REGEX = /\.([^./\\?#]+)(?:[?#].*)?$/;
type TrimSourceInput = PatchFileInstance | SourceRef;
type TrimWorkflowDeps = CreateWorkflowDeps;
type OutputCompressionSource = Parameters<typeof OutputCompressionManager.resolveOutputCompression>[0];

const getTrimLogLevel = (options: TrimWorkflowOptions | undefined) => options?.logging?.level;
const getTrimWorkerThreads = (options: TrimWorkflowOptions | undefined) => options?.workers?.threads;
const getTrimCompression = (options: TrimWorkflowOptions | undefined) => options?.output?.compression;
const getTrimOutputName = (options: TrimWorkflowOptions | undefined) => options?.output?.outputName;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("trim");

const getOutputTimingMs = (output: TrimResult["output"] | undefined): number | undefined => {
  const elapsedMs = output?.timing?.elapsedMs;
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? Math.round(elapsedMs)
    : undefined;
};

const isArchiveOutputCompression = (compression: CompressionFormat): compression is "7z" | "zip" =>
  compression === "7z" || compression === "zip";

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

const createClassificationSource = (
  source: SourceRef,
  deps: Pick<TrimWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
) => {
  const directSource = deps.getNamedSource(source) as DirectSource;
  const fileName = deps.getNamedSourceFileName(source);
  if (!fileName || directSource === source) return source;
  if (typeof Blob !== "undefined" && directSource instanceof Blob) return { _file: directSource, fileName };
  if (directSource && typeof directSource === "object") return { ...directSource, fileName };
  return directSource;
};

const shouldPrepareTrimSource = (
  source: SourceRef,
  options: TrimWorkflowOptions | undefined,
  selectedArchiveEntry: string | undefined,
  deps: Pick<TrimWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
) => {
  if (selectedArchiveEntry) return true;
  const directSource = deps.getNamedSource(source) as DirectSource;
  if (typeof directSource === "string") {
    if (isArchiveFile(directSource)) return options?.input?.containerInputsEnabled !== false;
    if (ROM_SPECIFIC_INPUT_EXTENSION_REGEX.test(directSource)) return options?.input?.containerInputsEnabled !== false;
    return false;
  }
  const classification = classifyPatcherInput(createClassificationSource(source, deps));
  return classification.kind === "compression" ? options?.input?.containerInputsEnabled !== false : false;
};

const getTrimSourceFileName = (
  source: TrimSourceInput,
  fallback: string,
  deps: Pick<TrimWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
) => {
  const namedFileName = deps.getNamedSourceFileName(source as SourceRef, { fallback: "" });
  if (namedFileName) return namedFileName;
  const directSource = deps.getNamedSource(source as SourceRef);
  if (typeof directSource === "string" && directSource.trim()) {
    const normalized = directSource.replace(/\\/g, "/").replace(FILE_QUERY_OR_HASH_REGEX, "");
    const slashIndex = normalized.lastIndexOf("/");
    return normalized.slice(slashIndex + 1) || fallback;
  }
  return getInputSourceFileName(source) || fallback;
};

const getTrimSourceSize = (source: TrimSourceInput) => {
  const record = source && typeof source === "object" ? (source as { fileSize?: unknown }) : null;
  if (typeof record?.fileSize === "number" && Number.isFinite(record.fileSize)) return record.fileSize;
  return getNamedSourceSize(source as SourceRef) ?? undefined;
};

const runTrimWorkflow = async (
  input: TrimInput,
  runtime: WorkflowRuntime,
  deps: TrimWorkflowDeps,
): Promise<TrimResult> => {
  const options = input.options || {};
  requireOutputName(options.output?.outputName);

  const prepareTrimSource = (source: SourceRef, selectedArchiveEntry?: string): Promise<TrimSourceInput> => {
    if (!shouldPrepareTrimSource(source, options, selectedArchiveEntry, deps)) {
      traceWorkflowStage(options, "stage.skip", "source.prepare", "input", {
        reason: "direct source",
        sourceName: getTrimSourceFileName(source, "input.bin", deps),
      });
      return Promise.resolve(source);
    }
    return traceWorkflowStageBlock(
      options,
      "source.prepare",
      "input",
      () =>
        deps.prepareInputAssets(source, options, 0, runtime, selectedArchiveEntry).then((assets) => {
          const selected = assets.find((asset) => asset.patchable) || assets[0];
          if (!selected) throw new Error("Trim source did not contain a trimmable file");
          return selected.file;
        }),
      () => ({
        selectedArchiveEntry,
        sourceName: getTrimSourceFileName(source, "input.bin", deps),
      }),
    );
  };

  const createCompressedTrimOutput = async (
    trimmedFile: PatchFileInstance,
    compression: CompressionFormat,
  ): Promise<TrimResult["output"]> => {
    if (compression === "none") {
      traceWorkflowStage(options, "stage.skip", "compress", "output", { reason: "output compression disabled" });
      return deps.toPublicOutput(trimmedFile, runtime);
    }
    if (isArchiveOutputCompression(compression)) {
      return createSingleFileArchiveOutput({
        compression,
        deps,
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
      return deps.toPublicOutput(compressedFile, runtime);
    }
    throw new Error(`Unsupported trim output compression: ${compression}`);
  };

  const trimCapability = runtime.trim.trim;
  if (!trimCapability) throw new Error("Trimming requires the rom-weaver wasm runtime");

  const source = await prepareTrimSource(input.source, input.selectedSourceEntryName);
  const inputSize = getTrimSourceSize(source);
  const sourceFileName = getTrimSourceFileName(source, "trimmed.bin", deps);
  const compression = getTrimOutputCompression(options, source);
  const requestedFileName =
    String(getTrimOutputName(options) || "").trim() || getTrimSourceFileName(source, "trimmed.bin", deps);
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

  deps.reportProgress(options, {
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
          deps.reportProgress(options, {
            label: typeof progress.label === "string" && progress.label ? progress.label : "Trimming...",
            percent: getProgressEventPercent(progress),
            stage: "apply",
          }),
        outputName: rawTrimFileName,
        signal: options.signal,
        source: source as SourceRef,
        workerThreads: getTrimWorkerThreads(options),
      }),
    () => ({ worker: true }),
  );
  const rawSize = result.sizeSummary?.outputSize ?? result.output.size;
  if (compression === "none") {
    return {
      ...result,
      sizeSummary: {
        ...(result.sizeSummary || {}),
        inputSize,
        outputSize: result.output.size,
        rawSize,
      },
    };
  }
  const trimmedFile = await createPatchFileFromPublicOutput(result.output, rawTrimFileName);
  const output = await createCompressedTrimOutput(trimmedFile, compression);
  const compressionTimeMs = getOutputTimingMs(output);
  return {
    output,
    sizeSummary: {
      ...(result.sizeSummary || {}),
      ...(compressionTimeMs === undefined ? {} : { compressionTimeMs }),
      inputSize,
      outputSize: output.size,
      rawSize: trimmedFile.fileSize,
    },
  };
};

const trimWorkflowDeps: TrimWorkflowDeps = {
  ...(createWorkflowDeps as unknown as TrimWorkflowDeps),
  getNamedSource,
  getNamedSourceFileName,
  getPatchFileBytes,
  hasArchiveFileName,
};

export type { TrimWorkflowDeps };
export { runTrimWorkflow, trimWorkflowDeps };
