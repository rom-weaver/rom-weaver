import type {
  RomWeaverRunJsonOptions as BaseRomWeaverRunJsonOptions,
  RomWeaverRunJsonResult as BaseRomWeaverRunJsonResult,
  CompressionLevelProfile,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverCommand,
  RomWeaverRunJsonEvent,
  ThreadBudget,
} from "rom-weaver-wasm";
import { createRomWeaverCommand } from "rom-weaver-wasm";
import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { ChecksumResult, ChecksumRomProbe } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { CompressionListResult } from "../../types/workflow-runtime.ts";
import type {
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateCandidatesWorkerInput,
  RuntimePatchCreateFormatCandidates,
  RuntimePatchCreateWorkerInput,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeThreadBudgetInput,
  RuntimeTrimWorkerInput,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventElapsedMs,
  getRomWeaverRunEventFormat,
  getRomWeaverRunEventLabel,
  getRomWeaverRunEventPercent,
  isRomWeaverLiveRunEvent,
  isRomWeaverTerminalRunEvent,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, runRomWeaverJson } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { parseCompressionCodecEntry } from "../compression/codec-parser.ts";
import { getFileNameParts, getPathBaseName, isCompressionLevelProfile } from "../path-utils.ts";

type RomWeaverRunJsonOptions = BaseRomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions & { signal?: AbortSignal };
type RomWeaverRunJsonResult = BaseRomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

const CHECKSUM_PAIR_REGEX = /([a-z0-9_-]+)=([0-9a-f]+)/gi;
const WORK_ROOT_PATH = "/work";
const BROWSER_SYNC_ACCESS_MODES = new Set<RomWeaverBrowserSyncAccessMode>([
  "read-only",
  "readwrite",
  "readwrite-unsafe",
]);

const nowIso = () => new Date().toISOString();

type SimpleRuntimeProgress = {
  details?: RuntimeValue;
  label?: string;
  message?: string;
  percent?: number | null;
  stage?: string;
};

const emitRuntimeLog = (
  onLog: ((log: WorkflowRuntimeLog) => void) | undefined,
  level: WorkflowRuntimeLog["level"],
  message: string,
  details?: Record<string, unknown>,
) => {
  onLog?.(
    details
      ? {
          details,
          level,
          message,
          namespace: "runtime:rom-weaver",
          timestamp: nowIso(),
        }
      : {
          level,
          message,
          namespace: "runtime:rom-weaver",
          timestamp: nowIso(),
        },
  );
};

const clampPercent = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
};

const isLiveProgressEvent = (event: RomWeaverRunJsonEvent): boolean => {
  return isRomWeaverLiveRunEvent(event);
};

const toThreadBudget = (value: unknown, fallback: ThreadBudget | null = null): ThreadBudget | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed >= 1 ? parsed : fallback;
  }
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  // Resolve "auto" to the host's core count here instead of forwarding the literal string. The wasm
  // worker's "auto" fallback is a fixed default (4), so leaving it unresolved would cap the browser
  // well below the available cores; passing an explicit count lets compress/extract use every core,
  // matching the resolved value shown by the settings placeholder.
  if (normalized === "auto") return getDefaultBrowserThreadCount();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
};

type CompressionCreateThreadArgInput = {
  codecs?: unknown;
  format?: string | null;
  levelProfile?: string | null;
  totalBytes?: number | null;
  workerThreads?: RuntimeThreadBudgetInput;
};

type CompressionCreateThreadArgResolution = {
  forcedSingleThread: boolean;
  forceSingleThreadReason: string;
  requestedThreadArg: ThreadBudget | null;
  threadArg: ThreadBudget | null;
  threadCap: number | null;
  zipZstdLevel: number | null;
};

type ZstdCompressionParams = {
  chainLog: number;
  hashLog: number;
  strategy: number;
  windowLog: number;
};

const ZSTD_STRATEGY_FAST = 0;
const ZSTD_STRATEGY_DFAST = 1;
const ZSTD_STRATEGY_GREEDY = 2;
const ZSTD_STRATEGY_LAZY = 3;
const ZSTD_STRATEGY_LAZY2 = 4;
const ZSTD_STRATEGY_BTLAZY2 = 5;
const ZSTD_STRATEGY_BTOPT = 6;
const ZSTD_STRATEGY_BTULTRA = 7;
const ZSTD_STRATEGY_BTULTRA2 = 8;
const ZSTD_LEVEL_DEFAULT = 3;
const ZSTD_LEVEL_MIN = -7;
const ZSTD_LEVEL_MAX = 22;
const ZSTD_MT_SPLIT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ZSTD_MT_JOB_SIZE_MIN_BYTES = 1024 * 1024;
const ZSTD_MT_JOB_LOG_MAX = 30;
const ZSTD_MT_OVERLAP_LOG = 6;
const ZSTD_WASM_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;
const ZSTD_WORKSPACE_WORD_BYTES = 4;
const ZSTD_PROFILE_LEVELS: Record<string, number> = {
  high: 15,
  low: 7,
  max: 22,
  medium: 11,
  min: -7,
  "very-high": 19,
  "very-low": 4,
};
const ZSTD_LARGE_SOURCE_PARAMS_FALLBACK: ZstdCompressionParams = {
  chainLog: 16,
  hashLog: 17,
  strategy: ZSTD_STRATEGY_DFAST,
  windowLog: 21,
};
const ZSTD_LARGE_SOURCE_PARAMS: ZstdCompressionParams[] = [
  { chainLog: 12, hashLog: 13, strategy: ZSTD_STRATEGY_FAST, windowLog: 19 },
  { chainLog: 13, hashLog: 14, strategy: ZSTD_STRATEGY_FAST, windowLog: 19 },
  { chainLog: 15, hashLog: 16, strategy: ZSTD_STRATEGY_FAST, windowLog: 20 },
  { chainLog: 16, hashLog: 17, strategy: ZSTD_STRATEGY_DFAST, windowLog: 21 },
  { chainLog: 18, hashLog: 18, strategy: ZSTD_STRATEGY_DFAST, windowLog: 21 },
  { chainLog: 18, hashLog: 19, strategy: ZSTD_STRATEGY_GREEDY, windowLog: 21 },
  { chainLog: 18, hashLog: 19, strategy: ZSTD_STRATEGY_LAZY, windowLog: 21 },
  { chainLog: 19, hashLog: 20, strategy: ZSTD_STRATEGY_LAZY, windowLog: 21 },
  { chainLog: 19, hashLog: 20, strategy: ZSTD_STRATEGY_LAZY2, windowLog: 21 },
  { chainLog: 20, hashLog: 21, strategy: ZSTD_STRATEGY_LAZY2, windowLog: 22 },
  { chainLog: 21, hashLog: 22, strategy: ZSTD_STRATEGY_LAZY2, windowLog: 22 },
  { chainLog: 21, hashLog: 22, strategy: ZSTD_STRATEGY_LAZY2, windowLog: 22 },
  { chainLog: 22, hashLog: 23, strategy: ZSTD_STRATEGY_LAZY2, windowLog: 22 },
  { chainLog: 22, hashLog: 22, strategy: ZSTD_STRATEGY_BTLAZY2, windowLog: 22 },
  { chainLog: 22, hashLog: 23, strategy: ZSTD_STRATEGY_BTLAZY2, windowLog: 22 },
  { chainLog: 23, hashLog: 23, strategy: ZSTD_STRATEGY_BTLAZY2, windowLog: 22 },
  { chainLog: 22, hashLog: 22, strategy: ZSTD_STRATEGY_BTOPT, windowLog: 22 },
  { chainLog: 23, hashLog: 22, strategy: ZSTD_STRATEGY_BTOPT, windowLog: 23 },
  { chainLog: 23, hashLog: 22, strategy: ZSTD_STRATEGY_BTULTRA, windowLog: 23 },
  { chainLog: 24, hashLog: 22, strategy: ZSTD_STRATEGY_BTULTRA2, windowLog: 23 },
  { chainLog: 25, hashLog: 23, strategy: ZSTD_STRATEGY_BTULTRA2, windowLog: 25 },
  { chainLog: 26, hashLog: 24, strategy: ZSTD_STRATEGY_BTULTRA2, windowLog: 26 },
  { chainLog: 27, hashLog: 25, strategy: ZSTD_STRATEGY_BTULTRA2, windowLog: 27 },
];

const toFiniteByteCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const bytesForLog = (log: number): number => 2 ** Math.max(0, Math.floor(log));

const ceilLog2 = (value: number): number => (value <= 1 ? 0 : Math.ceil(Math.log2(value)));

const zstdProfileLevel = (levelProfile: string | null | undefined): number => {
  const normalized = String(levelProfile || "max")
    .trim()
    .toLowerCase();
  return ZSTD_PROFILE_LEVELS[normalized] ?? ZSTD_PROFILE_LEVELS.max ?? ZSTD_LEVEL_MAX;
};

const zstdPlanningLevel = (level: number | null): number => {
  const rawLevel = level ?? ZSTD_LEVEL_DEFAULT;
  return Math.max(ZSTD_LEVEL_MIN, Math.min(ZSTD_LEVEL_MAX, Math.floor(rawLevel)));
};

const zstdLargeSourceParams = (level: number): ZstdCompressionParams => {
  const resolvedLevel = level === 0 ? ZSTD_LEVEL_DEFAULT : level;
  const row = resolvedLevel < 0 ? 0 : Math.max(0, Math.min(ZSTD_LEVEL_MAX, Math.floor(resolvedLevel)));
  return { ...(ZSTD_LARGE_SOURCE_PARAMS[row] ?? ZSTD_LARGE_SOURCE_PARAMS_FALLBACK) };
};

const zstdCycleLog = (chainLog: number, strategy: number): number =>
  Math.max(0, chainLog - (strategy >= ZSTD_STRATEGY_BTLAZY2 ? 1 : 0));

const zstdAdjustedParams = (totalBytes: number, level: number): ZstdCompressionParams => {
  const params = zstdLargeSourceParams(level);
  if (totalBytes > 0) {
    const srcLog = Math.max(ceilLog2(totalBytes), 10);
    params.windowLog = Math.min(params.windowLog, srcLog);
    const dictAndWindowLog = params.windowLog;
    params.hashLog = Math.min(params.hashLog, dictAndWindowLog + 1);
    const cycleLog = zstdCycleLog(params.chainLog, params.strategy);
    if (cycleLog > dictAndWindowLog) params.chainLog -= cycleLog - dictAndWindowLog;
  }
  params.windowLog = Math.max(params.windowLog, 10);
  return params;
};

const zstdSingleWorkerBytes = (totalBytes: number, params: ZstdCompressionParams): number => {
  const windowBytes = bytesForLog(params.windowLog);
  const activeWindow = totalBytes === 0 ? windowBytes : Math.max(1024, Math.min(windowBytes, Math.max(0, totalBytes)));
  const hashBytes = bytesForLog(params.hashLog) * ZSTD_WORKSPACE_WORD_BYTES;
  const chainBytes =
    params.strategy === ZSTD_STRATEGY_FAST ? 0 : bytesForLog(params.chainLog) * ZSTD_WORKSPACE_WORD_BYTES;
  const blockBytes = Math.min(activeWindow, 128 * 1024);
  return hashBytes + chainBytes + activeWindow + blockBytes * 3 + 4 * 1024 * 1024;
};

const zstdMtJobSizeBytes = (params: ZstdCompressionParams): number => {
  const jobLog = Math.max(20, Math.min(ZSTD_MT_JOB_LOG_MAX, params.windowLog + 2));
  return Math.max(bytesForLog(jobLog), ZSTD_MT_JOB_SIZE_MIN_BYTES);
};

const zstdMtOverlapBytes = (params: ZstdCompressionParams): number => {
  const overlapRLog = 9 - ZSTD_MT_OVERLAP_LOG;
  if (overlapRLog >= 8) return 0;
  const overlapLog = Math.max(0, params.windowLog - overlapRLog);
  return overlapLog === 0 ? 0 : bytesForLog(overlapLog);
};

const zstdAchievableJobs = (totalBytes: number, level: number): number => {
  if (totalBytes <= ZSTD_MT_SPLIT_THRESHOLD_BYTES) return 1;
  const params = zstdAdjustedParams(totalBytes, level);
  const jobSize = zstdMtJobSizeBytes(params);
  return Math.max(1, Math.ceil(totalBytes / jobSize));
};

const zstdThreadsForBudget = (totalBytes: number, level: number, budgetBytes: number): number => {
  const achievable = zstdAchievableJobs(totalBytes, level);
  if (achievable <= 1) return 1;

  const params = zstdAdjustedParams(totalBytes, level);
  const singleWorker = zstdSingleWorkerBytes(totalBytes, params);
  if (budgetBytes <= singleWorker) return 1;

  const jobSize = zstdMtJobSizeBytes(params);
  const slackJobs = zstdMtOverlapBytes(params) > 0 ? 3 : 2;
  const fixedMtBytes = jobSize * slackJobs + 8 * 1024 * 1024;
  if (budgetBytes <= fixedMtBytes) return 1;

  const perWorker = Math.max(1, singleWorker + jobSize);
  const workers = Math.max(1, Math.floor((budgetBytes - fixedMtBytes) / perWorker));
  return Math.min(workers, achievable);
};

const getZipZstdLevel = (
  format: string | null | undefined,
  codecs: string[],
  levelProfile: string | null | undefined,
): number | null => {
  if (
    String(format || "")
      .trim()
      .toLowerCase() !== "zip"
  )
    return null;
  for (const codecEntry of codecs) {
    const parsed = parseCompressionCodecEntry(codecEntry);
    const codec =
      parsed?.codec ||
      String(codecEntry || "")
        .trim()
        .toLowerCase();
    if (codec !== "zstd" && codec !== "zstandard") continue;
    return parsed?.level ?? zstdProfileLevel(levelProfile);
  }
  return null;
};

const resolveZipZstdBrowserThreadCap = (input: CompressionCreateThreadArgInput, codecs: string[]): number | null => {
  const level = getZipZstdLevel(input.format, codecs, input.levelProfile);
  if (level === null) return null;
  const totalBytes = toFiniteByteCount(input.totalBytes);
  if (totalBytes === null) return null;
  return zstdThreadsForBudget(totalBytes, zstdPlanningLevel(level), ZSTD_WASM_MEMORY_BUDGET_BYTES);
};

const resolveCompressionCreateThreadArg = (
  input: CompressionCreateThreadArgInput,
): CompressionCreateThreadArgResolution => {
  const requestedThreadArg = toThreadBudget(input.workerThreads);
  const codecs = normalizeCodecEntries(input.codecs);
  const threadCap = resolveZipZstdBrowserThreadCap(input, codecs);
  const zipZstdLevel = getZipZstdLevel(input.format, codecs, input.levelProfile);
  let threadArg = requestedThreadArg;
  if (threadCap !== null) {
    if (typeof requestedThreadArg === "number") threadArg = Math.max(1, Math.min(requestedThreadArg, threadCap));
    else if (threadCap <= 1) threadArg = 1;
  }
  const forcedSingleThread = threadArg === 1 && requestedThreadArg !== 1 && threadCap === 1;
  return {
    forcedSingleThread,
    forceSingleThreadReason: forcedSingleThread ? "zip-zstd-browser-memory" : "",
    requestedThreadArg,
    threadArg,
    threadCap,
    zipZstdLevel,
  };
};

const toBrowserSyncAccessMode = (value: unknown): RomWeaverBrowserSyncAccessMode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim() as RomWeaverBrowserSyncAccessMode;
  return BROWSER_SYNC_ACCESS_MODES.has(normalized) ? normalized : undefined;
};

