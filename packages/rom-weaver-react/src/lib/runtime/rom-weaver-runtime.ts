import type { ChecksumResult } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { CompressionListResult } from "../../types/workflow-runtime.ts";
import type {
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import {
  getRomWeaverFailureMessage,
  type RomWeaverRunJsonEvent,
  type RomWeaverRunJsonOptions,
  type RomWeaverRunJsonResult,
  resetRomWeaverRunner,
  runRomWeaverJson,
} from "../../workers/rom-weaver/rom-weaver-runner.ts";

const CHECKSUM_PAIR_REGEX = /([a-z0-9_-]+)=([0-9a-f]+)/gi;
const PATH_PART_SPLIT_REGEX = /[/\\]+/;
const PATH_FILE_CAPTURE_REGEX = /^(.+[/\\])?([^/\\]+)$/;
const FILE_EXTENSION_CAPTURE_REGEX = /^(.+?)(\.[^./\\]*)?$/;
const CODEC_LEVEL_ENTRY_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/i;
const COMPRESSION_LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;
const WASI_THREAD_FAILURE_REGEX = /(wasi thread\s+\d+\s+failed|thread\s+\d+\s+failed before completion)/i;
const THREAD_RUNTIME_TRAP_REGEX = /table index is out of bounds/i;
const OUT_OF_MEMORY_FAILURE_REGEX = /\bout of memory\b|\bmemory allocation\b|\bcannot allocate memory\b/i;
const WORK_ROOT_PATH = "/work";
const WORK_OUTPUT_PATH = "/work/output";

const nowIso = () => new Date().toISOString();

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
  const status = typeof event.status === "string" ? event.status.toLowerCase() : "";
  return !status || status === "running";
};

const toThreadArg = (value: unknown, fallback: string | null = null): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed >= 1 ? String(parsed) : fallback;
  }
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "auto") return "auto";
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? String(parsed) : fallback;
};

