import Download from "lucide-react/dist/esm/icons/download.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getCompressionOutputExtension,
  isCompressionFormat,
  resolveAutomaticCompressionFormat,
} from "../../lib/compression/container-format-registry.ts";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import { emitTraceLog } from "../../lib/logging.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
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
import { Notice } from "./components/ds/feedback.tsx";
import { InfoPopover } from "./components/ds/layout.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import { OutputRunAction, WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
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
import { getReactBinarySourceFileName, toBrowserPublicBinarySource } from "./workflow-adapters.ts";
import { createReactWorkflowId, createSettingsDependencyKey, mergeSettingsWithOutput } from "./workflow-form-utils.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
} from "./workflow-run-hooks.ts";

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

const getDefaultTrimOutputName = (sourceFileName: string, outputFormat: string, settings?: TrimPatchFormSettings) => {
  const sourceBaseName = getFileNameStem(sourceFileName) || "trimmed";
  const baseName = appendTrimmedMarker(sourceBaseName);
  return `${baseName}.${getTrimOutputExtension(sourceFileName, outputFormat, settings)}`;
};

const ensureTrimmedOutputName = (
  outputName: string,
  outputFormat: string,
  sourceFileName: string,
  settings?: TrimPatchFormSettings,
) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  const outputBaseName = getFileNameStem(normalizedOutputName).toLowerCase();
  const sourceBaseName = getFileNameStem(sourceFileName).toLowerCase();
  if (outputBaseName && outputBaseName === sourceBaseName) {
    return getDefaultTrimOutputName(sourceFileName, outputFormat, settings);
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

const formatElapsedMs = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : undefined;

const hasSourceQueueWarning = (source: TrimWorkflowSourceState | null | undefined) =>
  !!source && (source.status === "failed" || (source.warnings?.length ?? 0) > 0);

const getSourceNoticeMessage = (source: TrimWorkflowSourceState | null | undefined) => {
  if (!source) return "";
  const warningMessage = source.warnings
    ?.map((warning) => warning.message)
    .filter(Boolean)
    .join(" ");
  if (warningMessage) return warningMessage;
  if (source.status === "failed") return "Source preparation failed. Choose a different ROM.";
  return "";
};

const getSourceNoticeLevel = (source: TrimWorkflowSourceState | null | undefined) =>
  source?.status === "failed" ? "error" : "warn";

const isSourceInvalid = (source: TrimWorkflowSourceState | null | undefined) =>
  !!source && (source.status === "failed" || (source.warnings?.length ?? 0) > 0);

const isDismissibleWorkflowError = (code: string) => code !== "AMBIGUOUS_SELECTION";

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
  });
  const automaticSpecialOutputFormat =
    allowsDefaultCompressionSpecial(defaultCompressionMode) &&
    (automaticCompressionFormat === "chd" ||
      automaticCompressionFormat === "rvz" ||
      automaticCompressionFormat === "z3ds")
      ? automaticCompressionFormat
      : "";
  const automaticDefaultFormat =
    defaultCompressionMode === "auto"
      ? automaticCompressionFormat
      : automaticSpecialOutputFormat || defaultArchiveFormat;
  const automaticOutputFormat =
    automaticSpecialOutputFormat || (automaticDefaultFormat === "none" ? rawOutputFormat : automaticDefaultFormat);
  const resolvedOutputFormat = configuredOutputFormat || automaticOutputFormat;
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const generatedOutputName =
    configuredOutputName ||
    (source ? getDefaultTrimOutputName(resolvedSourceFileName, resolvedOutputFormat, settings) : "");
  const rawResolvedOutputName = outputName.trim() || generatedOutputName;
  const resolvedOutputName = ensureTrimmedOutputName(
    rawResolvedOutputName,
    resolvedOutputFormat,
    resolvedSourceFileName,
    settings,
  );
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
        limits: settings.limits,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        workerThreads: props.workerThreads,
      }),
    [props.workerThreads, settings],
  );
  const stagingSettings = useMemo(
    () =>
      toCreateWorkflowSettings(
        { ...settings, output: { ...settings.output, compression: "none" } } as CreateSettings,
        "",
        props.workerThreads,
      ),
    [props.workerThreads, settings.input, settings.limits, settings.logging, settings.workers],
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

  const updateSource = (file: BinarySource | null) => {
    setTrimQueued(false);
    disposeActiveOutput();
    clearCompletedRunState();
    stagedTrimWorkflowGenerationRef.current += 1;
    setSourceState(null);
    if (props.source === undefined) setInternalSource(file);
    props.onSourceChange?.(file);
    clearWorkflowMessage();
    setProgress(null);
  };

  cancelSelectionRef.current = () => updateSource(null);

  const updateSettings = (nextSettings: TrimPatchFormSettings) => {
    setTrimQueued(false);
    disposeActiveOutput();
    clearCompletedRunState();
    clearWorkflowMessage();
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updateOutputFormat = (nextOutputFormat: string) => {
    setTrimQueued(false);
    setOutputFormatEdited(true);
    disposeActiveOutput();
    clearCompletedRunState();
    if (props.outputFormat === undefined) setInternalOutputFormat(nextOutputFormat);
    props.onOutputFormatChange?.(nextOutputFormat);
    clearWorkflowMessage();
    setProgress(null);
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
      .setInput(toBrowserPublicBinarySource(source))
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
    props.workerThreads,
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
      await completedOutput.saveAs();
      return;
    }
    if (!source) return;
    if (trimQueueBlocked) {
      setTrimQueued(false);
      return;
    }
    if (trimPreparationPending && !trimReady) {
      setTrimQueued(true);
      return;
    }
    if (!trimReady) return;
    setTrimQueued(false);
    const abortController = new AbortController();
    rememberAbortController(abortController);
    setBusy(true);
    clearWorkflowMessage();
    disposeActiveOutput();
    clearCompletedRunState();
    setProgress(createIndeterminateWorkflowProgress({ label: "Trimming...", role: "worker", stage: "trim" }));
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
          props.workerThreads,
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
      if (details.stage === "compress" && trimExecutionTimingRef.current.compressionStartedAt === null) {
        const now = Date.now();
        trimExecutionTimingRef.current.compressionStartedAt = now;
        if (typeof trimExecutionTimingRef.current.trimStartedAt === "number") {
          setCompletedTrimTimeMs(Math.max(0, now - trimExecutionTimingRef.current.trimStartedAt));
        }
      }
      reportProgressEvent(event, "trim");
    };
    trimWorkflow.on("progress", handleProgress);
    const abortWorkflow = () => trimWorkflow.abort(abortController.signal.reason);
    abortController.signal.addEventListener("abort", abortWorkflow, { once: true });
    try {
      if (!usingStagedWorkflow) {
        emitTrimFormTrace("run.fallback-set-input.start", {
          sourceName: sourceFileName,
          workflowId: trimWorkflow.id,
        });
        await trimWorkflow.setInput(toBrowserPublicBinarySource(source));
        emitTrimFormTrace("run.fallback-set-input.finish", {
          input: trimWorkflow.getInput(),
          workflowId: trimWorkflow.id,
        });
      }
      await trimWorkflow.setOutputFormat(resolvedOutputFormat);
      await trimWorkflow.setOutputName(executionOutputName);

      if (trimWorkflow.getInput()?.status !== "ready" || !trimWorkflow.getInput()?.selectedCandidateId) {
        throw new Error("Trim source requires candidate selection");
      }

      trimExecutionTimingRef.current = { compressionStartedAt: null, trimStartedAt: Date.now() };
      const result = (await trimWorkflow.run()) as BrowserTrimResult;
      const completedAt = Date.now();
      const { compressionStartedAt, trimStartedAt } = trimExecutionTimingRef.current;
      const reportedTrimTimeMs =
        typeof result.sizeSummary?.trimTimeMs === "number" && Number.isFinite(result.sizeSummary.trimTimeMs)
          ? Math.max(0, Math.round(result.sizeSummary.trimTimeMs))
          : null;
      const reportedCompressionTimeMs =
        typeof result.sizeSummary?.compressionTimeMs === "number" &&
        Number.isFinite(result.sizeSummary.compressionTimeMs)
          ? Math.max(0, Math.round(result.sizeSummary.compressionTimeMs))
          : null;
      const fallbackTrimTimeMs =
        typeof trimStartedAt === "number"
          ? Math.max(0, (typeof compressionStartedAt === "number" ? compressionStartedAt : completedAt) - trimStartedAt)
          : null;
      const trimTimeMs = reportedTrimTimeMs ?? fallbackTrimTimeMs;
      const compressionTimeMs =
        reportedCompressionTimeMs ??
        (typeof compressionStartedAt === "number" ? Math.max(0, completedAt - compressionStartedAt) : null);
      emitTrimFormTrace("run.finish", {
        compressionTimeMs,
        outputName: result.output.fileName,
        outputSize: result.sizeSummary?.outputSize ?? result.output.size,
        reusedStagedWorkflow: usingStagedWorkflow,
        trimTimeMs,
        workflowId: trimWorkflow.id,
      });
      rememberOutputDispose(result.output.dispose);
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
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const code = getErrorCode(normalizedError);
      if (code === "WORKFLOW_SELECTION_SKIPPED") {
        clearWorkflowMessage();
        setProgress(null);
        return;
      }
      setWorkflowMessage("output", normalizedError);
      setProgress(null);
      clearCompletedRunState();
      onErrorRef.current?.(normalizedError);
    } finally {
      abortController.signal.removeEventListener("abort", abortWorkflow);
      trimWorkflow.off("progress", handleProgress);
      if (!usingStagedWorkflow) await trimWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
      setBusy(false);
    }
  };

  const onRunClick = () => {
    if (busy) {
      setTrimQueued(false);
      abortActiveOperation();
      return;
    }
    if (!source) return;
    setConfirmOpen(true);
  };

  const onConfirmTrim = () => {
    setConfirmOpen(false);
    if (sourceStaging) {
      setTrimQueued(true);
      return;
    }
    void runTrim();
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

  useEffect(() => {
    if (!trimQueued) return;
    if (busy || completedOutput) {
      setTrimQueued(false);
      return;
    }
    if (!source) {
      setTrimQueued(false);
      return;
    }
    if (trimQueueBlocked) {
      setTrimQueued(false);
      return;
    }
    if (trimPreparationPending) return;
    if (!trimReady) {
      setTrimQueued(false);
      return;
    }
    void runTrim();
  });

  const progressProps = toWorkflowFileProgressProps(progress);
  const waitingProgressProps = toWorkflowFileProgressProps(createWaitingWorkflowProgress());
  const showInputProgress =
    sourceStaging || (busy && progressProps && progress?.stage === "input" && progress.role === "input");
  const inputProgressProps = showInputProgress ? progressProps || waitingProgressProps : null;

  const rawExtensionOption = rawOutputFormat;
  const formatOptions = useMemo(() => createTrimOutputOptions(rawExtensionOption), [rawExtensionOption]);
  const compressFormatOptions = useMemo(
    () => createCompressionTypeOptions(formatOptions, rawExtensionOption),
    [formatOptions, rawExtensionOption],
  );
  const compressHeaderFormat = getOutputCompressionFormatLabel(resolvedOutputFormat, compressFormatOptions, {
    uncompressedValues: [rawExtensionOption],
  });
  const trimTimingText = formatElapsedMs(completedTrimTimeMs ?? undefined);
  const compressTimingText = formatElapsedMs(completedCompressionTimeMs ?? undefined);
  const checksumProgress = progress?.stage === "checksum" ? progress : null;
  const sourceNoticeMessage = getSourceNoticeMessage(sourceState);
  const runtimeSourceNoticeVisible = !!message && messagePlacement === "source";
  const sourceNotice = runtimeSourceNoticeVisible ? (
    <Notice
      id="trim-builder-source-error-message"
      level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
      onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
    >
      {message}
    </Notice>
  ) : sourceNoticeMessage ? (
    <Notice id="trim-builder-source-error-message" level={getSourceNoticeLevel(sourceState)}>
      {sourceNoticeMessage}
    </Notice>
  ) : null;
  const trimCompressPanel = buildCompressPanel(
    resolvedOutputFormat,
    settings as Record<string, unknown>,
    source
      ? ({ ...(source as unknown as Record<string, unknown>), fileName: resolvedSourceFileName } as Record<
          string,
          unknown
        >)
      : null,
  );

  return (
    <main aria-labelledby="tab-trim" className="panel" id="trim-builder-container">
      <WorkflowRomInputStep
        dropZone={{
          big: !source,
          disabled: uploadDisabled,
          hint: source ? undefined : "archives are extracted",
          label: source ? "Replace ROM · drop or browse" : "Select ROM · drop or browse",
          onFiles: (files) => updateSource(files[0] ?? null),
        }}
        info={
          <InfoPopover title="ROM input">
            <strong>ROM</strong>
            <ul>
              <li>Drop an over-dumped ROM (NDS/N64 and similar) to remove trailing padding.</li>
              <li>Archives are extracted; pick the ROM if several candidates are found.</li>
            </ul>
          </InfoPopover>
        }
        items={
          source
            ? [
                inputProgressProps
                  ? {
                      id: "trim-input-progress",
                      progress: inputProgressProps,
                    }
                  : {
                      card: {
                        extract: {
                          fileName: resolvedSourceFileName,
                          fileSize: sourceState?.size,
                          parentCompressions: sourceState?.parentCompressions,
                          timing: formatElapsedMs(sourceState?.decompressionTimeMs),
                        },
                        onRemove: () => updateSource(null),
                        panels: {
                          fixes: {
                            trim: sourceState?.romProbe?.trim,
                          },
                          info: {
                            bytes: sourceState?.size ?? sourceState?.sourceSize,
                            checksums: sourceState?.checksums,
                            defaultOpen: false,
                            progress: toWorkflowChecksumProgressProps(checksumProgress),
                            timing: formatElapsedMs(sourceState?.checksumTimeMs),
                          },
                        },
                        removeLabel: "Clear ROM",
                        state: isSourceInvalid(sourceState)
                          ? "bad"
                          : sourceState?.status === "ready"
                            ? "ok"
                            : undefined,
                      },
                      id: "trim-input-card",
                    },
              ]
            : []
        }
        notice={sourceNotice}
        num="01"
        title="ROM"
      />
      <WorkflowOutputStep
        action={
          <OutputRunAction
            disabled={actionDisabled}
            download={
              completedOutput
                ? getCompletedDownloadMeta(
                    completedOutput.fileName,
                    completedOutput.size,
                    completedOutput.inputSize ?? sourceState?.size,
                    completedOutput.rawSize,
                  )
                : undefined
            }
            icon={
              completedOutput ? <Download aria-hidden="true" /> : busy ? undefined : <Scissors aria-hidden="true" />
            }
            id="trim-builder-button-run"
            onClick={() => (completedOutput ? void runTrim() : onRunClick())}
            progress={
              trimQueued
                ? waitingProgressProps
                : busy && progressProps && progress?.stage !== "input"
                  ? progressProps
                  : null
            }
          >
            {busy ? "Cancel" : "TRIM & DOWNLOAD"}
          </OutputRunAction>
        }
        compress={buildOutputCompressionPanel({
          disabled: outputDisabled,
          fields: trimCompressPanel?.fields,
          format: compressHeaderFormat,
          formatId: "trim-builder-select-output-compression",
          formatOptions: compressFormatOptions,
          formatValue: resolvedOutputFormat,
          onFieldChange: (key, value) => updateSettings({ ...settings, [key]: value }),
          onFormatChange: updateOutputFormat,
          summary: trimCompressPanel?.summary,
          timing: compressTimingText,
        })}
        disabled={outputDisabled}
        fileName={resolvedOutputName}
        fileNameId="trim-builder-output-file"
        fileNamePlaceholder="Trimmed filename (no extension)"
        format={resolvedOutputFormat}
        formatId="trim-builder-select-output-format"
        formatOptions={formatOptions}
        info={
          <InfoPopover title="Output options">
            <strong>Output</strong>
            <ul>
              <li>Set the filename without an extension — the format selector controls it.</li>
              <li>Trimming permanently removes trailing padding from the ROM and can't be undone.</li>
              <li>Choose the raw extension to keep the trimmed bytes, or zip/7z to compress them.</li>
            </ul>
          </InfoPopover>
        }
        meta={trimTimingText ? <span className="t">{trimTimingText}</span> : undefined}
        notice={
          message && messagePlacement === "output" ? (
            <Notice
              id="trim-builder-row-error-message"
              level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
              onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
            >
              {message}
            </Notice>
          ) : null
        }
        num="02"
        onFileNameChange={(value) => {
          setOutputName(value);
          updateSettings({
            ...settings,
            output: { ...settings.output, outputName: value.trim() || undefined },
          });
        }}
        onFormatChange={updateOutputFormat}
        title="Trim"
      />
      <ConfirmDialog
        body={`Trimming is permanent — it removes trailing padding from ${sourceFileName} and can't be undone.`}
        cancelLabel="Cancel"
        confirmLabel="Trim ROM"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={onConfirmTrim}
        open={confirmOpen}
        title="Trim ROM permanently?"
      />
      {candidateSelectionDialog}
    </main>
  );
}

export { TrimPatchForm };
