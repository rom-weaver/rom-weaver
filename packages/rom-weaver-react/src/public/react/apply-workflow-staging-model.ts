import { resolveAutomaticCompressionFormat } from "../../lib/compression/container-format-registry.ts";
import { getBaseFileName } from "../../lib/input/path-utils.ts";
import { buildPatchedOutputBaseName } from "../../lib/output/output-name-composition.ts";
import { getFileNameWithoutExtension } from "../../lib/path-utils.ts";
import type { ApplyWorkflow, BrowserApplyResult, WorkflowProgress } from "../../platform/browser/browser-api.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import { createStageSettingsKey } from "./apply-session-settings.ts";
import { getBinarySourceFileName, getBinarySourceListStableIds, getBinarySourceSize } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { ApplyPatchFormSettings } from "./public-types.ts";
import { toApplyWorkflowSettings } from "./settings-context.tsx";
import { createWorkflowFormError, getReactBinarySourceFileName } from "./workflow-adapters.ts";
import { formatChecksumTiming } from "./workflow-form-utils.ts";

/**
 * Pure model helpers for the apply-patch staging workflow, extracted from
 * `ApplyPatchForm`. These own the snapshot/settings/output-name derivations, the
 * patch/input "stage info" view-model projections, the readiness validation and
 * the result normalization - none of which touch React state. Keeping them here
 * leaves the form as a thin orchestrator over the workflow runtime and lets the
 * derivations be unit-tested in isolation.
 */

/** Per-patch user options (Options drawer state) that must survive a run
 * re-stage: a filtered run (disabled patches stripped) rebuilds the workflow
 * stages from scratch, so the run replays these onto the fresh stages. */
type ApplyPatchRunOptions = {
  header?: "keep" | "strip";
  ppfUndo?: boolean;
  validateInputChecksum?: string;
  validateOutputChecksum?: string;
};

type ApplyWorkflowSessionInput = {
  inputs: BinarySource[];
  patches: BinarySource[];
  /** Index-aligned with `patches`. */
  patchOptions?: ApplyPatchRunOptions[];
  options: ApplyPatchFormSettings & {
    output: NonNullable<ApplyPatchFormSettings["output"]> & {
      compression: "auto" | CompressionFormat;
    };
    signal?: AbortSignal;
    workerThreads?: number | string;
    containerInputsEnabled?: boolean;
    onProgress?: (event: ProgressEvent) => void;
  };
};

type ApplyWorkflowPrepareHandlers = {
  onChecksumReady?: (input: ApplyWorkflowInputState) => void;
  onInputState?: (input: ApplyWorkflowInputState | null) => void;
  onPatchState?: (patches: ApplyWorkflowPatchState[]) => void;
  onProgress?: (event: WorkflowProgress) => void;
  selection?: {
    promptInputSelection?: boolean;
    promptPatchSelection?: boolean;
  };
};

type PreparedApplyWorkflow = {
  checksums: Record<string, string> | null;
  input: ApplyWorkflowInputState | null;
  patches: ApplyWorkflowPatchState[];
  workflow: ApplyWorkflow;
};

// A single staging member (one bucket) folded into a coalesced prepareWorkflow pass. Progress is
// emitted once at the merged-handler level and routed by role, so the one concurrent extraction
// drives the ROM rows (input role) AND the patch cards (patch role) instead of one bucket's pass
// dropping the other bucket's progress events.
type StageBatchHandlers = {
  onChecksumReady?: ApplyWorkflowPrepareHandlers["onChecksumReady"];
  onInputProgress?: (event: ProgressEvent) => void;
  onInputState?: ApplyWorkflowPrepareHandlers["onInputState"];
  onPatchProgress?: (event: ProgressEvent) => void;
  // Fires the moment a patch finishes its eager parse (before its addPatch mutation, which is queued
  // behind the ROM's setInput). Lets the card show the parsed info immediately instead of holding
  // "Reading…" until the ROM finishes staging.
  onPatchStaged?: (info: PatchStageInfo, order: number) => void;
  selection?: ApplyWorkflowPrepareHandlers["selection"];
};

type StageBatchMember = {
  handlers: StageBatchHandlers;
  run: (prepared: PreparedApplyWorkflow) => Promise<void>;
  fail: (error: unknown) => void;
};