const XDELTA_PATCH_FILE_EXTENSION_REGEX = /\.(?:xdelta|delta|dat|vcdiff)$/i;
const BPS_PATCH_FILE_EXTENSION_REGEX = /\.bps$/i;
const PATCH_FORMAT_NORMALIZE_REGEX = /[^a-z0-9]+/g;

const normalizePatchFormat = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(PATCH_FORMAT_NORMALIZE_REGEX, "");
};

const isXdeltaPatchFormat = (value: unknown) => {
  const normalized = normalizePatchFormat(value);
  return normalized === "xdelta" || normalized === "vcdiff";
};

const isBpsPatchFormat = (value: unknown) => normalizePatchFormat(value) === "bps";

const isXdeltaPatchPath = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return XDELTA_PATCH_FILE_EXTENSION_REGEX.test(trimmed);
};

const isBpsPatchPath = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return BPS_PATCH_FILE_EXTENSION_REGEX.test(trimmed);
};

const resolvePatchApplyThreadArg = (
  requestedThreadArg: ThreadBudget | null,
  patchFiles: Array<{ patchFileName?: string; patchFilePath?: string; patchFormat?: string }>,
) => {
  const hasXdeltaPatch = patchFiles.some((patch) => {
    return (
      isXdeltaPatchFormat(patch.patchFormat) ||
      isXdeltaPatchPath(patch.patchFilePath) ||
      isXdeltaPatchPath(patch.patchFileName)
    );
  });
  const hasBpsPatch = patchFiles.some((patch) => {
    return (
      isBpsPatchFormat(patch.patchFormat) || isBpsPatchPath(patch.patchFilePath) || isBpsPatchPath(patch.patchFileName)
    );
  });
  if (hasXdeltaPatch) {
    return {
      forcedSingleThread: requestedThreadArg !== 1,
      forceSingleThreadReason: "xdelta",
      hasBpsPatch,
      hasXdeltaPatch,
      threadArg: 1,
    };
  }
  if (hasBpsPatch) {
    return {
      forcedSingleThread: false,
      forceSingleThreadReason: "bps",
      hasBpsPatch,
      hasXdeltaPatch,
      threadArg: null,
    };
  }
  return {
    forcedSingleThread: false,
    forceSingleThreadReason: "",
    hasBpsPatch,
    hasXdeltaPatch,
    threadArg: requestedThreadArg || null,
  };
};

const isTraceEnabled = (logLevel: LogLevel | string | undefined) => String(logLevel || "").toLowerCase() === "trace";

const emitRuntimeTrace = (
  input: {
    logLevel?: LogLevel | string;
    onLog?: (log: WorkflowRuntimeLog) => void;
  },
  message: string,
  details?: Record<string, unknown>,
) => {
  if (!isTraceEnabled(input.logLevel)) return;
  emitRuntimeLog(input.onLog, "trace", message, details);
};

const getTraceMessage = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.trim() : String(value || "").trim();
  } catch (_error) {
    return String(value || "").trim();
  }
};

const appendBrowserStorageContext = async (message: string) => {
  const state = await getBrowserStorageEstimateState();
  return `${message} [storage: ${formatBrowserStorageEstimateState(state)}]`;
};

const throwRomWeaverFailureWithBrowserOutputContext = async (
  result: RomWeaverRunJsonResult,
  fallbackMessage: string,
  operationLabel: string,
): Promise<never> => {
  const message = getRomWeaverFailureMessage(result, fallbackMessage);
  const error = await withBrowserOutputStorageFailureContext(new Error(message), {
    operationLabel,
  });
  throw error instanceof Error ? error : new Error(String(error || message));
};

const toRomWeaverOptions = (input: {
  defaultThreads?: number | null;
  invalidateMountCacheBeforeRun?: boolean;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onLog?: (log: WorkflowRuntimeLog) => void;
  preopenOutputPaths?: string[];
  scratchFilePoolSize?: number | null;
  signal?: AbortSignal;
  syncAccessMode?: string;
  virtualFiles?: RuntimeValue[];
  virtualOnlyMounts?: boolean;
}): RomWeaverRunJsonOptions => {
  const traceEnabled = isTraceEnabled(input.logLevel);
  const options: RomWeaverRunJsonOptions = {
    onEvent: input.onEvent,
    onTraceEvent: traceEnabled
      ? (event) => {
          const message = getTraceMessage(event);
          if (!message) return;
          emitRuntimeLog(input.onLog, "trace", message);
        }
      : undefined,
    onTraceNonJsonLine: (line) => {
      const message = String(line || "").trim();
      if (!message) return;
      emitRuntimeLog(input.onLog, "trace", message);
    },
    signal: input.signal,
  };
  if (traceEnabled) {
    options.env = {
      RUST_BACKTRACE: "full",
    };
    options.trace = true;
  }
  if (typeof input.scratchFilePoolSize === "number" && Number.isFinite(input.scratchFilePoolSize)) {
    options.scratchFilePoolSize = Math.max(0, Math.floor(input.scratchFilePoolSize));
  }
  if (typeof input.defaultThreads === "number" && Number.isFinite(input.defaultThreads)) {
    options.defaultThreads = Math.floor(input.defaultThreads);
  }
  const syncAccessMode = toBrowserSyncAccessMode(input.syncAccessMode);
  if (syncAccessMode) options.syncAccessMode = syncAccessMode;
  if (input.invalidateMountCacheBeforeRun) options.invalidateMountCacheBeforeRun = true;
  if (Array.isArray(input.knownInputPaths)) {
    const knownInputPaths = input.knownInputPaths
      .map((pathValue) => String(pathValue || "").trim())
      .filter((pathValue) => !!pathValue);
    if (knownInputPaths.length) options.knownInputPaths = knownInputPaths;
  }
  if (Array.isArray(input.preopenOutputPaths)) {
    const preopenOutputPaths = input.preopenOutputPaths
      .map((pathValue) => String(pathValue || "").trim())
      .filter((pathValue) => !!pathValue);
    if (preopenOutputPaths.length) options.preopenOutputPaths = preopenOutputPaths;
  }
  if (Array.isArray(input.virtualFiles)) options.virtualFiles = input.virtualFiles;
  if (typeof input.virtualOnlyMounts === "boolean") options.virtualOnlyMounts = input.virtualOnlyMounts;
  return options;
};

const joinPath = (directory: string, fileName: string): string => {
  const normalizedDirectory = String(directory || "").trim();
  if (!normalizedDirectory) return fileName;
  const separator = normalizedDirectory.includes("\\") && !normalizedDirectory.includes("/") ? "\\" : "/";
  if (normalizedDirectory.endsWith("/") || normalizedDirectory.endsWith("\\"))
    return `${normalizedDirectory}${fileName}`;
  return `${normalizedDirectory}${separator}${fileName}`;
};

const normalizeAbsolutePosixPath = (pathValue: string): string => {
  const normalized = String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
};

const selectRomWeaverOutputPath = (sourcePath: string, outputFileName: string, blockedPaths: string[] = []) => {
  const outputBaseName = getPathBaseName(outputFileName, "output.bin");
  const preferredPath = joinPath(WORK_ROOT_PATH, outputBaseName);
  const normalizedPreferredPath = normalizeAbsolutePosixPath(preferredPath);
  const normalizedBlocked = new Set(
    [sourcePath, ...blockedPaths]
      .map((pathValue) => normalizeAbsolutePosixPath(pathValue))
      .filter((pathValue) => !!pathValue),
  );
  if (normalizedBlocked.has(normalizedPreferredPath)) {
    throw new Error(`Browser output path conflicts with an active input or patch: ${preferredPath}`);
  }
  return preferredPath;
};

