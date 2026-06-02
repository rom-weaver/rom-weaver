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
import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { ChecksumResult } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { CompressionListResult } from "../../types/workflow-runtime.ts";
import type {
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateWorkerInput,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventFormat,
  getRomWeaverRunEventLabel,
  getRomWeaverRunEventPercent,
  isRomWeaverLiveRunEvent,
  isRomWeaverTerminalRunEvent,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, runRomWeaverJson } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { getFileNameParts, getPathBaseName, isCompressionLevelProfile } from "../path-utils.ts";

type RomWeaverRunJsonOptions = BaseRomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions;
type RomWeaverRunJsonResult = BaseRomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

const CHECKSUM_PAIR_REGEX = /([a-z0-9_-]+)=([0-9a-f]+)/gi;
const CODEC_LEVEL_ENTRY_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/i;
const WORK_ROOT_PATH = "/work";
const BROWSER_SYNC_ACCESS_MODES = new Set<RomWeaverBrowserSyncAccessMode>([
  "read-only",
  "readwrite",
  "readwrite-unsafe",
]);

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
  if (normalized === "auto") return "auto";
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
};

const toBrowserSyncAccessMode = (value: unknown): RomWeaverBrowserSyncAccessMode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim() as RomWeaverBrowserSyncAccessMode;
  return BROWSER_SYNC_ACCESS_MODES.has(normalized) ? normalized : undefined;
};

const XDELTA_PATCH_FILE_EXTENSION_REGEX = /\.(?:xdelta|vcdiff)$/i;
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
  scratchFilePoolSize?: number | null;
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

