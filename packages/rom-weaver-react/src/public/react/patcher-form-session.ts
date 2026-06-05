import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveAutomaticCompressionFormat } from "../../lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { formatCodedErrorForDisplay } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult } from "../../types/workflow-runtime.ts";
import {
  createInertState,
  inertDialogController,
  inertOutputController,
  inertStackController,
  inertUiController,
  useLiveStoreController,
} from "./apply-session-controllers.ts";
import {
  createRomInputRow,
  formatOperationTiming,
  getChecksumProgressInfoPatch,
  getPendingInputDisplayFileName,
  getProgressDetails,
  getProgressStagedInputInfo,
  getStagedDecompressionTimeMs,
  resolveMergedRomFileName,
  sortRomInputs,
  sumStagedInfoSize,
} from "./apply-session-inputs.ts";
import { getTraceSourceSummaries, getTraceSourceSummary, logUiError } from "./apply-session-logging.ts";
import { createStageSettingsKey, getLegacyCompressionWorkerThreads } from "./apply-session-settings.ts";
import { useLocalPatcherSessionState } from "./apply-session-state.ts";
import type {
  ApplyExecutionTimingTracker,
  ApplyWorkflowStageSnapshot,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "./apply-session-types.ts";
import { buildCompressPanel } from "./compress-options.ts";
import {
  getBinarySourceFileName,
  getBinarySourceListStableIds,
  getBinarySourceSize,
  sameBinarySourceLists,
  toApplyButtonProgress,
  toInputProgress,
} from "./input-session-helpers.ts";
import {
  combineSectionTimingText,
  createOutputOptions,
  createSectionSizeText,
  getGeneratedOutputName,
} from "./output-view-model.ts";
import type { ApplyPatchFormSettings, BinarySource, NoticeController, StackPatchItem } from "./patcher-form.ts";
import {
  formatDownloadCompressionRatio,
  formatElapsedTiming,
  getLogicalRomInputCount,
  getMultiInputOutputError,
  getPublicOutputSize,
  getRequestedOutputName,
  isTraceLoggingEnabled,
  resolvePendingDownloadFileName,
  toError,
  waitForNextUiPaint,
} from "./patcher-form-session-utils.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, NoticeState, RomInputRowState } from "./patcher-ui-state.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  useActiveAbortController,
  useDisposableCleanup,
} from "./workflow-run-hooks.ts";

