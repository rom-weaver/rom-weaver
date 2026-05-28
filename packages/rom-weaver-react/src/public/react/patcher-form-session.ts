import { type SetStateAction, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { classifyPatcherInput } from "../../lib/input/input-classification.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { formatCodedErrorForDisplay } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime.ts";
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
  type OutputOptionLabelMap,
} from "./output-view-model.ts";
import type {
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  BinarySource,
  DialogController,
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StackPatchItem,
} from "./patcher-form.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, NoticeState, PatcherUiSessionState, RomInputRowState } from "./patcher-ui-state.ts";
import { createInertPatcherUiSessionState } from "./patcher-ui-state.ts";

type PatcherUiState = PatcherUiSessionState;
type ArchivePathEntry = {
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};
type StagedInputInfo = {
  id?: string;
  order?: number;
  groupId?: string;
  archiveName?: string;
  parentCompressions?: ArchivePathEntry[];
  targetLabel?: string;
  checksums?: Record<string, string>;
  checksumTiming?: string;
  decompressionTimeMs?: number;
  fileName?: string;
  size?: number;
  sourceSize?: number;
  wasDecompressed?: boolean;
};
type ApplyWorkflowStageSnapshot = {
  inputs: BinarySource[];
  patches: BinarySource[];
  options: ApplyPatchFormSettings & {
    output: NonNullable<ApplyPatchFormSettings["output"]> & {
      compression: "auto" | CompressionFormat;
    };
    workerThreads?: number | string;
    containerInputsEnabled?: boolean;
  };
};
type ApplyExecutionTimingTracker = {
  applyStartedAt: number | null;
  compressionStartedAt: number | null;
};
type LocalPatcherSessionState = {
  busy: boolean;
  completedApplyTimeMs: number | null;
  completedCompressionTimeMs: number | null;
  completedSizeSummary: ReturnType<typeof createOutputSizeSummary>;
  failureMessage: string;
  inputStaging: boolean;
  outputErrorMessage: string;
  outputName: string;
  outputNameEdited: boolean;
  patchInfoByKey: Record<string, StagedInputInfo>;
  patchProgress: InputProgress | null;
  patchProgressByKey: Record<string, InputProgress>;
  patchStaging: boolean;
  pendingDownloadFileName: string | null;
  progress: InputProgress | null;
  romInputs: RomInputRowState[];
};
type LocalPatcherSessionStatePatch =
  | Partial<LocalPatcherSessionState>
  | ((state: LocalPatcherSessionState) => Partial<LocalPatcherSessionState>);

const getPublicOutputSize = (output: { size?: number }) => output.size || 0;

const waitForNextUiPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(() => resolve(), 0);
  });

const isTraceLoggingEnabled = (settings: ApplyPatchFormSettings) =>
  String(settings.logging?.level || "").toLowerCase() === "trace";

const getTraceSourceKind = (source: unknown) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  if (
    source &&
    typeof source === "object" &&
    "getFile" in source &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  )
    return "file-handle";
  if (source && typeof source === "object") return "object";
  return typeof source;
};

const getTraceSourceSummary = (source: unknown, fallback: string) => ({
  fileName: getBinarySourceFileName(source as BinarySource, fallback),
  kind: getTraceSourceKind(source),
  size: getBinarySourceSize(source as BinarySource) ?? undefined,
});

const getTraceSourceSummaries = (sources: BinarySource[], fallbackPrefix: string) =>
  sources.map((source, index) => getTraceSourceSummary(source, `${fallbackPrefix} ${index + 1}`));

const createLocalPatcherSessionState = (): LocalPatcherSessionState => ({
  busy: false,
  completedApplyTimeMs: null,
  completedCompressionTimeMs: null,
  completedSizeSummary: createOutputSizeSummary(),
  failureMessage: "",
  inputStaging: false,
  outputErrorMessage: "",
  outputName: "",
  outputNameEdited: false,
  patchInfoByKey: {},
  patchProgress: null,
  patchProgressByKey: {},
  patchStaging: false,
  pendingDownloadFileName: null,
  progress: null,
  romInputs: [],
});

