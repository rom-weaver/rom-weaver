import Download from "lucide-react/dist/esm/icons/download.js";
import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPreferredCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import {
  type BrowserCreateResult,
  type BrowserSaveDestination,
  type CreateSettings,
  CreateWorkflow,
  getCreatePatchFormatCandidates,
  type RuntimePatchCreateFormatCandidates,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { InfoPopover } from "./components/ds/layout.tsx";
import { OutputRunAction, WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import { ROM_INPUT_HINT } from "./input-helper-text.ts";
import { useInputSelectionHandler } from "./input-selection-handler.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import { createCreateOutputCompressionOptions, createCreatePatchFormatOptions } from "./output-view-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import {
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toStagedInputInfo,
} from "./workflow-adapters.ts";
import { createReactWorkflowId, createSettingsDependencyKey, mergeSettingsWithOutput } from "./workflow-form-utils.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
  type WorkflowFormProgressState,
} from "./workflow-run-hooks.ts";

const resolveCreateExecutionOutputName = (outputName: string, patchType: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, patchType || "bps");
};

const getFileExtensionLabel = (fileName: string) => {
  const extension = fileName.trim().match(/(\.[^./\\]+)$/)?.[1];
  return extension || fileName;
};

const getCompressionRatioLabel = (
  compression: "7z" | "none" | "zip",
  outputSize?: number | null,
  rawSize?: number | null,
) => {
  if (compression === "none") return undefined;
  if (
    typeof outputSize !== "number" ||
    !Number.isFinite(outputSize) ||
    typeof rawSize !== "number" ||
    !Number.isFinite(rawSize) ||
    rawSize <= 0
  ) {
    return undefined;
  }
  return `${Math.round((outputSize / rawSize) * 100)}%`;
};

const getCompletedDownloadMeta = ({
  compression,
  fileName,
  patchType,
  rawSize,
  size,
}: {
  compression: "7z" | "none" | "zip";
  fileName: string;
  patchType: string;
  rawSize?: number | null;
  size?: number | null;
}) => ({
  format: `.${patchType || getFileExtensionLabel(fileName).replace(/^\./, "") || "patch"}`,
  name: compression === "none" ? undefined : getFileExtensionLabel(fileName),
  ratio: getCompressionRatioLabel(compression, size, rawSize),
  size: typeof size === "number" && Number.isFinite(size) ? formatByteSize(size) : undefined,
});

type CreateDisplaySourceState = CreateWorkflowSourceState;
type CreatePatchFormatCandidateState = RuntimePatchCreateFormatCandidates & {
  key: string;
};
type CompletedCreateOutput = {
  compression: "7z" | "none" | "zip";
  compressionTimeMs?: number;
  createTimeMs?: number;
  fileName: string;
  patchType: string;
  rawSize?: number;
  saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
  size?: number;
};
type CreateMessagePlacement = "modified" | "original" | "output";

const getDisplaySourceInfo = (source: CreateDisplaySourceState | null | undefined, fallback: string) =>
  toStagedInputInfo(source, fallback);

const formatElapsedMs = (elapsedMs: number | undefined) =>
  typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatTiming(createTiming(elapsedMs)) : "";

const formatChecksumTiming = (elapsedMs: number | undefined) =>
  elapsedMs === 0 ? "from extract" : formatElapsedMs(elapsedMs);

const getDisplaySourceChecksums = (source: CreateDisplaySourceState | null | undefined) =>
  (source as (CreateDisplaySourceState & { checksums?: Record<string, string> }) | null | undefined)?.checksums;

const getDisplaySourceChecksumTiming = (source: CreateDisplaySourceState | null | undefined) =>
  formatChecksumTiming(
    (source as (CreateDisplaySourceState & { checksumTimeMs?: number }) | null | undefined)?.checksumTimeMs,
  );

const hasSourceQueueWarning = (source: CreateDisplaySourceState | null | undefined) =>
  !!source && (source.status === "failed" || (source.warnings?.length ?? 0) > 0);

const getSourceNoticeMessage = (source: CreateDisplaySourceState | null | undefined) => {
  if (!source) return "";
  const warningMessage = source.warnings
    ?.map((warning) => warning.message)
    .filter(Boolean)
    .join(" ");
  if (warningMessage) return warningMessage;
  if (source.status === "failed") return "Source preparation failed. Choose a different ROM.";
  return "";
};

const getSourceNoticeLevel = (source: CreateDisplaySourceState | null | undefined) =>
  source?.status === "failed" ? "error" : "warn";

const isSourceInvalid = (source: CreateDisplaySourceState | null | undefined) =>
  !!source && (source.status === "failed" || (source.warnings?.length ?? 0) > 0);