const appendTrimmedOutputMarker = (fileName: string) => {
  const { extension, stem } = getFileNameParts(fileName || "trimmed.bin");
  const normalizedStem = stem.trim() || "trimmed";
  const trimmedStem = /\(trimmed\)$/i.test(normalizedStem) ? normalizedStem : `${normalizedStem} (trimmed)`;
  return `${trimmedStem}${extension || ".bin"}`;
};

const getTrimOutputFileName = (sourceFilePath: string, requestedOutputName: string | undefined) => {
  const sourceBaseName = getPathBaseName(sourceFilePath, "trimmed.bin");
  const requestedBaseName = getPathBaseName(requestedOutputName || sourceBaseName, sourceBaseName);
  const sourceParts = getFileNameParts(sourceBaseName);
  const requestedParts = getFileNameParts(requestedBaseName);
  if (requestedParts.stem.trim().toLowerCase() === sourceParts.stem.trim().toLowerCase()) {
    return appendTrimmedOutputMarker(requestedBaseName);
  }
  return requestedBaseName;
};

const getLastEvent = (result: RomWeaverRunJsonResult): RomWeaverRunJsonEvent | null => {
  const events = Array.isArray(result.events) ? result.events : [];
  if (!events.length) return null;
  const last = events[events.length - 1];
  return last || null;
};

const getTerminalEvent = (result: RomWeaverRunJsonResult): RomWeaverRunJsonEvent | null => {
  const events = Array.isArray(result.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isRomWeaverTerminalRunEvent(event)) return event;
  }
  return getLastEvent(result);
};

const createRuntimeTiming = (elapsedMs: unknown) => {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  const normalizedMs = Math.round(elapsedMs);
  return {
    elapsedMs: normalizedMs,
    elapsedSeconds: normalizedMs / 1000,
  };
};

const getRunResultTiming = (result: RomWeaverRunJsonResult) => {
  const terminal = getTerminalEvent(result);
  return terminal ? createRuntimeTiming(getRomWeaverRunEventElapsedMs(terminal)) : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const getEmittedFileDetails = (
  result: RomWeaverRunJsonResult,
): { fileName?: string; path?: string; sizeBytes?: number } | null => {
  const emittedFiles = getEmittedFiles(result);
  if (!emittedFiles.length) return null;
  const first = emittedFiles[0] || null;
  if (!first) return null;
  return {
    fileName: first.fileName,
    path: first.path,
    sizeBytes: first.sizeBytes,
  };
};

type RomWeaverEmittedFile = {
  checksums?: Record<string, string>;
  fileName: string;
  kind?: string;
  path: string;
  sizeBytes?: number;
};

const normalizeEmittedFileChecksums = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checksums: Record<string, string> = {};
  for (const [algorithm, checksum] of Object.entries(record)) {
    const key = algorithm.trim().toLowerCase();
    const normalized = typeof checksum === "string" ? checksum.trim().toLowerCase() : "";
    if (key && normalized) checksums[key] = normalized;
  }
  return Object.keys(checksums).length ? checksums : undefined;
};

const getEmittedFiles = (result: RomWeaverRunJsonResult): RomWeaverEmittedFile[] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const emitted = Array.isArray(details?.emitted_files) ? details?.emitted_files : [];
  const output: RomWeaverEmittedFile[] = [];
  for (const value of emitted) {
    const entry = asRecord(value);
    if (!entry) continue;
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) continue;
    const fileName =
      typeof entry.file_name === "string" && entry.file_name ? entry.file_name : getPathBaseName(path, "output.bin");
    output.push({
      checksums: normalizeEmittedFileChecksums(entry.checksums),
      fileName,
      kind: typeof entry.kind === "string" && entry.kind ? entry.kind : undefined,
      path,
      sizeBytes:
        typeof entry.size_bytes === "number" && Number.isFinite(entry.size_bytes) ? entry.size_bytes : undefined,
    });
  }
  return output;
};

const getContainerEntriesFromList = (result: RomWeaverRunJsonResult): CompressionListResult["entries"] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const container = asRecord(details?.container);
  const entryRecords = Array.isArray(container?.entry_records) ? container.entry_records : [];
  const entries = entryRecords.length ? entryRecords : Array.isArray(container?.entries) ? container.entries : [];
  const output: CompressionListResult["entries"] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const normalized = entry.trim();
      if (!normalized) continue;
      output.push({
        fileName: normalized,
        filename: normalized,
        name: getPathBaseName(normalized, normalized),
      });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const fileName = String(record.file_name || record.fileName || record.filename || record.name || "").trim();
    if (!fileName) continue;
    const sizeValue = record.size_bytes ?? record.size;
    const size = typeof sizeValue === "number" && Number.isFinite(sizeValue) ? sizeValue : undefined;
    output.push({
      fileName,
      filename: fileName,
      name: getPathBaseName(fileName, fileName),
      size,
    });
  }
  return output;
};

type RomWeaverProbePatchDetails = {
  format: string | null;
  minimum_source_size: number | null;
  patch_crc32: number | null;
  record_count: number | null;
  source_crc32: number | null;
  source_size: number | null;
  source_window_count: number | null;
  target_crc32: number | null;
  target_size: number | null;
  target_window_count: number | null;
  window_checksum_count: number | null;
};

const toNullableInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

const toNullableUint32 = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!normalized) return null;
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length <= 8) return Number.parseInt(normalized, 16) >>> 0;
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10) >>> 0;
  return null;
};

const toOptionalUint32Hex = (value: unknown): string | undefined => {
  const normalized = toNullableUint32(value);
  return normalized === null ? undefined : normalized.toString(16).padStart(8, "0");
};

const toOptionalChecksumHex = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return normalized && /^[0-9a-f]+$/i.test(normalized) ? normalized : undefined;
};

const toOptionalInt = (value: unknown): number | undefined => {
  const normalized = toNullableInt(value);
  return normalized === null ? undefined : normalized;
};

const getPatchDetailsFromProbe = (result: RomWeaverRunJsonResult): RomWeaverProbePatchDetails => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const patch = asRecord(details?.patch);
  const formatValue = patch?.format ?? patch?.patch_format ?? details?.format;
  return {
    format: typeof formatValue === "string" && formatValue.trim() ? formatValue.trim() : null,
    minimum_source_size: toNullableInt(patch?.minimum_source_size ?? patch?.minimumSourceSize),
    patch_crc32: toNullableUint32(patch?.patch_crc32 ?? patch?.patchCrc32),
    record_count: toNullableInt(patch?.record_count ?? patch?.recordCount),
    source_crc32: toNullableUint32(patch?.source_crc32 ?? patch?.sourceCrc32),
    source_size: toNullableInt(patch?.source_size ?? patch?.sourceSize),
    source_window_count: toNullableInt(patch?.source_window_count ?? patch?.sourceWindowCount),
    target_crc32: toNullableUint32(patch?.target_crc32 ?? patch?.targetCrc32),
    target_size: toNullableInt(patch?.target_size ?? patch?.targetSize),
    target_window_count: toNullableInt(patch?.target_window_count ?? patch?.targetWindowCount),
    window_checksum_count: toNullableInt(patch?.window_checksum_count ?? patch?.windowChecksumCount),
  };
};

const toSimpleProgress = (event: RomWeaverRunJsonEvent): SimpleRuntimeProgress | null => {
  if (!isLiveProgressEvent(event)) return null;
  const label = getRomWeaverRunEventLabel(event);
  const details = getRomWeaverRunEventDetails(event) as RuntimeValue;
  return {
    details: details === null || details === undefined ? undefined : details,
    label: label ? label : undefined,
    message: undefined,
    percent: clampPercent(getRomWeaverRunEventPercent(event)),
    stage: typeof event.stage === "string" && event.stage ? event.stage : undefined,
  };
};

