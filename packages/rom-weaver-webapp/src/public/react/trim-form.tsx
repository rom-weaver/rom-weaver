import { Download, Scissors } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCompressionOutputExtension,
  isCompressionFormat,
  resolveAutomaticCompressionFormat,
} from "../../lib/compression/container-format-registry.ts";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import { emitTraceLog } from "../../lib/logging.ts";
import {
  type BrowserSaveDestination,
  type BrowserTrimResult,
  type CreateSettings,
  TrimWorkflow,
  type WorkflowProgress,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { TrimWorkflowSourceState } from "../../types/trim-workflow.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { type FileProgressProps, Notice } from "./components/ds/feedback.tsx";
import { useFlatTransitionFlag } from "./components/ds/flat-transition.ts";
import { InfoPopover } from "./components/ds/layout.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import { OutputRunAction } from "./components/ds/workflow-output-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import { ARCHIVE_FILE_EXTENSIONS } from "./file-classification.ts";
import { getFileInputAcceptAttributes } from "./file-input-accept";
import { useInputSelectionHandler } from "./input-selection-handler.ts";
import { createCompressionTypeOptions, createTrimOutputOptions } from "./output-view-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, TrimPatchFormProps, TrimPatchFormSettings } from "./public-types.ts";
import {
  allowsDefaultCompressionSpecial,
  getCreateSettingsOutputName,
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import { TrimPatchFormView, type TrimPatchFormViewModel } from "./trim-form-view.tsx";
import { routeSingleRom } from "./unified-drop-routing.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";
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
  formatOptionalElapsedMs,
  getSourceNoticeLevel,
  getSourceNoticeMessage,
  hasSourceQueueWarning,
  isDismissibleWorkflowError,
  mergeSettingsWithOutput,
} from "./workflow-form-utils.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
} from "./workflow-run-hooks.ts";
import { deriveWorkflowRunTiming, useWorkflowRunLifecycle } from "./workflow-run-lifecycle.ts";

/** Trim-eligible formats only (Rust `TrimInputKind::from_path` + rvz-scrub
 * candidates), listed in the 0x01 info popover - not the full ROM registry. */
const TRIM_SUPPORTED_FILES = [
  {
    extensions: ["nds", "dsi", "srl", "gba", "3ds", "xiso", "xiso.iso", "iso", "gcm", "wbfs", "rvz"],
    label: "Trimmable ROMs",
  },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

const FILE_EXTENSION_REGEX = /\.[^./\\]+$/;

type BrowserTrimWorkflow = InstanceType<typeof TrimWorkflow>;
type CompletedTrimOutput = {
  fileName: string;
  inputSize?: number;
  rawSize?: number;
  saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
  size?: number;
};
type TrimMessagePlacement = "output" | "source";

const TrimNotice = ({
  id,
  level,
  message,
  onDismiss,
}: {
  id: string;
  level: "error" | "warn";
  message: string;
  onDismiss?: () => void;
}) =>
  message ? (
    <Notice id={id} level={level} onDismiss={onDismiss}>
      {message}
    </Notice>
  ) : null;

const buildTrimSourceItems = ({
  checksumProps,
  onRemove,
  resolvedSourceFileName,
  source,
  sourceState,
  stageBytes,
  stageLabel,
  stagePct,
  staging,
}: {
  checksumProps: ReturnType<typeof toWorkflowChecksumProgressProps>;
  onRemove: () => void;
  resolvedSourceFileName: string;
  source: BinarySource | null;
  sourceState: TrimWorkflowSourceState | null;
  stageBytes?: number;
  stageLabel: string;
  stagePct: number | null;
  staging: boolean;
}): TrimPatchFormViewModel["sourceStep"]["items"] => {
  if (!source) return [];
  return [
    {
      card: {
        extract: {
          fileName: resolvedSourceFileName,
          fileSize: sourceState?.size,
          parentCompressions: sourceState?.parentCompressions,
          timing: formatOptionalElapsedMs(sourceState?.decompressionTimeMs),
        },
        meta: staging ? (
          <>
            {typeof stageBytes === "number" ? <span className="fsize mono">{formatByteSize(stageBytes)}</span> : null}
            <StageStatus id="trim-input-stage" label={stageLabel} percent={stagePct} />
          </>
        ) : undefined,
        onRemove,
        panels: {
          info: {
            bytes: stageBytes,
            checksums: sourceState?.checksums,
            defaultOpen: false,
            progress: checksumProps,
            timing: formatOptionalElapsedMs(sourceState?.checksumTimeMs),
            trim: sourceState?.romProbe?.trim,
          },
        },
        removeLabel: "Clear ROM",
        stageBar: stageBarValue(staging, stagePct),
        state: hasSourceQueueWarning(sourceState) ? "bad" : sourceState?.status === "ready" ? "ok" : undefined,
      },
      id: "trim-input-card",
    },
  ];
};

const TrimOutputAction = ({
  busy,
  completedOutput,
  disabled,
  onCancelProgress,
  onDownload,
  onRun,
  progressProps,
  progressStage,
  queued,
  sourceInputSize,
  waitingProgressProps,
}: {
  busy: boolean;
  completedOutput: CompletedTrimOutput | null;
  disabled: boolean;
  onCancelProgress: () => void;
  onDownload: () => void;
  onRun: () => void;
  progressProps: FileProgressProps | null;
  progressStage?: string;
  queued: boolean;
  sourceInputSize?: number;
  waitingProgressProps: FileProgressProps | null;
}) => (
  <OutputRunAction
    disabled={disabled}
    download={
      completedOutput
        ? getCompletedDownloadMeta(
            completedOutput.fileName,
            completedOutput.size,
            completedOutput.inputSize ?? sourceInputSize,
            completedOutput.rawSize,
          )
        : undefined
    }
    icon={completedOutput ? <Download aria-hidden="true" /> : busy ? undefined : <Scissors aria-hidden="true" />}
    id="trim-builder-button-run"
    onClick={completedOutput ? onDownload : onRun}
    progress={
      queued
        ? waitingProgressProps
          ? {
              ...waitingProgressProps,
              cancelLabel: "Cancel queued trim",
              onCancel: onCancelProgress,
            }
          : null
        : busy && progressProps && progressStage !== "input"
          ? {
              ...progressProps,
              cancelLabel: "Cancel trim",
              onCancel: onCancelProgress,
            }
          : null
    }
  >
    TRIM & DOWNLOAD
  </OutputRunAction>
);

// Raw extension keeps the trimmed bytes uncompressed; zip/7z wrap the trimmed file in an archive.
const getSourceExtension = (fileName: string) => {
  const match = fileName.match(FILE_EXTENSION_REGEX);
  return match ? match[0].slice(1).toLowerCase() : "raw";
};

const getFileNameStem = (fileName: string) => fileName.replace(FILE_EXTENSION_REGEX, "").trim();

const appendTrimmedMarker = (baseName: string) => (/\(trimmed\)$/i.test(baseName) ? baseName : `${baseName} (trimmed)`);

const getTrimOutputExtension = (sourceFileName: string, outputFormat: string, settings?: TrimPatchFormSettings) => {
  if (isCompressionFormat(outputFormat))
    return getCompressionOutputExtension(outputFormat, {
      inputFileName: sourceFileName,
      settings,
    });
  return outputFormat || getSourceExtension(sourceFileName);
};

// The filename field holds the stem only - the format selector owns the
// extension, which resolveTrimExecutionOutputName appends at run time.
const getDefaultTrimOutputName = (sourceFileName: string) =>
  appendTrimmedMarker(getFileNameStem(sourceFileName) || "trimmed");

const ensureTrimmedOutputName = (outputName: string, sourceFileName: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  const outputBaseName = getFileNameStem(normalizedOutputName).toLowerCase();
  const sourceBaseName = getFileNameStem(sourceFileName).toLowerCase();
  if (outputBaseName && outputBaseName === sourceBaseName) {
    return getDefaultTrimOutputName(sourceFileName);
  }
  return normalizedOutputName;
};

const resolveTrimExecutionOutputName = (
  outputName: string,
  outputFormat: string,
  sourceFileName: string,
  settings?: TrimPatchFormSettings,
) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, getTrimOutputExtension(sourceFileName, outputFormat, settings));
};