const XDELTA_PATCH_FILE_EXTENSION_REGEX = /\.(?:xdelta|vcdiff)$/i;
const BPS_PATCH_FILE_EXTENSION_REGEX = /\.bps$/i;

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
  requestedThreadArg: string | null,
  patchFiles: Array<{ patchFileName?: string; patchFilePath?: string }>,
) => {
  const hasXdeltaPatch = patchFiles.some((patch) => {
    return isXdeltaPatchPath(patch.patchFilePath) || isXdeltaPatchPath(patch.patchFileName);
  });
  const hasBpsPatch = patchFiles.some((patch) => {
    return isBpsPatchPath(patch.patchFilePath) || isBpsPatchPath(patch.patchFileName);
  });
  if (hasXdeltaPatch) {
    return {
      forcedSingleThread: requestedThreadArg !== "1",
      forceSingleThreadReason: "xdelta",
      hasBpsPatch,
      hasXdeltaPatch,
      preferThreadedWasm: false,
      threadArg: "1",
    };
  }
  if (hasBpsPatch) {
    return {
      forcedSingleThread: false,
      forceSingleThreadReason: "bps",
      hasBpsPatch,
      hasXdeltaPatch,
      preferThreadedWasm: false,
      threadArg: null,
    };
  }
  return {
    forcedSingleThread: false,
    forceSingleThreadReason: "",
    hasBpsPatch,
    hasXdeltaPatch,
    preferThreadedWasm: true,
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

const toRomWeaverOptions = (input: {
  defaultThreads?: number | null;
  invalidateMountCacheBeforeRun?: boolean;
  logLevel?: LogLevel | string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onLog?: (log: WorkflowRuntimeLog) => void;
  preferThreadedWasm?: boolean;
  scratchFilePoolSize?: number | null;
  syncAccessMode?: string;
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
  };
  if (traceEnabled) {
    options.env = {
      RUST_BACKTRACE: "full",
    };
  }
  if (typeof input.scratchFilePoolSize === "number" && Number.isFinite(input.scratchFilePoolSize)) {
    options.scratchFilePoolSize = Math.max(0, Math.floor(input.scratchFilePoolSize));
  }
  if (typeof input.defaultThreads === "number" && Number.isFinite(input.defaultThreads)) {
    options.defaultThreads = Math.floor(input.defaultThreads);
  }
  if (typeof input.syncAccessMode === "string" && input.syncAccessMode.trim()) {
    options.syncAccessMode = input.syncAccessMode.trim();
  }
  if (input.invalidateMountCacheBeforeRun) options.invalidateMountCacheBeforeRun = true;
  if (typeof input.preferThreadedWasm === "boolean") options.preferThreadedWasm = input.preferThreadedWasm;
  if (typeof input.virtualOnlyMounts === "boolean") options.virtualOnlyMounts = input.virtualOnlyMounts;
  return options;
};

const getPathBaseName = (value: string, fallback: string): string => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  const parts = text.split(PATH_PART_SPLIT_REGEX).filter((part) => !!part);
  if (!parts.length) return fallback;
  return parts[parts.length - 1] || fallback;
};

const getPathDirectory = (filePath: string): string => {
  const match = String(filePath || "").match(PATH_FILE_CAPTURE_REGEX);
  return match?.[1] || "";
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

const getPreferredOutputDirectory = (sourcePath: string): string => {
  const normalizedSourcePath = normalizeAbsolutePosixPath(sourcePath);
  if (normalizedSourcePath === WORK_ROOT_PATH || normalizedSourcePath.startsWith(`${WORK_ROOT_PATH}/`)) {
    return WORK_OUTPUT_PATH;
  }
  return getPathDirectory(sourcePath);
};

let romWeaverOutputPathId = 0;

const selectRomWeaverOutputPath = (sourcePath: string, outputFileName: string, blockedPaths: string[] = []) => {
  const directory = getPreferredOutputDirectory(sourcePath);
  const preferredPath = joinPath(directory, outputFileName);
  const normalizedBlocked = new Set(
    [sourcePath, ...blockedPaths].map((pathValue) => String(pathValue || "").trim()).filter((pathValue) => !!pathValue),
  );
  if (!normalizedBlocked.has(preferredPath)) return preferredPath;
  romWeaverOutputPathId++;
  return joinPath(directory, `.rom-weaver-output-${romWeaverOutputPathId}-${outputFileName}`);
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
    const status = typeof event?.status === "string" ? event.status.toLowerCase() : "";
    if (status === "succeeded" || status === "failed") return event || null;
  }
  return getLastEvent(result);
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
  const details = asRecord(terminal?.details);
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

const getContainerEntriesFromInspect = (result: RomWeaverRunJsonResult): string[] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal?.details);
  const container = asRecord(details?.container);
  const entries = Array.isArray(container?.entries) ? container.entries : [];
  return entries.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => !!entry);
};