type ApplyWorkflowSyncState = {
  executionSettingsKey: string;
  inputs: BinarySource[];
  patches: BinarySource[];
  preparationSettingsKey: string;
};

const getOutputSourceKey = (inputs: BinarySource[], patches: BinarySource[]) =>
  JSON.stringify({
    inputs: getBinarySourceListStableIds(inputs),
    patches: getBinarySourceListStableIds(patches),
  });

const getApplyOutputCompression = (
  snapshot: ApplyWorkflowSessionInput,
  input: ApplyWorkflowInputState | null,
): CompressionFormat => {
  const configuredCompression = snapshot.options.output?.compression || "auto";
  if (configuredCompression !== "auto") return configuredCompression;
  const sourceName = snapshot.inputs[0] ? getReactBinarySourceFileName(snapshot.inputs[0], "") : "";
  return resolveAutomaticCompressionFormat({
    parentCompressions: input?.parentCompressions,
    sourceFileName: sourceName,
    sourceSize: input?.size ?? getBinarySourceSize(snapshot.inputs[0]),
  });
};

// Pre-stage estimate only (the controller owns the post-stage resolved name, including the
// disc-name special-casing). Pre-stage there is no staged input, so the dropped file name is used.
const getAutomaticApplyOutputName = (
  snapshot: ApplyWorkflowSessionInput,
  input: ApplyWorkflowInputState | null,
  patches: ApplyWorkflowPatchState[],
) => {
  const inputFileName = input?.fileName || getReactBinarySourceFileName(snapshot.inputs[0], "patched.bin");
  const inputBase = getFileNameWithoutExtension(inputFileName) || "patched";
  const patchNames = patches
    .map((patch, index) => {
      const patchFileName =
        patch.fileName || getReactBinarySourceFileName(snapshot.patches[index], `patch ${index + 1}`);
      // Keep any trailing `[label]`; `buildPatchedOutputBaseName` extracts and formats it.
      return getFileNameWithoutExtension(patchFileName);
    })
    .filter(Boolean);
  return buildPatchedOutputBaseName(inputBase, patchNames);
};

