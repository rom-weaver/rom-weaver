import { ApplyPatchForm } from "./apply-patch-form.tsx";
import { CreateSourceModeToggle } from "./create-source-mode-toggle.tsx";
import { countDropEntries, readDropEntries } from "./drop-destination.ts";
import type { PageFileDrop } from "./patcher-form.ts";
import { WorkflowErrorMessage } from "./workflow-error-message.tsx";
import { Download, GitCompare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getPreferredCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { getOutputExtensions } from "../../lib/output/output-name-validation.ts";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import type {
  BrowserCreateResult,
  CreateSettings,
  CreateWorkflow,
  getCreatePatchFormatCandidates,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { identifiedOutputBaseName } from "../../presentation/identify-title.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { resolveAssetUrl } from "./asset-url.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { InfoPopover, NeedsInput } from "./components/ds/layout.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import {
  getViewTutorialStep,
  SampleTutorial,
  SampleTutorialStart,
  type SampleTutorialStep,
  useGuidedSampleStart,
} from "./components/ds/sample-tutorial.tsx";
import { requestGuidedSampleStart, resolveGuidedSampleHref } from "./guided-sample-start.ts";
import { WORKFLOW_GUIDES } from "./workflow-guides.ts";
import { OutputRunAction } from "./components/ds/workflow-output-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import { CreatePatchFormView, type CreatePatchFormViewModel } from "./create-patch-form-view.tsx";
import {
  areCreateSourcesIdentical,
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
import { getBinarySourceListStableIds, hasDuplicateBinarySources } from "./input-session-helpers.ts";
import { createCreateOutputCompressionOptions, createCreatePatchFormatOptions } from "./output-view-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  getBareDefaultCompressionMode,
  getDefaultCompressionArchive,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
  useUiLocalizer,
} from "./settings-context.tsx";
import {
  getRomDropNotice,
  getRomDropNoticeLevel,
  routeByOrder,
  selectRomDropCandidate,
} from "./unified-drop-routing.ts";
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
import { describeAgentSource, useAgentWorkflow } from "../../webapp/agent/workflow-registry.ts";

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
const getCreateSampleTutorialSteps = (localizer: ReturnType<typeof useUiLocalizer>): readonly SampleTutorialStep[] => [
  {
    actions: [
      ["checks", localizer.message("ui.apply.tutorial.checks")],
      ["remove", localizer.message("ui.apply.tutorial.remove")],
    ],
    body: localizer.message("ui.create.tutorial.original.body"),
    target: "#patch-builder-row-original",
    title: localizer.message("ui.create.tutorial.original.title"),
    tryIt: localizer.message("ui.create.tutorial.original.tryIt"),
  },
  getViewTutorialStep(localizer, "#patch-builder-row-original"),
  {
    actions: [
      ["swap", localizer.message("ui.create.tutorial.swap")],
      ["checks", localizer.message("ui.apply.tutorial.checks")],
      ["remove", localizer.message("ui.apply.tutorial.remove")],
    ],
    body: localizer.message("ui.create.tutorial.modified.body"),
    lift: ".swap-row",
    target: "#patch-builder-row-modified",
    title: localizer.message("ui.create.tutorial.modified.title"),
    tryIt: localizer.message("ui.create.tutorial.modified.tryIt"),
  },
  {
    actions: [
      ["drop", localizer.message("ui.apply.tutorial.dropFiles")],
      ["drop", localizer.message("ui.apply.tutorial.browse")],
    ],
    body: localizer.message("ui.create.tutorial.addFiles.body"),
    target: "#patch-builder-row-unified-drop",
    title: localizer.message("ui.create.tutorial.addFiles.title"),
    tryIt: localizer.message("ui.create.tutorial.addFiles.tryIt"),
  },
  {
    actions: [
      ["options", localizer.message("ui.apply.tutorial.outputName")],
      ["archive", localizer.message("ui.create.tutorial.archive")],
      ["create", localizer.message("ui.create.tutorial.createDownload")],
    ],
    body: localizer.message("ui.create.tutorial.output.body"),
    cta: ".btn.run",
    placement: "top",
    target: "#patch-builder-row-output",
    title: localizer.message("ui.create.tutorial.output.title"),
    tryIt: localizer.message("ui.create.tutorial.output.tryIt"),
  },
];

type InternalCreatePatchFormProps = CreatePatchFormProps & {
  active?: boolean;
  sourceModeControls?: ReactNode;
  onUnifiedDrop?: (files: File[]) => void;
  /** The page drop is a ROM chosen as the Modified ROM, so it replaces a filled Modified slot. */
  pageDropReplacesModified?: boolean;
  onActivateRomMode?: () => void;
  onBusyChange?: (busy: boolean) => void;
  createWorkflow?: typeof CreateWorkflow;
  getCreatePatchFormatCandidates?: typeof getCreatePatchFormatCandidates;
};

type PendingCreateDrop = ReturnType<typeof routeByOrder>;

const selectCreateDropAssignments = async (
  routed: PendingCreateDrop,
  slotFilled: boolean[],
  selectFile: Parameters<typeof selectRomDropCandidate>[2],
  sourceNames: readonly [string, string],
): Promise<(File | null)[] | null> => {
  const assignment: (File | null)[] = slotFilled.map(() => null);
  const emptySlots = slotFilled.map((filled, index) => (filled ? -1 : index)).filter((index) => index >= 0);
  let candidates = routed.roms.slice();

  for (const [slotOffset, slot] of emptySlots.entries()) {
    if (!candidates.length) break;
    const slotsRemaining = emptySlots.length - slotOffset;
    const candidate =
      candidates.length > slotsRemaining
        ? await selectRomDropCandidate(candidates, sourceNames[slot] || "ROM", selectFile)
        : candidates[0] || null;
    if (!candidate) return null;
    assignment[slot] = candidate;
    candidates.splice(candidates.indexOf(candidate), 1);
  }
  return assignment;
};

function ModifiedRomCreateForm(props: InternalCreatePatchFormProps) {
  const { onError, onBusyChange } = props;
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
  const localizer = useUiLocalizer();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  // id matches webapp-root's `currentView` so root routing targets the active tab.
  useInputSelectionHandler("creator", selectFile, props.active !== false);
  const [internalOriginal, setInternalOriginal] = useState<BinarySource | null>(props.defaultOriginal || null);
  const [internalModified, setInternalModified] = useState<BinarySource | null>(props.defaultModified || null);
  const [internalSettings, setInternalSettings] = useState<CreatePatchFormSettings>(() =>
    mergeSettingsWithOutput(providerSettings, props.defaultSettings),
  );
  const syncedProviderOutputKeyRef = useRef(
    JSON.stringify([providerSettings?.output ?? null, props.defaultSettings?.output ?? null]),
  );
  const [internalPatchType, setInternalPatchType] = useState(props.defaultPatchType || "bps");
  const [patchTypeManuallySelected, setPatchTypeManuallySelected] = useState(
    () => props.patchType !== undefined || !!props.defaultPatchType,
  );
  const [createPatchFormatCandidates, setCreatePatchFormatCandidates] =
    useState<CreatePatchFormatCandidateState | null>(null);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const [sampleTutorial, setSampleTutorial] = useState<"create" | null>(null);
  const sampleLoadGenerationRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [createQueued, setCreateQueued] = useState(false);
  const [stagingRole, setStagingRole] = useState<"modified" | "original" | null>(null);
  const [message, setMessage] = useState("");
  const [messageDismissible, setMessageDismissible] = useState(false);
  const [messagePlacement, setMessagePlacement] = useState<CreateMessagePlacement | null>(null);
  const [dropNoticeRouting, setDropNoticeRouting] = useState<PendingCreateDrop | null>(null);
  const [pendingDuplicateDrop, setPendingDuplicateDrop] = useState<PendingCreateDrop | null>(null);
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
  const dropNotice = dropNoticeRouting ? getRomDropNotice(dropNoticeRouting, localizer) : "";
  const dropNoticeLevel = dropNoticeRouting ? getRomDropNoticeLevel(dropNoticeRouting) : "warn";
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
  const identicalSources = areCreateSourcesIdentical(originalState, modifiedState);
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
  // The patch is named after the ROM it patches, so the original's title is the
  // one that names it - the modified ROM is a hack and rarely has a record.
  const identifiedOutputTitle = identifiedOutputBaseName(originalState?.identification);
  const useIdentifiedOutputName = settings.output?.identifiedName !== false;
  const generatedOutputName =
    configuredOutputName ||
    (useIdentifiedOutputName ? identifiedOutputTitle : null) ||
    getDefaultCreateOutputName(generatedOutputSource);
  const resolvedOutputName = outputName.trim() || generatedOutputName;
  const executionOutputName =
    resolveCreateExecutionOutputName(resolvedOutputName, patchType) ||
    resolveCreateExecutionOutputName(generatedOutputName, patchType);
  const createCompression = (() => {
    const normalized = String(
      settings.output?.compression || getDefaultCompressionArchive(getBareDefaultCompressionMode(settings)),
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
    // Unrelated app settings (the Simple/Detailed view) also replace the provider object; only a
    // change to the provider's own output defaults may overwrite the output choices made here.
    const providerOutputKey = JSON.stringify([providerSettings?.output ?? null, props.defaultSettings?.output ?? null]);
    const providerOutputUnchanged = syncedProviderOutputKeyRef.current === providerOutputKey;
    syncedProviderOutputKeyRef.current = providerOutputKey;
    setInternalSettings((current) => {
      const merged = mergeSettingsWithOutput(providerSettings, props.defaultSettings);
      return providerOutputUnchanged && current.output ? { ...merged, output: current.output } : merged;
    });
  }, [props.defaultSettings, props.settings, providerSettings]);

  const updateOriginal = (file: BinarySource | null) => {
    resetWorkflowOutput();
    setDropNoticeRouting(null);
    setPendingDuplicateDrop(null);
    setOriginalState(null);
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
  };

  const updateModified = (file: BinarySource | null) => {
    resetWorkflowOutput();
    setDropNoticeRouting(null);
    setPendingDuplicateDrop(null);
    setModifiedState(null);
    if (props.modified === undefined) setInternalModified(file);
    props.onModifiedChange?.(file);
  };

  const handledPageDropIdRef = useRef<number | null>(null);
  const applyRoutedDrop = (routed: PendingCreateDrop) => {
    const [originalFile, modifiedFile] = routed.assignment;
    if (originalFile) updateOriginal(originalFile);
    if (modifiedFile) updateModified(modifiedFile);
    setDropNoticeRouting(routed);
  };
  const commitRoutedDrop = (routed: PendingCreateDrop) => {
    const assigned = routed.assignment.filter((file): file is File => file !== null);
    // Compare the resulting pair: a replaced slot's old source is not a duplicate of its replacement.
    const [nextOriginal, nextModified] = routed.assignment;
    const selectedSources = [nextOriginal ?? original, nextModified ?? modified].filter(
      (source): source is BinarySource => source !== null && source !== undefined,
    );
    if (assigned.length > 0 && hasDuplicateBinarySources(selectedSources)) {
      setDropNoticeRouting(null);
      setPendingDuplicateDrop(routed);
      return;
    }
    applyRoutedDrop(routed);
  };
  const handleUnifiedDrop = (files: File[], practiceSample = false, replaceModified = false) => {
    if (!practiceSample) {
      sampleLoadGenerationRef.current += 1;
      setSampleLoading(false);
      setSampleTutorial(null);
    }
    const slotFilled = [!!original, !!modified && !replaceModified];
    const routed = routeByOrder(files, slotFilled);
    const emptySlotCount = slotFilled.filter((filled) => !filled).length;
    if (emptySlotCount > 0 && routed.roms.length > emptySlotCount) {
      setDropNoticeRouting(null);
      void selectCreateDropAssignments(routed, slotFilled, selectFile, [
        localizer.message("ui.step.original"),
        localizer.message("ui.step.modified"),
      ]).then((assignment) => {
        if (!assignment) {
          setDropNoticeRouting(routed.ignoredPatches.length ? { ...routed, unused: [] } : null);
          return;
        }
        commitRoutedDrop({ ...routed, assignment, unused: [] });
      });
      return;
    }
    commitRoutedDrop(routed);
  };
  const closeSampleTutorial = useCallback(() => {
    sampleLoadGenerationRef.current += 1;
    setSampleLoading(false);
    setSampleTutorial(null);
  }, []);
  useEffect(
    () => () => {
      sampleLoadGenerationRef.current += 1;
    },
    [],
  );
  const loadCreateSample = async () => {
    const generation = ++sampleLoadGenerationRef.current;
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
      if (generation !== sampleLoadGenerationRef.current) return;
      handleUnifiedDrop(files, true);
    } catch {
      if (generation !== sampleLoadGenerationRef.current) return;
      closeSampleTutorial();
      setSampleError("Couldn't load the practice files. Check your connection and try again.");
    } finally {
      if (generation === sampleLoadGenerationRef.current) setSampleLoading(false);
    }
  };
  useGuidedSampleStart(
    "create",
    () => {
      props.onActivateRomMode?.();
      setSampleTutorial("create");
      void loadCreateSample();
    },
    closeSampleTutorial,
  );
  useEffect(() => {
    if (props.active === false) closeSampleTutorial();
  }, [closeSampleTutorial, props.active]);
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
  usePageDropForwarder(
    props.pageDrop,
    (files) => handleUnifiedDrop(files, false, !!props.pageDropReplacesModified),
    handledPageDropIdRef,
  );
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
    if (props.active === false) return;
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
    props.active,
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
    if (!original) return;
    if (!modified) return;
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
        if (stagedModified) await createWorkflow.setModified(stagedModified);
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
        warnings: result.warnings,
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
  const createSourcesEmpty = !(original || modified || createPreparationPending);
  const sampleTutorialReady = createSourcesReady && !createPreparationPending;
  // The selvage status strip mirrors this workflow's job state.
  useWorkbenchActivity(workflowIdRef.current, { busy, completed: !!completedOutput, queued: createQueued });

  // Switching the naming source discards any hand-typed name: the toggle picks
  // which automatic name is used, and a manual name would hide the result.
  const setUseIdentifiedOutputName = (on: boolean) => {
    setOutputName("");
    updateSettings({ ...settings, output: { ...settings.output, identifiedName: on, outputName: undefined } });
  };

  const createModel = (): CreatePatchFormViewModel => ({
    done: !!completedOutput,
    onSelectTab: props.onSelectTab,
    dialog: (
      <>
        {candidateSelectionDialog}
        {pendingDuplicateDrop ? (
          <ConfirmDialog
            body={localizer.message("ui.drop.duplicateBody")}
            cancelLabel={localizer.message("ui.common.cancel")}
            confirmLabel={localizer.message("ui.drop.duplicateConfirm")}
            onCancel={() => setPendingDuplicateDrop(null)}
            onConfirm={() => {
              if (!pendingDuplicateDrop) return;
              const routed = pendingDuplicateDrop;
              setPendingDuplicateDrop(null);
              applyRoutedDrop(routed);
            }}
            open
            title={localizer.message("ui.drop.duplicateTitle")}
          />
        ) : null}
        {sampleTutorial ? (
          <SampleTutorial
            download={{
              href: resolveAssetUrl(resolvedAssetBaseUrl, CREATE_SAMPLE_ARCHIVE),
              name: CREATE_SAMPLE_ARCHIVE,
            }}
            loadingBody="RomWeaver is loading two tiny ROMs, then fingerprinting the untouched and edited versions."
            onClose={closeSampleTutorial}
            ready={sampleTutorialReady}
            steps={getCreateSampleTutorialSteps(localizer)}
          />
        ) : null}
      </>
    ),
    dropZone: {
      accept: createFileInputAccept.unifiedApply,
      addLabel: localizer.message("ui.drop.addRom"),
      afterDropZone:
        dropNotice || identicalSources ? (
          <>
            {dropNotice ? (
              <Notice id="patch-builder-input-notice" level={dropNoticeLevel}>
                {dropNotice}
              </Notice>
            ) : null}
            {identicalSources ? (
              <Notice id="patch-builder-identical-notice" level="warn">
                {localizer.message("ui.create.identicalInputs")}
              </Notice>
            ) : null}
          </>
        ) : null,
      big: createSourcesEmpty,
      guide: WORKFLOW_GUIDES.create,
      disabled: uploadDisabled,
      heroLabel: "Drop or click to add original and modified ROMs or archives",
      heroLabelCoarse: "Tap to add original and modified ROMs or archives",
      id: "patch-builder-row-unified-drop",
      inputId: "patch-builder-input-file-unified",
      onFiles: props.onUnifiedDrop || handleUnifiedDrop,
      onboarding: createSourcesEmpty ? (
        <SampleTutorialStart
          chipLabel={localizer.message("ui.tutorial.tryCreate")}
          documentation={{
            href: resolveAssetUrl(resolvedAssetBaseUrl, WORKFLOW_GUIDES.create.path),
            label: localizer.message(WORKFLOW_GUIDES.create.label),
          }}
          downloadHref={resolveAssetUrl(resolvedAssetBaseUrl, CREATE_SAMPLE_ARCHIVE)}
          downloadName={CREATE_SAMPLE_ARCHIVE}
          downloadLabel="Download samples"
          error={sampleError}
          guideHref={resolveGuidedSampleHref(resolvedAssetBaseUrl, "create")}
          label="Start a practice run"
          startAction="create"
          loading={sampleLoading}
          onStart={() => {
            setSampleTutorial("create");
            void loadCreateSample();
          }}
          secondaryAction="toggle"
          secondaryHref={resolveGuidedSampleHref(resolvedAssetBaseUrl, "create-cheats")}
          secondaryLabel="Create a patch from cheats"
          onSecondaryStart={() => requestGuidedSampleStart("create-cheats")}
        />
      ) : null,
      supported: CREATE_SUPPORTED_FILES,
    },
    sourceModeControls: props.sourceModeControls,
    modifiedStep: {
      ...renderSourceStep({
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
      emptyState: (
        <NeedsInput onClick={() => document.getElementById("patch-builder-input-file-unified")?.click()}>
          {localizer.message("ui.create.needsModified")}
        </NeedsInput>
      ),
      headerExtra: props.sourceModeControls,
    },
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
      outputExtensions: getOutputExtensions([patchType], createCompression),
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
      nameSource: identifiedOutputTitle
        ? { identifiedName: identifiedOutputTitle, on: useIdentifiedOutputName, onChange: setUseIdentifiedOutputName }
        : null,
      notice:
        message && messagePlacement === "output" ? (
          <Notice
            id="patch-builder-row-error-message"
            level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
            onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
          >
            <WorkflowErrorMessage message={message} />
          </Notice>
        ) : completedOutput?.warnings?.length ? (
          <Notice id="patch-builder-output-warning" level="warn">
            {completedOutput.warnings.join(" ")}
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
    sourcesEmpty: createSourcesEmpty,
    swap: createInputsSelected
      ? { disabled: uploadDisabled || createPreparationPending || createQueued, onSwap: swapCreateSources }
      : null,
  });
  const model = createModel();

  const createActionEnabled = !(actionDisabled || completedOutput);
  const downloadActionEnabled = !actionDisabled && !!completedOutput;
  useAgentWorkflow(
    "creator",
    {
      getState: () => ({
        sources: {
          original: describeAgentSource(original),
          modified: describeAgentSource(modified),
        },
        sourceState: {
          original: originalState,
          modified: modifiedState,
        },
        settings,
        options: {
          compression: createCompression,
          outputName: resolvedOutputName,
          patchType,
        },
        ready: canStartCreate,
        staging: createPreparationPending,
        queued: createQueued,
        busy,
        error: message || null,
        errorCode: errorCode || null,
        progress,
        output: completedOutput
          ? {
              compression: completedOutput.compression,
              fileName: completedOutput.fileName,
              patchType: completedOutput.patchType,
              rawSize: completedOutput.rawSize,
              size: completedOutput.size,
            }
          : { fileName: executionOutputName, ready: canStartCreate },
        confirmationOpen: !!pendingDuplicateDrop,
      }),
      actions: {
        create: {
          description: "Create and download a patch from the staged sources.",
          enabled: createActionEnabled,
          execute: () => {
            if (createActionEnabled) return runCreate();
            return undefined;
          },
        },
        download: {
          description: "Download the completed patch again.",
          enabled: downloadActionEnabled,
          execute: () => {
            if (downloadActionEnabled) return runCreate();
            return undefined;
          },
        },
        cancel: {
          description: "Cancel the active or queued patch creation.",
          enabled: busy || createQueued,
          execute: () => {
            if (busy || createQueued) cancelCreateOutputProgress();
          },
        },
        cancelOriginalStaging: {
          description: "Cancel original ROM staging and clear that source.",
          enabled: stagingRole === "original",
          execute: () => {
            if (stagingRole === "original") cancelSourceStaging("original");
          },
        },
        cancelModifiedStaging: {
          description: "Cancel modified ROM staging and clear that source.",
          enabled: stagingRole === "modified",
          execute: () => {
            if (stagingRole === "modified") cancelSourceStaging("modified");
          },
        },
      },
    },
    props.active !== false,
  );
  useEffect(() => onBusyChange?.(busy || createQueued), [busy, createQueued, onBusyChange]);

  return <CreatePatchFormView {...model} active={props.active} />;
}

// The cheat entry page and a `?mode=cheats` request open Patches & cheats, where cheat codes live.
const entrySourceMode = (entry: CreatePatchFormProps["entry"]) => (entry === "cheats" ? "patches" : "rom");

function CreatePatchForm(props: CreatePatchFormProps) {
  const [sourceMode, setSourceMode] = useState<"rom" | "patches">(entrySourceMode(props.entry));
  const [patchesMounted, setPatchesMounted] = useState(props.entry === "cheats");
  const appliedEntryRef = useRef(props.entry);
  const [internalOriginal, setInternalOriginal] = useState<BinarySource | null>(props.defaultOriginal || null);
  const [romBusy, setRomBusy] = useState(false);
  const [patchesBusy, setPatchesBusy] = useState(false);
  const [cheatSampleRequestId, setCheatSampleRequestId] = useState(0);
  const [deliveries, setDeliveries] = useState<
    (PageFileDrop & { mode: "rom" | "patches"; replacesModified?: boolean })[]
  >([]);
  const nextDropId = useRef(0);
  const dropQueue = useRef(Promise.resolve());
  const handledPageDropIdRef = useRef<number | null>(null);
  const original = props.original === undefined ? internalOriginal : props.original;
  const inputs = useMemo(() => (original ? [original] : []), [original]);
  const changeOriginal = (file: BinarySource | null) => {
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
  };
  const changeMode = (mode: "rom" | "patches") => {
    if (mode === "patches") setPatchesMounted(true);
    setSourceMode(mode);
  };
  const sourceModeRef = useRef(sourceMode);
  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);
  // Each new entry request switches the mode once, after any running work, so the
  // reader can still change it afterwards.
  const modeLocked = !!props.disabled || romBusy || patchesBusy;
  useEffect(() => {
    if (props.entry === undefined) {
      appliedEntryRef.current = undefined;
      return;
    }
    if (appliedEntryRef.current === props.entry || modeLocked) return;
    appliedEntryRef.current = props.entry;
    if (props.entry === "cheats") setPatchesMounted(true);
    setSourceMode(entrySourceMode(props.entry));
  }, [props.entry, modeLocked]);
  // ROM-only drops stay in Patches & cheats while it is active; its form decides the ROM's slot.
  const queueDrop = (files: File[], romMode?: "rom", replacesModified = false) => {
    const id = ++nextDropId.current;
    dropQueue.current = dropQueue.current
      .catch(() => undefined)
      .then(async () => {
        const entries = await readDropEntries(files);
        const counts = countDropEntries(entries);
        const hasPatches = counts.patches || counts.weaves || entries.some((entry) => entry.hasPatches);
        const mode = hasPatches ? "patches" : romMode || sourceModeRef.current;
        setDeliveries((current) => [...current, { files, id, mode, replacesModified }]);
      })
      .catch((error: unknown) => props.onError?.(error instanceof Error ? error : new Error(String(error))));
  };
  const routeDrop = (files: File[]) => queueDrop(files);
  const delivery = deliveries[0];
  const activeMode = delivery?.mode || sourceMode;
  useEffect(() => {
    if (!delivery) return;
    if (delivery.mode === "patches") setPatchesMounted(true);
    setSourceMode(delivery.mode);
    const timer = setTimeout(() => setDeliveries((current) => current.filter((entry) => entry.id !== delivery.id)), 0);
    return () => clearTimeout(timer);
  }, [delivery]);
  usePageDropForwarder(props.pageDrop, routeDrop, handledPageDropIdRef);
  useGuidedSampleStart(
    "create-cheats",
    () => {
      changeMode("patches");
      setCheatSampleRequestId((id) => id + 1);
    },
    () => undefined,
  );
  const controls = <CreateSourceModeToggle value={activeMode} onChange={changeMode} disabled={modeLocked} />;
  const romDrop = delivery?.mode === "rom" ? delivery : null;
  const patchDrop = delivery?.mode === "patches" ? delivery : null;
  return (
    <>
      <div hidden={activeMode !== "rom"}>
        <ModifiedRomCreateForm
          {...props}
          active={activeMode === "rom"}
          original={original}
          onOriginalChange={changeOriginal}
          pageDrop={romDrop}
          pageDropReplacesModified={!!romDrop?.replacesModified}
          onUnifiedDrop={routeDrop}
          onActivateRomMode={() => changeMode("rom")}
          sourceModeControls={controls}
          onBusyChange={setRomBusy}
        />
      </div>
      {patchesMounted || activeMode === "patches" ? (
        <div hidden={activeMode !== "patches"}>
          <ApplyPatchForm
            mode="create"
            active={activeMode === "patches"}
            cheatsPage={props.entry === "cheats"}
            assetBaseUrl={props.assetBaseUrl}
            inputs={inputs}
            onInputsChange={(inputs) => changeOriginal(inputs[0] || null)}
            createSettings={props.settings || props.defaultSettings}
            patchType={props.patchType}
            defaultPatchType={props.defaultPatchType}
            onPatchTypeChange={props.onPatchTypeChange}
            disabled={props.disabled}
            threads={props.threads}
            pageDrop={patchDrop}
            createModeControls={controls}
            onCreateRomDrop={(files, asModified) => queueDrop(files, "rom", !!asModified)}
            onCreateComplete={props.onCreateComplete}
            onError={props.onError}
            onProgress={props.onProgress}
            onSelectTab={props.onSelectTab}
            onBusyChange={setPatchesBusy}
            createCheatSampleRequestId={cheatSampleRequestId}
          />
        </div>
      ) : null}
    </>
  );
}

export { CreatePatchForm };