const normalizeCodecEntries = (value: unknown): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string) => {
    const normalized = String(entry || "").trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  const collect = (candidate: unknown) => {
    if (candidate == null) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) collect(entry);
      return;
    }
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed) return;
      if (trimmed.includes(",")) for (const entry of trimmed.split(",")) collect(entry);
      else if (trimmed.includes("+")) for (const entry of trimmed.split("+")) collect(entry);
      else push(trimmed);
      return;
    }
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) push(String(Math.floor(candidate)));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [codecName, codecValue] of Object.entries(candidate as Record<string, unknown>)) {
      const name = codecName.trim();
      if (!name) continue;
      if (codecValue == null || codecValue === false) continue;
      if (codecValue === true) {
        push(name);
        continue;
      }
      if (typeof codecValue === "number") {
        if (!Number.isFinite(codecValue)) continue;
        push(`${name}:${Math.floor(codecValue)}`);
        continue;
      }
      if (typeof codecValue === "string") {
        const normalized = codecValue.trim();
        if (!normalized || normalized === "0" || normalized.toLowerCase() === "false") continue;
        if (normalized.toLowerCase() === "true") push(name);
        else push(`${name}:${normalized}`);
      }
    }
  };
  collect(value);
  return out;
};

const normalizeCompressionLevelProfile = (value: unknown): string | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return isCompressionLevelProfile(normalized) ? normalized : null;
};

const ensureRomWeaverSuccess = (result: RomWeaverRunJsonResult, fallbackMessage: string) => {
  if (result.ok && result.exitCode === 0) return;
  throw new Error(getRomWeaverFailureMessage(result, fallbackMessage));
};

const normalizeChdCodecArgs = (codecs: string[]) => {
  const explicitLevels = new Set<string>();
  const strippedCodecs: string[] = [];
  const strippedSeen = new Set<string>();
  for (const codecEntry of codecs) {
    const trimmed = String(codecEntry || "").trim();
    if (!trimmed) continue;
    const parsed = parseCompressionCodecEntry(trimmed);
    if (!parsed) {
      if (!strippedSeen.has(trimmed)) {
        strippedSeen.add(trimmed);
        strippedCodecs.push(trimmed);
      }
      continue;
    }
    const codecName = parsed.codec || trimmed;
    if (parsed.levelText !== null) explicitLevels.add(parsed.levelText);
    if (!strippedSeen.has(codecName)) {
      strippedSeen.add(codecName);
      strippedCodecs.push(codecName);
    }
  }

  // CHD codec sets cannot mix per-codec levels; keep user codec order but remove level suffixes on conflicts.
  if (explicitLevels.size <= 1) return { codecs, stripped: false };
  return { codecs: strippedCodecs, stripped: true };
};

const isChdCompressionFormat = (format: string): boolean => {
  const normalized = format.trim().toLowerCase();
  return normalized === "chd" || normalized.startsWith("chd-");
};

const getPatchApplyOutputFileName = (input: RuntimePatchApplyWorkerInput) => {
  const options = input.options || {};
  const outputName = typeof options.outputName === "string" ? options.outputName.trim() : "";
  if (outputName) return getPathBaseName(outputName, "patched.bin");
  const { extension, stem } = getFileNameParts(input.romFileName || "input.bin");
  const outputExtension = typeof options.outputExtension === "string" ? options.outputExtension.trim() : "";
  const normalizedOutputExtension = outputExtension
    ? outputExtension.startsWith(".")
      ? outputExtension
      : `.${outputExtension}`
    : extension;
  const patchStem = input.patchFiles
    .map((patch) => getFileNameParts(patch.patchFileName || "patch.bin").stem)
    .filter((value) => !!value)
    .join("-");
  const suffix = options.appendOutputSuffix === false ? "" : patchStem ? `-${patchStem}` : "-patched";
  return `${stem}${suffix}${normalizedOutputExtension || ".bin"}`;
};

const invokeRomWeaverCompressionCreateWorker = async (
  input: {
    codecs?: unknown;
    format?: string | null;
    invalidateMountCacheBeforeRun?: boolean;
    inputPaths: string[];
    knownInputPaths?: string[];
    levelProfile?: string | null;
    logLevel?: LogLevel | string;
    outputFileName: string;
    outputPath: string;
    preopenOutputPaths?: string[];
    signal?: AbortSignal;
    totalBytes?: number | null;
    virtualFiles?: RuntimeValue[];
    workerThreads?: RuntimeThreadBudgetInput;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const inputPaths = Array.isArray(input.inputPaths)
    ? input.inputPaths.map((pathValue) => String(pathValue || "").trim()).filter((pathValue) => !!pathValue)
    : [];
  if (!inputPaths.length) throw new Error("Compression create requires at least one input path");
  const outputPath = String(input.outputPath || "").trim();
  if (!outputPath) throw new Error("Compression create output path is required");

  const format = String(input.format || "").trim();
  const normalizedFormat = format.toLowerCase();
  const configuredCodecs = normalizeCodecEntries(input.codecs);
  const normalizedChdCodecs = isChdCompressionFormat(normalizedFormat)
    ? normalizeChdCodecArgs(configuredCodecs)
    : { codecs: configuredCodecs, stripped: false };
  if (normalizedChdCodecs.stripped) {
    emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson compress normalized chd codec levels", {
      configuredCodecs,
      normalizedCodecs: normalizedChdCodecs.codecs,
    });
  }
  const codecs = normalizedChdCodecs.codecs;
  const levelProfile = normalizeCompressionLevelProfile(input.levelProfile);
  const threadResolution = resolveCompressionCreateThreadArg({
    codecs,
    format,
    levelProfile,
    totalBytes: input.totalBytes,
    workerThreads: input.workerThreads,
  });
  const threadArg = threadResolution.threadArg;
  if (
    threadResolution.threadCap !== null &&
    !Object.is(threadResolution.threadArg, threadResolution.requestedThreadArg)
  ) {
    emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson compress normalized browser thread cap", {
      format,
      requestedThreadArg: threadResolution.requestedThreadArg,
      threadArg,
      threadCap: threadResolution.threadCap,
      totalBytes: input.totalBytes ?? null,
      zipZstdLevel: threadResolution.zipZstdLevel,
    });
  }
  const command = createRomWeaverCommand("compress", {
    codec: codecs,
    format: format || undefined,
    input: inputPaths,
    level: (levelProfile || "max") as CompressionLevelProfile,
    output: outputPath,
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson compress dispatch", {
    command,
    format,
    inputCount: inputPaths.length,
    outputPath,
    threadArg,
  });

  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      invalidateMountCacheBeforeRun: input.invalidateMountCacheBeforeRun,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      preopenOutputPaths: input.preopenOutputPaths,
      signal: input.signal,
      virtualFiles: input.virtualFiles,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Compression create failed");
    throw new Error(failureMessage);
  }

  const emitted = getEmittedFiles(result)[0];
  return {
    fileName: input.outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
    timing: getRunResultTiming(result),
  };
};

