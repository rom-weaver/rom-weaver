import { useCallback, useEffect, useRef, useState } from "react";
import { resolveAutomaticCompressionFormat } from "../../lib/compression/container-format-registry.ts";
import { getBaseFileName } from "../../lib/input/path-utils.ts";
import { emitTraceLog } from "../../lib/logging.ts";
import { buildPatchedOutputBaseName } from "../../lib/output/output-name-composition.ts";
import { getFileNameWithoutExtension } from "../../lib/path-utils.ts";
import { ApplyWorkflow, type BrowserApplyResult, type WorkflowProgress } from "../../platform/browser/browser-api.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import type { ApplyWorkflowInputState, ApplyWorkflowPatchState } from "../../types/apply-workflow.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime.ts";
import { createStageSettingsKey } from "./apply-session-settings.ts";
import type { StagedInputInfo } from "./apply-session-types.ts";
import { ApplyWorkflowFormView } from "./apply-workflow-form-view.tsx";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { useInputSelectionHandler } from "./input-selection-handler.ts";
import {
  getBinarySourceFileName,
  getBinarySourceListStableIds,
  getBinarySourceSize,
  sameBinarySourceLists,
} from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import { inertDialogController, useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import type {
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  CandidateSelectionPrompt,
  InternalApplyPatchFormProps,
} from "./public-types.ts";
import { toApplyWorkflowSettings, useApplySettings, useRomWeaverAssetBaseUrl } from "./settings-context.tsx";
import {
  createWorkflowFormError,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
} from "./workflow-adapters.ts";
import { createReactWorkflowId, formatChecksumTiming, formatElapsedMs } from "./workflow-form-utils.ts";

type ApplyWorkflowSessionInput = {
  inputs: BinarySource[];
  patches: BinarySource[];
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
  });
};

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
    formatPatchValidationValue("patch crc32", patch.requirements?.patchCrc32),
  ].filter(Boolean);
  const validationValues = requirementValues.length || !patch.patchValidation ? requirementValues : ["dry-run apply"];
  const actualValue = "";
  const status =
    patch.patchValidation?.status ||
    patch.checksumPreflight?.status ||
    (requirementValues.length ? "pending" : "unknown");
  const message =
    patch.patchValidation?.status === "valid"
      ? "Patch validation passed"
      : patch.patchValidation?.status === "invalid"
        ? patch.patchValidation.message || "Patch validation failed"
        : patch.patchValidation?.status === "pending"
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
    id: patch.id,
    order,
    parentCompressions: patch.parentCompressions,
    ppfUndo: patch.ppfUndo,
    size: patch.size,
    sourceChecksumState: patch.checksumPreflight?.status || "",
    sourceSize: patch.sourceSize,
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
      groupId: resolved.groupId,
      id: resolved.id,
      kind: resolved.kind,
      order: resolved.order ?? index,
      parentCompressions: resolved.parentCompressions,
      patchable: resolved.patchable ?? resolved.kind !== "cue",
      romProbe: resolved.romProbe || input.romProbe,
      size: resolved.size,
      sourceSize: resolved.sourceSize,
      splitBinAvailable: resolved.splitBinAvailable,
      wasDecompressed: resolved.wasDecompressed,
    };
  });
};