const localPatcherSessionStateReducer = (
  state: LocalPatcherSessionState,
  patch: LocalPatcherSessionStatePatch,
): LocalPatcherSessionState => ({
  ...state,
  ...(typeof patch === "function" ? patch(state) : patch),
});

const resolveLocalStateUpdate = <T>(current: T, update: SetStateAction<T>): T =>
  typeof update === "function" ? (update as (current: T) => T)(current) : update;

const toError = (error: RuntimeValue): Error => (error instanceof Error ? error : new Error(String(error)));

const getErrorLogDetails = (error: Error): Record<string, unknown> => {
  const coded = error as Error & { cause?: unknown; code?: unknown; details?: unknown };
  const cause = coded.cause;
  return {
    cause:
      cause instanceof Error
        ? {
            message: cause.message,
            name: cause.name,
            stack: cause.stack,
          }
        : cause,
    code: typeof coded.code === "string" ? coded.code : undefined,
    details: coded.details,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
};

const logUiError = (context: string, error: Error) => {
  try {
    console.error(`[RomWeaver UI] ${context}: ${error.message}`, getErrorLogDetails(error), error);
  } catch (_logError) {
    // Ignore console failures; the UI still surfaces the normalized message.
  }
};

const getRequestedOutputName = (outputName: string): string | undefined => {
  const normalizedOutputName = outputName.trim();
  return normalizedOutputName || undefined;
};

const getLegacyCompressionWorkerThreads = (settings: ApplyPatchFormSettings): number | string | undefined => {
  const legacyThreads = (settings as { compression?: { workerThreads?: unknown } }).compression?.workerThreads;
  if (typeof legacyThreads === "number" || typeof legacyThreads === "string") return legacyThreads;
  return undefined;
};

const createStageSettingsKey = ({
  containerInputsEnabled,
  settings,
  workerThreads,
}: {
  containerInputsEnabled: boolean;
  settings: ApplyPatchFormSettings;
  workerThreads?: number | string;
}) =>
  JSON.stringify(
    {
      ...settings,
      input: {
        ...settings.input,
        containerInputsEnabled,
      },
      output: {
        ...(settings.output || {}),
        compression: undefined,
        outputName: undefined,
      },
      workerThreads,
    },
    (_key, value) => (typeof value === "function" ? "[function]" : value),
  );

const createRomInputRow = (
  partial: Omit<Partial<RomInputRowState>, "info"> & {
    id: string;
    order?: number;
    info?: Partial<RomInputRowState["info"]>;
  },
): RomInputRowState => ({
  ...createInertPatcherUiSessionState().romInput,
  ...partial,
  groupId: partial.groupId || "",
  id: partial.id,
  info: {
    archiveName: "",
    checksumsExpanded: true,
    checksumTiming: "",
    crc32: "",
    fileName: "",
    md5: "",
    romInfo: "",
    sha1: "",
    validationPhase: "idle",
    ...(partial.info || {}),
  },
  order: partial.order ?? 0,
});

const sortRomInputs = (rows: RomInputRowState[]) =>
  rows.toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));

const getMultiInputOutputError = (compression: string, logicalInputCount: number) => {
  if (logicalInputCount <= 1) return "";
  if (compression === "7z" || compression === "zip") return "";
  if (compression === "none") {
    return "output.compression: 'none' cannot be used for multi-file output; use output.compression: 'zip' with zipCodec: 'store'";
  }
  return `output.compression: '${compression}' cannot be used for multi-file output; use output.compression: 'zip' or '7z'`;
};

const getProgressDetails = (event: ProgressEvent): Record<string, unknown> =>
  event.details && typeof event.details === "object" && !Array.isArray(event.details)
    ? (event.details as Record<string, unknown>)
    : {};