const invokeRomWeaverExtractWorker = async (
  input: {
    invalidateMountCacheBeforeRun?: boolean;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    outDirPath: string;
    preopenOutputPaths?: string[];
    scratchFilePoolSize?: number | null;
    select?: string[];
    romFilter?: boolean;
    patchFilter?: boolean;
    checksumAlgorithms?: string[];
    sourcePath: string;
    signal?: AbortSignal;
    splitBin?: boolean;
    workerThreads?: RuntimeThreadBudgetInput;
    /** When false, let the Rust core recursively descend nested containers in this one extract
     * (resolving a single payload per level via the interactive callback). Defaults to true, which
     * keeps the legacy single-level extract behaviour for existing per-entry callers. */
    noNestedExtract?: boolean;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ emittedFiles: RomWeaverEmittedFile[] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Compression extract source path is required");
  const outDirPath = String(input.outDirPath || "").trim();
  if (!outDirPath) throw new Error("Compression extract output directory is required");

  const select: string[] = [];
  for (const selected of Array.isArray(input.select) ? input.select : []) {
    const value = String(selected || "").trim();
    if (!value) continue;
    select.push(value);
  }
  const checksum: string[] = [];
  for (const algorithm of Array.isArray(input.checksumAlgorithms) ? input.checksumAlgorithms : []) {
    const value = String(algorithm || "").trim();
    if (value) checksum.push(value);
  }
  const threadArg = toThreadBudget(input.workerThreads);
  const command = createRomWeaverCommand("extract", {
    checksum,
    no_nested_extract: input.noNestedExtract !== false,
    out_dir: outDirPath,
    ...(input.romFilter ? { rom_filter: true } : {}),
    ...(input.patchFilter ? { patch_filter: true } : {}),
    select,
    source: sourcePath,
    ...(input.splitBin ? { split_bin: true } : {}),
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson extract dispatch", {
    command,
    outDirPath,
    patchFilter: !!input.patchFilter,
    romFilter: !!input.romFilter,
    selectCount: Array.isArray(input.select) ? input.select.length : 0,
    sourcePath,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      invalidateMountCacheBeforeRun: input.invalidateMountCacheBeforeRun,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      preopenOutputPaths: input.preopenOutputPaths,
      scratchFilePoolSize: input.scratchFilePoolSize,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const operationLabel =
      select.length === 1
        ? `extract \`${select[0]}\``
        : select.length > 1
          ? `extract ${select.length} entries`
          : "extract output";
    await throwRomWeaverFailureWithBrowserOutputContext(result, "Compression extract failed", operationLabel);
  }
  return {
    emittedFiles: getEmittedFiles(result),
  };
};

const runRomWeaverListWorker = async (
  input: {
    logLevel?: LogLevel | string;
    romFilter?: boolean;
    patchFilter?: boolean;
    sourcePath: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ entries: CompressionListResult["entries"] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Compression list source path is required");
  const command = createRomWeaverCommand("list", {
    ...(input.romFilter ? { rom_filter: true } : {}),
    ...(input.patchFilter ? { patch_filter: true } : {}),
    source: sourcePath,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson list dispatch", {
    command,
    patchFilter: !!input.patchFilter,
    romFilter: !!input.romFilter,
    sourcePath,
  });
  const runList = () =>
    runRomWeaverJson(
      command,
      toRomWeaverOptions({
        logLevel: input.logLevel,
        onEvent: (event) => {
          const progress = toSimpleProgress(event);
          if (progress) onProgress?.(progress);
        },
        onLog,
        signal: input.signal,
      }),
    );
  const result = await runList();
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Compression listing failed");
    throw new Error(failureMessage);
  }
  const entries = getContainerEntriesFromList(result);
  return { entries };
};

const runRomWeaverProbePatchWorker = async (
  input: {
    logLevel?: LogLevel | string;
    patchFilter?: boolean;
    sourcePath: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RomWeaverProbePatchDetails> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Patch probe source path is required");
  const command = createRomWeaverCommand("probe", {
    ...(input.patchFilter ? { patch_filter: true } : {}),
    source: sourcePath,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson probe-patch dispatch", {
    command,
    patchFilter: !!input.patchFilter,
    sourcePath,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Patch probe failed");
    throw new Error(failureMessage);
  }
  return getPatchDetailsFromProbe(result);
};

const normalizePatchValidationChecksumEntries = (value: unknown): string[] => {
  const entries: string[] = [];
  const push = (algorithm: string, checksum: unknown) => {
    const normalizedAlgorithm = String(algorithm || "")
      .trim()
      .toLowerCase();
    const normalizedChecksum = toOptionalChecksumHex(checksum);
    if (normalizedAlgorithm && normalizedChecksum) entries.push(`${normalizedAlgorithm}=${normalizedChecksum}`);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) entries.push(entry.trim());
      else {
        const record = asRecord(entry);
        if (record) {
          for (const [algorithm, checksum] of Object.entries(record)) push(algorithm, checksum);
        }
      }
    }
    return entries;
  }
  const record = asRecord(value);
  if (!record) return entries;
  for (const [algorithm, checksum] of Object.entries(record)) push(algorithm, checksum);
  return entries;
};

const getPatchValidationRequirements = (options: RuntimePatchValidateWorkerInput["options"]) => {
  const optionRecord = asRecord(options);
  const requirementsValue = optionRecord?.validationRequirements;
  if (Array.isArray(requirementsValue)) return asRecord(requirementsValue[0]) || null;
  return asRecord(requirementsValue);
};

const invokeRomWeaverPatchValidateWorker = async (
  input: RuntimePatchValidateWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ message?: string; status: "passed" }> => {
  const requirements = getPatchValidationRequirements(input.options);
  const optionRecord = asRecord(input.options);
  const sourceCrc32 = toOptionalUint32Hex(requirements?.sourceCrc32 ?? requirements?.source_crc32);
  const validateWithChecksums = [
    ...normalizePatchValidationChecksumEntries(
      optionRecord?.validateWithChecksums ?? optionRecord?.validate_with_checksums,
    ),
    ...(sourceCrc32 ? [`crc32=${sourceCrc32}`] : []),
  ];
  const checksumCache = normalizePatchValidationChecksumEntries(
    optionRecord?.checksumCache ?? optionRecord?.checksum_cache,
  );
  const validateWithSize = toOptionalInt(requirements?.sourceSize ?? requirements?.source_size);
  const validateWithMinSize = toOptionalInt(requirements?.minimumSourceSize ?? requirements?.minimum_source_size);
  const removeHeader = Boolean((input.options as { removeHeader?: unknown } | undefined)?.removeHeader);
  const ignoreChecksumValidation = Boolean(
    (input.options as { ignoreChecksumValidation?: unknown; ignore_checksum_validation?: unknown } | undefined)
      ?.ignoreChecksumValidation ||
      (input.options as { ignoreChecksumValidation?: unknown; ignore_checksum_validation?: unknown } | undefined)
        ?.ignore_checksum_validation,
  );
  const requestedThreadArg = toThreadBudget((input.options as { workerThreads?: unknown } | undefined)?.workerThreads);
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles);
  const disableDefaultThreadArgInjection = hasBpsPatch && !threadArg;
  const virtualOnlyMounts = hasBpsPatch;
  const scratchFilePoolSize = hasBpsPatch ? 8 : 64;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command = createRomWeaverCommand("patch-validate", {
    ...(checksumCache.length ? { checksum_cache: checksumCache } : {}),
    ignore_checksum_validation: ignoreChecksumValidation,
    input: input.romFilePath,
    no_extract: true,
    patch_filter: true,
    patches: input.patchFiles.map((patch) => patch.patchFilePath),
    rom_filter: true,
    strip_header: removeHeader,
    ...(threadArg ? { threads: threadArg } : {}),
    ...(validateWithChecksums.length ? { validate_with_checksums: validateWithChecksums } : {}),
    ...(validateWithMinSize === undefined ? {} : { validate_with_min_size: BigInt(validateWithMinSize) }),
    ...(validateWithSize === undefined ? {} : { validate_with_size: BigInt(validateWithSize) }),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-validate dispatch", {
    command,
    disableDefaultThreadArgInjection,
    forcedSingleThread,
    forceSingleThreadReason,
    hasBpsPatch,
    hasXdeltaPatch,
    patchCount: input.patchFiles.length,
    requestedThreadArg,
    romFilePath: input.romFilePath,
    scratchFilePoolSize,
    syncAccessMode: syncAccessMode || "",
    threadArg,
    validateWithChecksums,
    validateWithMinSize,
    validateWithSize,
    virtualOnlyMounts,
  });

  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      defaultThreads: disableDefaultThreadArgInjection ? 0 : undefined,
      invalidateMountCacheBeforeRun: true,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      scratchFilePoolSize,
      signal: input.signal,
      syncAccessMode,
      virtualOnlyMounts,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = await appendBrowserStorageContext(
      getRomWeaverFailureMessage(result, "Patch validation failed"),
    );
    throw new Error(failureMessage);
  }

  const terminal = getTerminalEvent(result);
  return {
    message: terminal ? getRomWeaverRunEventLabel(terminal) : "Patch validation passed",
    status: "passed",
  };
};