const formatPatchValidationValue = (label: string, value: number | string | undefined) => {
  if (value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `${label}=${Math.floor(value)}`;
  return `${label}=${String(value).trim()}`;
};

const getPatchValidationDetails = (patch: ApplyWorkflowPatchState) => {
  const requirementValues = [
    formatPatchValidationValue("in size", patch.requirements?.sourceSize),
    formatPatchValidationValue("in min size", patch.requirements?.minimumSourceSize),
    formatPatchValidationValue("in crc32", patch.requirements?.sourceCrc32),
    formatPatchValidationValue("out size", patch.requirements?.targetSize),
    formatPatchValidationValue("out crc32", patch.requirements?.targetCrc32),
  ].filter(Boolean);
  const actualValue = "";
  // The deep dry-run validation is deferred and runs silently after staging. Until its verdict
  // lands, a targeted patch (its cheap preflight computed) reads as "verifying"; a preflight checksum
  // mismatch fails immediately without waiting for the dry-run. Once the verdict lands it wins.
  const deep = patch.patchValidation;
  let status: string;
  if (deep) status = deep.status;
  else if (patch.checksumPreflight?.status === "invalid") status = "invalid";
  else if (patch.checksumPreflight) status = "verifying";
  else status = requirementValues.length ? "pending" : "unknown";
  const validationValues = requirementValues.length
    ? requirementValues
    : deep || patch.checksumPreflight
      ? ["dry-run apply"]
      : [];
  const message =
    status === "verifying"
      ? "Verifying patch against the ROM…"
      : deep?.status === "valid"
        ? "Patch validation passed"
        : deep?.status === "invalid"
          ? deep.message || "Patch validation failed"
          : deep?.status === "pending"
            ? "Patch validation pending"
            : status === "valid"
              ? "Source requirements matched"
              : status === "invalid"
                ? "Source requirements mismatch"
                : status === "pending"
                  ? "Source requirements pending"
                  : "Patch does not provide source requirements";
  return {
    checksumMismatch: status === "invalid",
    checksumTiming: formatChecksumTiming(patch.checksumTimeMs),
    validationActualValue: actualValue,
    validationLabel: requirementValues.length ? "Expected" : "Validation",
    validationMessage: message,
    validationState: status,
    validationValues,
  };
};

const toPatchStageInfo = (
  patch: ApplyWorkflowPatchState | undefined,
  originalName: string,
  order: number,
  targetLabel: string,
) => {
  if (!patch) return null;
  const selectedCandidatePath =
    patch.selectedCandidateId &&
    patch.candidates.find(
      (candidate): candidate is Extract<(typeof patch.candidates)[number], { type: "file" }> =>
        candidate.type === "file" && candidate.id === patch.selectedCandidateId && !!candidate.fileName,
    )?.fileName;
  const fileName = selectedCandidatePath || patch.fileName || originalName;
  let archiveName = "";
  if (patch.parentCompressions?.length) {
    archiveName = [...patch.parentCompressions]
      .sort((left, right) => left.depth - right.depth)
      .map((entry) => entry.fileName)
      .filter((entry): entry is string => !!entry)
      .join(" > ");
  } else if (originalName && fileName && originalName !== fileName) {
    archiveName = originalName;
  }
  const validation = getPatchValidationDetails(patch);
  return {
    archiveName,
    checksumPreflightMismatch: validation.checksumMismatch,
    checksumTiming: validation.checksumTiming,
    decompressionTimeMs: patch.decompressionTimeMs,
    fileName,
    format: patch.requirements?.format,
    headerChoice: patch.headerChoice,
    headerStrippedBytes: patch.headerResolution?.strippedBytes,
    id: patch.id,
    order,
    parentCompressions: patch.parentCompressions,
    // Only surface a header choice when there is actually a strippable header AND the
    // required checksums didn't already decide what to do with it.
    showHeaderOption: !!patch.headerResolution && !patch.headerResolution.decided,
    size: patch.size,
    sourceChecksumState: patch.checksumPreflight?.status || "",
    sourceSize: patch.sourceSize,
    targetInputFileName: patch.targetInputFileName,
    targetInputId: patch.targetInputId,
    targetLabel,
    validateInputChecksum: patch.validateInputChecksum,
    validateOutputChecksum: patch.validateOutputChecksum,
    validationActualValue: validation.validationActualValue,
    validationLabel: validation.validationLabel,
    validationMessage: validation.validationMessage,
    validationState: validation.validationState,
    validationValues: validation.validationValues,
    wasDecompressed: patch.wasDecompressed,
  };
};

type PatchStageInfo = ReturnType<typeof toPatchStageInfo>;

const getPatchTargetSelectionError = (input: ApplyWorkflowInputState | null, patches: ApplyWorkflowPatchState[]) => {
  if (!input || input.status !== "ready") return null;
  for (const patch of patches) {
    if (!(patch.status === "needsSelection" && patch.selectedCandidateId)) continue;
    const warning = patch.warnings.find(
      (entry) => entry.code === "AMBIGUOUS_SELECTION" || entry.code === "PATCH_TARGET_MISMATCH",
    );
    return createWorkflowFormError(
      warning?.code || "AMBIGUOUS_SELECTION",
      warning?.message || `${patch.fileName || "Patch"} target selection is required`,
    );
  }
  return null;
};

const getWorkflowReadinessError = (input: ApplyWorkflowInputState | null, patches: ApplyWorkflowPatchState[]) => {
  if (!input) return createWorkflowFormError("INVALID_INPUT", "Input source is required");
  if (input.status !== "ready" || !input.selectedCandidateId)
    return createWorkflowFormError("AMBIGUOUS_SELECTION", "Input selection is required");
  const patchTargetError = getPatchTargetSelectionError(input, patches);
  if (patchTargetError) return patchTargetError;
  const unresolvedPatch = patches.find((patch) => patch.status !== "ready");
  if (!unresolvedPatch) return null;
  return createWorkflowFormError("AMBIGUOUS_SELECTION", `${unresolvedPatch.fileName || "Patch"} requires selection`);
};

const normalizeApplyResult = (result: BrowserApplyResult): ApplyWorkflowResult => {
  const outputs = result.outputs.map((output) => ({
    cleanup: output.dispose,
    dispose: output.dispose,
    fileName: output.fileName,
    mediaType: undefined,
    path: "" as ApplyWorkflowResult["output"]["path"],
    prepareDownload: output.prepareDownload,
    saveAs: (destination?: unknown) => output.saveAs(destination as Parameters<typeof output.saveAs>[0]),
    size: output.size || 0,
    vfs: {} as ApplyWorkflowResult["output"]["vfs"],
  })) as unknown as ApplyWorkflowResult["outputs"];
  return {
    inputs: result.inputs,
    output: outputs[0] as ApplyWorkflowResult["output"],
    outputs,
    patches: result.patches,
    rom: {
      fileName: result.inputs[0]?.fileName || "",
      size: result.inputs[0]?.size || 0,
    },
    sizeSummary: result.sizeSummary,
  } as ApplyWorkflowResult;
};

const createBaseApplyWorkflowSettings = (
  options: ApplyWorkflowSessionInput["options"],
  workerThreads?: number | string,
) => {
  const {
    containerInputsEnabled,
    onProgress: _onProgress,
    signal: _signal,
    workerThreads: optionWorkerThreads,
    ...settingsInput
  } = options;
  const settings = toApplyWorkflowSettings(
    {
      ...settingsInput,
      input: {
        ...settingsInput.input,
        containerInputsEnabled,
      },
    },
    optionWorkerThreads || workerThreads,
  );
  return {
    ...settings,
    output: {
      ...(settings.output || {}),
      compression: undefined,
      outputName: undefined,
    },
  };
};

const createWorkflowSettingsKey = (settings: Partial<ApplyPatchFormSettings>) =>
  JSON.stringify(settings, (_key, value) => (typeof value === "function" ? "[function]" : value));

const createWorkflowPreparationSettingsKey = (settings: ApplyPatchFormSettings) =>
  createStageSettingsKey({
    containerInputsEnabled: settings.input?.containerInputsEnabled,
    settings,
    workerThreads: settings.workers?.threads,
  });

const createWorkflowOutputOverridesKey = (snapshot: ApplyWorkflowSessionInput) =>
  JSON.stringify({
    compression: snapshot.options.output?.compression || "auto",
    outputName:
      typeof snapshot.options.output?.outputName === "string" ? snapshot.options.output.outputName.trim() : "",
  });

const emitApplyWorkflowTrace = (
  options: ApplyWorkflowSessionInput["options"],
  message: string,
  details?: Record<string, unknown>,
) => {
  if (String(options.logging?.level || "").toLowerCase() !== "trace") return;
  options.logging?.sink?.({
    ...(details ? { details } : {}),
    level: "trace",
    message,
    namespace: "react:apply-workflow",
    timestamp: new Date().toISOString(),
  });
};

const summarizeApplyWorkflowSource = (source: BinarySource, fallback: string) => ({
  fileName: getBinarySourceFileName(source, fallback),
  size: getBinarySourceSize(source) ?? undefined,
});

const summarizeApplyWorkflowSources = (sources: BinarySource[], fallbackPrefix: string) =>
  sources.map((source, index) => summarizeApplyWorkflowSource(source, `${fallbackPrefix} ${index + 1}`));

const isReactBinarySource = (source: unknown): source is BinarySource =>
  (typeof File !== "undefined" && source instanceof File) ||
  (!!source &&
    typeof source === "object" &&
    (source as { kind?: unknown }).kind === "file" &&
    typeof (source as { getFile?: unknown }).getFile === "function");

const getSelectedFileCandidatePath = (
  candidates: ApplyWorkflowInputState["candidates"],
  selectedCandidateId: string | undefined,
) =>
  selectedCandidateId
    ? candidates.find(
        (candidate): candidate is Extract<ApplyWorkflowInputState["candidates"][number], { type: "file" }> =>
          candidate.type === "file" && candidate.id === selectedCandidateId && !!candidate.fileName,
      )?.fileName || ""
    : "";

const shouldPreferSelectedCandidatePath = (selectedCandidatePath: string, resolvedFileName: string | undefined) => {
  if (!selectedCandidatePath) return false;
  if (!resolvedFileName) return true;
  return getBaseFileName(selectedCandidatePath).toLowerCase() === getBaseFileName(resolvedFileName).toLowerCase();
};

const getResolvedInputArchiveName = (
  resolved: NonNullable<ApplyWorkflowInputState["resolvedInputs"]>[number],
  input: ApplyWorkflowInputState,
  originals: BinarySource[],
  index: number,
) => {
  if (resolved.parentCompressions?.length) {
    return [...resolved.parentCompressions]
      .sort((left, right) => left.depth - right.depth)
      .map((entry) => entry.fileName)
      .filter((entry): entry is string => !!entry)
      .join(" > ");
  }

  const originalName = getReactBinarySourceFileName(originals[resolved.order ?? index], "");
  const selectedCandidatePath = getSelectedFileCandidatePath(input.candidates, resolved.selectedCandidateId);
  const resolvedFileName = resolved.fileName || input.fileName;
  const resolvedName = shouldPreferSelectedCandidatePath(selectedCandidatePath, resolvedFileName)
    ? selectedCandidatePath
    : resolvedFileName;
  return originalName && resolvedName && originalName !== resolvedName ? originalName : "-";
};

const toStagedInputInfos = (input: ApplyWorkflowInputState | null, originals: BinarySource[]) => {
  if (!input) return [];
  const fallbackResolvedInput: NonNullable<ApplyWorkflowInputState["resolvedInputs"]>[number] = {
    checksums: input.checksums,
    checksumTimeMs: input.checksumTimeMs,
    decompressionTimeMs: input.decompressionTimeMs,
    fileName: input.fileName,
    id: input.id,
    order: 0,
    parentCompressions: input.parentCompressions,
    romProbe: input.romProbe,
    romType: input.romType,
    selected: true,
    selectedCandidateId: input.selectedCandidateId,
    size: input.size,
    sourceSize: input.sourceSize,
    wasDecompressed: input.wasDecompressed,
  };
  const resolvedInputs = input.resolvedInputs?.length ? input.resolvedInputs : [fallbackResolvedInput];
  return resolvedInputs.map((resolved, index) => {
    const selectedCandidatePath = getSelectedFileCandidatePath(input.candidates, resolved.selectedCandidateId);
    const resolvedFileName =
      resolved.fileName ||
      input.fileName ||
      getReactBinarySourceFileName(originals[resolved.order ?? index], `Input ${index + 1}`);
    const stagedFileName = shouldPreferSelectedCandidatePath(selectedCandidatePath, resolvedFileName)
      ? selectedCandidatePath
      : resolvedFileName;
    return {
      archiveName: getResolvedInputArchiveName(resolved, input, originals, index),
      chdMode: resolved.chdMode ?? input.chdMode,
      checksums: resolved.checksums || undefined,
      checksumTiming: formatChecksumTiming(resolved.checksumTimeMs ?? input.checksumTimeMs),
      checksumVariants: resolved.checksumVariants || input.checksumVariants,
      cueText: resolved.cueText,
      decompressionTimeMs: resolved.decompressionTimeMs,
      fileName: stagedFileName,
      gdiText: resolved.gdiText,
      groupId: resolved.groupId,
      id: resolved.id,
      kind: resolved.kind,
      order: resolved.order ?? index,
      parentCompressions: resolved.parentCompressions,
      patchable: resolved.patchable ?? (resolved.kind !== "cue" && resolved.kind !== "gdi"),
      romProbe: resolved.romProbe || input.romProbe,
      romType: resolved.romType || input.romType,
      size: resolved.size,
      sourceSize: resolved.sourceSize,
      splitBinAvailable: resolved.splitBinAvailable,
      wasDecompressed: resolved.wasDecompressed,
    };
  });
};

export {
  type ApplyPatchRunOptions,
  type ApplyWorkflowPrepareHandlers,
  type ApplyWorkflowSessionInput,
  type ApplyWorkflowSyncState,
  createBaseApplyWorkflowSettings,
  createWorkflowOutputOverridesKey,
  createWorkflowPreparationSettingsKey,
  createWorkflowSettingsKey,
  emitApplyWorkflowTrace,
  getApplyOutputCompression,
  getAutomaticApplyOutputName,
  getOutputSourceKey,
  getWorkflowReadinessError,
  isReactBinarySource,
  normalizeApplyResult,
  type PatchStageInfo,
  type PreparedApplyWorkflow,
  type StageBatchHandlers,
  type StageBatchMember,
  summarizeApplyWorkflowSources,
  toPatchStageInfo,
  toStagedInputInfos,
};