const getContainerEntriesFromInspect = (result: RomWeaverRunJsonResult): CompressionListResult["entries"] => {
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

type RomWeaverInspectPatchDetails = {
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

const getPatchDetailsFromInspect = (result: RomWeaverRunJsonResult): RomWeaverInspectPatchDetails => {
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

const toSimpleProgress = (
  event: RomWeaverRunJsonEvent,
): { label?: string; message?: string; percent?: number | null } | null => {
  if (!isLiveProgressEvent(event)) return null;
  const label = getRomWeaverRunEventLabel(event);
  return {
    label: label ? label : undefined,
    message: undefined,
    percent: clampPercent(getRomWeaverRunEventPercent(event)),
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
    virtualFiles?: RuntimeValue[];
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
  const threadArg = toThreadBudget(input.workerThreads);
  const command: RomWeaverCommand = {
    args: {
      codec: codecs,
      format: format || undefined,
      input: inputPaths,
      level: (levelProfile || "max") as CompressionLevelProfile,
      output: outputPath,
      ...(threadArg ? { threads: threadArg } : {}),
    },
    type: "compress",
  };
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
  const command: RomWeaverCommand = {
    args: {
      checksum,
      no_nested_extract: true,
      out_dir: outDirPath,
      select,
      source: sourcePath,
      ...(input.splitBin ? { split_bin: true } : {}),
      ...(threadArg ? { threads: threadArg } : {}),
    },
    type: "extract",
  };
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson extract dispatch", {
    command,
    outDirPath,
    selectCount: Array.isArray(input.select) ? input.select.length : 0,
    sourcePath,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
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
  const command: RomWeaverCommand = {
    args: {
      list: true,
      source: sourcePath,
    },
    type: "inspect",
  };
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson inspect-list dispatch", {
    command,
    sourcePath,
  });
  const runInspectList = () =>
    runRomWeaverJson(
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
  const result = await runInspectList();
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Compression listing failed");
    throw new Error(failureMessage);
  }
  const entries = getContainerEntriesFromInspect(result);
  return { entries };
};

const runRomWeaverInspectPatchWorker = async (
  input: {
    logLevel?: LogLevel | string;
    sourcePath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RomWeaverInspectPatchDetails> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Patch inspect source path is required");
  const command: RomWeaverCommand = {
    args: {
      source: sourcePath,
    },
    type: "inspect",
  };
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson inspect-patch dispatch", {
    command,
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
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = getRomWeaverFailureMessage(result, "Patch inspection failed");
    throw new Error(failureMessage);
  }
  return getPatchDetailsFromInspect(result);
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
  const command: RomWeaverCommand = {
    args: {
      ...(checksumCache.length ? { checksum_cache: checksumCache } : {}),
      ignore_checksum_validation: ignoreChecksumValidation,
      input: input.romFilePath,
      no_extract: true,
      patches: input.patchFiles.map((patch) => patch.patchFilePath),
      strip_header: removeHeader,
      ...(threadArg ? { threads: threadArg } : {}),
      ...(validateWithChecksums.length ? { validate_with_checksums: validateWithChecksums } : {}),
      ...(validateWithMinSize === undefined ? {} : { validate_with_min_size: BigInt(validateWithMinSize) }),
      ...(validateWithSize === undefined ? {} : { validate_with_size: BigInt(validateWithSize) }),
    },
    type: "patch-validate",
  };
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
  const removeHeader = Boolean((input.options as { removeHeader?: unknown } | undefined)?.removeHeader);
  const addHeader = Boolean((input.options as { addHeader?: unknown } | undefined)?.addHeader);
  const repairChecksum = Boolean((input.options as { fixChecksum?: unknown } | undefined)?.fixChecksum);
  const ignoreChecksumValidation =
    (input.options as { requireInputChecksumMatch?: unknown } | undefined)?.requireInputChecksumMatch !== true;
  const requestedThreadArg = toThreadBudget((input.options as { workerThreads?: unknown } | undefined)?.workerThreads);
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles);
  const disableDefaultThreadArgInjection = hasBpsPatch && !threadArg;
  const virtualOnlyMounts = hasBpsPatch;
  const scratchFilePoolSize = hasBpsPatch ? 8 : 64;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command: RomWeaverCommand = {
    args: {
      add_header: addHeader,
      ignore_checksum_validation: ignoreChecksumValidation,
      input: input.romFilePath,
      no_compress: true,
      output: outputPath,
      patches: input.patchFiles.map((patch) => patch.patchFilePath),
      repair_checksum: repairChecksum,
      strip_header: removeHeader,
      ...(threadArg ? { threads: threadArg } : {}),
    },
    type: "patch-apply",
  };
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
      syncAccessMode,
      virtualOnlyMounts,
    }),
  );
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
  const threadArg = toThreadBudget(input.workerThreads);
  const command: RomWeaverCommand = {
    args: {
      format: input.format,
      modified: input.modifiedFilePath,
      original: input.originalFilePath,
      output: outputPath,
      ...(threadArg ? { threads: threadArg } : {}),
    },
    type: "patch-create",
  };
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create dispatch", {
    command,
    modifiedFilePath: input.modifiedFilePath,
    originalFilePath: input.originalFilePath,
    outputPath,
    threadArg,
  });
  await onBeforeRun?.(outputPath);

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

  const checksumStart =
    typeof input.checksumStartOffset === "number" &&
    Number.isFinite(input.checksumStartOffset) &&
    input.checksumStartOffset > 0
      ? BigInt(Math.floor(input.checksumStartOffset))
      : undefined;
  const command: RomWeaverCommand = {
    args: {
      algo: algorithms,
      no_extract: true,
      source: filePath,
      ...(checksumStart === undefined ? {} : { start: checksumStart }),
    },
    type: "checksum",
  };
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
  const checksums = parseChecksumLabel(terminal ? getRomWeaverRunEventLabel(terminal) : "");
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
  invokeRomWeaverPatchValidateWorker,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  resolvePatchApplyThreadArg,
  runRomWeaverChecksumWorker,
  runRomWeaverInspectListWorker,
  runRomWeaverInspectPatchWorker,
  selectRomWeaverOutputPath,
};
