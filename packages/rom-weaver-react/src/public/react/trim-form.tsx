import Download from "lucide-react/dist/esm/icons/download.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { createProgressViewModelFromEvent, formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { TrimWorkflowSourceState } from "../../types/trim-workflow.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { CompressPanelBody } from "./components/ds/compress-panel.tsx";
import { type ExtractionLevel, ExtractionTree } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice, RunButton } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import { OutputCard } from "./components/ds/output-card.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, TrimPatchFormProps, TrimPatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  normalizeDefaultArchive,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import {
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
} from "./workflow-adapters.ts";

const FILE_EXTENSION_REGEX = /\.[^./\\]+$/;

const createWorkflowId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

type BrowserTrimWorkflow = InstanceType<typeof TrimWorkflow>;

const mergeTrimSettings = (
  baseSettings: TrimPatchFormSettings | undefined,
  overrideSettings: TrimPatchFormSettings | undefined,
): TrimPatchFormSettings => {
  const merged = { ...(baseSettings || {}), ...(overrideSettings || {}) } as TrimPatchFormSettings;
  if (baseSettings?.output || overrideSettings?.output) {
    merged.output = {
      ...(baseSettings?.output || {}),
      ...(overrideSettings?.output || {}),
    };
  }
  return merged;
};

const createSettingsDependencyKey = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "function" ? "[function]" : entry));

// Raw extension keeps the trimmed bytes uncompressed; zip/7z wrap the trimmed file in an archive.
const getSourceExtension = (fileName: string) => {
  const match = fileName.match(FILE_EXTENSION_REGEX);
  return match ? match[0].slice(1).toLowerCase() : "raw";
};

const getFileNameStem = (fileName: string) => fileName.replace(FILE_EXTENSION_REGEX, "").trim();

const appendTrimmedMarker = (baseName: string) => (/\(trimmed\)$/i.test(baseName) ? baseName : `${baseName} (trimmed)`);

const getDefaultTrimOutputName = (sourceFileName: string, outputFormat: string) => {
  const sourceBaseName = getFileNameStem(sourceFileName) || "trimmed";
  const baseName = appendTrimmedMarker(sourceBaseName);
  if (outputFormat === "zip") return `${baseName}.zip`;
  if (outputFormat === "7z") return `${baseName}.7z`;
  return `${baseName}.${outputFormat || getSourceExtension(sourceFileName)}`;
};

const ensureTrimmedOutputName = (outputName: string, outputFormat: string, sourceFileName: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  const outputBaseName = getFileNameStem(normalizedOutputName).toLowerCase();
  const sourceBaseName = getFileNameStem(sourceFileName).toLowerCase();
  if (outputBaseName && outputBaseName === sourceBaseName) {
    return getDefaultTrimOutputName(sourceFileName, outputFormat);
  }
  return normalizedOutputName;
};

const resolveTrimExecutionOutputName = (outputName: string, outputFormat: string, sourceFileName: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  if (outputFormat === "zip" || outputFormat === "7z")
    return appendFileNameExtension(normalizedOutputName, outputFormat);
  return appendFileNameExtension(normalizedOutputName, outputFormat || getSourceExtension(sourceFileName));
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

type TrimProgressState = {
  indeterminate: boolean;
  label: string;
  message: string;
  percent: number | null;
  role?: string;
  stage?: string;
  visualPercent: number | null;
};

const getProgressDetails = (event: WorkflowProgress): Record<string, unknown> =>
  event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? (event.details as Record<string, unknown>)
    : {};

const formatElapsedMs = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : undefined;

const toExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  sourceState: TrimWorkflowSourceState | null,
): ExtractionLevel[] => {
  const levels: ExtractionLevel[] = (sourceState?.parentCompressions || []).map((entry) => {
    const sizeBytes = entry.sourceSize ?? entry.outputSize;
    return {
      name: entry.fileName,
      sizeBytes,
      sizeLabel: typeof sizeBytes === "number" ? formatByteSize(sizeBytes) : undefined,
      timing: formatElapsedMs(entry.decompressionTimeMs),
    };
  });
  const last = levels[levels.length - 1];
  if (!last || last.name !== fileName) {
    levels.push({
      name: fileName,
      sizeBytes: fileSize,
      sizeLabel: typeof fileSize === "number" ? formatByteSize(fileSize) : undefined,
    });
  }
  return levels;
};

