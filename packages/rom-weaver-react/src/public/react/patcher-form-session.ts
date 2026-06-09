import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
} from "../../lib/compression/container-format-registry.ts";
import { emitTraceLog } from "../../lib/logging.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { formatCodedErrorForDisplay } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult } from "../../types/workflow-runtime.ts";
import {
  inertDialogController,
  inertOutputController,
  inertStackController,
  inertUiController,
  useLiveStoreController,
} from "./apply-session-controllers.ts";
import {
  createRomInputRow,
  formatOperationTiming,
  getPendingInputDisplayFileName,
  getStagedDecompressionTimeMs,
  resolveMergedRomFileName,
  sortRomInputs,
  sumStagedInfoSize,
} from "./apply-session-inputs.ts";
import { getTraceSourceSummaries, logUiError } from "./apply-session-logging.ts";
import { createStageSettingsKey, getLegacyCompressionWorkerThreads } from "./apply-session-settings.ts";
import {
  hasSameRecordValues,
  useStableSourceKeys,
  useStageGenerationMachine,
} from "./apply-session-staging-state-machine.ts";
import { useLocalPatcherSessionState } from "./apply-session-state.ts";
import type {
  ApplyExecutionTimingTracker,
  ApplyWorkflowStageSnapshot,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "./apply-session-types.ts";
import { getBinarySourceListStableIds, getBinarySourceSize, sameBinarySourceLists } from "./input-session-helpers.ts";
import { combineSectionTimingText, createSectionSizeText, getGeneratedOutputName } from "./output-view-model.ts";
import type { ApplyPatchFormSettings, BinarySource, NoticeController } from "./patcher-form.ts";
import {
  formatElapsedTiming,
  getLogicalRomInputCount,
  getMultiInputOutputError,
  getRequestedOutputName,
  isWorkflowDisposedError,
  resolvePendingDownloadFileName,
  toError,
} from "./patcher-form-session-utils.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, NoticeState, RomInputRowState } from "./patcher-ui-state.ts";
import {
  buildNoticeViewState,
  buildOutputViewState,
  buildStackViewState,
  buildUiViewState,
} from "./patcher-view-models.ts";
import { useApplyDownloadOrchestration } from "./use-apply-download-orchestration.ts";
import { useCompressionResolver } from "./use-compression-resolver.ts";
import { useInputStaging } from "./use-input-staging.ts";
import { useInputUiController, usePatchStackController } from "./use-patcher-controllers.ts";
import { useActiveAbortController, useDisposableCleanup } from "./workflow-run-hooks.ts";

const createSettingsIdentityKey = (settings: ApplyPatchFormSettings) =>
  JSON.stringify(settings, (_key, value) => (typeof value === "function" ? "[function]" : value));

const DEFAULT_COMPRESSION_OPTIONS = [
  "none",
  ...CREATE_ARCHIVE_COMPRESSION_FORMATS,
  ...CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
];

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
  compressionOptions = DEFAULT_COMPRESSION_OPTIONS,
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
  setPatchOption,
}: LocalApplyPatchFormSessionOptions) => {
  const [internalInputs, setInternalInputs] = useState(defaultInputs);
  const [internalPatches, setInternalPatches] = useState(defaultPatches);
  const [internalSettings, setInternalSettings] = useState<ApplyPatchFormSettings>(defaultSettings);
  const defaultSettingsKey = useMemo(() => createSettingsIdentityKey(defaultSettings), [defaultSettings]);
  const appliedDefaultSettingsKeyRef = useRef(defaultSettingsKey);
  const [checksumOverrideChecked, setChecksumOverrideChecked] = useState(false);
  const session = useLocalPatcherSessionState();
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
  } = session;
  const [outputCompressionEdited, setOutputCompressionEdited] = useState(false);
  const [failurePlacement, setFailurePlacement] = useState<"input" | "output" | "patch" | null>(null);
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
  const [applyQueued, setApplyQueued] = useState(false);
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
  const inputStageMachine = useStageGenerationMachine();
  const inputStageSyncRef = useRef<{ inputs: BinarySource[]; settingsKey: string }>({
    inputs: [],
    settingsKey: "",
  });
  const patchStageMachine = useStageGenerationMachine();
  const patchStageSyncRef = useRef<{
    inputs: BinarySource[];
    patches: BinarySource[];
    settingsKey: string;
  }>({
    inputs: [],
    patches: [],
    settingsKey: "",
  });
  const effectiveInputs = inputs === undefined ? internalInputs : inputs;
  const activePatches = patches === undefined ? internalPatches : patches;
  const activeSettings = settings === undefined ? internalSettings : settings;
  const emitSessionTrace = useCallback(
    (message: string, details?: Record<string, unknown>) =>
      emitTraceLog(
        {
          logLevel: activeSettings.logging?.level,
          namespace: "ui:apply-session",
          onLog: activeSettings.logging?.sink,
        },
        message,
        details,
      ),
    [activeSettings],
  );
  const {
    activeCompression,
    displayedCompression,
    effectiveActiveCompression,
    outputOptions,
    requestedCompression,
    selectedOutputOptionLabel,
    z3dsLabelSource,
  } = useCompressionResolver({
    activeSettings,
    compressionOptions,
    effectiveInputs,
    outputCompressionEdited,
    resolvedOutputCompression,
    romInputs,
  });
  const formatSessionError = useCallback(
    (error: Error) =>
      formatCodedErrorForDisplay(error, createBrowserLocalizer((activeSettings as { language?: string }).language)),
    [activeSettings],
  );
  const setSectionErrorMessage = useCallback(
    (placement: "input" | "output" | "patch", error: Error) => {
      setFailurePlacement(placement);
      setErrorMessage(formatSessionError(error));
    },
    [formatSessionError, setErrorMessage],
  );
  const clearDismissibleErrors = useCallback(() => {
    setFailurePlacement(null);
    setErrorMessage("");
    setOutputErrorMessage("");
  }, [setErrorMessage, setOutputErrorMessage]);
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
    if (appliedDefaultSettingsKeyRef.current === defaultSettingsKey) return;
    appliedDefaultSettingsKeyRef.current = defaultSettingsKey;
    setInternalSettings(defaultSettings);
  }, [defaultSettings, defaultSettingsKey, settings]);

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
  const { getKey: getInputKey } = useStableSourceKeys(effectiveInputs, "input");
  const { getKey: getPatchKey } = useStableSourceKeys(activePatches, "patch");
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
  const strictInputChecksumValidation = activeSettings.validation?.requireInputChecksumMatch === true;
  const hasStrictInputChecksumMismatch =
    strictInputChecksumValidation && stagedPatchInfos.some((info) => info.checksumPreflightMismatch === true);
  const strictInputChecksumBlocked = hasStrictInputChecksumMismatch && !checksumOverrideChecked;
  const multiInputOutputError = getMultiInputOutputError(displayedCompression, getLogicalRomInputCount(romInputs));
  const inputNoticeMessage = failurePlacement === "input" ? failureMessage : "";
  const patchNoticeMessage = failurePlacement === "patch" ? failureMessage : "";
  const outputRuntimeNoticeMessage = outputErrorMessage || (failurePlacement === "output" ? failureMessage : "");
  const effectiveOutputNoticeMessage = outputRuntimeNoticeMessage || multiInputOutputError;
  const applyPreparationPending =
    inputStaging ||
    patchStaging ||
    !!patchProgress ||
    Object.keys(patchProgressByKey).length > 0 ||
    romInputs.some((entry) => entry.loading || !!entry.progress);
  const patchValidationBlocked = stagedPatchInfos.some(
    (info) => info.validationState === "invalid" && info.checksumPreflightMismatch !== true,
  );
  const applyQueueBlocked =
    !!failureMessage || !!outputErrorMessage || strictInputChecksumBlocked || patchValidationBlocked;
  const canQueueApply = !!effectiveInputs.length && !multiInputOutputError;
  const canStartApply = canQueueApply && applyReady && !applyQueueBlocked && !applyPreparationPending;
  const disposeActiveOutput = useCallback(() => {
    clearPendingDownload();
    disposeActiveOutputCleanup();
  }, [clearPendingDownload, disposeActiveOutputCleanup]);

  const clearActiveApplyProgress = useCallback(() => {
    setProgress(null);
    setPatchProgress(null);
    setPatchProgressByKey({});
    setRomInputs((current) =>
      current.map((entry) =>
        entry.progress || entry.loading
          ? createRomInputRow({
              ...entry,
              disabled: disabledRef.current,
              loading: false,
              progress: null,
            })
          : entry,
      ),
    );
  }, [setPatchProgress, setPatchProgressByKey, setProgress, setRomInputs]);

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
      return hasSameRecordValues(current, nextInfoByKey) ? current : nextInfoByKey;
    });
    setPatchProgressByKey((current) => {
      const nextProgressByKey: Record<string, InputProgress> = {};
      for (const patch of activePatches) {
        const key = getPatchKey(patch, activePatches);
        if (current[key]) nextProgressByKey[key] = current[key];
      }
      return hasSameRecordValues(current, nextProgressByKey) ? current : nextProgressByKey;
    });
  }, [activePatches, getPatchKey]);

  useEffect(() => {
    if (hasStrictInputChecksumMismatch) return;
    setChecksumOverrideChecked(false);
  }, [hasStrictInputChecksumMismatch]);

  const localUiState = useMemo(
    () =>
      buildUiViewState({
        activePatches,
        activeSettings,
        busy,
        checksumOverrideChecked,
        disabled,
        effectiveInputs,
        effectiveOutputNoticeMessage,
        hasStrictInputChecksumMismatch,
        inputNoticeMessage,
        inputStaging,
        outputRuntimeNoticeMessage,
        patchNoticeMessage,
        patchProgress,
        patchProgressByKey,
        patchStaging,
        primaryRomInput,
        romInputs,
        sectionTimings: localPatcherSectionTimings,
      }),
    [
      activePatches.length,
      busy,
      checksumOverrideChecked,
      disabled,
      effectiveInputs,
      inputStaging,
      hasStrictInputChecksumMismatch,
      localPatcherSectionTimings,
      effectiveOutputNoticeMessage,
      inputNoticeMessage,
      outputRuntimeNoticeMessage,
      patchProgress,
      patchProgressByKey,
      patchStaging,
      patchNoticeMessage,
      primaryRomInput,
      romInputs,
    ],
  );
  const localStackState = useMemo(
    () =>
      buildStackViewState({
        activePatches,
        busy,
        disabled,
        getPatchKey,
        patchInfoByKey,
        patchProgressByKey,
        patchStaging,
        romInputs,
      }),
    [activePatches, busy, disabled, getPatchKey, patchInfoByKey, patchProgressByKey, patchStaging, romInputs],
  );
  const localOutputState = useMemo(
    () =>
      buildOutputViewState({
        activeSettings,
        applyQueued,
        applyTimingText,
        busy,
        canQueueApply,
        completedSizeSummary,
        compressTimingText,
        disabled,
        displayedCompression,
        effectiveResolvedOutputName,
        hasPendingDownload,
        outputName,
        outputNameEdited,
        outputOptions,
        pendingDownloadFileName,
        progress,
        selectedOutputOptionLabel,
        z3dsLabelSource,
      }),
    [
      activePatches.length,
      applyQueued,
      activeSettings,
      applyTimingText,
      busy,
      canQueueApply,
      canStartApply,
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
      z3dsLabelSource,
    ],
  );
  const localNoticeState = useMemo<NoticeState>(
    () => buildNoticeViewState({ failureMessage, failurePlacement }),
    [failureMessage, failurePlacement],
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
      setApplyQueued(false);
      clearDismissibleErrors();
      invalidateCompletedOutputState();
      if (settings === undefined) setInternalSettings(nextSettings);
      onSettingsChange?.(nextSettings);
    },
    [clearDismissibleErrors, invalidateCompletedOutputState, onSettingsChange, setChecksumOverrideChecked, settings],
  );
  const commitSettings = useCallback(
    (nextSettings: ApplyPatchFormSettings) => {
      setChecksumOverrideChecked(false);
      setApplyQueued(false);
      clearDismissibleErrors();
      if (settings === undefined) setInternalSettings(nextSettings);
      onSettingsChange?.(nextSettings);
    },
    [clearDismissibleErrors, onSettingsChange, setChecksumOverrideChecked, settings],
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
      clearDismissibleErrors();
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
    [
      clearDismissibleErrors,
      getPatchKey,
      invalidateCompletedOutputState,
      onPatchesChange,
      patches,
      setChecksumOverrideChecked,
    ],
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
          chdMode: info.chdMode ?? patch.chdMode ?? existing.chdMode,
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
      const { generation, progressGeneration } = inputStageMachine.nextRunGeneration();
      emitSessionTrace("input list updated", {
        generation,
        nextCount: nextInputs.length,
        previousCount: effectiveInputs.length,
        progressGeneration,
        sources: getTraceSourceSummaries(nextInputs, "Input"),
      });
      if (inputs === undefined) setInternalInputs(nextInputs);
      onInputsChange?.(nextInputs);
      clearDismissibleErrors();
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
              loading: existing?.loading ?? false,
              order: index,
              progress: existing?.progress || null,
              size: existing?.size ?? getBinarySourceSize(input) ?? undefined,
              sourceSize: existing?.sourceSize ?? getBinarySourceSize(input) ?? undefined,
              valid: existing?.valid ?? false,
            });
          }),
        );
      });
      return generation;
    },
    [
      effectiveInputs.length,
      clearDismissibleErrors,
      emitSessionTrace,
      getInputKey,
      inputStageMachine,
      invalidateCompletedOutputState,
      inputs,
      onInputsChange,
      setChecksumOverrideChecked,
    ],
  );
  const { syncPatchFiles, syncRomInput } = useInputStaging({
    machines: { inputStageMachine, patchStageMachine },
    refs: { busyRef, disabledRef },
    report: { emitSessionTrace, onError, setSectionErrorMessage },
    rows: { getInputKey, getPatchKey, getStableInputInfo, mergeRomInput, updatePatches },
    session: {
      setInputStaging,
      setPatchInfoByKey,
      setPatchProgress,
      setPatchProgressByKey,
      setPatchStaging,
      setRomInputs,
    },
    stage: { stageInput, stagePatches },
  });

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
      inputStageMachine.invalidateStage();
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
        if (isWorkflowDisposedError(normalizedError)) return;
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
  }, [
    createStageSnapshot,
    effectiveInputs,
    emitSessionTrace,
    inputStageMachine,
    onError,
    stageInput,
    stageSettingsKey,
    syncRomInput,
  ]);

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
      patchStageMachine.invalidateStage();
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
  }, [
    activePatches,
    createStageSnapshot,
    effectiveInputs,
    patchStageMachine,
    stagePatches,
    stageSettingsKey,
    syncPatchFiles,
  ]);

  const localUiStoreController = useLiveStoreController(localUiState);
  const localStackStoreController = useLiveStoreController(localStackState);
  const localOutputStoreController = useLiveStoreController(localOutputState);
  const localNoticeStoreController = useLiveStoreController(localNoticeState);

  const inputUiActions = useInputUiController({
    actions: {
      clearDismissibleErrors,
      emitSessionTrace,
      invalidatePatchStage: patchStageMachine.invalidateStage,
      setChecksumOverrideChecked,
      setErrorMessage,
      setFailurePlacement,
      setOutputErrorMessage,
      setPatchProgress,
      setPatchProgressByKey,
      setPatchStaging,
      setProgress,
      setRomInputs,
      updateInputs,
      updatePatches,
      updateSettings,
    },
    state: { activeSettings, effectiveInputs, failurePlacement, outputErrorMessage, romInputs },
  });
  const localUiController = useMemo(
    () => ({
      ...inputUiActions,
      getState: localUiStoreController.getState,
      subscribe: localUiStoreController.subscribe,
    }),
    [inputUiActions, localUiStoreController],
  );
  const patchStackActions = usePatchStackController({
    actions: {
      createStageSnapshot,
      getPatchKey,
      onError,
      setPatchInfoByKey,
      setPatchOption,
      setPatchTarget,
      setSectionErrorMessage,
      updatePatches,
    },
    state: { activePatches },
  });
  const localStackController = useMemo(
    () => ({
      ...patchStackActions,
      getState: localStackStoreController.getState,
      subscribe: localStackStoreController.subscribe,
    }),
    [patchStackActions, localStackStoreController],
  );
  const applyDownloadOrchestration = useApplyDownloadOrchestration({
    lifecycle: {
      cancelActiveOperation,
      clearActiveApplyProgress,
      clearDismissibleErrors,
      disposeActiveOutput,
      getPatchKey,
      getStableInputInfo,
      invalidateCompletedOutputState,
      mergeRomInput,
      rememberAbortController,
      rememberActiveOutputCleanup,
      resetCompletedOutputState,
      setApplyQueued,
      setChecksumOverrideChecked,
      setPendingDownloadReadyFileName,
    },
    refs: {
      activeAbortControllerRef,
      applyExecutionTimingRef,
      pendingDownloadFileNameRef,
      pendingDownloadResultRef,
    },
    request: {
      activePatches,
      activeSettings,
      applyQueueBlocked,
      busy,
      canQueueApply,
      canStartApply,
      checksumOverrideChecked,
      containerInputsEnabled,
      effectiveInputs,
      effectiveResolvedOutputName,
      hasPendingDownload,
      hasStrictInputChecksumMismatch,
      pendingDownloadFileName,
      requestedCompression,
      requestedOutputName,
      resolvedWorkerThreads,
    },
    session,
    workflow: { applyPatches, downloadOutput, onApplyComplete, onError, onProgress },
  });
  const localOutputController = useMemo(
    () => ({
      ...applyDownloadOrchestration,
      getState: localOutputStoreController.getState,
      setDisplayFileName: (value: string) => {
        const nextOutputName = getRequestedOutputName(value);
        clearDismissibleErrors();
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
      setOutputCompressOption: (key: string, value: string, updates?: Record<string, string>) => {
        // Per-job override of a flat compression setting (zipCodec, compressionProfile, …)
        // the run already reads; leaves the persisted Settings untouched.
        updateSettings({ ...activeSettings, ...(updates || { [key]: value }) });
      },
      subscribe: localOutputStoreController.subscribe,
    }),
    [
      activeSettings,
      applyDownloadOrchestration,
      automaticResolvedOutputName,
      clearDismissibleErrors,
      commitSettings,
      effectiveResolvedOutputName,
      hasPendingDownload,
      localOutputStoreController,
      setPendingDownloadReadyFileName,
      updateSettings,
    ],
  );
  useEffect(() => {
    if (!applyQueued) return;
    if (busy || hasPendingDownload) {
      setApplyQueued(false);
      return;
    }
    if (!canQueueApply || applyQueueBlocked) {
      setApplyQueued(false);
      return;
    }
    if (!canStartApply) return;
    void localOutputController.runPrimaryAction();
  }, [applyQueued, applyQueueBlocked, busy, canQueueApply, canStartApply, hasPendingDownload, localOutputController]);
  const localNoticeController = useMemo(
    (): NoticeController => ({
      dismiss: () => {
        setFailurePlacement(null);
        setErrorMessage("");
      },
      getState: localNoticeStoreController.getState,
      subscribe: localNoticeStoreController.subscribe,
    }),
    [localNoticeStoreController, setErrorMessage],
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