const toSimpleProgress = (
  event: RomWeaverRunJsonEvent,
): { label?: string; message?: string; percent?: number | null } | null => {
  if (!isLiveProgressEvent(event)) return null;
  return {
    label: typeof event.label === "string" && event.label ? event.label : undefined,
    message: undefined,
    percent: clampPercent(event.percent),
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
  return COMPRESSION_LEVEL_PROFILE_REGEX.test(normalized) ? normalized : null;
};

const ensureRomWeaverSuccess = (result: RomWeaverRunJsonResult, fallbackMessage: string) => {
  if (result.ok && result.exitCode === 0) return;
  throw new Error(getRomWeaverFailureMessage(result, fallbackMessage));
};

const isOutOfMemoryFailure = (message: string) => OUT_OF_MEMORY_FAILURE_REGEX.test(String(message || "").toLowerCase());

const runRomWeaverJsonWithRetryOnOutOfMemory = async (
  args: string[],
  options: RomWeaverRunJsonOptions,
  fallbackFailureMessage: string,
  trace: {
    commandLabel: string;
    logLevel?: LogLevel | string;
    onLog?: (log: WorkflowRuntimeLog) => void;
  },
): Promise<RomWeaverRunJsonResult> => {
  try {
    const result = await runRomWeaverJson(args, options);
    if (result.ok && result.exitCode === 0) return result;
    const failureMessage = getRomWeaverFailureMessage(result, fallbackFailureMessage);
    if (!isOutOfMemoryFailure(failureMessage)) return result;
    emitRuntimeTrace({ logLevel: trace.logLevel, onLog: trace.onLog }, "runJson retry after OOM", {
      args,
      command: trace.commandLabel,
      failureMessage,
      reason: "runner-reset",
    });
    await resetRomWeaverRunner().catch(() => undefined);
    return runRomWeaverJson(args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isOutOfMemoryFailure(message)) throw error;
    emitRuntimeTrace({ logLevel: trace.logLevel, onLog: trace.onLog }, "runJson retry after OOM throw", {
      args,
      command: trace.commandLabel,
      message,
      reason: "runner-reset",
    });
    await resetRomWeaverRunner().catch(() => undefined);
    return runRomWeaverJson(args, options);
  }
};

const isThreadedWorkerFailure = (message: string) =>
  WASI_THREAD_FAILURE_REGEX.test(message) || THREAD_RUNTIME_TRAP_REGEX.test(message);

const normalizeChdCodecArgs = (codecs: string[]) => {
  const explicitLevels = new Set<string>();
  const strippedCodecs: string[] = [];
  const strippedSeen = new Set<string>();
  for (const codecEntry of codecs) {
    const trimmed = String(codecEntry || "").trim();
    if (!trimmed) continue;
    const match = trimmed.match(CODEC_LEVEL_ENTRY_REGEX);
    if (!match) {
      if (!strippedSeen.has(trimmed)) {
        strippedSeen.add(trimmed);
        strippedCodecs.push(trimmed);
      }
      continue;
    }
    const codecName = match[1] || trimmed;
    const level = match[2];
    if (level !== undefined) explicitLevels.add(level);
    if (!strippedSeen.has(codecName)) {
      strippedSeen.add(codecName);
      strippedCodecs.push(codecName);
    }
  }

  // CHD codec sets cannot mix per-codec levels; keep user codec order but remove level suffixes on conflicts.
  if (explicitLevels.size <= 1) return { codecs, stripped: false };
  return { codecs: strippedCodecs, stripped: true };
};

const getFileNameParts = (fileName: string) => {
  const match = getPathBaseName(fileName, "input.bin").match(FILE_EXTENSION_CAPTURE_REGEX);
  return {
    extension: match?.[2] || "",
    stem: match?.[1] || getPathBaseName(fileName, "input.bin"),
  };
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

const toPatchProgress = (event: RomWeaverRunJsonEvent): RuntimePatchWorkerProgress | null => {
  if (!isLiveProgressEvent(event)) return null;
  return {
    label: typeof event.label === "string" && event.label ? event.label : undefined,
    message: undefined,
    percent: clampPercent(event.percent),
  };
};

const invokeRomWeaverCompressionCreateWorker = async (
  input: {
    codecs?: unknown;
    format?: string | null;
    inputPaths: string[];
    levelProfile?: string | null;
    logLevel?: LogLevel | string;
    outputFileName: string;
    outputPath: string;
    workerThreads?: number | string | null;
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
  const normalizedChdCodecs =
    normalizedFormat === "chd"
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
  const traceEnabled = isTraceEnabled(input.logLevel);
  const buildArgs = (threadArg: string | null) => {
    const args = ["compress", ...inputPaths, "--output", outputPath];
    if (format) args.push("--format", format);
    for (const codec of codecs) args.push("--codec", codec);
    if (levelProfile) args.push("--level", levelProfile);
    if (threadArg) args.push("--threads", threadArg);
    if (traceEnabled) args.unshift("--trace");
    return args;
  };
  const threadArg = toThreadArg(input.workerThreads);
  const args = buildArgs(threadArg);
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson compress dispatch", {
    args,
    format,
    inputCount: inputPaths.length,
    outputPath,
    threadArg,
  });

  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
    }),
    "Compression create failed",
    {
      commandLabel: "compress",
      logLevel: input.logLevel,
      onLog,
    },
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Compression create failed");
    if (threadArg && threadArg !== "1" && isThreadedWorkerFailure(failureMessage)) {
      const fallbackArgs = buildArgs("1");
      emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson compress retry single-thread", {
        failureMessage,
        fallbackArgs,
      });
      const fallbackResult = await runRomWeaverJsonWithRetryOnOutOfMemory(
        fallbackArgs,
        toRomWeaverOptions({
          logLevel: input.logLevel,
          onEvent: (event) => {
            const progress = toSimpleProgress(event);
            if (progress) onProgress?.(progress);
          },
          onLog,
        }),
        "Compression create failed after single-thread retry",
        {
          commandLabel: "compress",
          logLevel: input.logLevel,
          onLog,
        },
      );
      ensureRomWeaverSuccess(fallbackResult, "Compression create failed after single-thread retry");
      const fallbackEmitted = getEmittedFiles(fallbackResult)[0];
      return {
        fileName: input.outputFileName,
        filePath: fallbackEmitted?.path || outputPath,
        size: fallbackEmitted?.sizeBytes,
      };
    }
    throw new Error(failureMessage);
  }

  const emitted = getEmittedFiles(result)[0];
  return {
    fileName: input.outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
  };
};

