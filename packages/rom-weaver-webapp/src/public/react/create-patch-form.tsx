import { Download, GitCompare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPreferredCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import {
  type BrowserCreateResult,
  type CreateSettings,
  CreateWorkflow,
  getCreatePatchFormatCandidates,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { InfoPopover } from "./components/ds/layout.tsx";
import { OutputRunAction } from "./components/ds/workflow-output-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import { CreatePatchFormView, type CreatePatchFormViewModel } from "./create-patch-form-view.tsx";
import {
  type CompletedCreateOutput,
  CREATE_SUPPORTED_FILES,
  type CreateDisplaySourceState,
  type CreateMessagePlacement,
  type CreatePatchFormatCandidateState,
  getCompletedDownloadMeta,
  getDisplaySourceInfo,
  isChecksumProgress,
  resolveCreateExecutionOutputName,
} from "./create-patch-output-model.ts";
import { buildCreateSourceStep, type CreateSourceStepRuntimeNotice } from "./create-source-step-view-model.tsx";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { useInputSelectionHandler } from "./input-selection-handler.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import { createCreateOutputCompressionOptions, createCreatePatchFormatOptions } from "./output-view-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";

const finishCreateRoleStaging = (
  role: "modified" | "original",
  roleGeneration: number,
  isCurrentStaging: () => boolean,
  isCurrentRoleStaging: (role: "modified" | "original", roleGeneration: number) => boolean,
  commit: () => void,
  clearProgress: () => void,
) => {
  if (!isCurrentStaging()) return false;
  if (!isCurrentRoleStaging(role, roleGeneration)) return true;
  commit();
  clearProgress();
  return true;
};

const CREATE_SAMPLE_ASSETS = [
  ["/create-original.bin", "original.bin"],
  ["/create-modified.bin", "modified.bin"],
] as const;
import {
  getCreateSettingsOutputName,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import { routeByOrder } from "./unified-drop-routing.ts";
import { getDefaultCreateOutputName, getReactBinarySourceFileName } from "./workflow-adapters.ts";
import {
  markCompressionStart,
  usePageDropForwarder,
  useQueuedRunEffect,
  useWorkbenchActivity,
  useWorkflowResetActions,
} from "./workflow-form-effects.ts";
import {
  createReactWorkflowId,
  createSettingsDependencyKey,
  formatElapsedMs,
  hasSourceQueueWarning,
  isDismissibleWorkflowError,
  mergeSettingsWithOutput,
} from "./workflow-form-utils.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
} from "./workflow-run-hooks.ts";
import { deriveWorkflowRunTiming, useWorkflowRunLifecycle } from "./workflow-run-lifecycle.ts";

type InternalCreatePatchFormProps = CreatePatchFormProps & {
  createWorkflow?: typeof CreateWorkflow;
  getCreatePatchFormatCandidates?: typeof getCreatePatchFormatCandidates;
};

function CreatePatchForm(props: CreatePatchFormProps) {
  const { onError } = props;
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
  // id matches webapp-root's `currentView` so root routing targets the active tab.
  useInputSelectionHandler("creator", selectFile);
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
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState("");
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
  const candidateThreads = props.threads ?? settings.workers?.threads;
  // Canonical (order-independent) key: the available patch formats for a pair of
  // ROMs do not depend on which is original vs modified, so swapping must not
  // invalidate the resolved candidates (which would re-extract to re-measure).
  const patchFormatCandidateKey = `${[originalSourceKey, modifiedSourceKey].sort().join("\n")}\n${String(candidateThreads ?? "")}`;
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
  const resetWorkflowOutput = useWorkflowResetActions({
    clearCompleted: clearCompletedOutput,
    clearWorkflowMessage,
    disposeActiveOutput,
    setProgress,
    setQueued: setCreateQueued,
  });
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
  const setOutputWorkflowMessage = useCallback(
    (error: Error) => setWorkflowMessage("output", error),
    [setWorkflowMessage],
  );
  const createInitialProgress = useCallback(
    () => createIndeterminateWorkflowProgress({ label: "Creating patch...", role: "worker", stage: "create" }),
    [],
  );
  const notifyError = useCallback((error: Error) => onError?.(error), [onError]);
  const { cancelOutputProgress, runWorkflow } = useWorkflowRunLifecycle({
    abortActiveOperation,
    activeAbortControllerRef,
    clearCompleted: clearCompletedOutput,
    clearWorkflowMessage,
    createInitialProgress,
    disposeActiveOutput,
    notifyError,
    rememberAbortController,
    setBusy,
    setProgress,
    setQueued: setCreateQueued,
    setWorkflowOutputError: setOutputWorkflowMessage,
  });
  const stagingSettingsKey = useMemo(
    () =>
      createSettingsDependencyKey({
        input: settings.input,
        language: settingsLanguage,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        threads: props.threads,
      }),
    [props.threads, settings.input, settings.logging?.level, settings.workers, settingsLanguage],
  );
  const stagingSettings = useMemo(
    () =>
      toCreateWorkflowSettings(
        {
          input: settings.input,
          logging: settings.logging,
          output: { compression: "none" },
          workers: settings.workers,
        } as never,
        "",
        props.threads,
      ),
    [props.threads, settings.input, settings.logging, settings.workers],
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

  const resolvedCandidateKeyRef = useRef("");
  useEffect(() => {
    if (!(original && modified && originalSourceKey && modifiedSourceKey)) {
      resolvedCandidateKeyRef.current = "";
      setCreatePatchFormatCandidates(null);
      return;
    }
    // Same pair already resolved (e.g. after a Swap, the canonical key is
    // unchanged) - keep the candidates instead of re-extracting to re-measure.
    if (resolvedCandidateKeyRef.current === patchFormatCandidateKey) return;
    resolvedCandidateKeyRef.current = patchFormatCandidateKey;
    setCreatePatchFormatCandidates(null);
    const key = patchFormatCandidateKey;
    let cancelled = false;
    void resolveCreatePatchFormatCandidates({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      modified,
      original,
      settings: {
        logging: settings.logging,
        workers: settings.workers,
      },
      threads: props.threads,
    })
      .then((candidates) => {
        if (cancelled) return;
        setCreatePatchFormatCandidates({ ...candidates, key });
      })
      .catch(() => {
        if (cancelled) return;
        resolvedCandidateKeyRef.current = "";
        setCreatePatchFormatCandidates(null);
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
    props.threads,
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
    resetWorkflowOutput();
    setOriginalState(null);
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
  };

  const updateModified = (file: BinarySource | null) => {
    resetWorkflowOutput();
    setModifiedState(null);
    if (props.modified === undefined) setInternalModified(file);
    props.onModifiedChange?.(file);
  };

  // Combined drop surface: both sources are ROMs, so files fill Original then
  // Modified in drop order; patches in a dropped archive are ignored (no patch
  // bucket on this tab). See routeByOrder.
  const handledPageDropIdRef = useRef<number | null>(null);
  const handleUnifiedDrop = (files: File[]) => {
    // When both ROMs arrive together, treat the longer file name as the modified
    // ROM - hacks/edits usually carry the more descriptive name - so it lands in
    // the later (modified) slot. Stable sort keeps drop order for equal lengths.
    const ordered = [...files].sort((a, b) => a.name.length - b.name.length);
    const [originalFile, modifiedFile] = routeByOrder(ordered, [!!original, !!modified]);
    if (originalFile) updateOriginal(originalFile);
    if (modifiedFile) updateModified(modifiedFile);
  };
  const loadCreateSample = async () => {
    setSampleLoading(true);
    setSampleError("");
    try {
      const files = await Promise.all(
        CREATE_SAMPLE_ASSETS.map(async ([url, name]) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return new File([await response.blob()], name, { type: "application/octet-stream" });
        }),
      );
      handleUnifiedDrop(files);
    } catch {
      setSampleError("Could not load the sample. Try again.");
    } finally {
      setSampleLoading(false);
    }
  };
  const swapCreateSources = () => {
    const workflow = stagedCreateWorkflowRef.current;
    const bothStaged = !!workflow && originalState?.status === "ready" && modifiedState?.status === "ready";
    if (!bothStaged) {
      // Sources are still staging - fall back to the re-stage swap.
      const previousOriginal = original;
      updateOriginal(modified);
      updateModified(previousOriginal);
      return;
    }
    // Both ROMs are already extracted: swap the workflow's staged sessions and
    // the display state in place - no re-extraction. The patch is direction-
    // specific, so a finished output is invalidated, but the sources are reused.
    const previousOriginal = original;
    const previousOriginalState = originalState;
    void workflow.swap();
    resetWorkflowOutput();
    setOriginalState(modifiedState);
    setModifiedState(previousOriginalState);
    if (props.original === undefined) setInternalOriginal(modified);
    if (props.modified === undefined) setInternalModified(previousOriginal);
    props.onOriginalChange?.(modified);
    props.onModifiedChange?.(previousOriginal);
    // The source keys merely swapped, so tell the staging effect nothing changed.
    stagedCreateWorkflowSyncRef.current = {
      modifiedKey: originalSourceKey,
      originalKey: modifiedSourceKey,
      settingsKey: stagingSettingsKey,
    };
  };

  // Forward a page-level drop (dragging anywhere on the page) to the unified
  // handler so the whole tab is a drop target, not just the dropzone box.
  usePageDropForwarder(props.pageDrop, (files) => handleUnifiedDrop(files), handledPageDropIdRef);
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
    resetWorkflowOutput({ clearProgress: false });
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updatePatchType = (nextPatchType: string) => {
    setPatchTypeManuallySelected(true);
    resetWorkflowOutput();
    if (!props.patchType) setInternalPatchType(nextPatchType);
    props.onPatchTypeChange?.(nextPatchType);
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
    const stageCreateRole = async (
      role: "modified" | "original",
      changed: boolean,
      source: BinarySource | null,
      roleGeneration: number,
      setSource: () => Promise<void>,
      commit: () => void,
    ) => {
      if (!changed) return true;
      if (!source) return true;
      await enqueueSourceStage(role, setSource);
      return finishCreateRoleStaging(role, roleGeneration, isCurrentStaging, isCurrentRoleStaging, commit, () =>
        clearProgressForStage("input"),
      );
    };
    let activeRole: "modified" | "original" | null = null;
    const stageCreateRoles = async () => {
      if (originalChanged && original) {
        activeRole = "original";
        const originalStaged = await stageCreateRole(
          "original",
          originalChanged,
          original,
          originalGeneration,
          () => activeWorkflow.setOriginal(original),
          () => setOriginalState(activeWorkflow.getOriginal()),
        );
        if (!originalStaged) return false;
        activeRole = null;
      }
      if (modifiedChanged && modified) {
        activeRole = "modified";
        const modifiedStaged = await stageCreateRole(
          "modified",
          modifiedChanged,
          modified,
          modifiedGeneration,
          () => activeWorkflow.setModified(modified),
          () => setModifiedState(activeWorkflow.getModified()),
        );
        if (!modifiedStaged) return false;
        activeRole = null;
      }
      return true;
    };
    const finishStaging = async () => {
      try {
        if (!(await stageCreateRoles())) return;
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
        onError?.(normalizedError);
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
    onError,
    resolvedAssetBaseUrl,
    setWorkflowMessage,
    stagingSettingsKey,
    setProgress,
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
      try {
        await completedOutput.saveAs({ interactive: true });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        setOutputWorkflowMessage(normalizedError);
        notifyError(normalizedError);
      }
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
    const stagedOriginal = original;
    const stagedModified = modified;
    await runWorkflow(async (abortController, registerCleanup) => {
      const createWorkflow =
        stagedCreateWorkflowRef.current ||
        new CreateWorkflowConstructor({
          ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
          id: workflowIdRef.current,
          selectFile: async (request) =>
            createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
          settings: toCreateWorkflowSettings(settings, executionOutputName, props.threads),
          signal: abortController.signal,
        });
      const usingStagedWorkflow = stagedCreateWorkflowRef.current === createWorkflow;
      const baseProgressHandler = createProgressHandler("create");
      const handleProgress: typeof baseProgressHandler = (event) => {
        if (event.stage === "compress") markCompressionStart(createExecutionTimingRef.current);
        baseProgressHandler(event);
      };
      createWorkflow.on("progress", handleProgress);
      const abortWorkflow = () => createWorkflow.abort(abortController.signal.reason);
      abortController.signal.addEventListener("abort", abortWorkflow, { once: true });
      registerCleanup(async () => {
        abortController.signal.removeEventListener("abort", abortWorkflow);
        createWorkflow.off("progress", handleProgress);
        if (!usingStagedWorkflow) await createWorkflow.dispose();
      });
      if (usingStagedWorkflow) {
        await createWorkflow.setSettings(toCreateWorkflowSettings(settings, executionOutputName, props.threads));
      } else {
        await createWorkflow.setOriginal(stagedOriginal);
        await createWorkflow.setModified(stagedModified);
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
      const { compressionTimeMs, operationTimeMs: createTimeMs } = deriveWorkflowRunTiming({
        completedAt,
        compressionStartedAt,
        operationStartedAt: createStartedAt,
        reportedCompressionTimeMs: result.sizeSummary?.compressionTimeMs,
        reportedOperationTimeMs: result.sizeSummary?.createTimeMs,
      });
      rememberOutputDispose(result.output.dispose);
      // Warm the output's download snapshot so a later download tap reaches navigator.share
      // before its user activation expires (iOS PWA share path).
      void result.output.prepareDownload?.().catch(() => undefined);
      setCompletedOutput({
        compression: createCompression,
        compressionTimeMs: compressionTimeMs ?? undefined,
        createTimeMs: createTimeMs ?? undefined,
        fileName: result.output.fileName,
        patchType,
        rawSize: result.sizeSummary?.rawSize,
        saveAs: result.output.saveAs,
        size: result.sizeSummary?.outputSize ?? result.output.size,
      });
      setProgress(null);
      if (typeof window !== "undefined") await result.output.saveAs();
      props.onCreateComplete?.(result);
    });
  };

  useEffect(
    () => () => {
      abortActiveOperation();
      disposeActiveOutput();
    },
    [abortActiveOperation, disposeActiveOutput],
  );

  useQueuedRunEffect({
    blocked: createQueueBlocked,
    busy,
    canQueue: canQueueCreate,
    canStart: canStartCreate,
    completed: !!completedOutput,
    pending: createPreparationPending,
    queued: createQueued,
    run: () => void runCreate(),
    setQueued: setCreateQueued,
  });

  const progressProps = toWorkflowFileProgressProps(progress);
  const waitingProgressProps = toWorkflowFileProgressProps(createWaitingWorkflowProgress());
  const cancelCreateOutputProgress = () => cancelOutputProgress(busy);
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

  // Runtime-notice slice the source-step builder previously closed over (the failure message and its
  // placement/severity/dismissibility). Passed explicitly so the builder stays a pure projection.
  const sourceStepRuntimeNotice: CreateSourceStepRuntimeNotice = {
    clearWorkflowMessage,
    errorCode,
    message,
    messageDismissible,
    messagePlacement,
  };
  const renderSourceStep = (
    options: Omit<Parameters<typeof buildCreateSourceStep>[0], "runtimeNotice">,
  ): CreatePatchFormViewModel["originalStep"] =>
    buildCreateSourceStep({ ...options, runtimeNotice: sourceStepRuntimeNotice });

  const createFileInputAccept = getFileInputAcceptAttributes();
  const createSourcesActuallyEmpty = !(original || modified || createPreparationPending);
  const createSourcesEmpty = useFlatTransitionFlag(createSourcesActuallyEmpty);
  // The selvage status strip mirrors this workflow's job state.
  useWorkbenchActivity(workflowIdRef.current, { busy, completed: !!completedOutput, queued: createQueued });

  const createModel = (): CreatePatchFormViewModel => ({
    dialog: candidateSelectionDialog,
    dropZone: {
      accept: createFileInputAccept.unifiedRom,
      addLabel: "Add or replace a ROM",
      afterDropZone: createSourcesActuallyEmpty ? (
        <div className="first-weave-demo">
          <span>New here?</span>
          <button
            aria-busy={sampleLoading}
            className="btn ghost slim"
            disabled={sampleLoading}
            onClick={() => void loadCreateSample()}
            type="button"
          >
            {sampleLoading ? "Loading sample…" : "Start with sample assets"}
          </button>
          {sampleError ? <span role="status">{sampleError}</span> : null}
        </div>
      ) : null,
      big: createSourcesEmpty,
      disabled: uploadDisabled,
      heroLabel: "Drop or click to add the original and modified ROMs",
      heroLabelCoarse: "Tap to add the original and modified ROMs",
      id: "patch-builder-row-unified-drop",
      inputId: "patch-builder-input-file-unified",
      onFiles: handleUnifiedDrop,
      supported: CREATE_SUPPORTED_FILES,
    },
    modifiedStep: renderSourceStep({
      checksumProgress: getSourceChecksumProgress("modified"),
      file: modified,
      fileName: displayedModifiedFileName,
      num: "0x03",
      onClear: () => updateModified(null),
      removeLabel: "Clear modified ROM",
      role: "modified",
      sourceProgress: getSourceProgress("modified"),
      sourceState: modifiedState,
      title: "Modified",
    }),
    originalStep: renderSourceStep({
      checksumProgress: getSourceChecksumProgress("original"),
      file: original,
      fileName: displayedOriginalFileName,
      num: "0x02",
      onClear: () => updateOriginal(null),
      removeLabel: "Clear original ROM",
      role: "original",
      sourceProgress: getSourceProgress("original"),
      sourceState: originalState,
      title: "Original",
    }),
    output: {
      action: (
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
      ),
      compress: buildOutputCompressionPanel({
        disabled: outputDisabled,
        fields: createCompressPanel?.fields,
        format:
          createCompression === "none"
            ? getOutputCompressionFormatLabel(createCompression, createCompressionOptions)
            : `patch in ${getOutputCompressionFormatLabel(createCompression, createCompressionOptions)}`,
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
      }),
      disabled: outputDisabled,
      fileName: resolvedOutputName,
      fileNameId: "patch-builder-output-file",
      fileNamePlaceholder: "Patch filename",
      format: patchType,
      formatId: "patch-builder-select-patch-type",
      formatOptions: patchFormatOptions,
      info: (
        <InfoPopover title="Output options">
          <strong>Output</strong>
          <ul>
            <li>Set the filename without an extension - the format selector controls the patch type.</li>
            <li>BPS records source &amp; target checksums so applies can be verified.</li>
            <li>
              The patch is packaged in an archive by default; set Options &rarr; Type to None to download the raw patch
              file.
            </li>
          </ul>
        </InfoPopover>
      ),
      meta: createTimingText ? <span className="t">{createTimingText}</span> : undefined,
      notice:
        message && messagePlacement === "output" ? (
          <Notice
            id="patch-builder-row-error-message"
            level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
            onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
          >
            {message}
          </Notice>
        ) : null,
      num: "0x04",
      onFileNameChange: (value) => {
        setOutputName(value);
        updateSettings({
          ...settings,
          output: { ...settings.output, outputName: value.trim() || undefined },
        });
      },
      onFormatChange: updatePatchType,
      title: "Patch",
    },
    sourcesEmpty: createSourcesActuallyEmpty,
    swap: createInputsSelected
      ? { disabled: uploadDisabled || createPreparationPending || createQueued, onSwap: swapCreateSources }
      : null,
  });
  const model = createModel();

  return <CreatePatchFormView {...model} />;
}

export { CreatePatchForm };