const useLocalApplyPatchFormSession = ({
  inputs,
  patches,
  settings,
  defaultInputs = [],
  defaultPatches = [],
  defaultSettings = {},
  disabled = false,
  workerThreads,
  containerInputsEnabled = true,
  compressionOptions = ["none", "7z", "zip", "chd", "rvz", "z3ds"],
  onInputsChange,
  onPatchesChange,
  onSettingsChange,
  onProgress,
  onApplyComplete,
  onError,
  applyPatches,
  applyReady = false,
  downloadOutput,
  resolvedOutputCompression,
  resolvedOutputName,
  resolvedOutputNameKey,
  stageInput,
  stagePatches,
  setPatchTarget,
}: LocalApplyPatchFormSessionOptions) => {
  const [internalInputs, setInternalInputs] = useState(defaultInputs);
  const [internalPatches, setInternalPatches] = useState(defaultPatches);
  const [internalSettings, setInternalSettings] = useState<ApplyPatchFormSettings>(defaultSettings);
  const [checksumOverrideChecked, setChecksumOverrideChecked] = useState(false);
  const {
    localState,
    setBusy,
    setCompletedApplyTimeMs,
    setCompletedCompressionTimeMs,
    setCompletedSizeSummary,
    setErrorMessage,
    setInputStaging,
    setOutputErrorMessage,
    setOutputName,
    setOutputNameEdited,
    setPatchInfoByKey,
    setPatchProgress,
    setPatchProgressByKey,
    setPatchStaging,
    setPendingDownloadFileName,
    setProgress,
    setRomInputs,
  } = useLocalPatcherSessionState();
  const [outputCompressionEdited, setOutputCompressionEdited] = useState(false);
  const {
    busy,
    completedApplyTimeMs,
    completedCompressionTimeMs,
    completedSizeSummary,
    failureMessage,
    inputStaging,
    outputErrorMessage,
    outputName,
    outputNameEdited,
    patchInfoByKey,
    patchProgress,
    patchProgressByKey,
    patchStaging,
    pendingDownloadFileName,
    progress,
    romInputs,
  } = localState;
  const { disposeActiveCleanup: disposeActiveOutputCleanup, rememberActiveCleanup: rememberActiveOutputCleanup } =
    useDisposableCleanup();
  const { abortActiveOperation, activeAbortControllerRef, rememberAbortController } = useActiveAbortController();
  const pendingDownloadFileNameRef = useRef<string | null>(null);
  const pendingDownloadResultRef = useRef<ApplyWorkflowResult | null>(null);
  const applyExecutionTimingRef = useRef<ApplyExecutionTimingTracker>({
    applyStartedAt: null,
    compressionStartedAt: null,
  });
  const busyRef = useRef(busy);
  const disabledRef = useRef(disabled);
  const inputStageGenerationRef = useRef(0);
  const inputProgressGenerationRef = useRef(0);
  const inputStageSyncRef = useRef<{ inputs: BinarySource[]; settingsKey: string }>({
    inputs: [],
    settingsKey: "",
  });
  const patchStageGenerationRef = useRef(0);
  const patchStageSyncRef = useRef<{
    inputs: BinarySource[];
    patches: BinarySource[];
    settingsKey: string;
  }>({
    inputs: [],
    patches: [],
    settingsKey: "",
  });
  const inputKeyMapRef = useRef(new WeakMap<object, string>());
  const inputStableKeyMapRef = useRef(new Map<string, string>());
  const nextInputKeyRef = useRef(0);
  const patchKeyMapRef = useRef(new WeakMap<object, string>());
  const patchStableKeyMapRef = useRef(new Map<string, string>());
  const nextPatchKeyRef = useRef(0);
  const effectiveInputs = inputs === undefined ? internalInputs : inputs;
  const activePatches = patches === undefined ? internalPatches : patches;
  const activeSettings = settings === undefined ? internalSettings : settings;
  const emitSessionTrace = useCallback(
    (message: string, details?: Record<string, unknown>) => {
      if (!isTraceLoggingEnabled(activeSettings)) return;
      activeSettings.logging?.sink?.({
        ...(details ? { details } : {}),
        level: "trace",
        message,
        namespace: "ui:apply-session",
        timestamp: new Date().toISOString(),
      });
    },
    [activeSettings],
  );
  const defaultArchiveCompression =
    activeSettings.defaultArchive === "7z" || activeSettings.defaultArchive === "none"
      ? activeSettings.defaultArchive
      : "zip";
  const activeCompression = activeSettings.output?.compression || defaultArchiveCompression;
  const z3dsLabelSource = useMemo<BinarySource | undefined>(() => {
    const selectedInputFileName = String(romInputs[0]?.info?.fileName || "").trim();
    const baseSource = effectiveInputs[0];
    if (!selectedInputFileName) return baseSource;
    if (baseSource && typeof baseSource === "object") {
      return {
        ...(baseSource as unknown as Record<string, unknown>),
        fileName: selectedInputFileName,
        name: selectedInputFileName,
      } as unknown as BinarySource;
    }
    if (typeof File === "function") return new File([], selectedInputFileName);
    return { fileName: selectedInputFileName } as unknown as BinarySource;
  }, [effectiveInputs, romInputs]);
  const supportedCompressionOptions = useMemo(
    () =>
      compressionOptions.filter((option) =>
        OutputCompressionManager.supportsOutputCompression(z3dsLabelSource, option),
      ),
    [compressionOptions, z3dsLabelSource],
  );
  const effectiveActiveCompression =
    activeCompression === "auto" ||
    OutputCompressionManager.supportsOutputCompression(z3dsLabelSource, activeCompression)
      ? activeCompression
      : "none";
  const autoResolvedCompression = resolveAutomaticCompressionFormat({
    fallback: "zip",
    parentCompressions: romInputs[0]?.archivePathEntries,
    sourceFileName: String(romInputs[0]?.info?.fileName || getBinarySourceFileName(effectiveInputs[0], "")),
  });
  const specialCompressionFormat =
    autoResolvedCompression === "chd" || autoResolvedCompression === "rvz" || autoResolvedCompression === "z3ds"
      ? autoResolvedCompression
      : null;
  const requestedCompression = outputCompressionEdited
    ? effectiveActiveCompression
    : activeSettings.specialCompression !== false && specialCompressionFormat
      ? specialCompressionFormat
      : effectiveActiveCompression === "auto"
        ? defaultArchiveCompression
        : effectiveActiveCompression;
  const displayedCompression =
    requestedCompression === "auto"
      ? effectiveInputs.length
        ? resolvedOutputCompression || autoResolvedCompression
        : autoResolvedCompression
      : requestedCompression;
  const outputOptions = useMemo(
    () => createOutputOptions(supportedCompressionOptions, z3dsLabelSource),
    [supportedCompressionOptions, z3dsLabelSource],
  );
  const selectedOutputOptionLabel = useMemo(
    () => outputOptions.find((option) => option.value === displayedCompression)?.label,
    [displayedCompression, outputOptions],
  );
  const outputSourceKey = useMemo(
    () =>
      JSON.stringify({
        inputs: getBinarySourceListStableIds(effectiveInputs),
        patches: getBinarySourceListStableIds(activePatches),
      }),
    [activePatches, effectiveInputs],
  );
  const hasPendingDownload = !!pendingDownloadFileName;
  const setPendingDownloadReadyFileName = useCallback(
    (fileName: string) => {
      const normalizedFileName = getRequestedOutputName(fileName) || "output";
      pendingDownloadFileNameRef.current = normalizedFileName;
      setPendingDownloadFileName(normalizedFileName);
    },
    [setPendingDownloadFileName],
  );

  useEffect(() => {
    if (settings !== undefined) return;
    setInternalSettings(defaultSettings);
  }, [defaultSettings, settings]);

  const clearPendingDownload = useCallback(() => {
    pendingDownloadFileNameRef.current = null;
    pendingDownloadResultRef.current = null;
    setPendingDownloadFileName(null);
  }, [setPendingDownloadFileName]);
  const resetCompletedOutputState = useCallback(() => {
    setCompletedApplyTimeMs(null);
    setCompletedCompressionTimeMs(null);
    setCompletedSizeSummary(createOutputSizeSummary());
    setProgress(null);
    clearPendingDownload();
  }, [clearPendingDownload]);
  const getStableSourceKeys = useCallback(
    (
      sources: BinarySource[],
      keyMapRef: typeof inputKeyMapRef,
      stableKeyMapRef: typeof inputStableKeyMapRef,
      nextKeyRef: typeof nextInputKeyRef,
      prefix: "input" | "patch",
    ) =>
      getBinarySourceListStableIds(sources).map((stableId, index) => {
        const sourceObject = sources[index] as object | undefined;
        let key =
          (sourceObject ? keyMapRef.current.get(sourceObject) : undefined) || stableKeyMapRef.current.get(stableId);
        if (!key) {
          nextKeyRef.current += 1;
          key = `${prefix}-${nextKeyRef.current}`;
          stableKeyMapRef.current.set(stableId, key);
        }
        if (sourceObject) keyMapRef.current.set(sourceObject, key);
        return key;
      }),
    [],
  );
  const inputKeys = useMemo(
    () => getStableSourceKeys(effectiveInputs, inputKeyMapRef, inputStableKeyMapRef, nextInputKeyRef, "input"),
    [effectiveInputs, getStableSourceKeys],
  );
  const patchKeys = useMemo(
    () => getStableSourceKeys(activePatches, patchKeyMapRef, patchStableKeyMapRef, nextPatchKeyRef, "patch"),
    [activePatches, getStableSourceKeys],
  );
  const getInputKey = useCallback(
    (input: BinarySource, sources: BinarySource[] = effectiveInputs) => {
      const index = sources.indexOf(input);
      if (sources === effectiveInputs) return index >= 0 ? inputKeys[index] || "" : "";
      return index >= 0
        ? getStableSourceKeys(sources, inputKeyMapRef, inputStableKeyMapRef, nextInputKeyRef, "input")[index] || ""
        : "";
    },
    [effectiveInputs, getStableSourceKeys, inputKeys],
  );
  const getPatchKey = useCallback(
    (patch: BinarySource, sources: BinarySource[] = activePatches) => {
      const index = sources.indexOf(patch);
      if (sources === activePatches) return index >= 0 ? patchKeys[index] || "" : "";
      return index >= 0
        ? getStableSourceKeys(sources, patchKeyMapRef, patchStableKeyMapRef, nextPatchKeyRef, "patch")[index] || ""
        : "";
    },
    [activePatches, getStableSourceKeys, patchKeys],
  );
  const generatedOutputName = getGeneratedOutputName(effectiveInputs[0], activePatches, activeSettings.output || {});
  const requestedOutputName = outputNameEdited ? getRequestedOutputName(outputName) : undefined;
  const currentResolvedOutputName =
    resolvedOutputName && (!resolvedOutputNameKey || resolvedOutputNameKey === outputSourceKey)
      ? resolvedOutputName
      : "";
  const automaticResolvedOutputName = effectiveInputs.length
    ? currentResolvedOutputName || generatedOutputName
    : generatedOutputName;
  const resolvedWorkerThreads =
    activeSettings.workers?.threads ?? getLegacyCompressionWorkerThreads(activeSettings) ?? workerThreads;
  const effectiveResolvedOutputName = requestedOutputName || automaticResolvedOutputName;
  const stageSettingsKey = useMemo(
    () =>
      createStageSettingsKey({
        containerInputsEnabled,
        settings: activeSettings,
        workerThreads: resolvedWorkerThreads,
      }),
    [activeSettings, containerInputsEnabled, resolvedWorkerThreads],
  );
  const createStageSnapshot = useCallback(
    (): ApplyWorkflowStageSnapshot => ({
      inputs: effectiveInputs,
      options: {
        ...activeSettings,
        input: {
          ...activeSettings.input,
          containerInputsEnabled,
        },
        output: {
          ...activeSettings.output,
          compression: requestedCompression,
          outputName: requestedOutputName,
        },
        workerThreads: resolvedWorkerThreads,
      },
      patches: activePatches,
    }),
    [
      activePatches,
      activeSettings,
      containerInputsEnabled,
      effectiveInputs,
      requestedOutputName,
      requestedCompression,
      resolvedWorkerThreads,
    ],
  );
  const fallbackInputCompressedBytes =
    effectiveInputs.reduce((total, input) => total + (getBinarySourceSize(input) || 0), 0) || null;
  const primaryRomInput = romInputs[0] || null;
  const inputCompressedTotal =
    completedSizeSummary.inputBytes === null ? (primaryRomInput?.sourceSize ?? fallbackInputCompressedBytes) : null;
  const inputCompressedDisplayBytes = completedSizeSummary.inputCompressedBytes ?? inputCompressedTotal;
  const inputUncompressedBytes =
    completedSizeSummary.inputBytes ?? primaryRomInput?.size ?? fallbackInputCompressedBytes;
  const stagedPatchInfos = activePatches
    .map((patch) => patchInfoByKey[getPatchKey(patch)])
    .filter((info): info is StagedInputInfo => !!info);
  const stagedPatchCompressedBytes = sumStagedInfoSize(stagedPatchInfos, "sourceSize");
  const stagedPatchRawBytes = sumStagedInfoSize(stagedPatchInfos, "size");
  const fallbackPatchCompressedBytes =
    activePatches.reduce((total, patch) => total + (getBinarySourceSize(patch) || 0), 0) || null;
  const patchCompressedBytes =
    completedSizeSummary.patchCompressedBytes ?? stagedPatchCompressedBytes ?? fallbackPatchCompressedBytes;
  const patchRawBytes = completedSizeSummary.patchBytes ?? stagedPatchRawBytes ?? patchCompressedBytes;
  const localSectionTimingSizes = createSectionSizeText({
    inputCompressedBytes: inputCompressedDisplayBytes,
    inputUncompressedBytes,
    outputRawBytes: completedSizeSummary.rawBytes,
    outputRecompressedBytes: completedSizeSummary.outputBytes,
    patchCompressedBytes,
    patchRawBytes,
  });
  const inputDecompressionTimeMs = (() => {
    const elapsedMs = completedSizeSummary.inputDecompressionTimeMs ?? primaryRomInput?.decompressionTimeMs;
    if (!(primaryRomInput?.wasDecompressed || completedSizeSummary.inputDecompressionTimeMs !== null)) return null;
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return null;
    return elapsedMs;
  })();
  const inputOperationTimingText = formatOperationTiming("extract", inputDecompressionTimeMs);
  const outputOperationTimingText = [
    formatOperationTiming("apply", completedApplyTimeMs),
    formatOperationTiming("compress", completedCompressionTimeMs),
  ]
    .filter(Boolean)
    .join(" / ");
  const applyTimingText = formatElapsedTiming(completedApplyTimeMs);
  const compressTimingText = formatElapsedTiming(completedCompressionTimeMs);
  const patchDecompressionTimingText = (() => {
    const elapsedMs = getStagedDecompressionTimeMs(stagedPatchInfos);
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs)) return "";
    return `extract: ${formatTiming(createTiming(elapsedMs))}`;
  })();
  const localPatcherSectionTimings = useMemo(
    () => ({
      checksum: "",
      input: inputOperationTimingText,
      output: combineSectionTimingText(outputOperationTimingText, localSectionTimingSizes.output),
      patch: patchDecompressionTimingText,
    }),
    [inputOperationTimingText, localSectionTimingSizes.output, outputOperationTimingText, patchDecompressionTimingText],
  );
  const chdSplitBinVisible = romInputs.some((entry) => entry.splitBinAvailable);
  const chdSplitBinChecked = activeSettings.input?.chdSplitBin !== false;
  const strictInputChecksumValidation = activeSettings.validation?.requireInputChecksumMatch === true;
  const hasStrictInputChecksumMismatch =
    strictInputChecksumValidation && stagedPatchInfos.some((info) => info.checksumPreflightMismatch === true);
  const strictInputChecksumBlocked = hasStrictInputChecksumMismatch && !checksumOverrideChecked;
  const multiInputOutputError = getMultiInputOutputError(displayedCompression, getLogicalRomInputCount(romInputs));
  const effectiveOutputNoticeMessage = outputErrorMessage || multiInputOutputError;
  const canQueueApply =
    !!effectiveInputs.length &&
    !multiInputOutputError &&
    applyReady &&
    !(inputStaging || patchStaging) &&
    !strictInputChecksumBlocked;
  const disposeActiveOutput = useCallback(() => {
    clearPendingDownload();
    disposeActiveOutputCleanup();
  }, [clearPendingDownload, disposeActiveOutputCleanup]);

  const invalidateCompletedOutputState = useCallback(() => {
    disposeActiveOutput();
    resetCompletedOutputState();
  }, [disposeActiveOutput, resetCompletedOutputState]);

  const cancelActiveOperation = abortActiveOperation;

  useEffect(
    () => () => {
      cancelActiveOperation();
      disposeActiveOutput();
    },
    [cancelActiveOperation, disposeActiveOutput],
  );

  useEffect(() => {
    const configuredOutputName = activeSettings.output?.outputName || "";
    setOutputName(configuredOutputName);
    setOutputNameEdited(!!configuredOutputName.trim());
    if (pendingDownloadResultRef.current && hasPendingDownload) {
      setPendingDownloadReadyFileName(
        resolvePendingDownloadFileName({
          automaticOutputName: automaticResolvedOutputName,
          requestedOutputName: configuredOutputName,
          resultOutputName: pendingDownloadResultRef.current.output.fileName,
        }),
      );
    }
  }, [
    activeSettings.output?.outputName,
    automaticResolvedOutputName,
    hasPendingDownload,
    setPendingDownloadReadyFileName,
  ]);

  useEffect(() => {
    setPatchInfoByKey((current) => {
      const nextInfoByKey: Record<string, StagedInputInfo> = {};
      for (const patch of activePatches) {
        const key = getPatchKey(patch, activePatches);
        if (current[key]) nextInfoByKey[key] = current[key];
      }
      return nextInfoByKey;
    });
    setPatchProgressByKey((current) => {
      const nextProgressByKey: Record<string, InputProgress> = {};
      for (const patch of activePatches) {
        const key = getPatchKey(patch, activePatches);
        if (current[key]) nextProgressByKey[key] = current[key];
      }
      return nextProgressByKey;
    });
  }, [activePatches, getPatchKey]);

  useEffect(() => {
    if (hasStrictInputChecksumMismatch) return;
    setChecksumOverrideChecked(false);
  }, [hasStrictInputChecksumMismatch]);

  const localUiState = useMemo(
    () => ({
      ...createInertState(),
      chdSplitBin: {
        checked: chdSplitBinChecked,
        disabled: disabled || busy || inputStaging,
        label: "Split BIN tracks",
        visible: chdSplitBinVisible,
      },
      checksumOverride: {
        checked: checksumOverrideChecked,
        disabled: disabled || busy || inputStaging || patchStaging,
        label: createInertState().checksumOverride.label,
        visible: hasStrictInputChecksumMismatch,
      },
      outputNotice: {
        level: "error" as const,
        message: effectiveOutputNoticeMessage,
        visible: !!effectiveOutputNoticeMessage,
      },
      patchInput: {
        ...createInertState().patchInput,
        disabled: disabled || busy || patchStaging,
        loading: patchStaging || !!patchProgress || Object.keys(patchProgressByKey).length > 0,
        progress: null,
        valid: activePatches.length > 0,
      },
      romInfo: {
        ...createInertState().romInfo,
        alterHeaderChecked: activeSettings.compatibility?.fixChecksum === true,
        alterHeaderDisabled: disabled || busy || inputStaging,
        alterHeaderLabel: "Fix internal checksum",
        alterHeaderVisible: true,
        archiveName: primaryRomInput?.info.archiveName ?? (effectiveInputs.length ? "-" : ""),
        crc32: primaryRomInput?.info.crc32 || "",
        fileName:
          primaryRomInput?.info.fileName ||
          effectiveInputs.map((input, index) => getBinarySourceFileName(input, `Input ${index + 1}`)).join(", "),
        md5: primaryRomInput?.info.md5 || "",
        sha1: primaryRomInput?.info.sha1 || "",
        validationPhase: primaryRomInput?.info.validationPhase || "idle",
      },
      romInput: {
        disabled: disabled || busy || inputStaging,
        invalid: false,
        loading: inputStaging || romInputs.some((entry) => !!entry.progress),
        progress: primaryRomInput?.progress || null,
        valid: effectiveInputs.length > 0,
      },
      romInputs,
      sectionTimings: localPatcherSectionTimings,
    }),
    [
      activePatches.length,
      busy,
      checksumOverrideChecked,
      chdSplitBinChecked,
      chdSplitBinVisible,
      disabled,
      effectiveInputs,
      inputStaging,
      hasStrictInputChecksumMismatch,
      localPatcherSectionTimings,
      effectiveOutputNoticeMessage,
      patchProgress,
      patchProgressByKey,
      patchStaging,
      primaryRomInput,
      romInputs,
    ],
  );
  const localStackState = useMemo(
    () => ({
      items: activePatches.map<StackPatchItem>((patch, index) => {
        const key = getPatchKey(patch);
        const patchInfo = patchInfoByKey[key];
        const targetOptions = romInputs
          .filter((input) => input.patchable !== false && input.kind !== "cue")
          .map((input) => ({
            label: input.info.fileName || `Input ${input.order + 1}`,
            value: input.id,
          }));
        return {
          archiveFileName: patchInfo?.archiveName || "",
          archivePathEntries: patchInfo?.parentCompressions,
          canMoveDown: index < activePatches.length - 1 && !(busy || disabled),
          canMoveUp: index > 0 && !(busy || disabled),
          canRemove: !(busy || disabled),
          checksumTiming: patchInfo?.checksumTiming || "",
          decompressionTimeMs: patchInfo?.decompressionTimeMs,
          detailText: patchInfo?.targetLabel || "",
          fileName: patchInfo?.fileName || getBinarySourceFileName(patch, `Patch ${index + 1}`),
          fileSize: patchInfo?.size ?? patchInfo?.sourceSize ?? getBinarySourceSize(patch) ?? undefined,
          index: index + 1,
          key,
          progress: patchProgressByKey[key] || null,
          targetDisabled: disabled || busy || patchStaging || targetOptions.length < 2,
          targetOptions,
          targetValue: patchInfo?.targetInputId || (targetOptions.length === 1 ? targetOptions[0]?.value : ""),
          validationActualValue: patchInfo?.validationActualValue || "",
          validationLabel: patchInfo?.validationLabel || "",
          validationMessage: patchInfo?.validationMessage || "",
          validationState: patchInfo?.validationState || "",
          validationValues: patchInfo?.validationValues || [],
        };
      }),
    }),
    [activePatches, busy, disabled, getPatchKey, patchInfoByKey, patchProgressByKey, patchStaging, romInputs],
  );
  const localOutputState = useMemo(
    () => ({
      applyButton: {
        disabled: disabled || !(busy || hasPendingDownload || canQueueApply),
        label: busy ? "Cancel" : hasPendingDownload ? "Download output" : "Apply & download",
        loading: busy,
        progress: hasPendingDownload ? null : progress ? toApplyButtonProgress({ stage: "apply", ...progress }) : null,
        title: hasPendingDownload ? `Download ${pendingDownloadFileName}` : "",
      },
      applyTiming: applyTimingText,
      compress: buildCompressPanel(displayedCompression, activeSettings as Record<string, unknown>, z3dsLabelSource),
      compressionFormat: displayedCompression,
      compressTiming: compressTimingText,
      disabled: disabled || busy || inputStaging || patchStaging,
      displayFileName: outputNameEdited ? outputName : effectiveResolvedOutputName,
      downloadSummary: hasPendingDownload
        ? {
            format: selectedOutputOptionLabel || displayedCompression?.toUpperCase() || undefined,
            ratio:
              formatDownloadCompressionRatio(completedSizeSummary.inputBytes, completedSizeSummary.outputBytes) ||
              undefined,
            size: completedSizeSummary.outputLabel || undefined,
          }
        : null,
      options: outputOptions,
      pendingDownloadFileName,
      resolvedOutputName: effectiveResolvedOutputName,
      sizeSummary: completedSizeSummary,
    }),
    [
      activePatches.length,
      applyTimingText,
      busy,
      canQueueApply,
      completedSizeSummary,
      compressTimingText,
      disabled,
      displayedCompression,
      effectiveResolvedOutputName,
      effectiveInputs.length,
      hasPendingDownload,
      inputStaging,
      pendingDownloadFileName,
      patchStaging,
      outputOptions,
      outputName,
      outputNameEdited,
      progress,
      selectedOutputOptionLabel,
    ],
  );
  const localNoticeState = useMemo<NoticeState>(
    () => ({
      level: "error",
      message: failureMessage,
      visible: !!failureMessage,
    }),
    [failureMessage],
  );

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  const updateSettings = useCallback(
    (nextSettings: ApplyPatchFormSettings) => {
      setChecksumOverrideChecked(false);
      invalidateCompletedOutputState();
      if (settings === undefined) setInternalSettings(nextSettings);
      onSettingsChange?.(nextSettings);
    },
    [invalidateCompletedOutputState, onSettingsChange, setChecksumOverrideChecked, settings],
  );
  const commitSettings = useCallback(
    (nextSettings: ApplyPatchFormSettings) => {
      setChecksumOverrideChecked(false);
      if (settings === undefined) setInternalSettings(nextSettings);
      onSettingsChange?.(nextSettings);
    },
    [onSettingsChange, setChecksumOverrideChecked, settings],
  );
  useEffect(() => {
    if (!outputCompressionEdited || activeCompression === effectiveActiveCompression) return;
    updateSettings({
      ...activeSettings,
      output: {
        ...activeSettings.output,
        compression: effectiveActiveCompression,
      },
    });
  }, [activeCompression, activeSettings, effectiveActiveCompression, outputCompressionEdited, updateSettings]);
  const updatePatches = useCallback(
    (nextPatches: BinarySource[]) => {
      setChecksumOverrideChecked(false);
      invalidateCompletedOutputState();
      setPatchInfoByKey((current) => {
        const nextInfoByKey: Record<string, StagedInputInfo> = {};
        for (const patch of nextPatches) {
          const key = getPatchKey(patch, nextPatches);
          if (current[key]) nextInfoByKey[key] = current[key];
        }
        return nextInfoByKey;
      });
      if (patches === undefined) setInternalPatches(nextPatches);
      onPatchesChange?.(nextPatches);
    },
    [getPatchKey, invalidateCompletedOutputState, onPatchesChange, patches, setChecksumOverrideChecked],
  );
  const getStableInputInfo = useCallback(
    (info: StagedInputInfo, sources: BinarySource[]) => {
      const source = typeof info.order === "number" ? sources[info.order] : undefined;
      const stableId = source ? getInputKey(source, sources) : info.id;
      return stableId && stableId !== info.id ? { ...info, id: stableId } : info;
    },
    [getInputKey],
  );
  const mergeRomInput = useCallback(
    (
      info: StagedInputInfo,
      patch: Omit<Partial<RomInputRowState>, "info"> & { info?: Partial<RomInputRowState["info"]> } = {},
    ) => {
      const rowId = info.id || patch.id;
      if (!rowId) return;
      setRomInputs((current) => {
        const existing =
          current.find((entry) => entry.id === rowId) ||
          (typeof info.order === "number" ? current.find((entry) => entry.order === info.order) : undefined) ||
          createRomInputRow({
            id: rowId,
            info: {
              archiveName: info.archiveName || "",
              fileName: info.fileName || "",
            },
            order: info.order ?? current.length,
          });
        const archiveName = info.archiveName || patch.info?.archiveName || existing.info.archiveName;
        const fileName = resolveMergedRomFileName({
          archiveName,
          existingFileName: existing.info.fileName,
          nextFileName: info.fileName ?? patch.info?.fileName,
        });
        const nextRow = createRomInputRow({
          ...existing,
          ...patch,
          archivePathEntries:
            info.parentCompressions ??
            (patch as Partial<RomInputRowState>).archivePathEntries ??
            existing.archivePathEntries,
          decompressionTimeMs: info.decompressionTimeMs ?? patch.decompressionTimeMs ?? existing.decompressionTimeMs,
          groupId: info.groupId ?? patch.groupId ?? existing.groupId,
          id: rowId,
          info: {
            ...existing.info,
            ...(patch.info || {}),
            archiveName,
            checksumTiming: info.checksumTiming ?? patch.info?.checksumTiming ?? existing.info.checksumTiming,
            crc32: info.checksums?.crc32 ?? patch.info?.crc32 ?? existing.info.crc32,
            fileName,
            md5: info.checksums?.md5 ?? patch.info?.md5 ?? existing.info.md5,
            romProbe: info.romProbe ?? patch.info?.romProbe ?? existing.info.romProbe,
            sha1: info.checksums?.sha1 ?? patch.info?.sha1 ?? existing.info.sha1,
            validationPhase: patch.info?.validationPhase ?? existing.info.validationPhase,
          },
          kind: info.kind ?? patch.kind ?? existing.kind,
          order: info.order ?? patch.order ?? existing.order,
          patchable: info.patchable ?? patch.patchable ?? existing.patchable,
          size: info.size ?? patch.size ?? existing.size,
          sourceSize: info.sourceSize ?? patch.sourceSize ?? existing.sourceSize,
          splitBinAvailable: info.splitBinAvailable ?? patch.splitBinAvailable ?? existing.splitBinAvailable,
          wasDecompressed: info.wasDecompressed ?? patch.wasDecompressed ?? existing.wasDecompressed,
        });
        const remaining = current.filter((entry) => entry.id !== rowId && entry.id !== existing.id);
        return sortRomInputs([...remaining, nextRow]);
      });
    },
    [],
  );
  const updateInputs = useCallback(
    (nextInputs: BinarySource[]) => {
      setChecksumOverrideChecked(false);
      invalidateCompletedOutputState();
      inputStageGenerationRef.current += 1;
      inputProgressGenerationRef.current += 1;
      emitSessionTrace("input list updated", {
        generation: inputStageGenerationRef.current,
        nextCount: nextInputs.length,
        previousCount: effectiveInputs.length,
        progressGeneration: inputProgressGenerationRef.current,
        sources: getTraceSourceSummaries(nextInputs, "Input"),
      });
      if (inputs === undefined) setInternalInputs(nextInputs);
      onInputsChange?.(nextInputs);
      setErrorMessage("");
      setOutputErrorMessage("");
      setProgress(null);
      setInputStaging(false);
      setRomInputs((current) => {
        if (!nextInputs.length) return [];
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        return sortRomInputs(
          nextInputs.map((input, index) => {
            const id = getInputKey(input, nextInputs);
            const existing = byId.get(id);
            return createRomInputRow({
              ...existing,
              disabled: disabledRef.current || busyRef.current,
              id,
              info: {
                ...existing?.info,
                archiveName: existing?.info.archiveName || "",
                fileName: existing?.info.fileName || getPendingInputDisplayFileName(input, `Input ${index + 1}`),
                validationPhase: "idle",
              },
              loading: false,
              order: index,
              progress: null,
              size: existing?.size ?? getBinarySourceSize(input) ?? undefined,
              sourceSize: existing?.sourceSize ?? getBinarySourceSize(input) ?? undefined,
            });
          }),
        );
      });
      return inputStageGenerationRef.current;
    },
    [
      effectiveInputs.length,
      emitSessionTrace,
      getInputKey,
      invalidateCompletedOutputState,
      inputs,
      onInputsChange,
      setChecksumOverrideChecked,
    ],
  );
  const syncPatchFiles = useCallback(
    (
      snapshot: ApplyWorkflowStageSnapshot,
      options: {
        silent?: boolean;
      } = {},
    ) => {
      const generation = ++patchStageGenerationRef.current;
      if (!(snapshot.patches.length && stagePatches)) {
        setPatchStaging(false);
        setPatchProgress(null);
        setPatchProgressByKey({});
        return;
      }
      const silent = options.silent === true;
      const initialProgress = {
        indeterminate: true,
        label: "Preparing patch...",
        message: "Preparing patch...",
      };
      if (!silent) {
        setPatchStaging(true);
        setPatchProgress(null);
        setPatchProgressByKey(
          Object.fromEntries(
            snapshot.patches.map((patch, index) => [
              getPatchKey(patch, snapshot.patches),
              index === 0 ? initialProgress : createWaitingWorkflowProgress(),
            ]),
          ),
        );
      }
      void stagePatches(snapshot, {
        onProgress: (event) => {
          if (silent) return;
          if (patchStageGenerationRef.current !== generation) return;
          const details = getProgressDetails(event);
          const order = typeof details.order === "number" ? details.order : -1;
          const patch = (order >= 0 ? snapshot.patches[order] : undefined) || snapshot.patches[0] || null;
          if (!patch) {
            setPatchProgress(toInputProgress(event));
            return;
          }
          const key = getPatchKey(patch, snapshot.patches);
          setPatchProgressByKey((current) => ({
            ...current,
            [key]: toInputProgress(event),
          }));
        },
      })
        .then((infos) => {
          if (patchStageGenerationRef.current !== generation) return;
          setPatchInfoByKey(
            Object.fromEntries(
              snapshot.patches.map((patch, index) => [
                getPatchKey(patch, snapshot.patches),
                infos[index] || { fileName: getBinarySourceFileName(patch, `Patch ${index + 1}`) },
              ]),
            ),
          );
        })
        .catch((error) => {
          if (patchStageGenerationRef.current !== generation) return;
          const normalizedError = toError(error);
          logUiError("Patch staging failed", normalizedError);
          setErrorMessage(
            formatCodedErrorForDisplay(
              normalizedError,
              createBrowserLocalizer((activeSettings as { language?: string }).language),
            ),
          );
          onError?.(normalizedError);
        })
        .finally(() => {
          if (patchStageGenerationRef.current !== generation) return;
          if (!silent) {
            setPatchStaging(false);
            setPatchProgress(null);
            setPatchProgressByKey({});
          }
        });
    },
    [activeSettings, getPatchKey, onError, stagePatches],
  );
  const syncRomInput = useCallback(
    (snapshot: ApplyWorkflowStageSnapshot, previousInputs: BinarySource[] = []) => {
      const generation = ++inputStageGenerationRef.current;
      const progressGeneration = ++inputProgressGenerationRef.current;
      const retainedInputKeys = new Set(previousInputs.map((input) => getInputKey(input, previousInputs)));
      emitSessionTrace("input staging sync started", {
        generation,
        hasStageInput: !!stageInput,
        inputCount: snapshot.inputs.length,
        patchCount: snapshot.patches.length,
        previousCount: previousInputs.length,
        progressGeneration,
        retainedCount: retainedInputKeys.size,
        sources: getTraceSourceSummaries(snapshot.inputs, "Input"),
      });
      if (!(snapshot.inputs[0] && stageInput)) {
        emitSessionTrace("input staging sync skipped", {
          generation,
          hasFirstInput: !!snapshot.inputs[0],
          hasStageInput: !!stageInput,
        });
        setInputStaging(false);
        setRomInputs([]);
        return;
      }
      setInputStaging(true);
      const initialProgress = {
        indeterminate: true,
        label: "Preparing input...",
        message: "Preparing input...",
      };
      setRomInputs((current) =>
        sortRomInputs(
          snapshot.inputs.map((input, index) => {
            const existing = current[index];
            const existingProgress = existing?.progress || null;
            const isQueued = index > 0 || retainedInputKeys.size > 0;
            return createRomInputRow({
              ...existing,
              disabled: true,
              id: existing?.id || getInputKey(input, snapshot.inputs),
              info: {
                ...existing?.info,
                archiveName: existing?.info.archiveName || "",
                fileName: existing?.info.fileName || getPendingInputDisplayFileName(input, `Input ${index + 1}`),
              },
              loading: true,
              order: existing?.order ?? index,
              progress:
                existingProgress || (existing ? null : isQueued ? createWaitingWorkflowProgress() : initialProgress),
              valid: false,
            });
          }),
        ),
      );
      emitSessionTrace("stageInput dispatched", {
        generation,
        inputCount: snapshot.inputs.length,
        progressGeneration,
      });
      void stageInput(snapshot, {
        onChecksum: (info) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput checksum ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput checksum", {
            fileName: info.fileName,
            hasChecksums: !!info.checksums,
            order: info.order,
            size: info.size,
            sourceSize: info.sourceSize,
          });
          mergeRomInput(getStableInputInfo(info, snapshot.inputs), {
            disabled: true,
            info: { validationPhase: "idle" },
            loading: false,
            progress: null,
            valid: true,
          });
        },
        onProgress: (event) => {
          const details = getProgressDetails(event);
          if (
            inputStageGenerationRef.current !== generation ||
            inputProgressGenerationRef.current !== progressGeneration
          ) {
            emitSessionTrace("stageInput progress ignored", {
              currentGeneration: inputStageGenerationRef.current,
              currentProgressGeneration: inputProgressGenerationRef.current,
              generation,
              progress: {
                fileName: details.fileName,
                order: details.order,
                percent: event.percent,
                sourceId: details.sourceId,
                stage: details.stage,
              },
              progressGeneration,
              reason: "stale-generation",
            });
            return;
          }
          const sourceId = typeof details.sourceId === "string" ? details.sourceId : "";
          if (!sourceId) {
            emitSessionTrace("stageInput progress ignored", {
              generation,
              progress: {
                fileName: details.fileName,
                order: details.order,
                percent: event.percent,
                stage: details.stage,
              },
              progressGeneration,
              reason: "missing-sourceId",
            });
            return;
          }
          const info = getStableInputInfo(getProgressStagedInputInfo(event), snapshot.inputs);
          const source = typeof info.order === "number" ? snapshot.inputs[info.order] : undefined;
          if (source && retainedInputKeys.has(getInputKey(source, snapshot.inputs))) {
            emitSessionTrace("stageInput progress ignored", {
              generation,
              order: info.order,
              progressGeneration,
              reason: "retained-input",
              sourceId,
            });
            return;
          }
          emitSessionTrace("stageInput progress", {
            fileName: info.fileName,
            generation,
            order: info.order,
            percent: event.percent,
            progressGeneration,
            sourceId,
            stage: details.stage,
          });
          mergeRomInput(info, {
            ...getChecksumProgressInfoPatch(details),
            progress: toInputProgress(event),
          });
        },
        onState: (info) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput state ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput state", {
            fileName: info.fileName,
            generation,
            order: info.order,
            size: info.size,
            sourceSize: info.sourceSize,
          });
          mergeRomInput(getStableInputInfo(info, snapshot.inputs), {
            disabled: true,
            info: { validationPhase: "idle" },
            loading: false,
            progress: null,
            valid: !!info.fileName,
          });
        },
      })
        .then((infos) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput complete ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              infoCount: infos.length,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput complete", {
            generation,
            infoCount: infos.length,
            infos: infos.map((info) => ({
              fileName: info.fileName,
              order: info.order,
              size: info.size,
              sourceSize: info.sourceSize,
              wasDecompressed: info.wasDecompressed,
            })),
          });
          setRomInputs((current) => {
            const byId = new Map(current.map((entry) => [entry.id, entry]));
            return sortRomInputs(
              infos.map((rawInfo, index) => {
                const info = getStableInputInfo(rawInfo, snapshot.inputs);
                const stableId = info.id || getInputKey(snapshot.inputs[index] as BinarySource, snapshot.inputs);
                return createRomInputRow({
                  ...(stableId ? byId.get(stableId) : undefined),
                  disabled: disabledRef.current || busyRef.current,
                  id: stableId,
                  info: {
                    archiveName: info.archiveName || "",
                    checksumTiming: info.checksumTiming || byId.get(stableId)?.info.checksumTiming || "",
                    crc32: info.checksums?.crc32 || "",
                    fileName: info.fileName || getBinarySourceFileName(snapshot.inputs[index], `Input ${index + 1}`),
                    md5: info.checksums?.md5 || "",
                    romProbe: info.romProbe || byId.get(stableId)?.info.romProbe,
                    sha1: info.checksums?.sha1 || "",
                    validationPhase: "idle",
                  },
                  kind: info.kind,
                  loading: false,
                  order: info.order ?? index,
                  progress: null,
                  size: info.size,
                  sourceSize: info.sourceSize,
                  splitBinAvailable: info.splitBinAvailable,
                  valid: true,
                  wasDecompressed: info.wasDecompressed,
                });
              }),
            );
          });
        })
        .catch((error) => {
          const normalizedError = toError(error);
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput failure ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              message: normalizedError.message,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput failed", {
            generation,
            message: normalizedError.message,
            name: normalizedError.name,
          });
          logUiError("Input staging failed", normalizedError);
          setErrorMessage(
            formatCodedErrorForDisplay(
              normalizedError,
              createBrowserLocalizer((activeSettings as { language?: string }).language),
            ),
          );
          onError?.(normalizedError);
        })
        .finally(() => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput finalizer ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput finalizer", {
            generation,
          });
          setInputStaging(false);
          setRomInputs((current) =>
            current.map((entry) =>
              createRomInputRow({
                ...entry,
                disabled: disabledRef.current || busyRef.current,
                info: { ...entry.info, validationPhase: "idle" },
                loading: false,
                progress: null,
              }),
            ),
          );
        });
    },
    [activeSettings, emitSessionTrace, getInputKey, getStableInputInfo, mergeRomInput, onError, stageInput],
  );

  useEffect(() => {
    if (!stageInput) return;
    const previousSync = inputStageSyncRef.current;
    const inputsChanged = !sameBinarySourceLists(previousSync.inputs, effectiveInputs);
    const settingsChanged = previousSync.settingsKey !== stageSettingsKey;
    if (!effectiveInputs.length) {
      const shouldClearStagedInput = previousSync.inputs.length > 0;
      inputStageSyncRef.current = {
        inputs: [],
        settingsKey: stageSettingsKey,
      };
      inputStageGenerationRef.current += 1;
      setInputStaging(false);
      setRomInputs([]);
      if (!shouldClearStagedInput) return;
      emitSessionTrace("input staging clear dispatched", {
        previousCount: previousSync.inputs.length,
      });
      void stageInput(createStageSnapshot(), {
        onChecksum: () => undefined,
        onProgress: () => undefined,
        onState: () => undefined,
      }).catch((error) => {
        const normalizedError = toError(error);
        emitSessionTrace("input staging clear failed", {
          message: normalizedError.message,
          name: normalizedError.name,
        });
        logUiError("Input staging clear failed", normalizedError);
        onError?.(normalizedError);
      });
      return;
    }
    if (!(inputsChanged || settingsChanged)) return;
    const previousInputs = previousSync.inputs.slice();
    inputStageSyncRef.current = {
      inputs: effectiveInputs.slice(),
      settingsKey: stageSettingsKey,
    };
    syncRomInput(createStageSnapshot(), previousInputs);
  }, [createStageSnapshot, effectiveInputs, emitSessionTrace, onError, stageInput, stageSettingsKey, syncRomInput]);

  useEffect(() => {
    if (!stagePatches) return;
    const previousSync = patchStageSyncRef.current;
    const inputsChanged = !sameBinarySourceLists(previousSync.inputs, effectiveInputs);
    const patchesChanged = !sameBinarySourceLists(previousSync.patches, activePatches);
    const settingsChanged = previousSync.settingsKey !== stageSettingsKey;
    if (!(inputsChanged || patchesChanged || settingsChanged)) return;
    if (!activePatches.length) {
      patchStageSyncRef.current = {
        inputs: effectiveInputs.slice(),
        patches: [],
        settingsKey: stageSettingsKey,
      };
      patchStageGenerationRef.current += 1;
      setPatchStaging(false);
      setPatchProgress(null);
      return;
    }
    patchStageSyncRef.current = {
      inputs: effectiveInputs.slice(),
      patches: activePatches.slice(),
      settingsKey: stageSettingsKey,
    };
    if (inputsChanged && !patchesChanged && !settingsChanged) return;
    syncPatchFiles(createStageSnapshot());
  }, [activePatches, createStageSnapshot, effectiveInputs, stagePatches, stageSettingsKey, syncPatchFiles]);

  const localUiStoreController = useLiveStoreController(localUiState);
  const localStackStoreController = useLiveStoreController(localStackState);
  const localOutputStoreController = useLiveStoreController(localOutputState);
  const localNoticeStoreController = useLiveStoreController(localNoticeState);

  const localUiController = useMemo(
    () => ({
      clearRomInput: () => {
        emitSessionTrace("clearRomInput requested", {
          previousCount: effectiveInputs.length,
        });
        updateInputs([]);
      },
      getState: localUiStoreController.getState,
      providePatchInputFiles: (fileList: FileList | BinarySource[] | null) => {
        const nextPatches = Array.from(fileList || []) as BinarySource[];
        patchStageGenerationRef.current += 1;
        setPatchProgress(null);
        setPatchProgressByKey({});
        setPatchStaging(false);
        setErrorMessage("");
        setOutputErrorMessage("");
        setProgress(null);
        updatePatches(nextPatches);
      },
      provideRomInputFile: (file: BinarySource | null) => {
        emitSessionTrace("provideRomInputFile requested", {
          existingCount: effectiveInputs.length,
          hasFile: !!file,
          source: file ? getTraceSourceSummary(file, "Input") : undefined,
        });
        if (!file) {
          updateInputs([]);
          return;
        }
        updateInputs([...effectiveInputs, file]);
      },
      provideRomInputFiles: (fileList: FileList | BinarySource[] | null) => {
        const providedInputs = Array.from(fileList || []) as BinarySource[];
        const nextInputs = [...effectiveInputs, ...providedInputs];
        emitSessionTrace("provideRomInputFiles requested", {
          existingCount: effectiveInputs.length,
          nextCount: nextInputs.length,
          providedCount: providedInputs.length,
          providedSources: getTraceSourceSummaries(providedInputs, "Input"),
        });
        updateInputs(nextInputs);
      },
      removeRomInput: (id: string) => {
        const index = romInputs.findIndex((entry) => entry.id === id);
        if (index === -1) return;
        emitSessionTrace("removeRomInput requested", {
          id,
          index,
          previousCount: effectiveInputs.length,
        });
        if (effectiveInputs.length === 1) updateInputs([]);
        else updateInputs(effectiveInputs.filter((_input, inputIndex) => inputIndex !== index));
      },
      setAlterHeader: (checked: boolean) => {
        updateSettings({
          ...activeSettings,
          compatibility: {
            ...activeSettings.compatibility,
            fixChecksum: checked,
          },
        });
      },
      setChdSplitBin: (checked: boolean) => {
        updateSettings({
          ...activeSettings,
          input: {
            ...activeSettings.input,
            chdSplitBin: checked,
          },
        });
      },
      setChecksumOverride: (checked: boolean) => {
        setChecksumOverrideChecked(checked);
      },
      subscribe: localUiStoreController.subscribe,
      toggleRomInputChecksums: (id: string) => {
        setRomInputs((current) =>
          current.map((entry) =>
            entry.id === id
              ? createRomInputRow({
                  ...entry,
                  info: { ...entry.info, checksumsExpanded: !entry.info.checksumsExpanded },
                })
              : entry,
          ),
        );
      },
    }),
    [
      activeSettings,
      effectiveInputs,
      emitSessionTrace,
      localUiStoreController,
      romInputs,
      setChecksumOverrideChecked,
      updateInputs,
      updatePatches,
      updateSettings,
    ],
  );
  const localStackController = useMemo(
    () => ({
      getState: localStackStoreController.getState,
      moveItem: (index: number, direction: number) => {
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= activePatches.length) return;
        const nextPatches = activePatches.slice();
        const [item] = nextPatches.splice(index, 1);
        if (!item) return;
        nextPatches.splice(nextIndex, 0, item);
        updatePatches(nextPatches);
      },
      removeItem: (index: number) => {
        updatePatches(activePatches.filter((_patch, patchIndex) => patchIndex !== index));
      },
      setPatchTarget: async (index: number, targetInputId: string) => {
        if (!setPatchTarget) return;
        try {
          const snapshot = createStageSnapshot();
          const infos = await setPatchTarget(snapshot, index, targetInputId);
          setPatchInfoByKey((current) => {
            const next = { ...current };
            for (const info of infos) {
              if (!info) continue;
              const patch = typeof info.order === "number" ? snapshot.patches[info.order] : undefined;
              const key = patch ? getPatchKey(patch, snapshot.patches) : info.id;
              if (key) next[key] = info;
            }
            return next;
          });
        } catch (error) {
          const normalizedError = toError(error);
          logUiError("Patch target selection failed", normalizedError);
          setErrorMessage(
            formatCodedErrorForDisplay(
              normalizedError,
              createBrowserLocalizer((activeSettings as { language?: string }).language),
            ),
          );
          onError?.(normalizedError);
        }
      },
      subscribe: localStackStoreController.subscribe,
    }),
    [
      activePatches,
      activeSettings,
      createStageSnapshot,
      getPatchKey,
      localStackStoreController,
      onError,
      setErrorMessage,
      setPatchInfoByKey,
      setPatchTarget,
      updatePatches,
    ],
  );
  const localOutputController = useMemo(
    () => ({
      getState: localOutputStoreController.getState,
      runPrimaryAction: async () => {
        if (busy) {
          cancelActiveOperation();
          return;
        }
        const pendingDownloadResult = pendingDownloadResultRef.current;
        if (pendingDownloadResult && hasPendingDownload) {
          await Promise.resolve(
            downloadOutput(
              pendingDownloadResult,
              pendingDownloadFileNameRef.current || pendingDownloadFileName || effectiveResolvedOutputName || "output",
            ),
          );
          return;
        }
        if (!canQueueApply) return;
        const useChecksumOverride = hasStrictInputChecksumMismatch && checksumOverrideChecked;
        if (useChecksumOverride) setChecksumOverrideChecked(false);
        const runtimeValidationSettings = useChecksumOverride
          ? {
              ...(activeSettings.validation || {}),
              requireInputChecksumMatch: false,
            }
          : activeSettings.validation;
        const abortController = new AbortController();
        rememberAbortController(abortController);
        setBusy(true);
        setErrorMessage("");
        setOutputErrorMessage("");
        invalidateCompletedOutputState();
        applyExecutionTimingRef.current = {
          applyStartedAt: Date.now(),
          compressionStartedAt: null,
        };
        setProgress(createIndeterminateWorkflowProgress({ label: "Applying patch...", stage: "apply" }));
        try {
          await waitForNextUiPaint();
          let clearedPatchRowProgress = false;
          const result = await applyPatches({
            inputs: effectiveInputs,
            options: {
              ...activeSettings,
              input: {
                ...activeSettings.input,
                containerInputsEnabled,
              },
              onProgress: (event) => {
                const details = getProgressDetails(event);
                if (details.stage === "compress" && applyExecutionTimingRef.current.compressionStartedAt === null) {
                  const now = Date.now();
                  applyExecutionTimingRef.current.compressionStartedAt = now;
                  if (typeof applyExecutionTimingRef.current.applyStartedAt === "number") {
                    setCompletedApplyTimeMs(Math.max(0, now - applyExecutionTimingRef.current.applyStartedAt));
                  }
                }
                if (details.role === "input" && details.stage !== "apply") {
                  const info = getStableInputInfo(getProgressStagedInputInfo(event), effectiveInputs);
                  if (info.id) {
                    mergeRomInput(info, {
                      ...getChecksumProgressInfoPatch(details),
                      progress: toInputProgress(event),
                    });
                  }
                } else if (details.role === "patch" && details.stage !== "apply") {
                  const order = typeof details.order === "number" ? details.order : -1;
                  const patch = (order >= 0 ? activePatches[order] : undefined) || activePatches[0] || null;
                  if (patch) {
                    const key = getPatchKey(patch);
                    setPatchProgressByKey((current) => ({
                      ...current,
                      [key]: toInputProgress(event),
                    }));
                    setPatchProgress(null);
                  } else {
                    setPatchProgress(toInputProgress(event));
                  }
                } else {
                  if (!clearedPatchRowProgress) {
                    setPatchProgressByKey({});
                    clearedPatchRowProgress = true;
                  }
                  setPatchProgress(null);
                  setProgress(toInputProgress(event));
                }
                onProgress?.(event);
              },
              output: {
                ...activeSettings.output,
                compression: requestedCompression,
                outputName: requestedOutputName,
              },
              signal: abortController.signal,
              validation: runtimeValidationSettings,
              workers: {
                ...activeSettings.workers,
                threads: resolvedWorkerThreads,
              },
            },
            patches: activePatches,
          });
          const completedAt = Date.now();
          const applyStartedAt = applyExecutionTimingRef.current.applyStartedAt;
          const compressionStartedAt = applyExecutionTimingRef.current.compressionStartedAt;
          const resolvedApplyTimeMs =
            typeof applyStartedAt === "number"
              ? Math.max(
                  0,
                  (typeof compressionStartedAt === "number" ? compressionStartedAt : completedAt) - applyStartedAt,
                )
              : null;
          const resolvedCompressionTimeMs =
            typeof compressionStartedAt === "number" ? Math.max(0, completedAt - compressionStartedAt) : null;
          setCompletedApplyTimeMs(resolvedApplyTimeMs);
          setCompletedCompressionTimeMs(resolvedCompressionTimeMs);
          setProgress({
            indeterminate: false,
            label: `Created ${result.output.fileName}`,
            message: `Created ${result.output.fileName}`,
            percent: 100,
          });
          setCompletedSizeSummary(
            createOutputSizeSummary({
              inputBytes: result.sizeSummary?.inputSize ?? result.rom.size,
              inputCompressedBytes: result.sizeSummary?.inputCompressedSize,
              inputDecompressionTimeMs: result.sizeSummary?.inputDecompressionTimeMs,
              outputBytes: result.sizeSummary?.outputSize ?? getPublicOutputSize(result.output),
              patchBytes: result.sizeSummary?.patchSize,
              patchCompressedBytes: result.sizeSummary?.patchCompressedSize,
              rawBytes: result.sizeSummary?.rawSize ?? getPublicOutputSize(result.output),
              showRatio:
                (result.sizeSummary?.rawSize ?? getPublicOutputSize(result.output)) !==
                (result.sizeSummary?.outputSize ?? getPublicOutputSize(result.output)),
            }),
          );
          rememberActiveOutputCleanup(
            result.outputs.length > 0
              ? async () => {
                  await Promise.all(result.outputs.map((output) => output.cleanup?.()));
                }
              : result.output.cleanup || null,
          );
          pendingDownloadResultRef.current = result;
          const initialDownloadFileName = result.output.fileName || effectiveResolvedOutputName || "output";
          setPendingDownloadReadyFileName(initialDownloadFileName);
          try {
            await Promise.resolve(downloadOutput(result, initialDownloadFileName));
          } catch (downloadError) {
            const normalizedDownloadError = toError(downloadError);
            logUiError("Output download failed", normalizedDownloadError);
            setOutputErrorMessage(
              formatCodedErrorForDisplay(
                normalizedDownloadError,
                createBrowserLocalizer((activeSettings as { language?: string }).language),
              ),
            );
            onError?.(normalizedDownloadError);
          }
          onApplyComplete?.(result);
        } catch (error) {
          const normalizedError = toError(error);
          logUiError("Apply workflow failed", normalizedError);
          setOutputErrorMessage(
            formatCodedErrorForDisplay(
              normalizedError,
              createBrowserLocalizer((activeSettings as { language?: string }).language),
            ),
          );
          resetCompletedOutputState();
          onError?.(normalizedError);
        } finally {
          if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
          applyExecutionTimingRef.current = {
            applyStartedAt: null,
            compressionStartedAt: null,
          };
          setPatchProgress(null);
          setPatchProgressByKey({});
          setBusy(false);
        }
      },
      setDisplayFileName: (value: string) => {
        const nextOutputName = getRequestedOutputName(value);
        setOutputName(value);
        setOutputNameEdited(!!nextOutputName);
        if (pendingDownloadResultRef.current && hasPendingDownload) {
          setPendingDownloadReadyFileName(
            resolvePendingDownloadFileName({
              automaticOutputName: automaticResolvedOutputName,
              fallbackOutputName: effectiveResolvedOutputName,
              requestedOutputName: nextOutputName,
              resultOutputName: pendingDownloadResultRef.current.output.fileName,
            }),
          );
        }
        commitSettings({
          ...activeSettings,
          output: { ...activeSettings.output, outputName: nextOutputName },
        });
      },
      setOutputCompression: (value: string) => {
        setOutputCompressionEdited(true);
        updateSettings({
          ...activeSettings,
          output: {
            ...activeSettings.output,
            compression: value as "auto" | CompressionFormat,
          },
        });
      },
      setOutputCompressOption: (key: string, value: string) => {
        // Per-job override of a flat compression setting (zipCodec, compressionProfile, …)
        // the run already reads; leaves the persisted Settings untouched.
        updateSettings({ ...activeSettings, [key]: value });
      },
      subscribe: localOutputStoreController.subscribe,
    }),
    [
      activePatches,
      activeSettings,
      automaticResolvedOutputName,
      containerInputsEnabled,
      applyPatches,
      cancelActiveOperation,
      commitSettings,
      downloadOutput,
      effectiveInputs,
      getPatchKey,
      invalidateCompletedOutputState,
      localOutputStoreController,
      busy,
      onApplyComplete,
      onError,
      onProgress,
      updateSettings,
      resolvedWorkerThreads,
      requestedOutputName,
      activeCompression,
      canQueueApply,
      checksumOverrideChecked,
      effectiveResolvedOutputName,
      hasPendingDownload,
      hasStrictInputChecksumMismatch,
      mergeRomInput,
      pendingDownloadFileName,
      rememberAbortController,
      rememberActiveOutputCleanup,
      setPendingDownloadReadyFileName,
      setChecksumOverrideChecked,
    ],
  );
  const localNoticeController = useMemo(
    (): NoticeController => ({
      getState: localNoticeStoreController.getState,
      subscribe: localNoticeStoreController.subscribe,
    }),
    [localNoticeStoreController],
  );

  return {
    localNoticeController,
    localOutputController,
    localStackController,
    localUiController,
  };
};

export {
  getGeneratedOutputName,
  getRequestedOutputName,
  inertDialogController,
  inertOutputController,
  inertStackController,
  inertUiController,
  useLocalApplyPatchFormSession,
};