const invokeRomWeaverExtractWorker = async (
  input: {
    invalidateMountCacheBeforeRun?: boolean;
    logLevel?: LogLevel | string;
    outDirPath: string;
    scratchFilePoolSize?: number | null;
    select?: string[];
    checksumAlgorithms?: string[];
    sourcePath: string;
    splitBin?: boolean;
    workerThreads?: number | string | null;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ emittedFiles: RomWeaverEmittedFile[] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Compression extract source path is required");
  const outDirPath = String(input.outDirPath || "").trim();
  if (!outDirPath) throw new Error("Compression extract output directory is required");

  const args = ["extract", sourcePath, "--out-dir", outDirPath];
  for (const selected of Array.isArray(input.select) ? input.select : []) {
    const value = String(selected || "").trim();
    if (!value) continue;
    args.push("--select", value);
  }
  for (const algorithm of Array.isArray(input.checksumAlgorithms) ? input.checksumAlgorithms : []) {
    const value = String(algorithm || "").trim();
    if (value) args.push("--checksum", value);
  }
  args.push("--no-nested-extract");
  if (input.splitBin) args.push("--split-bin");
  const threadArg = toThreadArg(input.workerThreads);
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson extract dispatch", {
    args,
    outDirPath,
    selectCount: Array.isArray(input.select) ? input.select.length : 0,
    sourcePath,
    threadArg,
  });
  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      invalidateMountCacheBeforeRun: input.invalidateMountCacheBeforeRun,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      scratchFilePoolSize: input.scratchFilePoolSize,
    }),
    "Compression extract failed",
    {
      commandLabel: "extract",
      logLevel: input.logLevel,
      onLog,
    },
  );
  ensureRomWeaverSuccess(result, "Compression extract failed");
  return {
    emittedFiles: getEmittedFiles(result),
  };
};

