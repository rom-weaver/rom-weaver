import { resolveCompressionLevels } from "../../lib/compression/compression-settings.ts";
import {
  createDiscExtensionRegex,
  DISC_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../../lib/compression/disc-format-support.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { isArchiveFile } from "../../lib/input/archive-type-utils.ts";
import { getPatchFileBytes } from "../../lib/input/binary-service.ts";
import { classifyPatcherInput, getInputSourceFileName } from "../../lib/input/input-classification.ts";
import {
  createCompressionProgressLabelFromEvent,
  getProgressEventPercent,
} from "../../presentation/workflow-presentation.ts";
import { getNamedSource, getNamedSourceFileName } from "../../storage/shared/binary/source-file-utils.ts";
import type { DirectSource, SourceRef } from "../../types/source.ts";
import type { CreateWorkflowDeps, PatchFileInstance, SharedProgressEventLike } from "../../types/workflow-internal.ts";
import type {
  JsonValue,
  SevenZipZstdCompressionOptions,
  TrimInput,
  TrimResult,
  TrimWorkflowOptions,
} from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createWorkflowDeps } from "../create/workflow.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";

const DISC_INPUT_EXTENSION_REGEX = createDiscExtensionRegex(DISC_DECOMPRESSION_INPUT_EXTENSIONS);
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const ZIP_COMPRESSED_EXTENSION_REGEX = /\.(zip|zipx)$/i;
const SEVEN_ZIP_EXTENSION_REGEX = /\.7z$/i;
type TrimSourceInput = PatchFileInstance | SourceRef;
type TrimWorkflowDeps = CreateWorkflowDeps;

const getTrimLogLevel = (options: TrimWorkflowOptions | undefined) => options?.logging?.level;
const getTrimWorkerThreads = (options: TrimWorkflowOptions | undefined) => options?.workers?.threads;
const getTrimCompression = (options: TrimWorkflowOptions | undefined) => options?.output?.compression;
const getTrimOutputName = (options: TrimWorkflowOptions | undefined) => options?.output?.outputName;
const getTrimContainerSettings = (options: TrimWorkflowOptions | undefined) => options?.output?.container || {};
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("trim");

const getArchiveCompression = (value: string | number | boolean | null | undefined) => {
  const compression = OutputCompressionManager.normalizeOutputCompression(value || "none");
  if (compression !== "none" && compression !== "zip" && compression !== "7z") {
    throw new Error(`Unsupported trim output compression: ${compression}`);
  }
  return compression;
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
    if (DISC_INPUT_EXTENSION_REGEX.test(directSource)) return options?.input?.containerInputsEnabled !== false;
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

  const createCompressedTrimOutput = async (trimmedFile: PatchFileInstance): Promise<TrimResult["output"]> => {
    const compression = getArchiveCompression(getTrimCompression(options));
    if (compression === "none") {
      traceWorkflowStage(options, "stage.skip", "compress", "output", { reason: "output compression disabled" });
      return deps.toPublicOutput(trimmedFile, runtime);
    }
    const requestedFileName = String(getTrimOutputName(options) || "").trim();
    const trimEntryName =
      requestedFileName && !deps.hasArchiveFileName(requestedFileName, compression)
        ? requestedFileName
        : trimmedFile.fileName || "trimmed.bin";
    trimmedFile.fileName = trimEntryName;
    const archiveSettings = getTrimContainerSettings(options);
    const compressionSettings = resolveCompressionLevels({
      compressionProfile: archiveSettings.profile || "max",
      sevenZipCodec: archiveSettings.sevenZipCodec,
      sevenZipLevel: archiveSettings.sevenZipLevel,
      zipCodec: archiveSettings.zipCodec,
      zipLevel: archiveSettings.zipLevel,
    });
    const createArchive = runtime.compression.create;
    if (!createArchive) throw new Error("Trim output compression requires the rom-weaver wasm runtime");
    const outputName =
      requestedFileName && deps.hasArchiveFileName(requestedFileName, compression)
        ? requestedFileName
        : OutputCompressionManager.getCompressedFileName({ fileName: trimEntryName }, compression, compressionSettings);
    const compressionOptions: SevenZipZstdCompressionOptions = {
      compression,
      compressionProfile:
        compressionSettings.compressionProfile as SevenZipZstdCompressionOptions["compressionProfile"],
      onProgress: (progress: SharedProgressEventLike) => {
        const formatLabel = compression === "zip" ? "ZIP" : "7z";
        const progressDetails =
          progress.details && typeof progress.details === "object" && !Array.isArray(progress.details)
            ? (progress.details as Record<string, JsonValue>)
            : {};
        deps.reportProgress(options, {
          details: {
            ...(progress as Record<string, JsonValue>),
            ...progressDetails,
            runtimeStage: progressDetails.runtimeStage || progress.stage,
            stage: "compress",
          },
          label: createCompressionProgressLabelFromEvent({
            fallbackLabel: `Compressing to ${formatLabel}`,
            formatLabel,
            progress,
            threads: getTrimWorkerThreads(options),
          }),
          percent: getProgressEventPercent(progress),
          stage: "output",
        });
      },
      outputName,
      sevenZipCodec: compressionSettings.sevenZipCodec as SevenZipZstdCompressionOptions["sevenZipCodec"],
      sevenZipLevel: compressionSettings.sevenZipLevel,
      workerThreads: getTrimWorkerThreads(options),
      zipCodec: compressionSettings.zipCodec as SevenZipZstdCompressionOptions["zipCodec"],
      zipLevel: compressionSettings.zipLevel,
    };
    const compressionResult = await traceWorkflowStageBlock(
      options,
      "compress",
      "output",
      () =>
        createArchive({
          entries: [
            {
              data: deps.getPatchFileBytes(trimmedFile),
              fileName: trimEntryName,
              filename: trimEntryName,
            },
          ],
          format: compression,
          options: compressionOptions,
        }),
      () => ({
        compression,
        entryCount: 1,
        trimEntryName,
      }),
    );
    if ("output" in compressionResult) return compressionResult.output;
    return compressionResult;
  };

  const trimCapability = runtime.trim.trim;
  if (!trimCapability) throw new Error("Trimming requires the rom-weaver wasm runtime");

  const source = await prepareTrimSource(input.source, input.selectedSourceEntryName);
  const requestedFileName =
    String(getTrimOutputName(options) || "").trim() || getTrimSourceFileName(source, "trimmed.bin", deps);
  const compression = getArchiveCompression(getTrimCompression(options));
  const rawTrimFileName =
    compression !== "none" && deps.hasArchiveFileName(requestedFileName, compression)
      ? getTrimSourceFileName(source, "trimmed.bin", deps)
      : requestedFileName;

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
        source: source as SourceRef,
        workerThreads: getTrimWorkerThreads(options),
      }),
    () => ({ worker: true }),
  );
  if (compression === "none") return result;
  const trimmedFile = await createPatchFileFromPublicOutput(result.output, rawTrimFileName);
  return {
    output: await createCompressedTrimOutput(trimmedFile),
  };
};

const hasArchiveFileName = (fileName: string, compression: string) =>
  compression === "zip" ? ZIP_COMPRESSED_EXTENSION_REGEX.test(fileName) : SEVEN_ZIP_EXTENSION_REGEX.test(fileName);

const trimWorkflowDeps: TrimWorkflowDeps = {
  ...(createWorkflowDeps as unknown as TrimWorkflowDeps),
  getNamedSource,
  getNamedSourceFileName,
  getPatchFileBytes,
  hasArchiveFileName,
};

export type { TrimWorkflowDeps };
export { runTrimWorkflow, trimWorkflowDeps };
