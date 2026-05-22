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
  runRomWeaverJson,
} from "../../workers/rom-weaver/rom-weaver-runner.ts";

const CHECKSUM_PAIR_REGEX = /([a-z0-9_-]+)=([0-9a-f]+)/gi;
const PATH_PART_SPLIT_REGEX = /[/\\]+/;
const PATH_FILE_CAPTURE_REGEX = /^(.+[/\\])?([^/\\]+)$/;
const FILE_EXTENSION_CAPTURE_REGEX = /^(.+?)(\.[^./\\]*)?$/;
const COMPRESSION_LEVEL_PROFILE_REGEX = /^(min|very-low|low|medium|high|very-high|max)$/i;
const WORK_ROOT_PATH = "/work";
const WORK_OUTPUT_PATH = "/work/output";

const nowIso = () => new Date().toISOString();

const emitRuntimeLog = (
  onLog: ((log: WorkflowRuntimeLog) => void) | undefined,
  level: WorkflowRuntimeLog["level"],
  message: string,
  details: Record<string, unknown>,
) => {
  onLog?.({
    details,
    level,
    message,
    namespace: "runtime:rom-weaver",
    timestamp: nowIso(),
  });
};

const clampPercent = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
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

const isTraceEnabled = (logLevel: LogLevel | string | undefined) => String(logLevel || "").toLowerCase() === "trace";

const toRomWeaverOptions = (input: {
  logLevel?: LogLevel | string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onLog?: (log: WorkflowRuntimeLog) => void;
}): RomWeaverRunJsonOptions => ({
  onEvent: input.onEvent,
  onTraceEvent: isTraceEnabled(input.logLevel)
    ? (event) => emitRuntimeLog(input.onLog, "trace", "rom-weaver.trace", { event })
    : undefined,
  onTraceNonJsonLine: (line) => {
    const message = String(line || "").trim();
    if (!message) return;
    emitRuntimeLog(input.onLog, "trace", "rom-weaver.stderr", { line: message });
  },
});

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
  fileName: string;
  kind?: string;
  path: string;
  sizeBytes?: number;
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
): { label?: string; message?: string; percent?: number | null } => ({
  label: typeof event.label === "string" && event.label ? event.label : undefined,
  message: undefined,
  percent: clampPercent(event.percent),
});

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

const toPatchProgress = (event: RomWeaverRunJsonEvent): RuntimePatchWorkerProgress => ({
  label: typeof event.label === "string" && event.label ? event.label : undefined,
  message: undefined,
  percent: clampPercent(event.percent),
});

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

  const args = ["compress", ...inputPaths, "--output", outputPath];
  const format = String(input.format || "").trim();
  if (format) args.push("--format", format);
  for (const codec of normalizeCodecEntries(input.codecs)) args.push("--codec", codec);
  const levelProfile = normalizeCompressionLevelProfile(input.levelProfile);
  if (levelProfile) args.push("--level", levelProfile);
  const threadArg = toThreadArg(input.workerThreads, "1");
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");

  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => onProgress?.(toSimpleProgress(event)),
      onLog,
    }),
  );
  ensureRomWeaverSuccess(result, "Compression create failed");

  const emitted = getEmittedFiles(result)[0];
  return {
    fileName: input.outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
  };
};

const invokeRomWeaverExtractWorker = async (
  input: {
    logLevel?: LogLevel | string;
    outDirPath: string;
    select?: string[];
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
  if (input.splitBin) args.push("--split-bin");
  const threadArg = toThreadArg(input.workerThreads, "1");
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => onProgress?.(toSimpleProgress(event)),
      onLog,
    }),
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
  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => onProgress?.(toSimpleProgress(event)),
      onLog,
    }),
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

  const threadArg = toThreadArg((input.options as { workerThreads?: unknown } | undefined)?.workerThreads);
  if (threadArg) args.push("--threads", threadArg);
  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  await onBeforeRun?.(outputPath);

  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        onProgress?.(toPatchProgress(event));
      },
      onLog,
    }),
  );
  ensureRomWeaverSuccess(result, "Patch apply failed");

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
  await onBeforeRun?.(outputPath);

  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        onProgress?.(toPatchProgress(event));
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

  const args = ["checksum", filePath, "--no-extract"];
  for (const algorithm of algorithms) args.push("--algo", algorithm);

  if (
    typeof input.checksumStartOffset === "number" &&
    Number.isFinite(input.checksumStartOffset) &&
    input.checksumStartOffset > 0
  )
    args.push("--start", String(Math.floor(input.checksumStartOffset)));

  if (isTraceEnabled(input.logLevel)) args.unshift("--trace");
  const result = await runRomWeaverJson(
    args,
    toRomWeaverOptions({
      logLevel: input.logLevel,
      onEvent: (event) => {
        onProgress?.({
          label: typeof event.label === "string" && event.label ? event.label : undefined,
          message: undefined,
          percent: clampPercent(event.percent),
        });
      },
      onLog,
    }),
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
  normalizeCodecEntries,
  runRomWeaverChecksumWorker,
  runRomWeaverInspectListWorker,
  selectRomWeaverOutputPath,
};