const runRomWeaverInspectListWorker = async (
  input: {
    logLevel?: LogLevel | string;
    sourcePath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ entries: CompressionListResult["entries"] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Compression list source path is required");
  const args = ["inspect", "--list", sourcePath];
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson inspect-list dispatch", {
    args,
    sourcePath,
  });
  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
    }),
    "Compression listing failed",
    {
      commandLabel: "inspect",
      logLevel: input.logLevel,
      onLog,
    },
  );
  ensureRomWeaverSuccess(result, "Compression listing failed");
  const entries = getContainerEntriesFromInspect(result);
  return {
    entries: entries.map((entryName) => ({
      fileName: entryName,
      filename: entryName,
      name: getPathBaseName(entryName, entryName),
    })),
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
  const args: string[] = ["patch-apply", "--input", input.romFilePath];
  for (const patch of input.patchFiles) {
    args.push("--patch", patch.patchFilePath);
  }
  args.push("--output", outputPath, "--no-compress");

  if ((input.options as { removeHeader?: unknown } | undefined)?.removeHeader) args.push("--strip-header");
  if ((input.options as { addHeader?: unknown } | undefined)?.addHeader) args.push("--add-header");
  if ((input.options as { fixChecksum?: unknown } | undefined)?.fixChecksum) args.push("--repair-checksum");
  if ((input.options as { requireInputChecksumMatch?: unknown } | undefined)?.requireInputChecksumMatch !== true)
    args.push("--ignore-checksum-validation");

  const requestedThreadArg = toThreadArg((input.options as { workerThreads?: unknown } | undefined)?.workerThreads);
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, preferThreadedWasm, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles);
  const disableDefaultThreadArgInjection = hasBpsPatch && !threadArg;
  const virtualOnlyMounts = hasBpsPatch;
  const scratchFilePoolSize = hasBpsPatch ? 8 : 1;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-apply dispatch", {
    args,
    disableDefaultThreadArgInjection,
    forcedSingleThread,
    forceSingleThreadReason,
    hasBpsPatch,
    hasXdeltaPatch,
    outputPath,
    patchCount: input.patchFiles.length,
    preferThreadedWasm,
    requestedThreadArg,
    romFilePath: input.romFilePath,
    scratchFilePoolSize,
    syncAccessMode: syncAccessMode || "",
    threadArg,
    virtualOnlyMounts,
  });
  await onBeforeRun?.(outputPath);

  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      defaultThreads: disableDefaultThreadArgInjection ? 0 : undefined,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toPatchProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      preferThreadedWasm,
      scratchFilePoolSize,
      syncAccessMode,
      virtualOnlyMounts,
    }),
    "Patch apply failed",
    {
      commandLabel: "patch-apply",
      logLevel: input.logLevel,
      onLog,
    },
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Patch apply failed");
    const traceContext = isTraceEnabled(input.logLevel)
      ? ` [context: hasBpsPatch=${String(hasBpsPatch)} hasXdeltaPatch=${String(
          hasXdeltaPatch,
        )} forcedSingleThread=${String(forcedSingleThread)} reason=${forceSingleThreadReason || "none"} threadArg=${
          threadArg || "none"
        } preferThreadedWasm=${String(preferThreadedWasm)}]`
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
  return {
    applySummary: {
      outputSize: emitted?.sizeBytes,
      patches: input.patchFiles.map((patch) => ({
        fileName: patch.patchFileName || getPathBaseName(patch.patchFilePath, "patch.bin"),
        format: String(getLastEvent(result)?.format || "PATCH"),
      })),
      rom: {
        fileName: input.romFileName || getPathBaseName(input.romFilePath, "input.bin"),
      },
    },
    fileName: outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
  };
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
  const args = [
    "patch-create",
    "--original",
    input.originalFilePath,
    "--modified",
    input.modifiedFilePath,
    "--format",
    input.format,
    "--output",
    outputPath,
  ];
  const threadArg = toThreadArg(input.workerThreads);
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create dispatch", {
    args,
    modifiedFilePath: input.modifiedFilePath,
    originalFilePath: input.originalFilePath,
    outputPath,
    threadArg,
  });
  await onBeforeRun?.(outputPath);

  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toPatchProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
    }),
    "Patch create failed",
    {
      commandLabel: "patch-create",
      logLevel: input.logLevel,
      onLog,
    },
  );
  ensureRomWeaverSuccess(result, "Patch create failed");

  const emitted = getEmittedFileDetails(result);
  return {
    fileName: outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
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

  const args = ["checksum", filePath, "--no-extract"];
  for (const algorithm of algorithms) args.push("--algo", algorithm);

  if (
    typeof input.checksumStartOffset === "number" &&
    Number.isFinite(input.checksumStartOffset) &&
    input.checksumStartOffset > 0
  )
    args.push("--start", String(Math.floor(input.checksumStartOffset)));

  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson checksum dispatch", {
    algorithms,
    args,
    filePath,
    startOffset: input.checksumStartOffset,
  });
  const result = await runRomWeaverJsonWithRetryOnOutOfMemory(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        if (!isLiveProgressEvent(event)) return;
        onProgress?.({
          label: typeof event.label === "string" && event.label ? event.label : undefined,
          message: undefined,
          percent: clampPercent(event.percent),
        });
      },
      onLog,
    }),
    "Checksum calculation failed",
    {
      commandLabel: "checksum",
      logLevel: input.logLevel,
      onLog,
    },
  );
  ensureRomWeaverSuccess(result, "Checksum calculation failed");

  const terminal = getLastEvent(result);
  const checksums = parseChecksumLabel(typeof terminal?.label === "string" ? terminal.label : "");
  return {
    checksums: {
      crc32: checksums.crc32 || 0,
      md5: checksums.md5 || "",
      sha1: checksums.sha1 || "",
      ...(checksums.adler32 === undefined ? {} : { adler32: checksums.adler32 }),
    } as ChecksumResult,
  };
};

export {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverPatchApplyWorker,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  resolvePatchApplyThreadArg,
  runRomWeaverChecksumWorker,
  runRomWeaverInspectListWorker,
  selectRomWeaverOutputPath,
};