const getArchivePathEntriesFromProgressDetails = (details: Record<string, unknown>): ArchivePathEntry[] => {
  const parentCompressions = Array.isArray(details.parentCompressions) ? details.parentCompressions : [];
  return parentCompressions
    .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}))
    .sort((left, right) => Number(left.depth || 0) - Number(right.depth || 0))
    .map((entry) => ({
      decompressionTimeMs:
        typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)
          ? entry.decompressionTimeMs
          : undefined,
      fileName: typeof entry.fileName === "string" ? entry.fileName : "",
      outputSize:
        typeof entry.outputSize === "number" && Number.isFinite(entry.outputSize) ? entry.outputSize : undefined,
      sourceSize:
        typeof entry.sourceSize === "number" && Number.isFinite(entry.sourceSize) ? entry.sourceSize : undefined,
    }))
    .filter((entry) => !!entry.fileName);
};

const getArchiveNameFromProgressDetails = (details: Record<string, unknown>) => {
  const archivePathEntries = getArchivePathEntriesFromProgressDetails(details);
  return archivePathEntries.map((entry) => entry.fileName).join(" > ");
};

const getProgressStagedInputInfo = (event: ProgressEvent): StagedInputInfo => {
  const details = getProgressDetails(event);
  const fileName = typeof details.fileName === "string" ? details.fileName : "";
  const isPreparedFileName = details.wasDecompressed === true || details.stage === "checksum";
  return {
    archiveName: getArchiveNameFromProgressDetails(details),
    decompressionTimeMs: typeof details.decompressionTimeMs === "number" ? details.decompressionTimeMs : undefined,
    fileName: getInputDisplayFileName(fileName, isPreparedFileName),
    id: typeof details.sourceId === "string" ? details.sourceId : "",
    order: typeof details.order === "number" ? details.order : undefined,
    parentCompressions: getArchivePathEntriesFromProgressDetails(details),
    size: typeof details.size === "number" ? details.size : undefined,
    sourceSize: typeof details.sourceSize === "number" ? details.sourceSize : undefined,
    wasDecompressed: typeof details.wasDecompressed === "boolean" ? details.wasDecompressed : undefined,
  };
};

const getChecksumProgressInfoPatch = (
  details: Record<string, unknown>,
): Omit<Partial<RomInputRowState>, "info"> & { info?: Partial<RomInputRowState["info"]> } => {
  const isChecksum = details.stage === "checksum";
  const info: Partial<RomInputRowState["info"]> = {
    crc32: isChecksum ? "" : undefined,
    md5: isChecksum ? "" : undefined,
    sha1: isChecksum ? "" : undefined,
    validationPhase: isChecksum ? "checksum" : "idle",
  };
  return {
    disabled: true,
    info,
    loading: true,
  };
};

const isCompressedInputFileName = (fileName: string) => {
  if (!fileName) return false;
  try {
    return classifyPatcherInput({ fileName }).kind === "compression";
  } catch (_error) {
    return false;
  }
};

const getInputDisplayFileName = (fileName: string | undefined, prepared = false) => {
  const normalized = String(fileName || "");
  if (!normalized) return "";
  return !prepared && isCompressedInputFileName(normalized) ? "" : normalized;
};

const getPendingInputDisplayFileName = (input: BinarySource, fallback: string) =>
  getInputDisplayFileName(getBinarySourceFileName(input, fallback));