const isDismissibleWorkflowError = (code: string) => code !== "AMBIGUOUS_SELECTION";

const getChecksumTimingLabel = (timing: string) => (timing ? `Checksum ${timing}` : "");
const isChecksumProgress = (progress: WorkflowFormProgressState | null) =>
  !!progress && /checksum/i.test(`${progress.label} ${progress.message}`);
const isUserRequestedCancellation = (error: unknown, signal: AbortSignal) =>
  signal.aborted && getErrorCode(error) === "CANCELLED";

type InternalCreatePatchFormProps = CreatePatchFormProps & {
  createWorkflow?: typeof CreateWorkflow;
  getCreatePatchFormatCandidates?: typeof getCreatePatchFormatCandidates;
};

function CreatePatchForm(props: CreatePatchFormProps) {
  const internalProps = props as InternalCreatePatchFormProps;
  const CreateWorkflowConstructor = internalProps.createWorkflow || CreateWorkflow;
  const resolveCreatePatchFormatCandidates =
    internalProps.getCreatePatchFormatCandidates || getCreatePatchFormatCandidates;
  const providerSettings = useCreateSettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  useInputSelectionHandler(selectFile);
  const [internalOriginal, setInternalOriginal] = useState<BinarySource | null>(props.defaultOriginal || null);
  const [internalModified, setInternalModified] = useState<BinarySource | null>(props.defaultModified || null);
  const [internalSettings, setInternalSettings] = useState<CreatePatchFormSettings>(() =>
    mergeSettingsWithOutput(providerSettings, props.defaultSettings),
  );
  const [internalPatchType, setInternalPatchType] = useState(props.defaultPatchType || "bps");
  const [patchTypeManuallySelected, setPatchTypeManuallySelected] = useState(
    () => props.patchType !== undefined || !!props.defaultPatchType,
  );
  const [createPatchFormatCandidates, setCreatePatchFormatCandidates] =
    useState<CreatePatchFormatCandidateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [createQueued, setCreateQueued] = useState(false);
  const [stagingRole, setStagingRole] = useState<"modified" | "original" | null>(null);
  const [message, setMessage] = useState("");
  const [messageDismissible, setMessageDismissible] = useState(false);
  const [messagePlacement, setMessagePlacement] = useState<CreateMessagePlacement | null>(null);
  const [originalState, setOriginalState] = useState<CreateDisplaySourceState | null>(null);
  const [modifiedState, setModifiedState] = useState<CreateDisplaySourceState | null>(null);
  const { clearCompletedOutput, completedOutput, disposeActiveOutput, rememberOutputDispose, setCompletedOutput } =
    useDisposableWorkflowOutput<CompletedCreateOutput>();
  const { abortActiveOperation, activeAbortControllerRef, rememberAbortController } = useActiveAbortController();
  const { clearProgressForStage, createProgressHandler, progress, setProgress } = useWorkflowProgressState({
    onProgress: props.onProgress,
  });
  const [outputName, setOutputName] = useState("");
  const stagingOriginalGenerationRef = useRef(0);
  const stagingModifiedGenerationRef = useRef(0);
  const stagedCreateWorkflowRef = useRef<CreateWorkflow | null>(null);
  const stagedCreateWorkflowGenerationRef = useRef(0);
  const sourceStageQueueRef = useRef(Promise.resolve<void>(undefined));
  const handledPageDropIdRef = useRef<number | null>(null);
  const stagedCreateWorkflowSyncRef = useRef({
    modifiedKey: "",
    originalKey: "",
    settingsKey: "",
  });
  const workflowIdRef = useRef(createReactWorkflowId("react-create"));
  const createExecutionTimingRef = useRef<{ compressionStartedAt: number | null; createStartedAt: number | null }>({
    compressionStartedAt: null,
    createStartedAt: null,
  });
  const [errorCode, setErrorCode] = useState("");
  const original = props.original === undefined ? internalOriginal : props.original;
  const modified = props.modified === undefined ? internalModified : props.modified;
  const settings = props.settings || internalSettings || providerSettings;
  const originalSourceKey = useMemo(
    () => (original ? getBinarySourceListStableIds([original])[0] || "" : ""),
    [original],
  );
  const modifiedSourceKey = useMemo(
    () => (modified ? getBinarySourceListStableIds([modified])[0] || "" : ""),
    [modified],
  );
  const candidateWorkerThreads = props.workerThreads ?? settings.workers?.threads;
  const patchFormatCandidateKey = `${originalSourceKey}\n${modifiedSourceKey}\n${String(candidateWorkerThreads ?? "")}`;
  const activePatchFormatCandidates =
    createPatchFormatCandidates?.key === patchFormatCandidateKey ? createPatchFormatCandidates : null;
  const requestedPatchType = props.patchType || internalPatchType;
  const patchType = getPreferredCreatePatchFormat({
    automaticFormatSelection: props.patchType === undefined && !patchTypeManuallySelected,
    candidateDefaultFormat: activePatchFormatCandidates?.defaultFormat,
    candidateFormats: activePatchFormatCandidates?.formats,
    modifiedSize: modifiedState?.size,
    originalSize: originalState?.size,
    requestedFormat: requestedPatchType,
  });
  const uploadDisabled = !!props.disabled || busy;
  const outputDisabled = !!props.disabled || busy;
  const createInputsSelected = !!(original && modified);
  const createSourcesReady =
    createInputsSelected && originalState?.status === "ready" && modifiedState?.status === "ready";
  const createPreparationPending =
    !!stagingRole || progress?.stage === "input" || (createInputsSelected && !(originalState && modifiedState));
  const createQueueBlocked =
    !!message || !!errorCode || hasSourceQueueWarning(originalState) || hasSourceQueueWarning(modifiedState);
  const canStartCreate = createSourcesReady && !createPreparationPending;
  const canQueueCreate = createInputsSelected;
  const actionDisabled = !!props.disabled || createQueued || !(busy || completedOutput || canQueueCreate);
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const originalFileName = getReactBinarySourceFileName(original, "Original ROM");
  const modifiedFileName = getReactBinarySourceFileName(modified, "Modified ROM");
  const displayedOriginalInfo = getDisplaySourceInfo(originalState, originalFileName);
  const displayedModifiedInfo = getDisplaySourceInfo(modifiedState, modifiedFileName);
  const generatedOutputSource = displayedModifiedInfo?.fileName
    ? new File([], displayedModifiedInfo.fileName)
    : modified || (displayedOriginalInfo?.fileName ? new File([], displayedOriginalInfo.fileName) : original);
  const generatedOutputName = configuredOutputName || getDefaultCreateOutputName(generatedOutputSource);
  const resolvedOutputName = outputName.trim() || generatedOutputName;
  const executionOutputName = resolveCreateExecutionOutputName(resolvedOutputName, patchType);
  const createCompression = (() => {
    const normalized = String(
      settings.output?.compression || getDefaultCompressionArchive(getDefaultCompressionMode(settings)),
    )
      .trim()
      .toLowerCase();
    return normalized === "7z" ? "7z" : normalized === "none" ? "none" : "zip";
  })();
  const createCompressionOptions = useMemo(() => createCreateOutputCompressionOptions(), []);
  const patchFormatOptions = useMemo(
    () =>
      createCreatePatchFormatOptions({
        candidateFormats: activePatchFormatCandidates?.formats,
        modifiedSize: modifiedState?.size,
        originalSize: originalState?.size,
      }),
    [activePatchFormatCandidates?.formats, modifiedState?.size, originalState?.size],
  );
  const displayedOriginalFileName = displayedOriginalInfo?.fileName || originalFileName;
  const displayedModifiedFileName = displayedModifiedInfo?.fileName || modifiedFileName;
  const settingsLanguage = (settings as { language?: string }).language;
  const clearWorkflowMessage = useCallback(() => {
    setErrorCode("");
    setMessage("");
    setMessageDismissible(false);
    setMessagePlacement(null);
  }, []);
  const setWorkflowMessage = useCallback(
    (placement: CreateMessagePlacement, error: Error) => {
      const code = getErrorCode(error);
      setErrorCode(code);
      setMessage(formatCodedErrorForDisplay(error, createBrowserLocalizer(settingsLanguage)));
      setMessageDismissible(isDismissibleWorkflowError(code));
      setMessagePlacement(placement);
    },
    [settingsLanguage],
  );
  const stagingSettingsKey = useMemo(
    () =>
      createSettingsDependencyKey({
        input: settings.input,
        language: settingsLanguage,
        limits: settings.limits,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        workerThreads: props.workerThreads,
      }),
    [props.workerThreads, settings.input, settings.limits, settings.logging?.level, settings.workers, settingsLanguage],
  );
  const stagingSettings = useMemo(
    () =>
      toCreateWorkflowSettings(
        {
          input: settings.input,
          limits: settings.limits,
          logging: settings.logging,
          output: { compression: "none" },
          workers: settings.workers,
        } as never,
        "",
        props.workerThreads,
      ),
    [props.workerThreads, settings.input, settings.limits, settings.logging, settings.workers],
  );
  const stagingSettingsRef = useRef(stagingSettings);
  useEffect(() => {
    stagingSettingsRef.current = stagingSettings;
  }, [stagingSettings]);

  const resetStagedCreateWorkflow = useCallback(() => {
    stagedCreateWorkflowGenerationRef.current += 1;
    sourceStageQueueRef.current = Promise.resolve(undefined);
    const workflow = stagedCreateWorkflowRef.current;
    stagedCreateWorkflowRef.current = null;
    stagedCreateWorkflowSyncRef.current = {
      modifiedKey: "",
      originalKey: "",
      settingsKey: "",
    };
    workflow?.dispose().catch(() => undefined);
    setStagingRole(null);
    clearProgressForStage("input");
  }, [clearProgressForStage]);

  useEffect(() => {
    setCreatePatchFormatCandidates(null);
    if (!(original && modified && originalSourceKey && modifiedSourceKey)) return;
    const key = patchFormatCandidateKey;
    let cancelled = false;
    void resolveCreatePatchFormatCandidates({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      modified: toBrowserPublicBinarySource(modified),
      original: toBrowserPublicBinarySource(original),
      settings: {
        logging: settings.logging,
        workers: settings.workers,
      },
      workerThreads: props.workerThreads,
    })
      .then((candidates) => {
        if (cancelled) return;
        setCreatePatchFormatCandidates({ ...candidates, key });
      })
      .catch(() => {
        if (!cancelled) setCreatePatchFormatCandidates(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    modified,
    modifiedSourceKey,
    original,
    originalSourceKey,
    patchFormatCandidateKey,
    props.workerThreads,
    resolvedAssetBaseUrl,
    resolveCreatePatchFormatCandidates,
    settings.logging,
    settings.workers,
  ]);

  useEffect(() => {
    if (props.settings !== undefined) return;
    setInternalSettings(mergeSettingsWithOutput(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const updateOriginal = (file: BinarySource | null) => {
    setCreateQueued(false);
    disposeActiveOutput();
    clearCompletedOutput();
    setOriginalState(null);
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
    clearWorkflowMessage();
    setProgress(null);
  };

  const updateModified = (file: BinarySource | null) => {
    setCreateQueued(false);
    disposeActiveOutput();
    clearCompletedOutput();
    setModifiedState(null);
    if (props.modified === undefined) setInternalModified(file);
    props.onModifiedChange?.(file);
    clearWorkflowMessage();
    setProgress(null);
  };

  useEffect(() => {
    const pageDrop = props.pageDrop;
    if (!pageDrop || handledPageDropIdRef.current === pageDrop.id) return;
    handledPageDropIdRef.current = pageDrop.id;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (pageDrop.target === "original") {
        updateOriginal(pageDrop.file);
        return;
      }
      updateModified(pageDrop.file);
    });
    return () => {
      cancelled = true;
    };
  }, [props.pageDrop]);

  const cancelSourceStaging = (role: "modified" | "original") => {
    setCreateQueued(false);
    resetStagedCreateWorkflow();
    if (role === "original") updateOriginal(null);
    else updateModified(null);
  };

  cancelSelectionRef.current = (request) => {
    if (request.role === "original") {
      updateOriginal(null);
      return;
    }
    if (request.role === "modified") updateModified(null);
  };

  const updateSettings = (nextSettings: CreatePatchFormSettings) => {
    setCreateQueued(false);
    disposeActiveOutput();
    clearCompletedOutput();
    clearWorkflowMessage();
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updatePatchType = (nextPatchType: string) => {
    setCreateQueued(false);
    setPatchTypeManuallySelected(true);
    disposeActiveOutput();
    clearCompletedOutput();
    if (!props.patchType) setInternalPatchType(nextPatchType);
    props.onPatchTypeChange?.(nextPatchType);
    clearWorkflowMessage();
    setProgress(null);
  };

  const createSelectFileHandler = useCallback(
    (_role: "modified" | "original") => async (request: Parameters<typeof selectFile>[0]) => {
      const automaticSelection = resolveAutomaticSelection(request);
      return automaticSelection || selectFile(request);
    },
    [selectFile],
  );

  useEffect(() => {
    const previousSync = stagedCreateWorkflowSyncRef.current;
    const settingsChanged = previousSync.settingsKey !== stagingSettingsKey;
    const originalKeyChanged = previousSync.originalKey !== originalSourceKey;
    const modifiedKeyChanged = previousSync.modifiedKey !== modifiedSourceKey;
    const sourceCleared = (originalKeyChanged && !original) || (modifiedKeyChanged && !modified);
    const workflowReset = settingsChanged || sourceCleared;
    const originalChanged = settingsChanged || originalKeyChanged || (workflowReset && !!original);
    const modifiedChanged = settingsChanged || modifiedKeyChanged || (workflowReset && !!modified);
    let workflow = stagedCreateWorkflowRef.current;
    const generation = workflowReset
      ? ++stagedCreateWorkflowGenerationRef.current
      : stagedCreateWorkflowGenerationRef.current;
    if (workflowReset) {
      workflow?.dispose().catch(() => undefined);
      workflow = null;
      stagedCreateWorkflowRef.current = null;
    }
    const originalGeneration = originalChanged
      ? ++stagingOriginalGenerationRef.current
      : stagingOriginalGenerationRef.current;
    const modifiedGeneration = modifiedChanged
      ? ++stagingModifiedGenerationRef.current
      : stagingModifiedGenerationRef.current;
    if (originalChanged) setOriginalState(null);
    if (modifiedChanged) setModifiedState(null);
    stagedCreateWorkflowSyncRef.current = {
      modifiedKey: modifiedSourceKey,
      originalKey: originalSourceKey,
      settingsKey: stagingSettingsKey,
    };
    if (!(original || modified)) {
      setStagingRole(null);
      setProgress((current) => (current?.stage === "input" ? null : current));
      return;
    }
    if (!workflow) {
      workflow = new CreateWorkflowConstructor({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: `${workflowIdRef.current}:stage:${generation}`,
        selectFile: async (request) =>
          createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
        settings: stagingSettingsRef.current,
      });
      stagedCreateWorkflowRef.current = workflow;
    }
    const activeWorkflow = workflow;
    const handleProgress = createProgressHandler("input");
    activeWorkflow.on("progress", handleProgress);
    const isCurrentStaging = () =>
      stagedCreateWorkflowGenerationRef.current === generation && stagedCreateWorkflowRef.current === activeWorkflow;
    const isCurrentRoleStaging = (role: "modified" | "original", roleGeneration: number) =>
      isCurrentStaging() &&
      (role === "original"
        ? stagingOriginalGenerationRef.current === roleGeneration
        : stagingModifiedGenerationRef.current === roleGeneration);
    const enqueueSourceStage = (role: "modified" | "original", run: () => Promise<void>) => {
      const queued = sourceStageQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (!isCurrentStaging()) return;
          setStagingRole(role);
          await run();
        });
      sourceStageQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    };
    const finishStaging = async () => {
      let activeRole: "modified" | "original" | null = null;
      try {
        if (originalChanged && original) {
          activeRole = "original";
          await enqueueSourceStage("original", () => activeWorkflow.setOriginal(toBrowserPublicBinarySource(original)));
          if (!isCurrentStaging()) return;
          if (isCurrentRoleStaging("original", originalGeneration)) {
            setOriginalState(activeWorkflow.getOriginal());
            clearProgressForStage("input");
          }
          activeRole = null;
        }
        if (modifiedChanged && modified) {
          activeRole = "modified";
          await enqueueSourceStage("modified", () => activeWorkflow.setModified(toBrowserPublicBinarySource(modified)));
          if (!isCurrentStaging()) return;
          if (isCurrentRoleStaging("modified", modifiedGeneration)) {
            setModifiedState(activeWorkflow.getModified());
            clearProgressForStage("input");
          }
          activeRole = null;
        }
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const code = getErrorCode(normalizedError);
        if (code === "WORKFLOW_SELECTION_SKIPPED" || !isCurrentStaging()) return;
        setOriginalState(activeWorkflow.getOriginal());
        setModifiedState(activeWorkflow.getModified());
        const failedRole = activeRole || "output";
        const failedSource =
          failedRole === "original"
            ? activeWorkflow.getOriginal()
            : failedRole === "modified"
              ? activeWorkflow.getModified()
              : null;
        if (!hasSourceQueueWarning(failedSource)) setWorkflowMessage(failedRole, normalizedError);
        props.onError?.(normalizedError);
      } finally {
        activeWorkflow.off("progress", handleProgress);
        if (isCurrentStaging()) {
          setStagingRole(null);
          clearProgressForStage("input");
        }
      }
    };
    void finishStaging();
    return () => {
      activeWorkflow.off("progress", handleProgress);
    };
  }, [
    clearProgressForStage,
    CreateWorkflowConstructor,
    createProgressHandler,
    createSelectFileHandler,
    modified,
    modifiedSourceKey,
    original,
    originalSourceKey,
    props.onError,
    resolvedAssetBaseUrl,
    setWorkflowMessage,
    stagingSettingsKey,
  ]);

  useEffect(
    () => () => {
      stagedCreateWorkflowGenerationRef.current += 1;
      const workflow = stagedCreateWorkflowRef.current;
      stagedCreateWorkflowRef.current = null;
      stagedCreateWorkflowSyncRef.current = {
        modifiedKey: "",
        originalKey: "",
        settingsKey: "",
      };
      workflow?.dispose().catch(() => undefined);
    },
    [],
  );

  const runCreate = async () => {
    if (busy) {
      setCreateQueued(false);
      abortActiveOperation();
      return;
    }
    if (completedOutput) {
      setCreateQueued(false);
      await completedOutput.saveAs();
      return;
    }
    if (createQueueBlocked) {
      setCreateQueued(false);
      return;
    }
    if (canQueueCreate && createPreparationPending && !canStartCreate) {
      setCreateQueued(true);
      return;
    }
    if (!canStartCreate) return;
    if (!(original && modified)) return;
    setCreateQueued(false);
    const abortController = new AbortController();
    rememberAbortController(abortController);
    setBusy(true);
    clearWorkflowMessage();
    disposeActiveOutput();
    clearCompletedOutput();
    setProgress(createIndeterminateWorkflowProgress({ label: "Creating patch...", role: "worker", stage: "create" }));
    const createWorkflow =
      stagedCreateWorkflowRef.current ||
      new CreateWorkflowConstructor({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: workflowIdRef.current,
        selectFile: async (request) =>
          createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
        settings: toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads),
        signal: abortController.signal,
      });
    const usingStagedWorkflow = stagedCreateWorkflowRef.current === createWorkflow;
    const baseProgressHandler = createProgressHandler("create");
    const handleProgress: typeof baseProgressHandler = (event) => {
      if (event.stage === "compress" && createExecutionTimingRef.current.compressionStartedAt === null) {
        createExecutionTimingRef.current.compressionStartedAt = Date.now();
      }
      baseProgressHandler(event);
    };
    createWorkflow.on("progress", handleProgress);
    const abortWorkflow = () => createWorkflow.abort(abortController.signal.reason);
    abortController.signal.addEventListener("abort", abortWorkflow, { once: true });
    try {
      if (usingStagedWorkflow) {
        await createWorkflow.setSettings(toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads));
      } else {
        await createWorkflow.setOriginal(toBrowserPublicBinarySource(original));
        await createWorkflow.setModified(toBrowserPublicBinarySource(modified));
      }
      await createWorkflow.setPatchType(patchType as NonNullable<CreateSettings["format"]>);
      await createWorkflow.setOutputName(executionOutputName);

      if (createWorkflow.getOriginal()?.status !== "ready" || !createWorkflow.getOriginal()?.selectedCandidateId) {
        throw new Error("Original source requires candidate selection");
      }
      if (createWorkflow.getModified()?.status !== "ready" || !createWorkflow.getModified()?.selectedCandidateId) {
        throw new Error("Modified source requires candidate selection");
      }

      createExecutionTimingRef.current = { compressionStartedAt: null, createStartedAt: Date.now() };
      const result = (await createWorkflow.run()) as BrowserCreateResult;
      const completedAt = Date.now();
      const { compressionStartedAt, createStartedAt } = createExecutionTimingRef.current;
      const reportedCreateTimeMs =
        typeof result.sizeSummary?.createTimeMs === "number" && Number.isFinite(result.sizeSummary.createTimeMs)
          ? Math.max(0, Math.round(result.sizeSummary.createTimeMs))
          : undefined;
      const reportedCompressionTimeMs =
        typeof result.sizeSummary?.compressionTimeMs === "number" &&
        Number.isFinite(result.sizeSummary.compressionTimeMs)
          ? Math.max(0, Math.round(result.sizeSummary.compressionTimeMs))
          : undefined;
      const fallbackCreateTimeMs =
        typeof createStartedAt === "number"
          ? Math.max(0, (compressionStartedAt ?? completedAt) - createStartedAt)
          : undefined;
      const createTimeMs = reportedCreateTimeMs ?? fallbackCreateTimeMs;
      const compressionTimeMs =
        reportedCompressionTimeMs ??
        (typeof compressionStartedAt === "number" ? Math.max(0, completedAt - compressionStartedAt) : undefined);
      rememberOutputDispose(result.output.dispose);
      setCompletedOutput({
        compression: createCompression,
        compressionTimeMs,
        createTimeMs,
        fileName: result.output.fileName,
        patchType,
        rawSize: result.sizeSummary?.rawSize,
        saveAs: result.output.saveAs,
        size: result.sizeSummary?.outputSize ?? result.output.size,
      });
      setProgress(null);
      if (typeof window !== "undefined") await result.output.saveAs();
      props.onCreateComplete?.(result);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const code = getErrorCode(normalizedError);
      if (isUserRequestedCancellation(normalizedError, abortController.signal)) {
        clearWorkflowMessage();
        setProgress(null);
        clearCompletedOutput();
        return;
      }
      if (code === "WORKFLOW_SELECTION_SKIPPED") {
        clearWorkflowMessage();
        setProgress(null);
        return;
      }
      setWorkflowMessage("output", normalizedError);
      setProgress(null);
      clearCompletedOutput();
      props.onError?.(normalizedError);
    } finally {
      abortController.signal.removeEventListener("abort", abortWorkflow);
      createWorkflow.off("progress", handleProgress);
      if (!usingStagedWorkflow) await createWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
      setBusy(false);
    }
  };

  useEffect(
    () => () => {
      abortActiveOperation();
      disposeActiveOutput();
    },
    [abortActiveOperation, disposeActiveOutput],
  );

  useEffect(() => {
    if (!createQueued) return;
    if (busy || completedOutput) {
      setCreateQueued(false);
      return;
    }
    if (!canQueueCreate) {
      setCreateQueued(false);
      return;
    }
    if (createQueueBlocked) {
      setCreateQueued(false);
      return;
    }
    if (createPreparationPending) return;
    if (!canStartCreate) {
      setCreateQueued(false);
      return;
    }
    void runCreate();
  });

  const progressProps = toWorkflowFileProgressProps(progress);
  const waitingProgressProps = toWorkflowFileProgressProps(createWaitingWorkflowProgress());
  const cancelCreateOutputProgress = () => {
    setCreateQueued(false);
    if (busy) {
      abortActiveOperation();
      disposeActiveOutput();
      clearCompletedOutput();
      return;
    }
    setProgress(null);
  };
  const getSourceProgress = (role: "modified" | "original") => {
    const cancelProps = {
      cancelLabel: role === "original" ? "Cancel original ROM staging" : "Cancel modified ROM staging",
      onCancel: () => cancelSourceStaging(role),
    };
    if (stagingRole === role && progressProps && progress && !isChecksumProgress(progress))
      return { ...progressProps, ...cancelProps };
    const file = role === "original" ? original : modified;
    const sourceState = role === "original" ? originalState : modifiedState;
    return file && !sourceState && stagingRole && waitingProgressProps
      ? { ...waitingProgressProps, ...cancelProps }
      : null;
  };
  const getSourceChecksumProgress = (role: "modified" | "original") =>
    stagingRole === role && progress && isChecksumProgress(progress) ? progress : null;
  const createCompressPanel = buildCompressPanel(createCompression, settings as Record<string, unknown>);
  const createTimingText = completedOutput ? formatElapsedMs(completedOutput.createTimeMs) : "";
  const compressTimingText = completedOutput ? formatElapsedMs(completedOutput.compressionTimeMs) : "";

  const renderSourceStep = ({
    num,
    role,
    title,
    file,
    fileName,
    sourceState,
    emptyLabel,
    hint,
    replaceLabel,
    removeLabel,
    onSelect,
    onClear,
    sourceProgress = null,
    checksumProgress = null,
  }: {
    num: string;
    role: "modified" | "original";
    title: string;
    file: BinarySource | null;
    fileName: string;
    sourceState: CreateDisplaySourceState | null;
    hint: string;
    emptyLabel: string;
    replaceLabel: string;
    removeLabel: string;
    onSelect: (file: BinarySource | null) => void;
    onClear: () => void;
    sourceProgress?: typeof progressProps;
    checksumProgress?: WorkflowFormProgressState | null;
  }) => {
    const displayInfo = getDisplaySourceInfo(sourceState, fileName);
    const sourceChecksumProgress = isChecksumProgress(checksumProgress) ? checksumProgress : null;
    const sourceNoticeMessage = getSourceNoticeMessage(sourceState);
    const runtimeNoticeVisible = !!message && messagePlacement === role;
    const notice = runtimeNoticeVisible ? (
      <Notice
        id={`patch-builder-${role}-error-message`}
        level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
        onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
      >
        {message}
      </Notice>
    ) : sourceNoticeMessage ? (
      <Notice id={`patch-builder-${role}-error-message`} level={getSourceNoticeLevel(sourceState)}>
        {sourceNoticeMessage}
      </Notice>
    ) : null;
    return (
      <WorkflowRomInputStep
        dropZone={{
          big: !file,
          disabled: uploadDisabled,
          hint: file ? undefined : hint,
          label: file ? replaceLabel : emptyLabel,
          onFiles: (files) => onSelect(files[0] ?? null),
        }}
        id={`patch-builder-row-${role}`}
        items={
          file
            ? [
                sourceProgress
                  ? {
                      id: `${num}:progress`,
                      progress: sourceProgress,
                    }
                  : {
                      card: {
                        extract: {
                          fileName,
                          fileSize: displayInfo?.size,
                          parentCompressions: displayInfo?.parentCompressions,
                          timing: formatElapsedMs(displayInfo?.decompressionTimeMs),
                        },
                        onRemove: onClear,
                        panels: {
                          fixes: {},
                          info: {
                            bytes: displayInfo?.size ?? displayInfo?.sourceSize,
                            checksums: getDisplaySourceChecksums(sourceState),
                            defaultOpen: false,
                            progress: toWorkflowChecksumProgressProps(sourceChecksumProgress),
                            timing: getChecksumTimingLabel(getDisplaySourceChecksumTiming(sourceState)) || undefined,
                          },
                        },
                        removeLabel,
                        state: isSourceInvalid(sourceState)
                          ? "bad"
                          : sourceState?.status === "ready"
                            ? "ok"
                            : undefined,
                      },
                      id: `${num}:card`,
                    },
              ]
            : []
        }
        notice={notice}
        num={num}
        title={title}
      />
    );
  };

  return (
    <main aria-labelledby="tab-creator" className="panel" id="patch-builder-container">
      {renderSourceStep({
        checksumProgress: getSourceChecksumProgress("original"),
        emptyLabel: "Select original ROM · drop or browse",
        file: original,
        fileName: displayedOriginalFileName,
        hint: `unmodified original · ${ROM_INPUT_HINT}`,
        num: "01",
        onClear: () => updateOriginal(null),
        onSelect: updateOriginal,
        removeLabel: "Clear original ROM",
        replaceLabel: "Replace original ROM · drop or browse",
        role: "original",
        sourceProgress: getSourceProgress("original"),
        sourceState: originalState,
        title: "Original ROM",
      })}
      {renderSourceStep({
        checksumProgress: getSourceChecksumProgress("modified"),
        emptyLabel: "Select modified ROM · drop or browse",
        file: modified,
        fileName: displayedModifiedFileName,
        hint: `edited ROM · ${ROM_INPUT_HINT}`,
        num: "02",
        onClear: () => updateModified(null),
        onSelect: updateModified,
        removeLabel: "Clear modified ROM",
        replaceLabel: "Replace modified ROM · drop or browse",
        role: "modified",
        sourceProgress: getSourceProgress("modified"),
        sourceState: modifiedState,
        title: "Modified ROM",
      })}
      <WorkflowOutputStep
        action={
          <OutputRunAction
            disabled={actionDisabled}
            download={completedOutput ? getCompletedDownloadMeta(completedOutput) : undefined}
            icon={
              completedOutput ? <Download aria-hidden="true" /> : busy ? undefined : <GitCompare aria-hidden="true" />
            }
            id="patch-builder-button-create"
            onClick={() => void runCreate()}
            progress={
              createQueued
                ? waitingProgressProps
                  ? {
                      ...waitingProgressProps,
                      cancelLabel: "Cancel queued create",
                      onCancel: cancelCreateOutputProgress,
                    }
                  : null
                : busy && progressProps && progress?.role !== "input"
                  ? {
                      ...progressProps,
                      cancelLabel: "Cancel patch creation",
                      onCancel: cancelCreateOutputProgress,
                    }
                  : null
            }
          >
            CREATE & DOWNLOAD PATCH
          </OutputRunAction>
        }
        compress={buildOutputCompressionPanel({
          disabled: outputDisabled,
          fields: createCompressPanel?.fields,
          format: getOutputCompressionFormatLabel(createCompression, createCompressionOptions),
          formatId: "patch-builder-select-output-compression",
          formatOptions: createCompressionOptions,
          formatValue: createCompression,
          onFieldChange: (key, value, updates) => updateSettings({ ...settings, ...(updates || { [key]: value }) }),
          onFormatChange: (value) =>
            updateSettings({
              ...settings,
              output: { ...settings.output, compression: value as "7z" | "none" | "zip" },
            }),
          summary: createCompression === "none" ? undefined : createCompressPanel?.summary,
          timing: compressTimingText || undefined,
        })}
        disabled={outputDisabled}
        fileName={resolvedOutputName}
        fileNameId="patch-builder-output-file"
        fileNamePlaceholder="Patch filename"
        format={patchType}
        formatId="patch-builder-select-patch-type"
        formatOptions={patchFormatOptions}
        info={
          <InfoPopover title="Output options">
            <strong>Output</strong>
            <ul>
              <li>Set the filename without an extension — the format selector controls the patch type.</li>
              <li>BPS records source &amp; target checksums so applies can be verified.</li>
            </ul>
          </InfoPopover>
        }
        meta={createTimingText ? <span className="t">{createTimingText}</span> : undefined}
        notice={
          message && messagePlacement === "output" ? (
            <Notice
              id="patch-builder-row-error-message"
              level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
              onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
            >
              {message}
            </Notice>
          ) : null
        }
        num="03"
        onFileNameChange={(value) => {
          setOutputName(value);
          updateSettings({
            ...settings,
            output: { ...settings.output, outputName: value.trim() || undefined },
          });
        }}
        onFormatChange={updatePatchType}
        title="Output"
      />
      {candidateSelectionDialog}
    </main>
  );
}

export { CreatePatchForm };
