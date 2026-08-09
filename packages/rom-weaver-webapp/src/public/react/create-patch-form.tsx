import { Download, GitCompare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPreferredCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import type {
  BrowserCreateResult,
  CreateSettings,
  CreateWorkflow,
  getCreatePatchFormatCandidates,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { resolveAssetUrl } from "./asset-url.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { IgnoredPatchDropNotice } from "./components/ds/ignored-patch-notice.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { InfoPopover } from "./components/ds/layout.tsx";
import {
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
  useGuidedSampleStart,
} from "./components/ds/sample-tutorial.tsx";
import { GUIDED_SAMPLE_HREFS } from "./guided-sample-start.ts";
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
import {
  getCreateSettingsOutputName,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import { collectIgnoredPatchDrops, routeByOrder } from "./unified-drop-routing.ts";
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
import { loadBrowserApi } from "./workflow-loader.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
} from "./workflow-run-hooks.ts";
import { deriveWorkflowRunTiming, useWorkflowRunLifecycle } from "./workflow-run-lifecycle.ts";

/**
 * What the staging effect has to redo this pass. Settings changes rebuild the
 * workflow outright; clearing either source does too, since the surviving one
 * has to be re-staged against a fresh workflow.
 */
const resolveCreateStagingPlan = (
  previousSync: { modifiedKey: string; originalKey: string; settingsKey: string },
  next: {
    modified: BinarySource | null;
    modifiedSourceKey: string;
    original: BinarySource | null;
    originalSourceKey: string;
    settingsKey: string;
  },
) => {
  const settingsChanged = previousSync.settingsKey !== next.settingsKey;
  const originalKeyChanged = previousSync.originalKey !== next.originalSourceKey;
  const modifiedKeyChanged = previousSync.modifiedKey !== next.modifiedSourceKey;
  const sourceCleared = (originalKeyChanged && !next.original) || (modifiedKeyChanged && !next.modified);
  const workflowReset = settingsChanged || sourceCleared;
  return {
    modifiedChanged: settingsChanged || modifiedKeyChanged || (workflowReset && !!next.modified),
    originalChanged: settingsChanged || originalKeyChanged || (workflowReset && !!next.original),
    workflowReset,
  };
};

/** The source a failed role was staging, so its own queue warning can suppress the message. */
const readStagedRoleSource = <TSource,>(
  workflow: { getModified: () => TSource; getOriginal: () => TSource },
  role: "modified" | "original" | "output",
): TSource | null => {
  if (role === "original") return workflow.getOriginal();
  return role === "modified" ? workflow.getModified() : null;
};

/**
 * Claim this staging pass. Bumping a generation is what invalidates any pass
 * still in flight, so the bumps, the workflow reset, and the sync-key commit all
 * have to land together - a pass that claimed half of this would let a displaced
 * run write over the newer one's state.
 */
const claimCreateStagingPass = (input: {
  generationRefs: {
    modified: { current: number };
    original: { current: number };
    workflow: { current: number };
  };
  modifiedChanged: boolean;
  originalChanged: boolean;
  syncKeys: { modifiedKey: string; originalKey: string; settingsKey: string };
  syncRef: { current: { modifiedKey: string; originalKey: string; settingsKey: string } };
  workflowReset: boolean;
  workflowRef: { current: CreateWorkflow | null };
}) => {
  const { generationRefs, workflowReset } = input;
  const bump = (ref: { current: number }, changed: boolean) => (changed ? ++ref.current : ref.current);
  let workflow = input.workflowRef.current;
  const generation = bump(generationRefs.workflow, workflowReset);
  if (workflowReset) {
    workflow?.dispose().catch(() => undefined);
    workflow = null;
    input.workflowRef.current = null;
  }
  const originalGeneration = bump(generationRefs.original, input.originalChanged);
  const modifiedGeneration = bump(generationRefs.modified, input.modifiedChanged);
  input.syncRef.current = input.syncKeys;
  return { generation, modifiedGeneration, originalGeneration, workflow };
};

type CreateStagingRoleEntry = {
  changed: boolean;
  commit: () => void;
  generation: number;
  role: "modified" | "original";
  setSource: () => Promise<void>;
  source: BinarySource | null;
};

/**
 * The staging pass for one effect run. Every callback closes over the generation
 * it was created with, so a displaced pass writes nothing: `isCurrent` fails and
 * the run returns without touching state the newer pass now owns.
 */
const createCreateStagingSession = (input: {
  activeWorkflow: CreateWorkflow;
  clearInputProgress: () => void;
  generation: number;
  generationRefs: {
    modified: { current: number };
    original: { current: number };
    workflow: { current: number };
  };
  onError?: (error: Error) => void;
  queueRef: { current: Promise<void> };
  rolePlan: CreateStagingRoleEntry[];
  setModifiedState: (value: ReturnType<CreateWorkflow["getModified"]> | null) => void;
  setOriginalState: (value: ReturnType<CreateWorkflow["getOriginal"]> | null) => void;
  setStagingRole: (role: "modified" | "original" | null) => void;
  setWorkflowMessage: (role: "modified" | "original" | "output", error: Error) => void;
  workflowRef: { current: CreateWorkflow | null };
}) => {
  const { activeWorkflow, generationRefs, rolePlan } = input;
  let activeRole: "modified" | "original" | null = null;

  const isCurrentStaging = () =>
    generationRefs.workflow.current === input.generation && input.workflowRef.current === activeWorkflow;

  const isCurrentRoleStaging = (role: "modified" | "original", roleGeneration: number) =>
    isCurrentStaging() &&
    (role === "original"
      ? generationRefs.original.current === roleGeneration
      : generationRefs.modified.current === roleGeneration);

  // One source at a time: two concurrent setOriginal/setModified calls would race
  // the same workflow.
  const enqueueSourceStage = (role: "modified" | "original", run: () => Promise<void>) => {
    const queued = input.queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrentStaging()) return;
        input.setStagingRole(role);
        await run();
      });
    input.queueRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  const stageRoles = async () => {
    for (const entry of rolePlan) {
      if (!(entry.changed && entry.source)) continue;
      activeRole = entry.role;
      await enqueueSourceStage(entry.role, entry.setSource);
      const staged = finishCreateRoleStaging(
        entry.role,
        entry.generation,
        isCurrentStaging,
        isCurrentRoleStaging,
        entry.commit,
        input.clearInputProgress,
      );
      if (!staged) return false;
      activeRole = null;
    }
    return true;
  };

  const reportFailure = (error: unknown) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    if (getErrorCode(normalizedError) === "WORKFLOW_SELECTION_SKIPPED" || !isCurrentStaging()) return;
    input.setOriginalState(activeWorkflow.getOriginal());
    input.setModifiedState(activeWorkflow.getModified());
    const failedRole = activeRole || "output";
    if (!hasSourceQueueWarning(readStagedRoleSource(activeWorkflow, failedRole))) {
      input.setWorkflowMessage(failedRole, normalizedError);
    }
    input.onError?.(normalizedError);
  };

  const finish = async (detachProgress: () => void) => {
    try {
      await stageRoles();
    } catch (error) {
      reportFailure(error);
    } finally {
      detachProgress();
      if (isCurrentStaging()) {
        input.setStagingRole(null);
        input.clearInputProgress();
      }
    }
  };

  return { finish };
};

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