const archiveNameIncludesFileName = (archiveName: string, fileName: string) =>
  archiveName
    .split(" > ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(fileName);

const resolveMergedRomFileName = ({
  archiveName,
  existingFileName,
  nextFileName,
}: {
  archiveName: string;
  existingFileName: string;
  nextFileName: string | undefined;
}) => {
  if (!nextFileName) return existingFileName;
  if (
    existingFileName &&
    existingFileName !== nextFileName &&
    archiveNameIncludesFileName(archiveName, nextFileName) &&
    !archiveNameIncludesFileName(archiveName, existingFileName)
  ) {
    return existingFileName;
  }
  return nextFileName;
};

const sumStagedInfoSize = (infos: StagedInputInfo[], key: "size" | "sourceSize") => {
  let total = 0;
  let found = false;
  for (const info of infos) {
    const value = info[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
};

const getStagedDecompressionTimeMs = (infos: StagedInputInfo[]) => {
  if (!infos.some((info) => info.wasDecompressed)) return null;
  let total = 0;
  let found = false;
  for (const info of infos) {
    const elapsedMs = info.decompressionTimeMs;
    if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs)) {
      total += elapsedMs;
      found = true;
    }
  }
  return found ? total : null;
};

const formatOperationTiming = (label: string, elapsedMs: number | null) => {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  return `${label}: ${formatTiming(createTiming(elapsedMs))}`;
};

const createInertState = (): PatcherUiState => createInertPatcherUiSessionState();
const createStaticStoreController = <State>(state: State) => ({
  getState: () => state,
  subscribe: () => () => undefined,
});
const Z3DS_LABEL_BY_OUTPUT_EXTENSION: Record<string, string> = {
  z3ds: "Z3DS",
  z3dsx: "Z3DSX",
  zcci: "ZCCI",
  zcia: "ZCIA",
  zcxi: "ZCXI",
};
const getZ3dsOutputOptionLabel = (source: BinarySource | undefined) => {
  if (!source) return "Z3DS";
  try {
    const outputName = OutputCompressionManager.getCompressedFileName(source, "z3ds", {});
    const extension = OutputCompressionManager.getExtension({ fileName: outputName });
    return Z3DS_LABEL_BY_OUTPUT_EXTENSION[extension] || "Z3DS";
  } catch (_error) {
    return "Z3DS";
  }
};
const useLiveStoreController = <State>(state: State) => {
  const stateRef = useRef(state);
  const listenersRef = useRef(new Set<() => void>());

  stateRef.current = state;

  useEffect(() => {
    stateRef.current = state;
    for (const listener of listenersRef.current) listener();
  }, [state]);

  const getState = useCallback(() => stateRef.current, []);
  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  return useMemo(() => ({ getState, subscribe }), [getState, subscribe]);
};

const inertState = createInertState();

const inertUiController: PatcherUiController = createStaticStoreController(inertState);
const inertDialogController: DialogController = createStaticStoreController(inertState);
const inertStackController: PatcherStackController = {
  ...createStaticStoreController({ items: [] }),
  moveItem: () => undefined,
  removeItem: () => undefined,
};
const inertOutputController: PatcherOutputController = {
  ...createStaticStoreController({
    applyButton: {
      disabled: true,
      label: "Apply patch",
      loading: false,
      progress: null,
      title: "",
    },
    compressionFormat: "7z",
    disabled: true,
    displayFileName: "",
    options: [],
    pendingDownloadFileName: null,
    resolvedOutputName: "",
    sizeSummary: createOutputSizeSummary(),
  }),
  runPrimaryAction: () => undefined,
  setDisplayFileName: () => undefined,
  setOutputCompression: () => undefined,
};

type LocalApplyPatchFormSessionOptions = Pick<
  ApplyPatchFormProps,
  | "inputs"
  | "patches"
  | "settings"
  | "defaultInputs"
  | "defaultPatches"
  | "defaultSettings"
  | "disabled"
  | "workerThreads"
  | "containerInputsEnabled"
  | "compressionOptions"
  | "onInputsChange"
  | "onPatchesChange"
  | "onSettingsChange"
  | "onProgress"
  | "onApplyComplete"
  | "onError"
> & {
  applyPatches: (input: {
    inputs: BinarySource[];
    patches: BinarySource[];
    options: ApplyPatchFormSettings & {
      output: NonNullable<ApplyPatchFormSettings["output"]> & {
        compression: "auto" | CompressionFormat;
      };
      signal?: AbortSignal;
      workerThreads?: number | string;
      containerInputsEnabled?: boolean;
      onProgress: (event: ProgressEvent) => void;
    };
  }) => Promise<ApplyWorkflowResult>;
  downloadOutput: (result: ApplyWorkflowResult) => void | Promise<void>;
  applyReady?: boolean;
  resolvedOutputCompression?: CompressionFormat;
  resolvedOutputName?: string;
  stageInput?: (
    input: ApplyWorkflowStageSnapshot,
    handlers: {
      onChecksum: (info: StagedInputInfo) => void;
      onProgress: (event: ProgressEvent) => void;
      onState: (info: StagedInputInfo) => void;
    },
  ) => Promise<StagedInputInfo[]>;
  stagePatches?: (
    input: ApplyWorkflowStageSnapshot,
    handlers: {
      onProgress: (event: ProgressEvent) => void;
    },
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
};

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
  stageInput,
  stagePatches,
}: LocalApplyPatchFormSessionOptions) => {
  const [internalInputs, setInternalInputs] = useState(defaultInputs);
  const [internalPatches, setInternalPatches] = useState(defaultPatches);
  const [internalSettings, setInternalSettings] = useState<ApplyPatchFormSettings>(defaultSettings);
  const [localState, setLocalState] = useReducer(
    localPatcherSessionStateReducer,
    undefined,
    createLocalPatcherSessionState,
  );
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
  const setBusy = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ busy: resolveLocalStateUpdate(current.busy, value) })),
    [],
  );
  const setInputStaging = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ inputStaging: resolveLocalStateUpdate(current.inputStaging, value) })),
    [],
  );
  const setErrorMessage = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({ failureMessage: resolveLocalStateUpdate(current.failureMessage, value) })),
    [],
  );
  const setOutputErrorMessage = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({
        outputErrorMessage: resolveLocalStateUpdate(current.outputErrorMessage, value),
      })),
    [],
  );
  const setProgress = useCallback(
    (value: SetStateAction<InputProgress | null>) =>
      setLocalState((current) => ({ progress: resolveLocalStateUpdate(current.progress, value) })),
    [],
  );
  const setPatchProgress = useCallback(
    (value: SetStateAction<InputProgress | null>) =>
      setLocalState((current) => ({ patchProgress: resolveLocalStateUpdate(current.patchProgress, value) })),
    [],
  );
  const setPatchProgressByKey = useCallback(
    (value: SetStateAction<Record<string, InputProgress>>) =>
      setLocalState((current) => ({
        patchProgressByKey: resolveLocalStateUpdate(current.patchProgressByKey, value),
      })),
    [],
  );
  const setPatchStaging = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({ patchStaging: resolveLocalStateUpdate(current.patchStaging, value) })),
    [],
  );
  const setPatchInfoByKey = useCallback(
    (value: SetStateAction<Record<string, StagedInputInfo>>) =>
      setLocalState((current) => ({ patchInfoByKey: resolveLocalStateUpdate(current.patchInfoByKey, value) })),
    [],
  );
  const setRomInputs = useCallback(
    (value: SetStateAction<RomInputRowState[]>) =>
      setLocalState((current) => ({ romInputs: resolveLocalStateUpdate(current.romInputs, value) })),
    [],
  );
  const setOutputName = useCallback(
    (value: SetStateAction<string>) =>
      setLocalState((current) => ({ outputName: resolveLocalStateUpdate(current.outputName, value) })),
    [],
  );
  const setOutputNameEdited = useCallback(
    (value: SetStateAction<boolean>) =>
      setLocalState((current) => ({
        outputNameEdited: resolveLocalStateUpdate(current.outputNameEdited, value),
      })),
    [],
  );
  const setCompletedSizeSummary = useCallback(
    (value: SetStateAction<ReturnType<typeof createOutputSizeSummary>>) =>
      setLocalState((current) => ({
        completedSizeSummary: resolveLocalStateUpdate(current.completedSizeSummary, value),
      })),
    [],
  );
  const setCompletedApplyTimeMs = useCallback(
    (value: SetStateAction<number | null>) =>
      setLocalState((current) => ({
        completedApplyTimeMs: resolveLocalStateUpdate(current.completedApplyTimeMs, value),
      })),
    [],
  );
  const setCompletedCompressionTimeMs = useCallback(
    (value: SetStateAction<number | null>) =>
      setLocalState((current) => ({
        completedCompressionTimeMs: resolveLocalStateUpdate(current.completedCompressionTimeMs, value),
      })),
    [],
  );
  const setPendingDownloadFileName = useCallback(
    (value: SetStateAction<string | null>) =>
      setLocalState((current) => ({
        pendingDownloadFileName: resolveLocalStateUpdate(current.pendingDownloadFileName, value),
      })),
    [],
  );
  const activeOutputCleanupRef = useRef<(() => Promise<void> | void) | null>(null);
  const pendingDownloadActionRef = useRef<(() => void | Promise<void>) | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
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
  const activeCompression = activeSettings.output?.compression || "auto";
  const autoResolvedCompression = OutputCompressionManager.resolveOutputCompression(effectiveInputs[0], {
    compressionFormat: "auto",
  });
  const displayedCompression =
    activeCompression === "auto"
      ? effectiveInputs.length
        ? resolvedOutputCompression || autoResolvedCompression
        : autoResolvedCompression
      : activeCompression;
  const outputOptionLabels = useMemo<OutputOptionLabelMap>(() => {
    const labels: OutputOptionLabelMap = {};
    if (compressionOptions.includes("z3ds")) labels.z3ds = getZ3dsOutputOptionLabel(effectiveInputs[0]);
    return labels;
  }, [compressionOptions, effectiveInputs]);
  const outputOptions = useMemo(
    () => createOutputOptions(compressionOptions, outputOptionLabels),
    [compressionOptions, outputOptionLabels],
  );
  const hasPendingDownload = !!pendingDownloadFileName;
  const clearPendingDownload = useCallback(() => {
    pendingDownloadActionRef.current = null;
    setPendingDownloadFileName(null);
  }, []);
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
  const resolvedWorkerThreads =
    activeSettings.workers?.threads ?? getLegacyCompressionWorkerThreads(activeSettings) ?? workerThreads;
  const effectiveResolvedOutputName =
    requestedOutputName || (effectiveInputs.length ? resolvedOutputName || generatedOutputName : generatedOutputName);
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
          compression: activeCompression,
          outputName: requestedOutputName,
        },
        workerThreads: resolvedWorkerThreads,
      },
      patches: activePatches,
    }),
    [
      activeCompression,
      activePatches,
      activeSettings,
      containerInputsEnabled,
      effectiveInputs,
      requestedOutputName,
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
  const multiInputOutputError = getMultiInputOutputError(displayedCompression, romInputs.length);
  const effectiveOutputNoticeMessage = outputErrorMessage || multiInputOutputError;
  const canQueueApply =
    !!effectiveInputs.length && !multiInputOutputError && applyReady && !(inputStaging || patchStaging);
  const disposeActiveOutput = useCallback(() => {
    const cleanup = activeOutputCleanupRef.current;
    activeOutputCleanupRef.current = null;
    clearPendingDownload();
    if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
  }, [clearPendingDownload]);

  const cancelActiveOperation = useCallback(() => {
    activeAbortControllerRef.current?.abort();
  }, []);

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
  }, [activeSettings.output?.outputName]);

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

  const localUiState = useMemo(
    () => ({
      ...createInertState(),
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
      disabled,
      effectiveInputs,
      inputStaging,
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
        return {
          archiveFileName: patchInfo?.archiveName || "",
          archivePathEntries: patchInfo?.parentCompressions,
          canMoveDown: index < activePatches.length - 1 && !(busy || disabled),
          canMoveUp: index > 0 && !(busy || disabled),
          canRemove: !(busy || disabled),
          detailText: patchInfo?.targetLabel || "",
          fileName: patchInfo?.fileName || getBinarySourceFileName(patch, `Patch ${index + 1}`),
          fileSize: patchInfo?.size ?? getBinarySourceSize(patch) ?? undefined,
          index: index + 1,
          key,
          progress: patchProgressByKey[key] || null,
          validationActualValue: "",
          validationLabel: "",
          validationMessage: "",
          validationState: "",
          validationValues: [],
        };
      }),
    }),
    [activePatches, busy, disabled, getPatchKey, patchInfoByKey, patchProgressByKey],
  );
  const localOutputState = useMemo(
    () => ({
      applyButton: {
        disabled: disabled || !(busy || hasPendingDownload || canQueueApply),
        label: busy ? "Cancel" : hasPendingDownload ? "Download output" : "Apply patch",
        loading: busy,
        progress: hasPendingDownload ? null : progress ? toApplyButtonProgress({ stage: "apply", ...progress }) : null,
        title: hasPendingDownload ? `Download ${pendingDownloadFileName}` : "",
      },
      compressionFormat: displayedCompression,
      disabled: disabled || busy || inputStaging || patchStaging,
      displayFileName: outputNameEdited ? outputName : effectiveResolvedOutputName,
      options: outputOptions,
      pendingDownloadFileName,
      resolvedOutputName: effectiveResolvedOutputName,
      sizeSummary: completedSizeSummary,
    }),
    [
      activePatches.length,
      busy,
      canQueueApply,
      completedSizeSummary,
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
      disposeActiveOutput();
      resetCompletedOutputState();
      if (settings === undefined) setInternalSettings(nextSettings);
      onSettingsChange?.(nextSettings);
    },
    [disposeActiveOutput, onSettingsChange, resetCompletedOutputState, settings],
  );
  const updatePatches = useCallback(
    (nextPatches: BinarySource[]) => {
      disposeActiveOutput();
      resetCompletedOutputState();
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
    [disposeActiveOutput, getPatchKey, onPatchesChange, patches, resetCompletedOutputState],
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
            sha1: info.checksums?.sha1 ?? patch.info?.sha1 ?? existing.info.sha1,
            validationPhase: patch.info?.validationPhase ?? existing.info.validationPhase,
          },
          order: info.order ?? patch.order ?? existing.order,
          size: info.size ?? patch.size ?? existing.size,
          sourceSize: info.sourceSize ?? patch.sourceSize ?? existing.sourceSize,
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
      disposeActiveOutput();
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
      resetCompletedOutputState();
      return inputStageGenerationRef.current;
    },
    [
      disposeActiveOutput,
      effectiveInputs.length,
      emitSessionTrace,
      getInputKey,
      inputs,
      onInputsChange,
      resetCompletedOutputState,
    ],
  );
  const syncPatchFiles = useCallback(
    (snapshot: ApplyWorkflowStageSnapshot) => {
      const generation = ++patchStageGenerationRef.current;
      if (!(snapshot.patches.length && stagePatches)) {
        setPatchStaging(false);
        setPatchProgress(null);
        setPatchProgressByKey({});
        return;
      }
      const initialProgress = {
        indeterminate: true,
        label: "Preparing patch...",
        message: "Preparing patch...",
      };
      setPatchStaging(true);
      setPatchProgress(null);
      setPatchProgressByKey(
        Object.fromEntries(snapshot.patches.map((patch) => [getPatchKey(patch, snapshot.patches), initialProgress])),
      );
      void stagePatches(snapshot, {
        onProgress: (event) => {
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
          setPatchStaging(false);
          setPatchProgress(null);
          setPatchProgressByKey({});
        });
    },
    [activeSettings, getPatchKey, onError, stagePatches],
  );
  const syncRomInput = useCallback(
    (snapshot: ApplyWorkflowStageSnapshot, previousInputs: BinarySource[] = []) => {
      const generation = ++inputStageGenerationRef.current;
      const progressGeneration = ++inputProgressGenerationRef.current;
      const inputOnlySnapshot = {
        ...snapshot,
        patches: [],
      };
      const retainedInputKeys = new Set(previousInputs.map((input) => getInputKey(input, previousInputs)));
      emitSessionTrace("input staging sync started", {
        generation,
        hasStageInput: !!stageInput,
        inputCount: snapshot.inputs.length,
        patchCountIgnored: snapshot.patches.length,
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
      setRomInputs((current) =>
        sortRomInputs(
          snapshot.inputs.map((input, index) => {
            const existing = current[index];
            const existingProgress = existing?.progress || null;
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
                existingProgress ||
                (existing
                  ? null
                  : {
                      indeterminate: true,
                      label: "Preparing input...",
                      message: "Preparing input...",
                    }),
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
      void stageInput(inputOnlySnapshot, {
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
                    sha1: info.checksums?.sha1 || "",
                    validationPhase: "idle",
                  },
                  loading: false,
                  order: info.order ?? index,
                  progress: null,
                  size: info.size,
                  sourceSize: info.sourceSize,
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
      const clearSnapshot = {
        ...createStageSnapshot(),
        patches: [],
      };
      void stageInput(clearSnapshot, {
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
    if (!(inputsChanged || patchesChanged || settingsChanged)) return;
    patchStageSyncRef.current = {
      inputs: effectiveInputs.slice(),
      patches: activePatches.slice(),
      settingsKey: stageSettingsKey,
    };
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
        disposeActiveOutput();
        const nextPatches = Array.from(fileList || []) as BinarySource[];
        patchStageGenerationRef.current += 1;
        setPatchProgress(null);
        setPatchProgressByKey({});
        setPatchStaging(false);
        setErrorMessage("");
        setOutputErrorMessage("");
        setProgress(null);
        resetCompletedOutputState();
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
        updateInputs(effectiveInputs.filter((_input, inputIndex) => inputIndex !== index));
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
      disposeActiveOutput,
      effectiveInputs,
      emitSessionTrace,
      localUiStoreController,
      resetCompletedOutputState,
      romInputs,
      updateInputs,
      updatePatches,
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
      subscribe: localStackStoreController.subscribe,
    }),
    [activePatches, localStackStoreController, updatePatches],
  );
  const localOutputController = useMemo(
    () => ({
      getState: localOutputStoreController.getState,
      runPrimaryAction: async () => {
        if (busy) {
          cancelActiveOperation();
          return;
        }
        if (pendingDownloadActionRef.current && hasPendingDownload) {
          await Promise.resolve(pendingDownloadActionRef.current());
          return;
        }
        if (!canQueueApply) return;
        const abortController = new AbortController();
        activeAbortControllerRef.current = abortController;
        setBusy(true);
        setErrorMessage("");
        setOutputErrorMessage("");
        disposeActiveOutput();
        resetCompletedOutputState();
        applyExecutionTimingRef.current = {
          applyStartedAt: Date.now(),
          compressionStartedAt: null,
        };
        setProgress({
          indeterminate: true,
          label: "Applying patch...",
          message: "Applying patch...",
          percent: null,
          stage: "apply",
        });
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
                compression: activeCompression,
                outputName: requestedOutputName,
              },
              signal: abortController.signal,
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
          activeOutputCleanupRef.current =
            result.outputs.length > 0
              ? async () => {
                  await Promise.all(result.outputs.map((output) => output.cleanup?.()));
                }
              : result.output.cleanup || null;
          const downloadResult = () => downloadOutput(result);
          pendingDownloadActionRef.current = downloadResult;
          setPendingDownloadFileName(result.output.fileName || effectiveResolvedOutputName || "output");
          try {
            await Promise.resolve(downloadResult());
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
          if (activeAbortControllerRef.current === abortController) activeAbortControllerRef.current = null;
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
        updateSettings({
          ...activeSettings,
          output: { ...activeSettings.output, outputName: nextOutputName },
        });
      },
      setOutputCompression: (value: string) => {
        updateSettings({
          ...activeSettings,
          output: {
            ...activeSettings.output,
            compression: value as "auto" | CompressionFormat,
          },
        });
      },
      subscribe: localOutputStoreController.subscribe,
    }),
    [
      activePatches,
      activeSettings,
      containerInputsEnabled,
      applyPatches,
      cancelActiveOperation,
      disposeActiveOutput,
      downloadOutput,
      effectiveInputs,
      getPatchKey,
      localOutputStoreController,
      busy,
      clearPendingDownload,
      onApplyComplete,
      onError,
      onProgress,
      updateSettings,
      resolvedWorkerThreads,
      requestedOutputName,
      activeCompression,
      canQueueApply,
      effectiveResolvedOutputName,
      hasPendingDownload,
      mergeRomInput,
      resetCompletedOutputState,
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