const getFiniteSize = (size?: number | null) => (typeof size === "number" && Number.isFinite(size) ? size : undefined);

const getCompletedDownloadMeta = (
  fileName: string,
  size?: number | null,
  inputSize?: number | null,
  rawSize?: number | null,
) => {
  const outputSize = getFiniteSize(size);
  const sourceSize = getFiniteSize(inputSize);
  const trimmedSize = getFiniteSize(rawSize) ?? outputSize;
  const rawSavedSize =
    typeof sourceSize === "number" && typeof trimmedSize === "number" ? Math.max(0, sourceSize - trimmedSize) : 0;
  const compressedSavedSize =
    typeof outputSize === "number" && typeof trimmedSize === "number" ? Math.max(0, trimmedSize - outputSize) : 0;
  const savedSize = [
    rawSavedSize > 0 ? `${formatByteSize(rawSavedSize)} raw` : "",
    compressedSavedSize > 0 ? `${formatByteSize(compressedSavedSize)} compressed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    format: `Trimmed .${getSourceExtension(fileName)}`,
    savedSize: savedSize || undefined,
    size: typeof outputSize === "number" ? formatByteSize(outputSize) : undefined,
  };
};

const getProgressDetails = (event: WorkflowProgress): Record<string, unknown> =>
  event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? (event.details as Record<string, unknown>)
    : {};

const shouldRunTrim = ({
  source,
  trimQueueBlocked,
  trimPreparationPending,
  trimReady,
  setTrimQueued,
}: {
  source: BinarySource | null;
  trimQueueBlocked: boolean;
  trimPreparationPending: boolean;
  trimReady: boolean;
  setTrimQueued: (queued: boolean) => void;
}) => {
  if (!source) return false;
  if (trimQueueBlocked) {
    setTrimQueued(false);
    return false;
  }
  if (trimPreparationPending && !trimReady) {
    setTrimQueued(true);
    return false;
  }
  return trimReady;
};

const handleTrimRunClick = ({
  abortActiveOperation,
  busy,
  setConfirmOpen,
  setTrimQueued,
  source,
}: {
  abortActiveOperation: () => void;
  busy: boolean;
  setConfirmOpen: (open: boolean) => void;
  setTrimQueued: (queued: boolean) => void;
  source: BinarySource | null;
}) => {
  if (busy) {
    setTrimQueued(false);
    abortActiveOperation();
    return;
  }
  if (!source) return;
  setConfirmOpen(true);
};

const downloadCompletedTrimOutput = async ({
  completedOutput,
  notifyError,
  setOutputWorkflowMessage,
}: {
  completedOutput: CompletedTrimOutput;
  notifyError: (error: Error) => void;
  setOutputWorkflowMessage: (error: Error) => void;
}) => {
  try {
    await completedOutput.saveAs({ interactive: true });
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    setOutputWorkflowMessage(normalizedError);
    notifyError(normalizedError);
  }
};

const setFallbackTrimInput = async ({
  source,
  sourceFileName,
  trace,
  trimWorkflow,
  usingStagedWorkflow,
}: {
  source: BinarySource;
  sourceFileName: string;
  trace: (message: string, details?: Record<string, unknown>) => void;
  trimWorkflow: BrowserTrimWorkflow;
  usingStagedWorkflow: boolean;
}) => {
  if (usingStagedWorkflow) return;
  trace("run.fallback-set-input.start", { sourceName: sourceFileName, workflowId: trimWorkflow.id });
  await trimWorkflow.setInput(source);
  trace("run.fallback-set-input.finish", { input: trimWorkflow.getInput(), workflowId: trimWorkflow.id });
};

const confirmTrimRun = ({
  runTrim,
  setConfirmOpen,
  setTrimQueued,
  sourceStaging,
}: {
  runTrim: () => Promise<void>;
  setConfirmOpen: (open: boolean) => void;
  setTrimQueued: (queued: boolean) => void;
  sourceStaging: boolean;
}) => {
  setConfirmOpen(false);
  if (sourceStaging) {
    setTrimQueued(true);
    return;
  }
  void runTrim();
};

const createTrimSourceNotice = ({
  clearWorkflowMessage,
  errorCode,
  message,
  messageDismissible,
  runtimeSourceNoticeVisible,
  sourceNoticeMessage,
  sourceState,
}: {
  clearWorkflowMessage: () => void;
  errorCode: string;
  message: string;
  messageDismissible: boolean;
  runtimeSourceNoticeVisible: boolean;
  sourceNoticeMessage: string;
  sourceState: TrimWorkflowSourceState | null;
}) => (
  <TrimNotice
    id="trim-builder-source-error-message"
    level={
      runtimeSourceNoticeVisible
        ? errorCode === "AMBIGUOUS_SELECTION"
          ? "warn"
          : "error"
        : getSourceNoticeLevel(sourceState)
    }
    message={runtimeSourceNoticeVisible ? message : sourceNoticeMessage}
    onDismiss={runtimeSourceNoticeVisible && messageDismissible ? clearWorkflowMessage : undefined}
  />
);

const resolveTrimAutomaticOutputFormat = ({
  automaticCompressionFormat,
  defaultArchiveFormat,
  defaultCompressionMode,
  rawOutputFormat,
}: {
  automaticCompressionFormat: string;
  defaultArchiveFormat: string;
  defaultCompressionMode: Parameters<typeof allowsDefaultCompressionSpecial>[0];
  rawOutputFormat: string;
}) => {
  const automaticSpecialOutputFormat = getTrimSpecialOutputFormat(automaticCompressionFormat, defaultCompressionMode);
  const automaticDefaultFormat = getTrimDefaultOutputFormat(
    automaticCompressionFormat,
    automaticSpecialOutputFormat,
    defaultArchiveFormat,
    defaultCompressionMode,
  );
  return automaticSpecialOutputFormat || (automaticDefaultFormat === "none" ? rawOutputFormat : automaticDefaultFormat);
};

const getTrimSpecialOutputFormat = (
  automaticCompressionFormat: string,
  defaultCompressionMode: Parameters<typeof allowsDefaultCompressionSpecial>[0],
) => {
  if (!allowsDefaultCompressionSpecial(defaultCompressionMode)) return "";
  if (!["chd", "rvz", "z3ds"].includes(automaticCompressionFormat)) return "";
  return automaticCompressionFormat;
};

const getTrimDefaultOutputFormat = (
  automaticCompressionFormat: string,
  automaticSpecialOutputFormat: string,
  defaultArchiveFormat: string,
  defaultCompressionMode: Parameters<typeof allowsDefaultCompressionSpecial>[0],
) => {
  if (defaultCompressionMode === "auto") return automaticCompressionFormat;
  return automaticSpecialOutputFormat || defaultArchiveFormat;
};

type InternalTrimPatchFormProps = TrimPatchFormProps & {
  trimWorkflow?: typeof TrimWorkflow;
};

function TrimPatchForm(props: TrimPatchFormProps) {
  const internalProps = props as InternalTrimPatchFormProps;
  const TrimWorkflowConstructor = internalProps.trimWorkflow || TrimWorkflow;
  const providerSettings = useCreateSettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  // id matches webapp-root's `currentView` so root routing targets the active tab.
  useInputSelectionHandler("trim", selectFile);
  const [internalSource, setInternalSource] = useState<BinarySource | null>(props.defaultSource || null);
  const [internalSettings, setInternalSettings] = useState<TrimPatchFormSettings>(() =>
    mergeSettingsWithOutput(providerSettings, props.defaultSettings),
  );
  const [internalOutputFormat, setInternalOutputFormat] = useState(props.defaultOutputFormat || "");
  const [outputFormatEdited, setOutputFormatEdited] = useState(
    props.outputFormat !== undefined || !!props.defaultOutputFormat,
  );
  const [busy, setBusy] = useState(false);
  const [trimQueued, setTrimQueued] = useState(false);
  const [sourceStaging, setSourceStaging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageDismissible, setMessageDismissible] = useState(false);
  const [messagePlacement, setMessagePlacement] = useState<TrimMessagePlacement | null>(null);
  const [errorCode, setErrorCode] = useState("");
  const [sourceState, setSourceState] = useState<TrimWorkflowSourceState | null>(null);
  const { clearCompletedOutput, completedOutput, disposeActiveOutput, rememberOutputDispose, setCompletedOutput } =
    useDisposableWorkflowOutput<CompletedTrimOutput>();
  const { abortActiveOperation, activeAbortControllerRef, rememberAbortController } = useActiveAbortController();
  const { clearProgressForStage, createProgressHandler, progress, reportProgressEvent, setProgress } =
    useWorkflowProgressState({
      onProgress: props.onProgress,
    });
  const [completedCompressionTimeMs, setCompletedCompressionTimeMs] = useState<number | null>(null);
  const [completedTrimTimeMs, setCompletedTrimTimeMs] = useState<number | null>(null);
  const [outputName, setOutputName] = useState("");
  const stagedTrimWorkflowRef = useRef<BrowserTrimWorkflow | null>(null);
  const stagedTrimWorkflowGenerationRef = useRef(0);
  const stagedTrimWorkflowReadyRef = useRef<Promise<void> | null>(null);
  const trimExecutionTimingRef = useRef<{ compressionStartedAt: number | null; trimStartedAt: number | null }>({
    compressionStartedAt: null,
    trimStartedAt: null,
  });
  const workflowIdRef = useRef(createReactWorkflowId("react-trim"));

  const source = props.source === undefined ? internalSource : props.source;
  const settings = props.settings || internalSettings || providerSettings;
  const settingsLanguage = (settings as { language?: string }).language;
  const traceSettingsRef = useRef(settings);
  const onErrorRef = useRef(props.onError);
  useEffect(() => {
    traceSettingsRef.current = settings;
    onErrorRef.current = props.onError;
  }, [props.onError, settings]);
  const emitTrimFormTrace = useCallback((message: string, details: Record<string, unknown> = {}) => {
    const traceSettings = traceSettingsRef.current;
    emitTraceLog(
      {
        logLevel: traceSettings.logging?.level,
        namespace: "react:trim-form",
        onLog: traceSettings.logging?.sink,
      },
      message,
      details,
    );
  }, []);
  const clearWorkflowMessage = useCallback(() => {
    setErrorCode("");
    setMessage("");
    setMessageDismissible(false);
    setMessagePlacement(null);
  }, []);
  const setWorkflowMessage = useCallback(
    (placement: TrimMessagePlacement, error: Error) => {
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
    () => createIndeterminateWorkflowProgress({ label: "Trimming...", role: "worker", stage: "trim" }),
    [],
  );
  const notifyError = useCallback((error: Error) => onErrorRef.current?.(error), []);
  const uploadDisabled = !!props.disabled || busy;
  const outputDisabled = !!props.disabled || busy;
  const trimSourceReady = !!source && sourceState?.status === "ready";
  const trimPreparationPending = sourceStaging || progress?.stage === "input" || (!!source && !sourceState);
  const trimQueueBlocked = !!message || !!errorCode || hasSourceQueueWarning(sourceState);
  const trimReady = trimSourceReady && !trimPreparationPending;
  const actionDisabled = !!props.disabled || trimQueued || !(busy || completedOutput || source);
  const sourceFileName = getReactBinarySourceFileName(source, "ROM");
  const resolvedSourceFileName = sourceState?.fileName || sourceFileName;
  const rawOutputFormat = getSourceExtension(resolvedSourceFileName);
  const defaultCompressionMode = getDefaultCompressionMode(settings);
  const defaultArchiveFormat = getDefaultCompressionArchive(defaultCompressionMode);
  const configuredOutputFormat = props.outputFormat ?? (outputFormatEdited ? internalOutputFormat : "");
  const automaticCompressionFormat = resolveAutomaticCompressionFormat({
    fallback: defaultArchiveFormat,
    parentCompressions: sourceState?.parentCompressions,
    sourceFileName: resolvedSourceFileName,
    sourceSize: sourceState?.size,
  });
  const automaticOutputFormat = resolveTrimAutomaticOutputFormat({
    automaticCompressionFormat,
    defaultArchiveFormat,
    defaultCompressionMode,
    rawOutputFormat,
  });
  const resolvedOutputFormat = configuredOutputFormat || automaticOutputFormat;
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const generatedOutputName = configuredOutputName || (source ? getDefaultTrimOutputName(resolvedSourceFileName) : "");
  const rawResolvedOutputName = outputName.trim() || generatedOutputName;
  const resolvedOutputName = ensureTrimmedOutputName(rawResolvedOutputName, resolvedSourceFileName);
  const executionOutputName = resolveTrimExecutionOutputName(
    resolvedOutputName,
    resolvedOutputFormat,
    resolvedSourceFileName,
    settings,
  );
  const stagingSettingsKey = useMemo(
    () =>
      createSettingsDependencyKey({
        input: settings.input,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        threads: props.threads,
      }),
    [props.threads, settings],
  );
  const stagingSettings = useMemo(
    () =>
      toCreateWorkflowSettings(
        {
          input: settings.input,
          logging: settings.logging,
          output: { compression: "none" },
          workers: settings.workers,
        } as CreateSettings,
        "",
        props.threads,
      ),
    [props.threads, settings.input, settings.logging, settings.workers],
  );
  const stagingSettingsRef = useRef(stagingSettings);
  useEffect(() => {
    stagingSettingsRef.current = stagingSettings;
  }, [stagingSettings]);

  useEffect(() => {
    if (props.settings !== undefined) return;
    setInternalSettings(mergeSettingsWithOutput(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const clearCompletedRunState = useCallback(() => {
    setCompletedCompressionTimeMs(null);
    clearCompletedOutput();
    setCompletedTrimTimeMs(null);
    trimExecutionTimingRef.current = { compressionStartedAt: null, trimStartedAt: null };
  }, [clearCompletedOutput]);
  const resetWorkflowOutput = useWorkflowResetActions({
    clearCompleted: clearCompletedRunState,
    clearWorkflowMessage,
    disposeActiveOutput,
    setProgress,
    setQueued: setTrimQueued,
  });
  const { cancelOutputProgress, runWorkflow } = useWorkflowRunLifecycle({
    abortActiveOperation,
    activeAbortControllerRef,
    clearCompleted: clearCompletedRunState,
    clearWorkflowMessage,
    createInitialProgress,
    disposeActiveOutput,
    notifyError,
    rememberAbortController,
    setBusy,
    setProgress,
    setQueued: setTrimQueued,
    setWorkflowOutputError: setOutputWorkflowMessage,
  });

  const updateSource = (file: BinarySource | null) => {
    resetWorkflowOutput();
    stagedTrimWorkflowGenerationRef.current += 1;
    setSourceState(null);
    if (props.source === undefined) setInternalSource(file);
    props.onSourceChange?.(file);
  };

  // Single-bucket unified routing: keep the first dropped ROM, ignore patches
  // and any extra files (Trim has one source). See routeSingleRom.
  const handledPageDropIdRef = useRef<number | null>(null);
  const handleUnifiedDrop = (files: File[]) => {
    const source = routeSingleRom(files);
    if (source) updateSource(source);
  };

  // Forward a page-level drop (dragging anywhere on the page) to the unified
  // handler so the whole tab is a drop target, not just the dropzone box.
  usePageDropForwarder(props.pageDrop, (files) => handleUnifiedDrop(files), handledPageDropIdRef);
  const cancelSourceStaging = () => {
    setTrimQueued(false);
    stagedTrimWorkflowGenerationRef.current += 1;
    const workflow = stagedTrimWorkflowRef.current;
    stagedTrimWorkflowRef.current = null;
    stagedTrimWorkflowReadyRef.current = null;
    workflow?.dispose().catch(() => undefined);
    setSourceStaging(false);
    clearProgressForStage("input");
    updateSource(null);
  };

  cancelSelectionRef.current = () => updateSource(null);

  const updateSettings = (nextSettings: TrimPatchFormSettings) => {
    resetWorkflowOutput({ clearProgress: false });
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updateOutputFormat = (nextOutputFormat: string) => {
    setOutputFormatEdited(true);
    resetWorkflowOutput();
    if (props.outputFormat === undefined) setInternalOutputFormat(nextOutputFormat);
    props.onOutputFormatChange?.(nextOutputFormat);
  };

  useEffect(() => {
    const generation = ++stagedTrimWorkflowGenerationRef.current;
    emitTrimFormTrace("stage.reset", {
      generation,
      hadStagedWorkflow: !!stagedTrimWorkflowRef.current,
      reason: source ? "source-or-settings-changed" : "empty-source",
      sourceName: sourceFileName,
      stagingSettingsKey,
    });
    stagedTrimWorkflowRef.current?.dispose().catch(() => undefined);
    stagedTrimWorkflowRef.current = null;
    stagedTrimWorkflowReadyRef.current = null;
    if (!source) {
      setSourceState(null);
      setSourceStaging(false);
      return;
    }
    const workflow = new TrimWorkflowConstructor({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: `${workflowIdRef.current}:stage:${generation}`,
      selectFile,
      settings: stagingSettingsRef.current,
    });
    emitTrimFormTrace("stage.workflow.created", {
      generation,
      sourceName: sourceFileName,
      workflowId: workflow.id,
    });
    stagedTrimWorkflowRef.current = workflow;
    const handleProgress = createProgressHandler("input");
    workflow.on("progress", handleProgress);
    setSourceStaging(true);
    emitTrimFormTrace("stage.set-input.start", {
      generation,
      sourceName: sourceFileName,
      workflowId: workflow.id,
    });

    const stagedReady = workflow
      .setInput(source)
      .then(() => {
        if (stagedTrimWorkflowGenerationRef.current !== generation) return;
        emitTrimFormTrace("stage.set-input.finish", {
          generation,
          input: workflow.getInput(),
          workflowId: workflow.id,
        });
        setSourceState(workflow.getInput());
      })
      .catch((error) => {
        if (stagedTrimWorkflowGenerationRef.current !== generation) return;
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        emitTrimFormTrace("stage.set-input.fail", {
          error,
          generation,
          input: workflow.getInput(),
          workflowId: workflow.id,
        });
        const nextSourceState = workflow.getInput();
        setSourceState(nextSourceState);
        if (getErrorCode(normalizedError) !== "WORKFLOW_SELECTION_SKIPPED" && !hasSourceQueueWarning(nextSourceState)) {
          setWorkflowMessage("source", normalizedError);
          onErrorRef.current?.(normalizedError);
        }
      })
      .finally(() => {
        workflow.off("progress", handleProgress);
        if (stagedTrimWorkflowGenerationRef.current === generation) {
          emitTrimFormTrace("stage.finish", {
            generation,
            keptStagedWorkflow: stagedTrimWorkflowRef.current === workflow,
            workflowId: workflow.id,
          });
          setSourceStaging(false);
          clearProgressForStage("input");
        } else {
          emitTrimFormTrace("stage.finish.stale", {
            currentGeneration: stagedTrimWorkflowGenerationRef.current,
            generation,
            workflowId: workflow.id,
          });
          void workflow.dispose();
        }
      });
    stagedTrimWorkflowReadyRef.current = stagedReady;

    return () => {
      workflow.off("progress", handleProgress);
      emitTrimFormTrace("stage.cleanup", {
        generation,
        isCurrentWorkflow: stagedTrimWorkflowRef.current === workflow,
        workflowId: workflow.id,
      });
      if (stagedTrimWorkflowRef.current === workflow) {
        stagedTrimWorkflowGenerationRef.current += 1;
        stagedTrimWorkflowRef.current = null;
        stagedTrimWorkflowReadyRef.current = null;
      }
      workflow.dispose().catch(() => undefined);
    };
  }, [
    clearProgressForStage,
    createProgressHandler,
    emitTrimFormTrace,
    resolvedAssetBaseUrl,
    selectFile,
    source,
    sourceFileName,
    stagingSettingsKey,
    setWorkflowMessage,
    TrimWorkflowConstructor,
  ]);

  const runTrim = async () => {
    if (completedOutput) {
      setTrimQueued(false);
      await downloadCompletedTrimOutput({ completedOutput, notifyError, setOutputWorkflowMessage });
      return;
    }
    const stagedSource = source;
    if (!shouldRunTrim({ setTrimQueued, source: stagedSource, trimPreparationPending, trimQueueBlocked, trimReady }))
      return;
    if (!stagedSource) return;
    await runWorkflow(async (abortController, registerCleanup) => {
      const outputCompression = isCompressionFormat(resolvedOutputFormat) ? resolvedOutputFormat : "none";
      await stagedTrimWorkflowReadyRef.current?.catch(() => undefined);
      const trimWorkflow =
        stagedTrimWorkflowRef.current ||
        new TrimWorkflowConstructor({
          ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
          id: workflowIdRef.current,
          selectFile,
          settings: toCreateWorkflowSettings(
            { ...settings, output: { ...settings.output, compression: outputCompression } } as CreateSettings,
            executionOutputName,
            props.threads,
          ),
          signal: abortController.signal,
        });
      const usingStagedWorkflow = stagedTrimWorkflowRef.current === trimWorkflow;
      emitTrimFormTrace(usingStagedWorkflow ? "run.reuse-staged" : "run.fallback-created", {
        outputName: executionOutputName,
        sourceName: sourceFileName,
        workflowId: trimWorkflow.id,
      });
      const handleProgress = (event: WorkflowProgress) => {
        const details = getProgressDetails(event);
        if (details.stage === "compress" && markCompressionStart(trimExecutionTimingRef.current)) {
          const { compressionStartedAt, trimStartedAt } = trimExecutionTimingRef.current;
          if (typeof trimStartedAt === "number" && typeof compressionStartedAt === "number") {
            setCompletedTrimTimeMs(Math.max(0, compressionStartedAt - trimStartedAt));
          }
        }
        reportProgressEvent(event, "trim");
      };
      trimWorkflow.on("progress", handleProgress);
      const abortWorkflow = () => trimWorkflow.abort(abortController.signal.reason);
      abortController.signal.addEventListener("abort", abortWorkflow, { once: true });
      registerCleanup(async () => {
        abortController.signal.removeEventListener("abort", abortWorkflow);
        trimWorkflow.off("progress", handleProgress);
        if (!usingStagedWorkflow) await trimWorkflow.dispose();
      });
      await setFallbackTrimInput({
        source: stagedSource,
        sourceFileName,
        trace: emitTrimFormTrace,
        trimWorkflow,
        usingStagedWorkflow,
      });
      await trimWorkflow.setOutputFormat(resolvedOutputFormat);
      await trimWorkflow.setOutputName(executionOutputName);

      if (trimWorkflow.getInput()?.status !== "ready" || !trimWorkflow.getInput()?.selectedCandidateId) {
        throw new Error("Trim source requires candidate selection");
      }

      trimExecutionTimingRef.current = { compressionStartedAt: null, trimStartedAt: Date.now() };
      const result = (await trimWorkflow.run()) as BrowserTrimResult;
      const completedAt = Date.now();
      const { compressionStartedAt, trimStartedAt } = trimExecutionTimingRef.current;
      const { compressionTimeMs, operationTimeMs: trimTimeMs } = deriveWorkflowRunTiming({
        completedAt,
        compressionStartedAt,
        operationStartedAt: trimStartedAt,
        reportedCompressionTimeMs: result.sizeSummary?.compressionTimeMs,
        reportedOperationTimeMs: result.sizeSummary?.trimTimeMs,
      });
      emitTrimFormTrace("run.finish", {
        compressionTimeMs,
        outputName: result.output.fileName,
        outputSize: result.sizeSummary?.outputSize ?? result.output.size,
        reusedStagedWorkflow: usingStagedWorkflow,
        trimTimeMs,
        workflowId: trimWorkflow.id,
      });
      rememberOutputDispose(result.output.dispose);
      // Warm the output's download snapshot so a later download tap reaches navigator.share
      // before its user activation expires (iOS PWA share path).
      void result.output.prepareDownload?.().catch(() => undefined);
      setCompletedOutput({
        fileName: result.output.fileName,
        inputSize: result.sizeSummary?.inputSize,
        rawSize: result.sizeSummary?.rawSize,
        saveAs: result.output.saveAs,
        size: result.sizeSummary?.outputSize ?? result.output.size,
      });
      setCompletedCompressionTimeMs(compressionTimeMs);
      setCompletedTrimTimeMs(trimTimeMs);
      setProgress(null);
      if (typeof window !== "undefined") await result.output.saveAs();
      props.onTrimComplete?.(result);
    });
  };

  const onRunClick = () => {
    handleTrimRunClick({ abortActiveOperation, busy, setConfirmOpen, setTrimQueued, source });
  };

  const onConfirmTrim = () => {
    confirmTrimRun({ runTrim, setConfirmOpen, setTrimQueued, sourceStaging });
  };

  useEffect(
    () => () => {
      abortActiveOperation();
      stagedTrimWorkflowRef.current?.dispose().catch(() => undefined);
      stagedTrimWorkflowRef.current = null;
      disposeActiveOutput();
    },
    [abortActiveOperation, disposeActiveOutput],
  );

  useQueuedRunEffect({
    blocked: trimQueueBlocked,
    busy,
    canQueue: !!source,
    canStart: trimReady,
    completed: !!completedOutput,
    pending: trimPreparationPending,
    queued: trimQueued,
    run: () => void runTrim(),
    setQueued: setTrimQueued,
  });

  const progressProps = toWorkflowFileProgressProps(progress);
  const waitingProgressProps = toWorkflowFileProgressProps(createWaitingWorkflowProgress());
  const cancelTrimOutputProgress = () => cancelOutputProgress(busy);
  const showInputProgress =
    sourceStaging || (busy && progressProps && progress?.stage === "input" && progress.role === "input");
  const inputProgress = progressProps || waitingProgressProps;
  const inputProgressProps = showInputProgress
    ? {
        ...inputProgress,
        cancelLabel: "Cancel ROM staging",
        onCancel: cancelSourceStaging,
      }
    : null;

  const rawExtensionOption = rawOutputFormat;
  const formatOptions = useMemo(
    () => createTrimOutputOptions(rawExtensionOption, { rawLabel: source ? undefined : "None" }),
    [rawExtensionOption, source],
  );
  const compressFormatOptions = useMemo(
    () => createCompressionTypeOptions(formatOptions, rawExtensionOption),
    [formatOptions, rawExtensionOption],
  );
  const compressHeaderFormat = getOutputCompressionFormatLabel(resolvedOutputFormat, compressFormatOptions, {
    uncompressedValues: [rawExtensionOption],
  });
  const trimTimingText = formatOptionalElapsedMs(completedTrimTimeMs ?? undefined);
  const compressTimingText = formatOptionalElapsedMs(completedCompressionTimeMs ?? undefined);
  const checksumProgress = progress?.stage === "checksum" ? progress : null;
  // Staging treatment shared with the apply form: the resolved card stays mounted
  // and a slim determinate bar on its top edge + a status on the meta line carry
  // progress, rather than swapping the whole card for a bordered progress panel.
  const checksumProps = toWorkflowChecksumProgressProps(checksumProgress);
  const staging = !!inputProgressProps || !!checksumProgress;
  const stagingProgress = checksumProgress ? checksumProps : inputProgressProps;
  const stagePct = stagePercent(stagingProgress);
  const stageLabel = stageStatusLabel("Checksumming", !checksumProgress && !!inputProgressProps);
  const stageBytes = sourceState?.size ?? sourceState?.sourceSize;
  const sourceNoticeMessage = getSourceNoticeMessage(sourceState);
  const runtimeSourceNoticeVisible = !!message && messagePlacement === "source";
  const sourceNotice = createTrimSourceNotice({
    clearWorkflowMessage,
    errorCode,
    message,
    messageDismissible,
    runtimeSourceNoticeVisible,
    sourceNoticeMessage,
    sourceState,
  });
  const sourceItems = buildTrimSourceItems({
    checksumProps,
    onRemove: () => updateSource(null),
    resolvedSourceFileName,
    source,
    sourceState,
    stageBytes,
    stageLabel,
    stagePct,
    staging,
  });
  const trimCompressPanel = buildCompressPanel(
    resolvedOutputFormat,
    settings as Record<string, unknown>,
    source
      ? ({
          ...(source as unknown as Record<string, unknown>),
          ...(sourceState?.chdMode ? { metadata: { mode: sourceState.chdMode } } : {}),
          fileName: resolvedSourceFileName,
        } as Record<string, unknown>)
      : null,
  );

  const trimSourceActuallyEmpty = !(source || trimPreparationPending);
  const trimSourceEmpty = useFlatTransitionFlag(trimSourceActuallyEmpty);
  // The selvage status strip mirrors this workflow's job state.
  useWorkbenchActivity(workflowIdRef.current, { busy, completed: !!completedOutput, queued: trimQueued });

  const createOutputModel = (): TrimPatchFormViewModel["output"] => ({
    action: (
      <TrimOutputAction
        busy={busy}
        completedOutput={completedOutput}
        disabled={actionDisabled}
        onCancelProgress={cancelTrimOutputProgress}
        onDownload={() => void runTrim()}
        onRun={onRunClick}
        progressProps={progressProps}
        progressStage={progress?.stage}
        queued={trimQueued}
        sourceInputSize={sourceState?.size}
        waitingProgressProps={waitingProgressProps}
      />
    ),
    compress: buildOutputCompressionPanel({
      disabled: outputDisabled,
      fields: trimCompressPanel?.fields,
      format: compressHeaderFormat,
      formatId: "trim-builder-select-output-compression",
      formatOptions: compressFormatOptions,
      formatValue: resolvedOutputFormat,
      onFieldChange: (key, value, updates) => updateSettings({ ...settings, ...(updates || { [key]: value }) }),
      onFormatChange: updateOutputFormat,
      summary: trimCompressPanel?.summary,
      timing: compressTimingText,
    }),
    disabled: outputDisabled,
    fileName: resolvedOutputName,
    fileNameId: "trim-builder-output-file",
    fileNamePlaceholder: "Trimmed filename (no extension)",
    format: resolvedOutputFormat,
    formatId: "trim-builder-select-output-format",
    formatOptions,
    info: (
      <InfoPopover title="Output options">
        <strong>Output</strong>
        <ul>
          <li>Set the filename without an extension - the format selector controls it.</li>
          <li>Trimming permanently removes trailing padding from the ROM and can't be undone.</li>
          <li>Choose the raw extension to keep the trimmed bytes, or zip/7z to compress them.</li>
        </ul>
      </InfoPopover>
    ),
    meta: trimTimingText ? <span className="t">{trimTimingText}</span> : undefined,
    notice: (
      <TrimNotice
        id="trim-builder-row-error-message"
        level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
        message={messagePlacement === "output" ? message : ""}
        onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
      />
    ),
    num: "0x03",
    onFileNameChange: (value) => {
      setOutputName(value);
      updateSettings({
        ...settings,
        output: { ...settings.output, outputName: value.trim() || undefined },
      });
    },
    onFormatChange: updateOutputFormat,
    title: "Trim",
  });

  const createModel = (): TrimPatchFormViewModel => ({
    confirm: {
      body: `The trimmed copy of ${sourceFileName} is saved as a new download - your original file is not changed. Keep the original: some patches and tools need the untrimmed ROM, and restored padding may not be byte-identical.`,
      cancelLabel: "Cancel",
      confirmLabel: "Trim ROM",
      onCancel: () => setConfirmOpen(false),
      onConfirm: onConfirmTrim,
      open: confirmOpen,
      title: "Trim this ROM?",
    },
    dialog: candidateSelectionDialog,
    dropZone: {
      accept: getFileInputAcceptAttributes().unifiedRom,
      addLabel: "Replace the ROM",
      big: trimSourceEmpty,
      disabled: uploadDisabled,
      heroLabel: "Drop or click to add a ROM to trim",
      heroLabelCoarse: "Tap to add a ROM to trim",
      id: "trim-builder-row-unified-drop",
      inputId: "trim-builder-input-file-unified",
      onFiles: handleUnifiedDrop,
      supported: TRIM_SUPPORTED_FILES,
    },
    output: createOutputModel(),
    sourceEmpty: trimSourceActuallyEmpty,
    sourceStep: {
      id: "trim-builder-row-source",
      info: (
        <InfoPopover title="ROM input">
          <strong>ROM</strong>
          <ul>
            <li>Drop an over-dumped ROM (NDS/N64 and similar) to remove trailing padding.</li>
            <li>Archives are extracted; pick the ROM if several candidates are found.</li>
          </ul>
        </InfoPopover>
      ),
      items: sourceItems,
      notice: sourceNotice,
      num: "0x02",
      title: "ROM",
    },
  });
  const model = createModel();

  return <TrimPatchFormView {...model} />;
}

export { TrimPatchForm };