function ApplyPatchForm(props: ApplyPatchFormProps) {
  const providerSettings = useApplySettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const internalProps = props as InternalApplyPatchFormProps;
  const { startup, controllers } = internalProps;
  const handleSelectionCancelledRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => handleSelectionCancelledRef.current(request),
  });
  const [applyReady, setApplyReady] = useState(false);
  const [resolvedOutputCompression, setResolvedOutputCompression] = useState<CompressionFormat | undefined>(undefined);
  const [resolvedOutputName, setResolvedOutputName] = useState("");
  const [resolvedOutputNameKey, setResolvedOutputNameKey] = useState("");
  const workflowIdRef = useRef(createReactWorkflowId("react-apply"));
  const mutationQueueRef = useRef(Promise.resolve<void>(undefined));
  const selectFileRef = useRef(selectFile);
  selectFileRef.current = selectFile;
  useInputSelectionHandler(selectFile);
  const lastInputsRef = useRef<BinarySource[]>([]);
  const lastPatchOrderRef = useRef("");
  const forcePatchWorkflowRefreshRef = useRef(false);
  const workflowRef = useRef<ApplyWorkflow | null>(null);
  const workflowSyncRef = useRef<ApplyWorkflowSyncState>({
    executionSettingsKey: "",
    inputs: [],
    patches: [],
    preparationSettingsKey: "",
  });
  const workflowOutputOverridesKeyRef = useRef("");
  const prepareHandlersRef = useRef<ApplyWorkflowPrepareHandlers | null>(null);
  const propsWithSettings = {
    ...props,
    defaultSettings: props.defaultSettings || providerSettings,
    settings: props.settings,
  };
  const traceSettings = props.settings || props.defaultSettings || providerSettings;
  const emitApplyFormInputTrace = useCallback(
    (message: string, details?: Record<string, unknown>) => {
      emitTraceLog(
        {
          logLevel: traceSettings.logging?.level,
          namespace: "react:apply-form",
          onLog: traceSettings.logging?.sink,
        },
        message,
        details || {},
      );
    },
    [traceSettings],
  );

  const syncInputSelectionRefs = useCallback((inputs: BinarySource[]) => {
    if (!sameBinarySourceLists(lastInputsRef.current, inputs)) lastInputsRef.current = inputs.slice();
  }, []);

  const syncPatchSelectionRefs = useCallback((patches: BinarySource[]) => {
    const patchOrder = getBinarySourceListStableIds(patches).join("|");
    if (lastPatchOrderRef.current !== patchOrder) {
      forcePatchWorkflowRefreshRef.current = true;
      lastPatchOrderRef.current = patchOrder;
    }
  }, []);

  const syncSelectionRefs = useCallback(
    (snapshot: ApplyWorkflowSessionInput) => {
      syncInputSelectionRefs(snapshot.inputs);
      syncPatchSelectionRefs(snapshot.patches);
    },
    [syncInputSelectionRefs, syncPatchSelectionRefs],
  );

  const setResolvedOutputNameForSnapshot = useCallback((snapshot: ApplyWorkflowSessionInput, outputName: string) => {
    setResolvedOutputName(outputName);
    setResolvedOutputNameKey(getOutputSourceKey(snapshot.inputs, snapshot.patches));
  }, []);

  const handleLocalInputsChange = useCallback(
    (nextInputs: BinarySource[]) => {
      syncInputSelectionRefs(nextInputs);
      props.onInputsChange?.(nextInputs);
    },
    [props.onInputsChange, syncInputSelectionRefs],
  );

  const handleLocalPatchesChange = useCallback(
    (nextPatches: BinarySource[]) => {
      syncPatchSelectionRefs(nextPatches);
      props.onPatchesChange?.(nextPatches);
    },
    [props.onPatchesChange, syncPatchSelectionRefs],
  );

  const queueMutation = useCallback(<TValue,>(callback: () => Promise<TValue>) => {
    const run = mutationQueueRef.current.catch(() => undefined).then(callback);
    mutationQueueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const resetWorkflow = useCallback(() => {
    const workflow = workflowRef.current;
    workflowRef.current = null;
    workflowSyncRef.current = { executionSettingsKey: "", inputs: [], patches: [], preparationSettingsKey: "" };
    workflowOutputOverridesKeyRef.current = "";
    prepareHandlersRef.current = null;
    void workflow?.dispose();
  }, []);

  const getWorkflow = useCallback(() => {
    if (workflowRef.current) return workflowRef.current;
    workflowRef.current = new ApplyWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: workflowIdRef.current,
      selectFile: async (request) => {
        const handlers = prepareHandlersRef.current;
        const promptInputSelection = handlers?.selection?.promptInputSelection !== false;
        const promptPatchSelection = handlers?.selection?.promptPatchSelection !== false;
        if ((request.role === "input" && !promptInputSelection) || (request.role === "patch" && !promptPatchSelection))
          throw createWorkflowFormError("WORKFLOW_SELECTION_SKIPPED", `${request.sourceName} requires selection`);
        return selectFileRef.current(request);
      },
    });
    return workflowRef.current;
  }, [resolvedAssetBaseUrl]);

  useEffect(
    () => () => {
      resetWorkflow();
    },
    [resetWorkflow],
  );

  const emitWorkflowProgress = useCallback(
    (event: WorkflowProgress, onProgress?: (event: ProgressEvent) => void) => {
      const progressEvent = toReactProgressEvent(event);
      onProgress?.(progressEvent);
      props.onProgress?.(progressEvent);
      return { progressEvent, workflowProgress: event };
    },
    [props.onProgress],
  );

  const applyOutputOverrides = useCallback(async (workflow: ApplyWorkflow, snapshot: ApplyWorkflowSessionInput) => {
    const manualOutputName =
      typeof snapshot.options.output?.outputName === "string" && snapshot.options.output.outputName.trim()
        ? snapshot.options.output.outputName
        : "";
    if (manualOutputName) await workflow.setOutputName(manualOutputName);
    const compressionMode = snapshot.options.output?.compression || "auto";
    if (compressionMode !== "auto") await workflow.setOutputFormat(compressionMode);
  }, []);

  const syncWorkflowOutputOverrides = useCallback(
    async (
      workflow: ApplyWorkflow,
      snapshot: ApplyWorkflowSessionInput,
      baseSettings: ReturnType<typeof createBaseApplyWorkflowSettings>,
      baseSettingsChanged: boolean,
      options: { baseSettingsApplied?: boolean } = {},
    ) => {
      const outputOverridesKey = createWorkflowOutputOverridesKey(snapshot);
      const outputOverridesChanged = workflowOutputOverridesKeyRef.current !== outputOverridesKey;
      if (!(baseSettingsChanged || outputOverridesChanged)) return;
      if (!options.baseSettingsApplied) await workflow.setSettings(baseSettings);
      await applyOutputOverrides(workflow, snapshot);
      workflowOutputOverridesKeyRef.current = outputOverridesKey;
    },
    [applyOutputOverrides],
  );

  const prepareWorkflow = useCallback(
    async <TValue,>(
      snapshot: ApplyWorkflowSessionInput,
      handlers: ApplyWorkflowPrepareHandlers,
      callback: (prepared: {
        checksums: Record<string, string> | null;
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => Promise<TValue>,
    ): Promise<TValue> => {
      syncSelectionRefs(snapshot);
      emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow start", {
        inputCount: snapshot.inputs.length,
        inputs: summarizeApplyWorkflowSources(snapshot.inputs, "Input"),
        patchCount: snapshot.patches.length,
      });
      setResolvedOutputCompression(getApplyOutputCompression(snapshot, null));
      setResolvedOutputNameForSnapshot(snapshot, getAutomaticApplyOutputName(snapshot, null, []));
      const workflow = getWorkflow();
      prepareHandlersRef.current = handlers;
      const handleProgress = (event: WorkflowProgress) => handlers.onProgress?.(event);
      workflow.on("progress", handleProgress);
      try {
        const baseSettings = createBaseApplyWorkflowSettings(snapshot.options, props.workerThreads);
        const executionSettingsKey = createWorkflowSettingsKey(baseSettings);
        const preparationSettingsKey = createWorkflowPreparationSettingsKey(baseSettings);
        const previousSync = workflowSyncRef.current;
        const executionSettingsChanged = previousSync.executionSettingsKey !== executionSettingsKey;
        const preparationSettingsChanged = previousSync.preparationSettingsKey !== preparationSettingsKey;
        const inputsChanged =
          preparationSettingsChanged || !sameBinarySourceLists(previousSync.inputs, snapshot.inputs);
        const patchesChanged =
          forcePatchWorkflowRefreshRef.current ||
          preparationSettingsChanged ||
          !sameBinarySourceLists(previousSync.patches, snapshot.patches);
        // Appending patches keeps the existing prefix staged in the workflow (and OPFS).
        // Only the new tail needs addPatch, so skip the clear-and-re-add of everything.
        const previousPatches = previousSync.patches;
        const patchesAppended =
          patchesChanged &&
          !forcePatchWorkflowRefreshRef.current &&
          !preparationSettingsChanged &&
          !inputsChanged &&
          snapshot.patches.length > previousPatches.length &&
          sameBinarySourceLists(previousPatches, snapshot.patches.slice(0, previousPatches.length));
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow diff", {
          executionSettingsChanged,
          inputsChanged,
          patchesAppended,
          patchesChanged,
          preparationSettingsChanged,
        });
        if (executionSettingsChanged) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setSettings start");
          await workflow.setSettings(baseSettings);
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setSettings finish");
        }
        if (patchesChanged && !patchesAppended) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearPatches start");
          await workflow.clearPatches();
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearPatches finish");
        }
        if (!inputsChanged) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input skipped", {
            reason: "unchanged",
          });
        } else if (snapshot.inputs.length) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput start", {
            inputCount: snapshot.inputs.length,
          });
          await workflow.setInput(snapshot.inputs.map(toBrowserPublicBinarySource)).catch((error) => {
            emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput failed", {
              code: getErrorCode(error),
              message: error instanceof Error ? error.message : String(error),
            });
            if (getErrorCode(error) !== "WORKFLOW_SELECTION_SKIPPED") throw error;
          });
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput finish", {
            input: workflow.getInput(),
          });
          handlers.onInputState?.(workflow.getInput());
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input state emitted", {
            input: workflow.getInput(),
          });
        } else {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearInput start");
          await workflow.clearInput();
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearInput finish");
          handlers.onInputState?.(workflow.getInput());
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input state emitted", {
            input: workflow.getInput(),
          });
        }
        if (patchesChanged) {
          const patchesToAdd = patchesAppended ? snapshot.patches.slice(previousPatches.length) : snapshot.patches;
          for (const patch of patchesToAdd) {
            await workflow.addPatch(toBrowserPublicBinarySource(patch)).catch((error) => {
              if (getErrorCode(error) !== "WORKFLOW_SELECTION_SKIPPED") throw error;
            });
            handlers.onPatchState?.(workflow.getPatches());
          }
        }

        await syncWorkflowOutputOverrides(workflow, snapshot, baseSettings, executionSettingsChanged, {
          baseSettingsApplied: executionSettingsChanged,
        });
        workflowSyncRef.current = {
          executionSettingsKey,
          inputs: snapshot.inputs.slice(),
          patches: snapshot.patches.slice(),
          preparationSettingsKey,
        };
        forcePatchWorkflowRefreshRef.current = false;

        const input = workflow.getInput();
        const patches = workflow.getPatches();
        const checksums = input?.checksums || null;
        const outputCompression = getApplyOutputCompression(snapshot, input);
        setResolvedOutputCompression(outputCompression);
        setResolvedOutputNameForSnapshot(snapshot, getAutomaticApplyOutputName(snapshot, input, patches));
        handlers.onInputState?.(input);
        handlers.onPatchState?.(patches);
        if (input?.checksums) handlers.onChecksumReady?.(input);
        setApplyReady(
          !getWorkflowReadinessError(input, patches) &&
            (!snapshot.patches.length || patches.length === snapshot.patches.length),
        );
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow finish", {
          hasChecksums: !!input?.checksums,
          inputStatus: input?.status,
          patchCount: patches.length,
        });

        return await callback({
          checksums,
          input,
          patches,
          workflow,
        });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (
          (normalized as Error & { code?: string }).code === "INVALID_INPUT" &&
          snapshot.inputs.length > 1 &&
          snapshot.patches.length > 0
        ) {
          throw createWorkflowFormError("AMBIGUOUS_SELECTION", "Patch target selection is required");
        }
        throw normalized;
      } finally {
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow cleanup");
        prepareHandlersRef.current = null;
        workflow.off("progress", handleProgress);
      }
    },
    [
      getWorkflow,
      props.workerThreads,
      setResolvedOutputNameForSnapshot,
      syncSelectionRefs,
      syncWorkflowOutputOverrides,
    ],
  );

  const withPreparedWorkflow = useCallback(
    <TValue,>(
      snapshot: ApplyWorkflowSessionInput,
      handlers: ApplyWorkflowPrepareHandlers,
      callback: (prepared: {
        checksums: Record<string, string> | null;
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => Promise<TValue>,
    ): Promise<TValue> => {
      emitApplyWorkflowTrace(snapshot.options, "withPreparedWorkflow queued", {
        inputCount: snapshot.inputs.length,
        patchCount: snapshot.patches.length,
      });
      return queueMutation(() => prepareWorkflow(snapshot, handlers, callback));
    },
    [prepareWorkflow, queueMutation],
  );

  const applyPatches = useCallback(
    async (input: ApplyWorkflowSessionInput) => {
      const runPreparedWorkflow = async ({
        input: stagedInput,
        patches,
        workflow,
      }: {
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => {
        const readinessError = getWorkflowReadinessError(stagedInput, patches);
        if (readinessError) throw readinessError;
        const abortSignal = input.options.signal;
        const abortWorkflow = () => workflow.abort(abortSignal?.reason);
        if (abortSignal?.aborted) abortWorkflow();
        else abortSignal?.addEventListener("abort", abortWorkflow, { once: true });
        try {
          const result = (await workflow.run()) as BrowserApplyResult;
          props.onApplyComplete?.(result);
          return normalizeApplyResult(result);
        } finally {
          abortSignal?.removeEventListener("abort", abortWorkflow);
        }
      };

      return queueMutation(async () => {
        syncSelectionRefs(input);
        const baseSettings = createBaseApplyWorkflowSettings(input.options, props.workerThreads);
        const executionSettingsKey = createWorkflowSettingsKey(baseSettings);
        const preparationSettingsKey = createWorkflowPreparationSettingsKey(baseSettings);
        const previousSync = workflowSyncRef.current;
        const workflow = workflowRef.current;
        const workflowPrepared =
          !!workflow &&
          previousSync.preparationSettingsKey === preparationSettingsKey &&
          sameBinarySourceLists(previousSync.inputs, input.inputs) &&
          sameBinarySourceLists(previousSync.patches, input.patches) &&
          !forcePatchWorkflowRefreshRef.current;
        if (!(workflowPrepared && workflow)) {
          return prepareWorkflow(
            input,
            {
              onProgress: (event) => {
                emitWorkflowProgress(event, input.options.onProgress);
              },
            },
            runPreparedWorkflow,
          );
        }

        prepareHandlersRef.current = {
          onProgress: (event) => {
            emitWorkflowProgress(event, input.options.onProgress);
          },
        };
        const handleProgress = (event: WorkflowProgress) => prepareHandlersRef.current?.onProgress?.(event);
        workflow.on("progress", handleProgress);
        try {
          const executionSettingsChanged = previousSync.executionSettingsKey !== executionSettingsKey;
          await syncWorkflowOutputOverrides(workflow, input, baseSettings, executionSettingsChanged);
          if (executionSettingsChanged) {
            workflowSyncRef.current = {
              ...previousSync,
              executionSettingsKey,
            };
          }
          return await runPreparedWorkflow({
            input: workflow.getInput(),
            patches: workflow.getPatches(),
            workflow,
          });
        } finally {
          prepareHandlersRef.current = null;
          workflow.off("progress", handleProgress);
        }
      });
    },
    [
      emitWorkflowProgress,
      props.onApplyComplete,
      props.workerThreads,
      queueMutation,
      syncSelectionRefs,
      syncWorkflowOutputOverrides,
      prepareWorkflow,
    ],
  );

  const downloadOutput = useCallback((result: ApplyWorkflowResult, fileName?: string) => {
    if (typeof window !== "undefined") return result.output.saveAs?.(fileName ? { fileName } : undefined);
    return undefined;
  }, []);

  const stageInput = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      handlers: {
        onChecksum: (info: {
          archiveName?: string;
          checksums?: Record<string, string>;
          checksumVariants?: ApplyWorkflowInputState["checksumVariants"];
          decompressionTimeMs?: number;
          fileName?: string;
          romProbe?: ApplyWorkflowInputState["romProbe"];
          size?: number;
          sourceSize?: number;
          wasDecompressed?: boolean;
        }) => void;
        onImplicitPatches?: (patches: BinarySource[], infos?: Array<StagedInputInfo | null | undefined>) => void;
        onProgress: (event: ProgressEvent) => void;
        onState: (info: {
          archiveName?: string;
          checksums?: Record<string, string>;
          checksumVariants?: ApplyWorkflowInputState["checksumVariants"];
          decompressionTimeMs?: number;
          fileName?: string;
          romProbe?: ApplyWorkflowInputState["romProbe"];
          size?: number;
          sourceSize?: number;
          wasDecompressed?: boolean;
        }) => void;
      },
    ) => {
      emitApplyWorkflowTrace(input.options, "stageInput callback start", {
        inputCount: input.inputs.length,
        inputs: summarizeApplyWorkflowSources(input.inputs, "Input"),
      });
      return withPreparedWorkflow(
        input,
        {
          onChecksumReady: (state) => {
            for (const info of toStagedInputInfos(state, input.inputs)) {
              if (info) handlers.onChecksum(info);
            }
          },
          onInputState: (state) => {
            for (const info of toStagedInputInfos(state, input.inputs)) {
              if (info) handlers.onState(info);
            }
          },
          onProgress: (event) => {
            const emitted = emitWorkflowProgress(event);
            if (emitted.workflowProgress.role === "input") handlers.onProgress(emitted.progressEvent);
          },
        },
        async ({ input: stagedInput, workflow }) => {
          const infos = toStagedInputInfos(stagedInput, input.inputs);
          if (!input.patches.length) {
            const implicitPatchSources = workflow.getPatchSources().filter(isReactBinarySource);
            if (implicitPatchSources.length) {
              const inputLabelById = new Map(infos.map((entry) => [entry.id || "", entry.fileName || "Input"]));
              const implicitPatchInfos = workflow.getPatches().map((patch, index) => {
                const targetName =
                  patch?.targetInputFileName ||
                  (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
                  "None selected";
                return toPatchStageInfo(
                  patch,
                  getReactBinarySourceFileName(implicitPatchSources[index] || null, `Patch ${index + 1}`),
                  index,
                  `Target: ${targetName}`,
                );
              });
              handlers.onImplicitPatches?.(implicitPatchSources, implicitPatchInfos);
            }
          }
          emitApplyWorkflowTrace(input.options, "stageInput callback finish", {
            infoCount: infos.length,
            infos,
            inputStatus: stagedInput?.status,
          });
          return infos;
        },
      );
    },
    [emitWorkflowProgress, withPreparedWorkflow],
  );

  const stagePatches = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      handlers: {
        onProgress: (event: ProgressEvent) => void;
      },
    ) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return withPreparedWorkflow(
        input,
        {
          onProgress: (event) => {
            const emitted = emitWorkflowProgress(event);
            if (emitted.workflowProgress.role === "patch") handlers.onProgress(emitted.progressEvent);
          },
          selection: {
            promptInputSelection: false,
            promptPatchSelection: true,
          },
        },
        async ({ input: stagedInput, patches }) => {
          const inputLabelById = new Map(
            toStagedInputInfos(stagedInput, input.inputs).map((entry) => [entry.id || "", entry.fileName || "Input"]),
          );
          return patches.map((patch, index) => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(
              patch,
              originalNames[index] || `Patch ${index + 1}`,
              index,
              `Target: ${targetName}`,
            );
          });
        },
      );
    },
    [emitWorkflowProgress, withPreparedWorkflow],
  );

  const setPatchTarget = useCallback(
    async (input: ApplyWorkflowSessionInput, patchIndex: number, targetInputId: string) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return withPreparedWorkflow(
        input,
        {
          selection: {
            promptInputSelection: false,
            promptPatchSelection: false,
          },
        },
        async ({ input: stagedInput, workflow }) => {
          await workflow.setPatchTarget(patchIndex, targetInputId || "auto");
          const refreshedInput = workflow.getInput();
          const refreshedPatches = workflow.getPatches();
          setApplyReady(
            !getWorkflowReadinessError(refreshedInput, refreshedPatches) &&
              refreshedPatches.length === input.patches.length,
          );
          const inputLabelById = new Map(
            toStagedInputInfos(refreshedInput || stagedInput, input.inputs).map((entry) => [
              entry.id || "",
              entry.fileName || "Input",
            ]),
          );
          return refreshedPatches.map((patch, index) => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(
              patch,
              originalNames[index] || `Patch ${index + 1}`,
              index,
              `Target: ${targetName}`,
            );
          });
        },
      );
    },
    [withPreparedWorkflow],
  );

  const setPatchOption = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      patchIndex: number,
      option: { ppfUndo?: boolean; validateInputChecksum?: string; validateOutputChecksum?: string },
    ) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return withPreparedWorkflow(
        input,
        {
          selection: {
            promptInputSelection: false,
            promptPatchSelection: false,
          },
        },
        async ({ input: stagedInput, workflow }) => {
          await workflow.setPatchOption(patchIndex, option);
          const refreshedInput = workflow.getInput();
          const refreshedPatches = workflow.getPatches();
          const inputLabelById = new Map(
            toStagedInputInfos(refreshedInput || stagedInput, input.inputs).map((entry) => [
              entry.id || "",
              entry.fileName || "Input",
            ]),
          );
          return refreshedPatches.map((patch, index) => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(
              patch,
              originalNames[index] || `Patch ${index + 1}`,
              index,
              `Target: ${targetName}`,
            );
          });
        },
      );
    },
    [withPreparedWorkflow],
  );

  const { localUiController, localStackController, localOutputController, localNoticeController } =
    useLocalApplyPatchFormSession({
      ...propsWithSettings,
      applyPatches,
      applyReady,
      downloadOutput,
      onApplyComplete: () => undefined,
      onInputsChange: handleLocalInputsChange,
      onPatchesChange: handleLocalPatchesChange,
      resolvedOutputCompression,
      resolvedOutputName,
      resolvedOutputNameKey,
      setPatchOption,
      setPatchTarget,
      stageInput,
      stagePatches,
    });
  const resolvedUiController = controllers?.ui || localUiController;
  const resolvedStackController = controllers?.patchStack || localStackController;

  handleSelectionCancelledRef.current = (request) => {
    const normalizedSourceName = request.sourceName.trim().toLowerCase();
    if (request.role === "patch") {
      const items = resolvedStackController.getState().items;
      const matchingIndex = items.findIndex((item) =>
        [item.fileName, item.archiveFileName].some((value) => value.trim().toLowerCase() === normalizedSourceName),
      );
      const removeIndex = matchingIndex >= 0 ? matchingIndex : items.length - 1;
      if (removeIndex >= 0) resolvedStackController.removeItem(removeIndex);
      return;
    }
    if (request.role !== "input") return;
    const romInputs = resolvedUiController.getState().romInputs;
    const matchingInput = romInputs.find((entry) =>
      [entry.info.fileName, entry.info.archiveName].some(
        (value) => value.trim().toLowerCase() === normalizedSourceName,
      ),
    );
    const fallbackInput = romInputs[romInputs.length - 1];
    const removeId = matchingInput?.id || fallbackInput?.id;
    if (removeId) resolvedUiController.removeRomInput?.(removeId);
  };

  return (
    <>
      <ApplyWorkflowFormView
        controllers={{
          dialog: controllers?.dialog || inertDialogController,
          notice: controllers?.notice || localNoticeController,
          output: controllers?.output || localOutputController,
          patchStack: resolvedStackController,
          ui: resolvedUiController,
        }}
        onTrace={emitApplyFormInputTrace}
        startup={startup}
      />
      {candidateSelectionDialog}
    </>
  );
}

export { ApplyPatchForm };