const invokeRomWeaverPatchApplyWorker = async (
  input: RuntimePatchApplyWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
  onBeforeRun?: (outputPath: string) => Promise<void> | void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPatchApplyOutputFileName(input);
  const outputPath = selectRomWeaverOutputPath(
    input.romFilePath,
    outputFileName,
    input.patchFiles.map((patch) => patch.patchFilePath),
  );
  const applyOptionRecord = asRecord(input.options);
  const removeHeader = Boolean((input.options as { removeHeader?: unknown } | undefined)?.removeHeader);
  const addHeader = Boolean((input.options as { addHeader?: unknown } | undefined)?.addHeader);
  const repairChecksum = Boolean((input.options as { fixChecksum?: unknown } | undefined)?.fixChecksum);
  const ignoreChecksumValidation =
    (input.options as { requireInputChecksumMatch?: unknown } | undefined)?.requireInputChecksumMatch !== true;
  const validateWithChecksums = normalizePatchValidationChecksumEntries(
    applyOptionRecord?.validateWithChecksums ?? applyOptionRecord?.validate_with_checksums,
  );
  const validateWithOutputChecksums = normalizePatchValidationChecksumEntries(
    applyOptionRecord?.validateWithOutputChecksums ?? applyOptionRecord?.validate_with_output_checksums,
  );
  const ppfUndoAware = Boolean(applyOptionRecord?.ppfUndoAware ?? applyOptionRecord?.ppf_undo_aware);
  const requestedThreadArg = toThreadBudget((input.options as { workerThreads?: unknown } | undefined)?.workerThreads);
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles);
  const disableDefaultThreadArgInjection = hasBpsPatch && !threadArg;
  const virtualOnlyMounts = hasBpsPatch;
  const scratchFilePoolSize = hasBpsPatch ? 8 : 64;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command = createRomWeaverCommand("patch-apply", {
    add_header: addHeader,
    ignore_checksum_validation: ignoreChecksumValidation,
    input: input.romFilePath,
    no_compress: true,
    output: outputPath,
    patch_filter: true,
    patches: input.patchFiles.map((patch) => patch.patchFilePath),
    ...(ppfUndoAware ? { ppf_undo_aware: true } : {}),
    repair_checksum: repairChecksum,
    rom_filter: true,
    strip_header: removeHeader,
    ...(threadArg ? { threads: threadArg } : {}),
    ...(validateWithChecksums.length ? { validate_with_checksums: validateWithChecksums } : {}),
    ...(validateWithOutputChecksums.length ? { validate_with_output_checksums: validateWithOutputChecksums } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-apply dispatch", {
    command,
    disableDefaultThreadArgInjection,
    forcedSingleThread,
    forceSingleThreadReason,
    hasBpsPatch,
    hasXdeltaPatch,
    outputPath,
    patchCount: input.patchFiles.length,
    requestedThreadArg,
    romFilePath: input.romFilePath,
    scratchFilePoolSize,
    syncAccessMode: syncAccessMode || "",
    threadArg,
    virtualOnlyMounts,
  });
  if (isTraceEnabled(input.logLevel)) {
    emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "browser storage before patch-apply", {
      storage: await getBrowserStorageEstimateState(),
    });
  }
  await onBeforeRun?.(outputPath);

  let result: RomWeaverRunJsonResult;
  try {
    result = await runRomWeaverJson(
      command,
      toRomWeaverOptions({
        defaultThreads: disableDefaultThreadArgInjection ? 0 : undefined,
        invalidateMountCacheBeforeRun: true,
        logLevel: input.logLevel,
        onEvent: (event) => {
          const progress = toSimpleProgress(event);
          if (progress) onProgress?.(progress);
        },
        onLog,
        preopenOutputPaths: [outputPath],
        scratchFilePoolSize,
        signal: input.signal,
        syncAccessMode,
        virtualOnlyMounts,
      }),
    );
  } catch (error) {
    if (input.signal?.aborted) await Promise.resolve(onBeforeRun?.(outputPath)).catch(() => undefined);
    throw error;
  }
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = await appendBrowserStorageContext(getRomWeaverFailureMessage(result, "Patch apply failed"));
    const traceContext = isTraceEnabled(input.logLevel)
      ? ` [context: hasBpsPatch=${String(hasBpsPatch)} hasXdeltaPatch=${String(
          hasXdeltaPatch,
        )} forcedSingleThread=${String(forcedSingleThread)} reason=${forceSingleThreadReason || "none"} threadArg=${
          threadArg || "none"
        }]`
      : "";
    if (isTraceEnabled(input.logLevel)) {
      const traceTail = Array.isArray(result.traceNonJsonLines)
        ? result.traceNonJsonLines
            .map((line) => String(line || "").trim())
            .filter((line) => !!line)
            .slice(-8)
            .join(" | ")
        : "";
      if (traceTail) throw new Error(`${failureMessage}${traceContext} [trace: ${traceTail}]`);
    }
    throw new Error(`${failureMessage}${traceContext}`);
  }

  const emitted = getEmittedFileDetails(result);
  const lastEvent = getLastEvent(result);
  const patchFormat = lastEvent ? getRomWeaverRunEventFormat(lastEvent) || "PATCH" : "PATCH";
  return {
    applySummary: {
      outputSize: emitted?.sizeBytes,
      patches: input.patchFiles.map((patch) => ({
        fileName: patch.patchFileName || getPathBaseName(patch.patchFilePath, "patch.bin"),
        format: String(patchFormat),
      })),
      rom: {
        fileName: input.romFileName || getPathBaseName(input.romFilePath, "input.bin"),
      },
      timing: getRunResultTiming(result),
    },
    fileName: outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
    timing: getRunResultTiming(result),
  };
};

const readPatchCreateFormatCandidates = (result: RomWeaverRunJsonResult): RuntimePatchCreateFormatCandidates => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const candidates = asRecord(details?.patch_create_format_candidates);
  const rawFormats = Array.isArray(candidates?.formats) ? candidates.formats : [];
  const formats = rawFormats
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter((value) => !!value);
  const defaultFormat =
    (typeof candidates?.default === "string" ? candidates.default.trim().toLowerCase() : "") ||
    (terminal
      ? String(getRomWeaverRunEventFormat(terminal) || "")
          .trim()
          .toLowerCase()
      : "") ||
    formats[0] ||
    "bps";
  const rawLimits = asRecord(candidates?.limits);
  const limits: Record<string, number> = {};
  if (rawLimits) {
    for (const [key, value] of Object.entries(rawLimits)) {
      if (typeof value === "number" && Number.isFinite(value)) limits[key] = value;
    }
  }
  return {
    defaultFormat,
    formats: formats.length ? formats : [defaultFormat],
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(asRecord(candidates?.source_values) ? { sourceValues: asRecord(candidates?.source_values) || undefined } : {}),
  };
};

