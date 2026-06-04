import {
  createDiscExtensionRegex,
  DISC_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../../lib/compression/disc-format-support.ts";
import { isArchiveFile } from "../../lib/input/archive-type-utils.ts";
import {
  createPatchFile,
  getDefaultCreatePatchOutputFileName,
  getPatchFileBytes,
} from "../../lib/input/binary-service.ts";
import { classifyPatcherInput, getInputSourceFileName } from "../../lib/input/input-classification.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import { getNamedSource, getNamedSourceFileName } from "../../storage/shared/binary/source-file-utils.ts";
import type { DirectSource, SourceRef } from "../../types/source.ts";
import type { CreateWorkflowDeps, PatchFileInstance } from "../../types/workflow-internal.ts";
import type { CreatePatchInput, CreatePatchResult, JsonValue } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { patchWorkflowDeps } from "../apply/workflow.ts";
import {
  createSingleFileArchiveOutput,
  getArchiveOutputCompression,
  hasArchiveFileName,
} from "../output/archive-output-service.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";

const DISC_INPUT_EXTENSION_REGEX = createDiscExtensionRegex(DISC_DECOMPRESSION_INPUT_EXTENSIONS);
const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
type JsonObject = { [key: string]: JsonValue };
type CreateSourceInput = PatchFileInstance | SourceRef;

const getCreateFormat = (options: CreatePatchInput["options"]) => options?.format || "ips";
const getCreateLogLevel = (options: CreatePatchInput["options"]) => options?.logging?.level;
const getCreateWorkerThreads = (options: CreatePatchInput["options"]) => options?.workers?.threads;
const getCreateMetadata = (options: CreatePatchInput["options"]): JsonObject =>
  (options?.patch?.metadata || {}) as JsonObject;
const getCreateCompression = (options: CreatePatchInput["options"]) => options?.output?.compression;
const getCreateOutputName = (options: CreatePatchInput["options"]) => options?.output?.outputName;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("create");

const createClassificationSource = (
  source: SourceRef,
  deps: Pick<CreateWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
) => {
  const directSource = deps.getNamedSource(source) as DirectSource;
  const fileName = deps.getNamedSourceFileName(source);
  if (!fileName || directSource === source) return source;
  if (typeof Blob !== "undefined" && directSource instanceof Blob) return { _file: directSource, fileName };
  if (directSource && typeof directSource === "object") return { ...directSource, fileName };
  return directSource;
};

const shouldPrepareCreateSource = (
  source: SourceRef,
  options: CreatePatchInput["options"] | undefined,
  selectedArchiveEntry: string | undefined,
  deps: Pick<CreateWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
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

const getCreateSourceFileName = (
  source: CreateSourceInput,
  fallback: string,
  deps: Pick<CreateWorkflowDeps, "getNamedSource" | "getNamedSourceFileName">,
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

const runCreateWorkflow = async (
  input: CreatePatchInput,
  runtime: WorkflowRuntime,
  deps: CreateWorkflowDeps,
): Promise<CreatePatchResult> => {
  const options = input.options || {};
  requireOutputName(options.output?.outputName);
  const format = getCreateFormat(options);
  const optionsForRole = (role: "original" | "modified") => ({
    ...options,
    onCandidatesFound: options.onCandidatesFound
      ? (event: Parameters<NonNullable<typeof options.onCandidatesFound>>[0]) =>
          options.onCandidatesFound?.({ ...event, role } as typeof event)
      : undefined,
  });
  const prepareCreateSource = (
    source: SourceRef,
    role: "original" | "modified",
    selectedArchiveEntry?: string,
  ): Promise<CreateSourceInput> => {
    if (!shouldPrepareCreateSource(source, options, selectedArchiveEntry, deps)) {
      traceWorkflowStage(options, "stage.skip", "source.prepare", role, {
        reason: "direct source",
        sourceName: getCreateSourceFileName(source, `${role}.bin`, deps),
      });
      return Promise.resolve(source);
    }
    return traceWorkflowStageBlock(
      options,
      "source.prepare",
      role,
      () =>
        deps.prepareInputAssets(source, optionsForRole(role), 0, runtime, selectedArchiveEntry).then((assets) => {
          const selected = assets.find((asset) => asset.patchable) || assets[0];
          if (!selected) throw new Error(`${role} source did not contain a patchable file`);
          return selected.file;
        }),
      () => ({
        selectedArchiveEntry,
        sourceName: getCreateSourceFileName(source, `${role}.bin`, deps),
      }),
    );
  };

  const createCompressedPatchOutput = async (patchFile: PatchFileInstance) => {
    const compression = getArchiveOutputCompression(getCreateCompression(options), "create patch");
    if (compression === "none") {
      traceWorkflowStage(options, "stage.skip", "compress", "output", { reason: "output compression disabled" });
      return deps.toPublicOutput(patchFile, runtime);
    }
    return createSingleFileArchiveOutput({
      compression,
      deps,
      entryFile: patchFile,
      entryNameDetailKey: "patchEntryName",
      fallbackEntryName: patchFile.fileName || `patch.${format}`,
      options,
      runtime,
      trace: (operation, details) => traceWorkflowStageBlock(options, "compress", "output", operation, details),
      unsupportedRuntimeMessage: "Patch output compression requires the rom-weaver wasm runtime",
    });
  };

  const createPatchCapability = runtime.patch.createPatch;
  const shouldUseWorkerCreate = !!createPatchCapability;
  const original = await prepareCreateSource(input.original, "original", input.selectedOriginalEntryName);
  const requestedFileName =
    getCreateOutputName(options) ||
    deps.getDefaultCreatePatchOutputFileName(getCreateSourceFileName(original, "original.bin", deps), format);
  const compression = getArchiveOutputCompression(getCreateCompression(options), "create patch");
  const rawPatchFileName =
    compression !== "none" && deps.hasArchiveFileName(requestedFileName, compression)
      ? deps.getDefaultCreatePatchOutputFileName(getCreateSourceFileName(original, "original.bin", deps), format)
      : requestedFileName;

  if (shouldUseWorkerCreate) {
    deps.reportProgress(options, {
      label: "Creating patch...",
      percent: null,
      stage: "apply",
    });
    const modified = await prepareCreateSource(input.modified, "modified", input.selectedModifiedEntryName);
    const result = await traceWorkflowStageBlock(
      options,
      "create",
      "output",
      () =>
        createPatchCapability({
          format,
          logLevel: getCreateLogLevel(options),
          metadata: getCreateMetadata(options),
          modified: modified as SourceRef,
          onLog: options.onLog,
          onProgress: (progress) =>
            deps.reportProgress(options, {
              label: typeof progress.label === "string" && progress.label ? progress.label : "Creating patch...",
              percent: getProgressEventPercent(progress),
              stage: "apply",
            }),
          original: original as SourceRef,
          outputName: rawPatchFileName,
          workerThreads: getCreateWorkerThreads(options),
        }),
      () => ({ patchType: format, worker: true }),
    );
    if (compression === "none") return result;
    const patchFile = await createPatchFileFromPublicOutput(result.output, rawPatchFileName);
    const output = await createCompressedPatchOutput(patchFile);
    return {
      format,
      output,
      sizeSummary: {
        ...(result.sizeSummary || {}),
        outputSize: output.size,
        rawSize: patchFile.fileSize,
      },
    };
  }

  throw new Error("Patch creation requires the rom-weaver wasm runtime");
};

const createWorkflowDeps: CreateWorkflowDeps = {
  ...(patchWorkflowDeps as unknown as CreateWorkflowDeps),
  createPatchFile,
  getDefaultCreatePatchOutputFileName,
  getNamedSource,
  getNamedSourceFileName,
  getPatchFileBytes,
  hasArchiveFileName,
};

export { createWorkflowDeps, runCreateWorkflow };