// Bare names, resolved against the app's base at fetch time: a root-absolute
// path breaks any deployment that is not served from the domain root.
const CREATE_SAMPLE_ASSETS = [
  ["hello-world.nes", "hello-world.nes"],
  ["modified-world.nes", "modified-world.nes"],
] as const;
// The pair as one download; the guided path fetches the two ROMs individually.
const CREATE_SAMPLE_ARCHIVE = "first-create.zip";
const CREATE_SAMPLE_TUTORIAL_STEPS: readonly SampleTutorialStep[] = [
  {
    actions: [
      ["checks", "Checks"],
      ["remove", "Remove"],
    ],
    body: "The Original card keeps the starting file's name, remove control, and checksums together.",
    openDrawers: true,
    target: "#patch-builder-row-original",
    title: "Start with the original",
  },
  {
    actions: [
      ["swap", "Swap"],
      ["checks", "Checks"],
      ["remove", "Remove"],
    ],
    body: "Modified is the version the new patch should reproduce. Dropped them the wrong way round? Swap trades the two in one click.",
    lift: ".swap-row",
    openDrawers: true,
    target: "#patch-builder-row-modified",
    title: "Compare the modified ROM",
  },
  {
    actions: [
      ["drop", "Drop files"],
      ["drop", "Browse"],
    ],
    body: "The compact 0x01 row stays available after setup for adding files by drag and drop or the file picker.",
    target: "#patch-builder-row-unified-drop",
    title: "Add files at any time",
  },
  {
    actions: [
      ["options", "Options"],
      ["archive", "Archive"],
      ["create", "Create & download"],
    ],
    body: "Choose the patch name, format, archive, and compression settings. Then press CREATE & DOWNLOAD PATCH.",
    cta: ".btn.run",
    openDrawers: true,
    placement: "top",
    target: "#patch-builder-row-output",
    title: "Create the patch",
  },
];