const getTrimFixLabel = (sourceState: TrimWorkflowSourceState | null) => {
  const trim = sourceState?.romProbe?.trim;
  if (!trim?.detected) return "Not detected";
  const details = [
    typeof trim.trimmedInputBytes === "number" ? formatByteSize(trim.trimmedInputBytes) : "",
    trim.mode ? `mode ${trim.mode}` : "",
    trim.preservedDownloadPlayCert ? "download-play cert preserved" : "",
  ].filter(Boolean);
  return details.length ? `Detected (${details.join(" · ")})` : "Detected";
};

const TrimFixes = ({ sourceState }: { sourceState: TrimWorkflowSourceState | null }) => (
  <ChecksumList
    defaultOpen={false}
    label="Fixes"
    sublabel={sourceState?.romProbe?.trim.detected ? "trim detected" : "trim not detected"}
  >
    <ChecksumRow label="HEADER" value="No change" />
    <ChecksumRow label="TRIM" value={getTrimFixLabel(sourceState)} />
  </ChecksumList>
);

const TrimInfo = ({
  progress,
  sourceState,
}: {
  progress: TrimProgressState | null;
  sourceState: TrimWorkflowSourceState | null;
}) => {
  const checksumProgress = progress?.stage === "checksum" ? progress : null;
  const bytes = sourceState?.size ?? sourceState?.sourceSize;
  const checksums = sourceState?.checksums;
  if (!(checksumProgress || checksums || typeof bytes === "number")) return null;
  return (
    <ChecksumList
      defaultOpen={false}
      label="Info"
      lead={
        checksumProgress ? (
          <FileProgress
            indeterminate={checksumProgress.indeterminate}
            label={checksumProgress.label || checksumProgress.message || "Checksum"}
            percent={
              typeof checksumProgress.visualPercent === "number"
                ? checksumProgress.visualPercent
                : checksumProgress.percent
            }
            value={
              typeof checksumProgress.percent === "number" ? `${Math.round(checksumProgress.percent)}%` : "working"
            }
          />
        ) : undefined
      }
      timing={formatElapsedMs(sourceState?.checksumTimeMs)}
    >
      <ChecksumRow
        copyValue={typeof bytes === "number" ? String(Math.floor(bytes)) : ""}
        label="BYTES"
        value={typeof bytes === "number" ? String(Math.floor(bytes)) : ""}
      />
      <ChecksumRow label="CRC32" value={checksums?.crc32 || ""} />
      <ChecksumRow label="MD5" value={checksums?.md5 || ""} />
      <ChecksumRow label="SHA-1" value={checksums?.sha1 || ""} />
    </ChecksumList>
  );
};