const invokeRomWeaverCreatePatchCandidatesWorker = async (
  input: RuntimePatchCreateCandidatesWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RuntimePatchCreateFormatCandidates> => {
  const threadArg = toThreadBudget(input.workerThreads);
  const command = createRomWeaverCommand("patch-create-candidates", {
    modified: input.modifiedFilePath,
    original: input.originalFilePath,
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create-candidates dispatch", {
    command,
    modifiedFileName: input.modifiedFileName,
    modifiedFilePath: input.modifiedFilePath,
    originalFileName: input.originalFileName,
    originalFilePath: input.originalFilePath,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Patch create candidate selection failed");
  return readPatchCreateFormatCandidates(result);
};

const invokeRomWeaverCreatePatchWorker = async (
  input: RuntimePatchCreateWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
  onBeforeRun?: (outputPath: string) => Promise<void> | void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPathBaseName(
    input.outputName || `patch.${String(input.format || "bin").toLowerCase()}`,
    `patch.${String(input.format || "bin").toLowerCase()}`,
  );
  const outputPath = selectRomWeaverOutputPath(input.modifiedFilePath || input.originalFilePath, outputFileName, [
    input.originalFilePath,
    input.modifiedFilePath,
  ]);
  const threadArg = toThreadBudget(input.workerThreads);
  const command = createRomWeaverCommand("patch-create", {
    format: input.format,
    modified: input.modifiedFilePath,
    original: input.originalFilePath,
    output: outputPath,
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create dispatch", {
    command,
    modifiedFilePath: input.modifiedFilePath,
    originalFilePath: input.originalFilePath,
    outputPath,
    threadArg,
  });
  await onBeforeRun?.(outputPath);

  let result: RomWeaverRunJsonResult;
  try {
    result = await runRomWeaverJson(
      command,
      toRomWeaverOptions({
        logLevel: input.logLevel,
        onEvent: (event) => {
          const progress = toSimpleProgress(event);
          if (progress) onProgress?.(progress);
        },
        onLog,
        preopenOutputPaths: [outputPath],
        signal: input.signal,
      }),
    );
  } catch (error) {
    if (input.signal?.aborted) await Promise.resolve(onBeforeRun?.(outputPath)).catch(() => undefined);
    throw error;
  }
  ensureRomWeaverSuccess(result, "Patch create failed");

  const emitted = getEmittedFileDetails(result);
  return {
    fileName: outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
    timing: getRunResultTiming(result),
  };
};

const invokeRomWeaverTrimWorker = async (
  input: RuntimeTrimWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
  onBeforeRun?: (outputPath: string) => Promise<void> | void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const sourceFilePath = String(input.sourceFilePath || "").trim();
  if (!sourceFilePath) throw new Error("Trim source path is required");
  const outputFileName = getTrimOutputFileName(sourceFilePath, input.outputName);
  const outputPath = selectRomWeaverOutputPath(sourceFilePath, outputFileName, [sourceFilePath]);
  const normalizedExtension = typeof input.extension === "string" ? input.extension.trim() : "";
  const threadArg = toThreadBudget(input.workerThreads);
  // Matches the Rust `TrimCommand`: `source: Vec<PathBuf>` (required), `output: Option<PathBuf>`
  // (conflicts with `in_place`), `extension: Option<String>`, `in_place`, `dry_run`, `revert`,
  // `recursive` (defaults true), `threads`. We always write a new file (`in_place: false`), never
  // simulate (`dry_run: false`), and never restore padding (`revert: false`).
  const command = createRomWeaverCommand("trim", {
    dry_run: false,
    in_place: false,
    output: outputPath,
    revert: false,
    source: [sourceFilePath],
    ...(normalizedExtension ? { extension: normalizedExtension } : {}),
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson trim dispatch", {
    command,
    extension: normalizedExtension || "",
    outputPath,
    sourceFilePath,
    threadArg,
  });
  await onBeforeRun?.(outputPath);

  let result: RomWeaverRunJsonResult;
  try {
    result = await runRomWeaverJson(
      command,
      toRomWeaverOptions({
        logLevel: input.logLevel,
        onEvent: (event) => {
          const progress = toSimpleProgress(event);
          if (progress) onProgress?.(progress);
        },
        onLog,
        preopenOutputPaths: [outputPath],
        signal: input.signal,
      }),
    );
  } catch (error) {
    if (input.signal?.aborted) await Promise.resolve(onBeforeRun?.(outputPath)).catch(() => undefined);
    throw error;
  }
  ensureRomWeaverSuccess(result, "Trim failed");

  const emitted = getEmittedFileDetails(result);
  return {
    fileName: outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
    timing: getRunResultTiming(result),
  };
};

const normalizeChecksumResult = (
  checksums: Partial<ChecksumResult>,
  algorithm: string,
  value: string,
): Partial<ChecksumResult> => {
  const normalizedAlgorithm = algorithm.trim().toLowerCase();
  if (!normalizedAlgorithm) return checksums;
  if (normalizedAlgorithm === "crc32") {
    checksums.crc32 = Number.parseInt(value, 16) >>> 0;
    return checksums;
  }
  if (normalizedAlgorithm === "adler32") {
    checksums.adler32 = Number.parseInt(value, 16) >>> 0;
    return checksums;
  }
  if (normalizedAlgorithm === "md5") {
    checksums.md5 = value.toLowerCase();
    return checksums;
  }
  if (normalizedAlgorithm === "sha1") {
    checksums.sha1 = value.toLowerCase();
    return checksums;
  }
  return checksums;
};

const parseChecksumLabel = (label: string): Partial<ChecksumResult> => {
  const out: Partial<ChecksumResult> = {};
  for (const match of label.matchAll(CHECKSUM_PAIR_REGEX)) {
    const algorithm = match[1];
    const value = match[2];
    if (!(algorithm && value)) continue;
    normalizeChecksumResult(out, algorithm, value);
  }
  return out;
};

const parseChecksumRomProbeLabel = (label: string): ChecksumRomProbe => {
  const trimmedInputBytes = label.match(/\btrimmed_input_bytes=(\d+)\b/)?.[1];
  const mode = label.match(/\bmode=([^;\s]+)\b/)?.[1];
  const preservedDownloadPlayCert = label.match(/\bpreserved_download_play_cert=(true|false)\b/)?.[1];
  const detected = typeof trimmedInputBytes === "string";
  return {
    trim: {
      detected,
      ...(mode ? { mode } : {}),
      ...(preservedDownloadPlayCert ? { preservedDownloadPlayCert: preservedDownloadPlayCert === "true" } : {}),
      ...(detected ? { trimmedInputBytes: Number.parseInt(trimmedInputBytes, 10) } : {}),
    },
  };
};

const runRomWeaverChecksumWorker = async (
  input: {
    checksumAlgorithms: string[];
    checksumStartOffset?: number;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    logLevel?: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ checksums: ChecksumResult }> => {
  const filePath = String(input.filePath || "").trim();
  if (!filePath) throw new Error("Checksum input path is required");
  const algorithms = Array.isArray(input.checksumAlgorithms)
    ? input.checksumAlgorithms
        .map((algorithm) =>
          String(algorithm || "")
            .trim()
            .toLowerCase(),
        )
        .filter((algorithm) => !!algorithm)
    : [];
  if (!algorithms.length) throw new Error("Checksum requires at least one algorithm");

  const checksumStart =
    typeof input.checksumStartOffset === "number" &&
    Number.isFinite(input.checksumStartOffset) &&
    input.checksumStartOffset > 0
      ? BigInt(Math.floor(input.checksumStartOffset))
      : undefined;
  const command = createRomWeaverCommand("checksum", {
    algo: algorithms,
    no_extract: true,
    source: filePath,
    ...(checksumStart === undefined ? {} : { start: checksumStart }),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson checksum dispatch", {
    algorithms,
    command,
    filePath,
    startOffset: input.checksumStartOffset,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
    }),
  );
  ensureRomWeaverSuccess(result, "Checksum calculation failed");

  const terminal = getLastEvent(result);
  const label = terminal ? getRomWeaverRunEventLabel(terminal) : "";
  const checksums = parseChecksumLabel(label);
  return {
    checksums: {
      crc32: checksums.crc32 || 0,
      md5: checksums.md5 || "",
      romProbe: parseChecksumRomProbeLabel(label),
      sha1: checksums.sha1 || "",
      ...(checksums.adler32 === undefined ? {} : { adler32: checksums.adler32 }),
    } as ChecksumResult,
  };
};

export {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverPatchApplyWorker,
  invokeRomWeaverPatchValidateWorker,
  invokeRomWeaverTrimWorker,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  resolveCompressionCreateThreadArg,
  resolvePatchApplyThreadArg,
  runRomWeaverChecksumWorker,
  runRomWeaverListWorker,
  runRomWeaverProbePatchWorker,
  selectRomWeaverOutputPath,
};