type InternalCreatePatchFormProps = CreatePatchFormProps & {
  createWorkflow?: typeof CreateWorkflow;
  getCreatePatchFormatCandidates?: typeof getCreatePatchFormatCandidates;
};

function CreatePatchForm(props: CreatePatchFormProps) {
  const { onError } = props;
  const internalProps = props as InternalCreatePatchFormProps;
  const createWorkflowOverride = internalProps.createWorkflow;
  const createPatchFormatCandidatesOverride = internalProps.getCreatePatchFormatCandidates;
  const resolveCreatePatchFormatCandidates = useCallback(
    (options: Parameters<typeof getCreatePatchFormatCandidates>[0]) =>
      createPatchFormatCandidatesOverride
        ? createPatchFormatCandidatesOverride(options)
        : loadBrowserApi().then(({ getCreatePatchFormatCandidates }) => getCreatePatchFormatCandidates(options)),
    [createPatchFormatCandidatesOverride],
  );
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
  const [sampleTutorialActive, setSampleTutorialActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createQueued, setCreateQueued] = useState(false);
  const [stagingRole, setStagingRole] = useState<"modified" | "original" | null>(null);
  const [message, setMessage] = useState("");
  const [messageDismissible, setMessageDismissible] = useState(false);
  const [messagePlacement, setMessagePlacement] = useState<CreateMessagePlacement | null>(null);
  const [originalState, setOriginalState] = useState<CreateDisplaySourceState | null>(null);
  const [modifiedState, setModifiedState] = useState<CreateDisplaySourceState | null>(null);
  // Patch files the last drop discarded - this tab has no patch bucket.
  const [ignoredPatchNames, setIgnoredPatchNames] = useState<string[]>([]);
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
    setIgnoredPatchNames(collectIgnoredPatchDrops(files).map((file) => file.name));
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
        CREATE_SAMPLE_ASSETS.map(async ([asset, name]) => {
          const response = await fetch(resolveAssetUrl(resolvedAssetBaseUrl, asset));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return new File([await response.blob()], name, { type: "application/octet-stream" });
        }),
      );
      handleUnifiedDrop(files);
    } catch {
      setSampleTutorialActive(false);
      setSampleError("Could not load the sample. Try again.");
    } finally {
      setSampleLoading(false);
    }
  };
  useGuidedSampleStart(
    "create",
    () => {
      setSampleTutorialActive(true);
      void loadCreateSample();
    },
    () => setSampleTutorialActive(false),
  );
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
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const stage = async () => {
      // Load the constructor BEFORE any bookkeeping. The sync-key commit below
      // marks the sources as staged, so everything from there to the staging
      // enqueue must stay atomic (as it was when the constructor was a static
      // import): a run aborted at this await has claimed nothing, and the
      // re-run that displaced it re-derives the full diff itself. The
      // cleared-source path stays off this await so it never pulls the chunk.
      const hasSource = !!(original || modified);
      const CreateWorkflowConstructor =
        createWorkflowOverride || (hasSource ? (await loadBrowserApi()).CreateWorkflow : null);
      if (disposed) return;
      const { modifiedChanged, originalChanged, workflowReset } = resolveCreateStagingPlan(
        stagedCreateWorkflowSyncRef.current,
        { modified, modifiedSourceKey, original, originalSourceKey, settingsKey: stagingSettingsKey },
      );
      const claimed = claimCreateStagingPass({
        generationRefs: {
          modified: stagingModifiedGenerationRef,
          original: stagingOriginalGenerationRef,
          workflow: stagedCreateWorkflowGenerationRef,
        },
        modifiedChanged,
        originalChanged,
        syncKeys: {
          modifiedKey: modifiedSourceKey,
          originalKey: originalSourceKey,
          settingsKey: stagingSettingsKey,
        },
        syncRef: stagedCreateWorkflowSyncRef,
        workflowReset,
        workflowRef: stagedCreateWorkflowRef,
      });
      const { generation, modifiedGeneration, originalGeneration } = claimed;
      if (originalChanged) setOriginalState(null);
      if (modifiedChanged) setModifiedState(null);
      if (!(original || modified)) {
        setStagingRole(null);
        setProgress((current) => (current?.stage === "input" ? null : current));
        return;
      }
      const activeWorkflow =
        claimed.workflow ??
        (CreateWorkflowConstructor
          ? new CreateWorkflowConstructor({
              ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
              id: `${workflowIdRef.current}:stage:${generation}`,
              selectFile: async (request) =>
                createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
              settings: stagingSettingsRef.current,
            })
          : null);
      if (!activeWorkflow) return;
      stagedCreateWorkflowRef.current = activeWorkflow;
      const handleProgress = createProgressHandler("input");
      activeWorkflow.on("progress", handleProgress);
      const session = createCreateStagingSession({
        activeWorkflow,
        clearInputProgress: () => clearProgressForStage("input"),
        generation,
        generationRefs: {
          modified: stagingModifiedGenerationRef,
          original: stagingOriginalGenerationRef,
          workflow: stagedCreateWorkflowGenerationRef,
        },
        onError,
        queueRef: sourceStageQueueRef,
        // Original first: the diff reads it as the base, so a modified source
        // staged against a half-set original would derive the wrong patch.
        rolePlan: [
          {
            changed: originalChanged,
            commit: () => setOriginalState(activeWorkflow.getOriginal()),
            generation: originalGeneration,
            role: "original",
            setSource: () => activeWorkflow.setOriginal(original as BinarySource),
            source: original,
          },
          {
            changed: modifiedChanged,
            commit: () => setModifiedState(activeWorkflow.getModified()),
            generation: modifiedGeneration,
            role: "modified",
            setSource: () => activeWorkflow.setModified(modified as BinarySource),
            source: modified,
          },
        ],
        setModifiedState,
        setOriginalState,
        setStagingRole,
        setWorkflowMessage,
        workflowRef: stagedCreateWorkflowRef,
      });
      const finishStaging = () => session.finish(() => activeWorkflow.off("progress", handleProgress));
      void finishStaging();
      cleanup = () => activeWorkflow.off("progress", handleProgress);
    };
    void stage();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [
    clearProgressForStage,
    createWorkflowOverride,
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
        new (createWorkflowOverride || (await loadBrowserApi()).CreateWorkflow)({
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
  const sampleTutorialReady = createSourcesReady && !createPreparationPending;
  // The selvage status strip mirrors this workflow's job state.
  useWorkbenchActivity(workflowIdRef.current, { busy, completed: !!completedOutput, queued: createQueued });

  const createModel = (): CreatePatchFormViewModel => ({
    dropNotice: (
      <IgnoredPatchDropNotice
        fileNames={ignoredPatchNames}
        onDismiss={() => setIgnoredPatchNames([])}
        onOpenApplyTab={
          props.onOpenApplyTab
            ? () => {
                setIgnoredPatchNames([]);
                props.onOpenApplyTab?.();
              }
            : undefined
        }
      />
    ),
    dialog: (
      <>
        {candidateSelectionDialog}
        {sampleTutorialActive ? (
          <SampleTutorial
            loadingBody="RomWeaver is loading two tiny ROMs, then fingerprinting the untouched and edited versions."
            onClose={() => setSampleTutorialActive(false)}
            ready={sampleTutorialReady}
            steps={CREATE_SAMPLE_TUTORIAL_STEPS}
          />
        ) : null}
      </>
    ),
    dropZone: {
      accept: createFileInputAccept.unifiedRom,
      addLabel: "Add or replace a ROM",
      afterDropZone: createSourcesActuallyEmpty ? (
        <SampleTutorialStart
          downloadHref={resolveAssetUrl(resolvedAssetBaseUrl, CREATE_SAMPLE_ARCHIVE)}
          downloadName={CREATE_SAMPLE_ARCHIVE}
          downloadLabel="Download the sample ROMs"
          error={sampleError}
          guideHref={GUIDED_SAMPLE_HREFS.create}
          label="Start guided Create"
          startAction="create"
          loading={sampleLoading}
          onStart={() => {
            setSampleTutorialActive(true);
            void loadCreateSample();
          }}
        />
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
        format: getOutputCompressionFormatLabel(createCompression, createCompressionOptions),
        formatId: "patch-builder-select-output-compression",
        formatOptions: createCompressionOptions,
        formatValue: createCompression,
        note: createCompressPanel?.note,
        onFieldChange: (key, value, updates) => updateSettings({ ...settings, ...(updates || { [key]: value }) }),
        onFormatChange: (value) =>
          updateSettings({
            ...settings,
            output: { ...settings.output, compression: value as "7z" | "none" | "zip" },
          }),
        timing: compressTimingText || undefined,
      }),
      disabled: outputDisabled,
      fileName: resolvedOutputName,
      fileNameId: "patch-builder-output-file",
      fileNamePlaceholder: "Patch filename",
      format: patchType,
      formatId: "patch-builder-select-patch-type",
      formatOptions: patchFormatOptions,
      id: "patch-builder-row-output",
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