function TrimPatchForm(props: TrimPatchFormProps) {
  const providerSettings = useCreateSettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  const [internalSource, setInternalSource] = useState<BinarySource | null>(props.defaultSource || null);
  const [internalSettings, setInternalSettings] = useState<TrimPatchFormSettings>(() =>
    mergeTrimSettings(providerSettings, props.defaultSettings),
  );
  const [internalOutputFormat, setInternalOutputFormat] = useState(props.defaultOutputFormat || "");
  const [busy, setBusy] = useState(false);
  const [sourceStaging, setSourceStaging] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [sourceState, setSourceState] = useState<TrimWorkflowSourceState | null>(null);
  const [completedOutput, setCompletedOutput] = useState<{
    fileName: string;
    inputSize?: number;
    rawSize?: number;
    saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
    size?: number;
  } | null>(null);
  const [completedCompressionTimeMs, setCompletedCompressionTimeMs] = useState<number | null>(null);
  const [completedTrimTimeMs, setCompletedTrimTimeMs] = useState<number | null>(null);
  const [progress, setProgress] = useState<{
    indeterminate: boolean;
    label: string;
    message: string;
    percent: number | null;
    role?: string;
    stage?: string;
    visualPercent: number | null;
  } | null>(null);
  const [outputName, setOutputName] = useState("");
  const activeOutputDisposeRef = useRef<(() => Promise<void> | void) | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const stagedTrimWorkflowRef = useRef<BrowserTrimWorkflow | null>(null);
  const stagedTrimWorkflowGenerationRef = useRef(0);
  const stagedTrimWorkflowReadyRef = useRef<Promise<void> | null>(null);
  const trimExecutionTimingRef = useRef<{ compressionStartedAt: number | null; trimStartedAt: number | null }>({
    compressionStartedAt: null,
    trimStartedAt: null,
  });
  const workflowIdRef = useRef(createWorkflowId("react-trim"));
  const selectedSourceCandidateIdRef = useRef<string | null>(null);

  const source = props.source === undefined ? internalSource : props.source;
  const settings = props.settings || internalSettings || providerSettings;
  const traceSettingsRef = useRef(settings);
  const onProgressRef = useRef(props.onProgress);
  const onErrorRef = useRef(props.onError);
  useEffect(() => {
    traceSettingsRef.current = settings;
    onProgressRef.current = props.onProgress;
    onErrorRef.current = props.onError;
  }, [props.onError, props.onProgress, settings]);
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
  const outputFormat = props.outputFormat ?? internalOutputFormat;
  const disabled = !!props.disabled || busy || sourceStaging;
  const actionDisabled = !!props.disabled || sourceStaging || !(busy || completedOutput || source);
  const sourceFileName = getReactBinarySourceFileName(source, "ROM");
  const resolvedSourceFileName = sourceState?.fileName || sourceFileName;
  const rawOutputFormat = getSourceExtension(resolvedSourceFileName);
  const defaultArchiveFormat = normalizeDefaultArchive(settings.defaultArchive);
  const resolvedOutputFormat =
    outputFormat || (defaultArchiveFormat === "none" ? rawOutputFormat : defaultArchiveFormat);
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const generatedOutputName =
    configuredOutputName || (source ? getDefaultTrimOutputName(resolvedSourceFileName, resolvedOutputFormat) : "");
  const rawResolvedOutputName = outputName.trim() || generatedOutputName;
  const resolvedOutputName = ensureTrimmedOutputName(
    rawResolvedOutputName,
    resolvedOutputFormat,
    resolvedSourceFileName,
  );
  const executionOutputName = resolveTrimExecutionOutputName(
    resolvedOutputName,
    resolvedOutputFormat,
    resolvedSourceFileName,
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
    setInternalSettings(mergeTrimSettings(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const disposeActiveOutput = useCallback(() => {
    const dispose = activeOutputDisposeRef.current;
    activeOutputDisposeRef.current = null;
    if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
  }, []);

  const clearCompletedRunState = useCallback(() => {
    setCompletedCompressionTimeMs(null);
    setCompletedOutput(null);
    setCompletedTrimTimeMs(null);
    trimExecutionTimingRef.current = { compressionStartedAt: null, trimStartedAt: null };
  }, []);

  const updateSource = (file: BinarySource | null) => {
    disposeActiveOutput();
    clearCompletedRunState();
    selectedSourceCandidateIdRef.current = null;
    stagedTrimWorkflowGenerationRef.current += 1;
    setSourceState(null);
    if (props.source === undefined) setInternalSource(file);
    props.onSourceChange?.(file);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  cancelSelectionRef.current = () => updateSource(null);

  const updateSettings = (nextSettings: TrimPatchFormSettings) => {
    disposeActiveOutput();
    clearCompletedRunState();
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updateOutputFormat = (nextOutputFormat: string) => {
    disposeActiveOutput();
    clearCompletedRunState();
    if (props.outputFormat === undefined) setInternalOutputFormat(nextOutputFormat);
    props.onOutputFormatChange?.(nextOutputFormat);
    setMessage("");
    setErrorCode("");
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
    const workflow = new TrimWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: `${workflowIdRef.current}:stage:${generation}`,
      selectFile: async (request) => {
        const preferredCandidate = request.candidates.find(
          (candidate) => candidate.id === selectedSourceCandidateIdRef.current,
        );
        if (preferredCandidate?.selectable) return { id: preferredCandidate.id };
        const choice = await selectFile(request);
        selectedSourceCandidateIdRef.current = choice.id;
        return choice;
      },
      settings: stagingSettingsRef.current,
    });
    emitTrimFormTrace("stage.workflow.created", {
      generation,
      sourceName: sourceFileName,
      workflowId: workflow.id,
    });
    stagedTrimWorkflowRef.current = workflow;
    const handleProgress = (event: WorkflowProgress) => {
      onProgressRef.current?.(toReactProgressEvent(event));
      setProgress({
        ...createProgressViewModelFromEvent(event, { stage: event.stage || "input" }),
        role: typeof event.role === "string" ? event.role : undefined,
        stage: typeof event.stage === "string" ? event.stage : "input",
      });
    };
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
        emitTrimFormTrace("stage.set-input.fail", {
          error,
          generation,
          input: workflow.getInput(),
          workflowId: workflow.id,
        });
        setSourceState(workflow.getInput());
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
          setProgress((current) => (current?.stage === "input" ? null : current));
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
    emitTrimFormTrace,
    props.workerThreads,
    resolvedAssetBaseUrl,
    selectFile,
    source,
    sourceFileName,
    stagingSettingsKey,
  ]);

  const runTrim = async () => {
    if (completedOutput) {
      await completedOutput.saveAs();
      return;
    }
    if (!source) return;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    setBusy(true);
    setMessage("");
    setErrorCode("");
    disposeActiveOutput();
    clearCompletedRunState();
    setProgress({
      indeterminate: true,
      label: "Trimming...",
      message: "Trimming...",
      percent: null,
      role: "worker",
      stage: "trim",
      visualPercent: null,
    });
    const outputCompression =
      resolvedOutputFormat === "zip" || resolvedOutputFormat === "7z" ? resolvedOutputFormat : "none";
    await stagedTrimWorkflowReadyRef.current?.catch(() => undefined);
    const trimWorkflow =
      stagedTrimWorkflowRef.current ||
      new TrimWorkflow({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: workflowIdRef.current,
        selectFile: async (request) => {
          const preferredCandidate = request.candidates.find(
            (candidate) => candidate.id === selectedSourceCandidateIdRef.current,
          );
          if (preferredCandidate?.selectable) return { id: preferredCandidate.id };
          return selectFile(request);
        },
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
      onProgressRef.current?.(toReactProgressEvent(event));
      setProgress({
        ...createProgressViewModelFromEvent(event, { stage: event.stage || "trim" }),
        role: typeof event.role === "string" ? event.role : undefined,
        stage: typeof event.stage === "string" ? event.stage : "trim",
      });
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
      const trimTimeMs =
        typeof trimStartedAt === "number"
          ? Math.max(0, (typeof compressionStartedAt === "number" ? compressionStartedAt : completedAt) - trimStartedAt)
          : null;
      const compressionTimeMs =
        typeof compressionStartedAt === "number" ? Math.max(0, completedAt - compressionStartedAt) : null;
      emitTrimFormTrace("run.finish", {
        compressionTimeMs,
        outputName: result.output.fileName,
        outputSize: result.sizeSummary?.outputSize ?? result.output.size,
        reusedStagedWorkflow: usingStagedWorkflow,
        trimTimeMs,
        workflowId: trimWorkflow.id,
      });
      activeOutputDisposeRef.current = result.output.dispose;
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
        setErrorCode("");
        setMessage("");
        setProgress(null);
        return;
      }
      setErrorCode(code);
      setMessage(
        formatCodedErrorForDisplay(
          normalizedError,
          createBrowserLocalizer((settings as { language?: string }).language),
        ),
      );
      setProgress(null);
      clearCompletedRunState();
      onErrorRef.current?.(normalizedError);
    } finally {
      abortController.signal.removeEventListener("abort", abortWorkflow);
      trimWorkflow.off("progress", handleProgress);
      if (!usingStagedWorkflow) await trimWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) activeAbortControllerRef.current = null;
      setBusy(false);
    }
  };

  const onRunClick = () => {
    if (busy) {
      activeAbortControllerRef.current?.abort();
      return;
    }
    if (!source) return;
    setConfirmOpen(true);
  };

  const onConfirmTrim = () => {
    setConfirmOpen(false);
    void runTrim();
  };

  useEffect(
    () => () => {
      activeAbortControllerRef.current?.abort();
      stagedTrimWorkflowRef.current?.dispose().catch(() => undefined);
      stagedTrimWorkflowRef.current = null;
      disposeActiveOutput();
    },
    [disposeActiveOutput],
  );

  const progressProps = progress
    ? {
        indeterminate: progress.indeterminate && progress.visualPercent === null && progress.percent === null,
        label: progress.label || progress.message || "Working…",
        percent: typeof progress.visualPercent === "number" ? progress.visualPercent : progress.percent,
        value: typeof progress.percent === "number" ? `${Math.round(progress.percent)}%` : "working",
      }
    : null;
  const showInputProgress =
    sourceStaging || (busy && progressProps && progress?.stage === "input" && progress.role === "input");

  const rawExtensionOption = rawOutputFormat;
  const formatOptions = [
    { label: `.${rawExtensionOption}`, value: rawExtensionOption },
    { label: ".zip", value: "zip" },
    { label: ".7z", value: "7z" },
  ];
  const compressFormatOptions = formatOptions;
  const compressHeaderFormat =
    resolvedOutputFormat === rawExtensionOption
      ? "None"
      : compressFormatOptions.find((option) => option.value === resolvedOutputFormat)?.label;
  const trimTimingText = formatElapsedMs(completedTrimTimeMs ?? undefined);
  const compressTimingText = formatElapsedMs(completedCompressionTimeMs ?? undefined);

  return (
    <main aria-labelledby="tab-trim" className="panel" id="trim-builder-container">
      <StepSection
        info={
          <InfoPopover title="ROM input">
            <strong>ROM</strong>
            <ul>
              <li>Drop an over-dumped ROM (NDS/N64 and similar) to remove trailing padding.</li>
              <li>Archives are extracted; pick the ROM if several candidates are found.</li>
            </ul>
          </InfoPopover>
        }
        num="01"
        title="ROM"
      >
        {source ? (
          showInputProgress && progressProps ? (
            <FileProgress {...progressProps} />
          ) : (
            <FileCard
              name={
                <ExtractionTree
                  levels={toExtractionLevels(resolvedSourceFileName, sourceState?.size, sourceState)}
                  timing={formatElapsedMs(sourceState?.decompressionTimeMs)}
                />
              }
              onRemove={() => updateSource(null)}
              removeLabel="Clear ROM"
            >
              <TrimFixes sourceState={sourceState} />
              <TrimInfo progress={progress} sourceState={sourceState} />
            </FileCard>
          )
        ) : null}
        <DropZone
          big={!source}
          disabled={disabled}
          hint={source ? undefined : "archives are extracted"}
          label={source ? "Replace ROM · drop or browse" : "Select ROM · drop or browse"}
          onFiles={(files) => updateSource(files[0] ?? null)}
        />
      </StepSection>
      <StepSection
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
        num="02"
        title="Trim"
      >
        <OutputCard
          action={
            <>
              {busy && progressProps && progress?.stage !== "input" ? <FileProgress {...progressProps} /> : null}
              <RunButton
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
              >
                {busy ? "Cancel" : "TRIM & DOWNLOAD"}
              </RunButton>
            </>
          }
          compress={(() => {
            const panel = buildCompressPanel(
              resolvedOutputFormat,
              settings as Record<string, unknown>,
              source
                ? ({ ...(source as unknown as Record<string, unknown>), fileName: resolvedSourceFileName } as Record<
                    string,
                    unknown
                  >)
                : null,
            );
            return {
              children: panel ? (
                <CompressPanelBody
                  disabled={disabled}
                  fields={panel.fields}
                  onChange={(key, value) => updateSettings({ ...settings, [key]: value })}
                />
              ) : null,
              format: compressHeaderFormat,
              formatId: "trim-builder-select-output-compression",
              formatLabel: "Type",
              formatOptions: compressFormatOptions,
              formatValue: resolvedOutputFormat,
              onFormatChange: updateOutputFormat,
              summary: panel?.summary,
              timing: compressTimingText,
            };
          })()}
          disabled={disabled}
          fileName={resolvedOutputName}
          fileNameId="trim-builder-output-file"
          fileNamePlaceholder="Trimmed filename (no extension)"
          format={resolvedOutputFormat}
          formatId="trim-builder-select-output-format"
          formatOptions={formatOptions}
          onFileNameChange={(value) => {
            setOutputName(value);
            updateSettings({
              ...settings,
              output: { ...settings.output, outputName: value.trim() || undefined },
            });
          }}
          onFormatChange={updateOutputFormat}
        />
        {message ? (
          <Notice id="trim-builder-row-error-message" level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}>
            {message}
          </Notice>
        ) : null}
      </StepSection>
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
