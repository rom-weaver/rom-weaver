import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import type { RuntimeThreadBudgetInput } from "../../types/workflow-runtime-adapter.ts";
import type { ThreadBudget } from "../../wasm/index.ts";
import { parseCompressionCodecEntry } from "../compression/codec-parser.ts";
import { normalizeCodecEntries } from "./compression-codec-args.ts";

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

export { resolveCompressionCreateThreadArg, toThreadBudget };
