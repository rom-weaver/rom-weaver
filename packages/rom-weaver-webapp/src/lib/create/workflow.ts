import { getDefaultCreatePatchOutputFileName } from "../../lib/input/binary-service.ts";
import { getPrimaryInputAsset } from "../../lib/input/input-assets.ts";
import { prepareInputAssets } from "../../lib/input/input-preparation-service.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import type { SourceRef } from "../../types/source.ts";
import type { ArchiveOutputSettings } from "../../types/workflow-compression.ts";
import type { PatchFileInstance } from "../../types/workflow-internal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CreatePatchInput, CreatePatchResult, JsonValue } from "../../types/workflow-runtime-types.ts";
import { getArchiveOutputCompression, hasArchiveFileName } from "../output/archive-output-service.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { getRustOutputExportOptions } from "../output/output-build-service.ts";
import { getCompressedOutputFileName } from "../output/output-files.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { getWorkflowSourceFileName, shouldPrepareWorkflowSource } from "../workflow/source-preparation.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";

type JsonObject = { [key: string]: JsonValue };
type CreateSourceInput = PatchFileInstance | SourceRef;

const CRC32_HEX_REGEX = /^[0-9a-f]{8}$/;

const getCreateFormat = (options: CreatePatchInput["options"]) => options?.format || "bps";
const getCreateLogLevel = (options: CreatePatchInput["options"]) => options?.logging?.level;
const getCreateThreads = (options: CreatePatchInput["options"]) => options?.workers?.threads;
const getCreateMetadata = (options: CreatePatchInput["options"]): JsonObject =>
  (options?.patch?.metadata || {}) as JsonObject;
const getCreateCompression = (options: CreatePatchInput["options"]) => options?.output?.compression;
const getCreateOutputName = (options: CreatePatchInput["options"]) => options?.output?.outputName;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("create");

const resolveCreateOutputName = (
  requestedFileName: string,
  compression: string,
  options: CreatePatchInput["options"],
): string => {
  if (compression === "none" || hasArchiveFileName(requestedFileName, compression)) return requestedFileName;
  return getCompressedOutputFileName(
    requestedFileName,
    compression,
    (options?.output?.container || {}) as ArchiveOutputSettings,
  );
};

const runCreateWorkflow = async (input: CreatePatchInput, runtime: WorkflowRuntime): Promise<CreatePatchResult> => {
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
    if (!shouldPrepareWorkflowSource(source, options, selectedArchiveEntry)) {
      traceWorkflowStage(options, "stage.skip", "source.prepare", role, {
        reason: "direct source",
        sourceName: getWorkflowSourceFileName(source, `${role}.bin`),
      });
      return Promise.resolve(source);
    }
    return traceWorkflowStageBlock(
      options,
      "source.prepare",
      role,
      () =>
        prepareInputAssets(source, optionsForRole(role), 0, runtime, selectedArchiveEntry).then((assets) => {
          const selected = getPrimaryInputAsset(assets);
          if (!selected) throw new Error(`${role} source did not contain a patchable file`);
          return selected.file;
        }),
      () => ({
        selectedArchiveEntry,
        sourceName: getWorkflowSourceFileName(source, `${role}.bin`),
      }),
    );
  };

  const createPatchCapability = runtime.patch.createPatch;
  const shouldUseWorkerCreate = !!createPatchCapability;
  const original = await prepareCreateSource(input.original, "original", input.selectedOriginalEntryName);

  if (shouldUseWorkerCreate) {
    reportProgress(options, {
      label: "Creating patch...",
      percent: null,
      stage: "create",
    });
    const modified = await prepareCreateSource(input.modified, "modified", input.selectedModifiedEntryName);
    const defaultPatchFileName = getDefaultCreatePatchOutputFileName(
      getWorkflowSourceFileName(modified, "modified.bin"),
      format,
    );
    const requestedFileName = getCreateOutputName(options) || defaultPatchFileName;
    const compression = getArchiveOutputCompression(getCreateCompression(options), "create patch");
    const outputName = resolveCreateOutputName(requestedFileName, compression, options);
    const archiveEntryName =
      compression === "none"
        ? undefined
        : hasArchiveFileName(requestedFileName, compression)
          ? defaultPatchFileName
          : requestedFileName;
    const outputExport =
      compression === "none"
        ? undefined
        : getRustOutputExportOptions(compression, options, undefined, archiveEntryName);
    // Embed the source crc32 into the patch file name via Rust `--checksum-name`
    // (the engine owns the parse/embed; see patch_filename_checksum.rs) so
    // checksumless formats round trip a "right ROM?" guard back into apply/validate.
    // Pass the already-known crc32 so Rust need not re-read the original; it renames
    // the emitted file, which flows back as the output name.
    const normalizedSourceCrc32 = String(input.originalCrc32 || "")
      .trim()
      .toLowerCase();
    const sourceCrc32 = CRC32_HEX_REGEX.test(normalizedSourceCrc32) ? normalizedSourceCrc32 : undefined;
    const result = await traceWorkflowStageBlock(
      options,
      "create",
      "output",
      () =>
        createPatchCapability({
          checksumName: !!sourceCrc32,
          format,
          logLevel: getCreateLogLevel(options),
          metadata: getCreateMetadata(options),
          modified: modified as SourceRef,
          onLog: options.onLog,
          onProgress: (progress) =>
            reportProgress(options, {
              label: typeof progress.label === "string" && progress.label ? progress.label : "Creating patch...",
              percent: getProgressEventPercent(progress),
              stage: "create",
            }),
          original: original as SourceRef,
          outputName,
          ...(outputExport ? { export: outputExport } : {}),
          signal: options.signal,
          sourceCrc32,
          threads: getCreateThreads(options),
        }),
      () => ({ patchType: format, worker: true }),
    );
    return {
      ...result,
      sizeSummary: {
        ...result.sizeSummary,
        outputSize: result.sizeSummary?.outputSize ?? result.output.size,
        ...(result.sizeSummary?.rawSize === undefined
          ? compression === "none"
            ? { rawSize: result.sizeSummary?.outputSize ?? result.output.size }
            : {}
          : { rawSize: result.sizeSummary.rawSize }),
      },
    };
  }

  throw new Error("Patch creation requires the rom-weaver wasm runtime");
};

export { runCreateWorkflow };
