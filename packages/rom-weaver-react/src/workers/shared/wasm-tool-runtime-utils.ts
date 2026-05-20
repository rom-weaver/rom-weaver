const FILE_QUERY_OR_HASH_SPLIT_REGEX = /[?#]/;
const LINE_BREAK_REGEX = /\r|\n/;
const FAILED_SUFFIX_REGEX = /\s+failed$/i;

type RuntimeRoot = typeof globalThis & {
  PatchFile?: new (...args: RuntimeValue[]) => RuntimeValue;
};

type PatchFileConstructor = new (...args: RuntimeValue[]) => RuntimeValue;

type BinaryLikeSource = ArrayBuffer | ArrayBufferView | { _u8array?: Uint8Array | null | undefined };

type WastToolRunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type WasmToolRunOptions = Record<string, RuntimeValue> & {
  onOutput?: (text: string) => void;
  wasmToolPhase?: string;
};

type WasmTool = {
  __romWeaverWasmAbort?: WasmToolAbortInfo | null;
  __wasmToolSelectionReason?: string;
  __wasmToolThreaded?: boolean;
  selectionReason?: string;
  supportsOnOutput?: boolean;
  threadCount?: number;
  threaded?: boolean;
  wasmToolName?: string;
  exists: (filePath: string) => boolean;
  unlink: (filePath: string) => void;
  run: (argv: string[], options: Record<string, RuntimeValue>) => Promise<WastToolRunResult>;
};

type WasmToolAbortInfo = {
  args: RuntimeValue[];
  message: string;
  timestamp: number;
};

type WasmToolErrorDetails = {
  toolName: string;
  phase: string;
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  threaded: boolean | null;
  threadCount: number | null;
  selectionReason: string;
  abortMessage: string;
  diagnosticMessage: string;
};

type WasmToolError = Error & {
  wasmTool?: WasmToolErrorDetails;
  cause?: RuntimeValue;
};

type ProgressOptions = {
  onProgress?: (progress: { label: string; percent: number | null; hasProgress?: boolean }) => void;
};

type ProgressEvent = {
  label: string;
  percent: number | null;
  [key: string]: RuntimeValue;
};

type ProgressExtraFields = Record<string, RuntimeValue>;

type MonotonicProgressEmitter = {
  emit: (percent: number | null, extra?: ProgressExtraFields) => void;
  getLastPercent: () => number;
  hasIntermediate: () => boolean;
};

type CoveredByteRangeTracker = {
  add: (rangeStart: number, rangeEnd: number) => number | null;
  getTotal: () => number;
};

type WasmToolSource = {
  source: RuntimeValue;
  fileName: string;
  fileSize: number | null;
  extension: string;
  inputPath: string | null;
  outputPath: string | null;
  shouldStageInput: boolean;
  allowInputBuffering: boolean;
  sourceDisplayFileName: string;
  archiveEntryName: string | null;
  archiveFileName: string | null;
  bytes?: Uint8Array | null;
  metadata: Record<string, RuntimeValue>;
};

type WasmToolSourceOptions = {
  allowInputBuffering?: boolean;
  fallbackFileName: string;
  fileNameKeys?: string[];
  inputPath?: string | null;
  outputPath?: string | null;
  shouldStageInput?: boolean;
  getExtension?: (source: RuntimeValue, fileName: string) => string;
  getBytes?: ((source: RuntimeValue) => Uint8Array | null | undefined) | null;
  getFileSize?: ((source: RuntimeValue) => number | null | undefined) | null;
};

type WasmToolOutputOptions<TMetadata extends object> = {
  source: WasmToolSource;
  outputData: BinaryLikeSource;
  outputName: string;
  readOutput: boolean;
  PatchFileClass: PatchFileConstructor;
  metadata: TMetadata;
  applyMetadata?: ((target: Record<string, RuntimeValue>, metadata: TMetadata) => void) | null;
};

type NormalizedProgressEvent = {
  label: string;
  percent: number | null;
  normalizedLabel: string;
  aliases: string[];
  resolvedFileName?: string;
  sourceDisplayFileName?: string;
};

const getPatchFileClass = (root: RuntimeRoot | null | undefined, PatchFileClass?: PatchFileConstructor) => {
  if (typeof PatchFileClass === "function") return PatchFileClass;
  if (root && typeof root.PatchFile === "function") return root.PatchFile;
  throw new Error("Rom Patcher JS: PatchFile not found");
};

const toUint8ArrayCopy = (source: BinaryLikeSource, fallbackMessage = "Invalid wasm tool output data") => {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  if (source && source._u8array instanceof Uint8Array) return source._u8array;
  throw new Error(fallbackMessage);
};

const toArrayBufferCopy = (source: BinaryLikeSource, fallbackMessage?: string) => {
  const u8array = toUint8ArrayCopy(source, fallbackMessage);
  const copy = new Uint8Array(u8array.byteLength);
  copy.set(u8array);
  return copy.buffer;
};

const getSourceMetadataValue = (source: RuntimeValue, keys: string[]) => {
  const sourceRecord =
    source && (typeof source === "object" || typeof source === "function")
      ? (source as Record<string, RuntimeValue>)
      : null;
  if (!sourceRecord) return undefined;
  for (const key of keys) {
    if (key && Object.hasOwn(sourceRecord, key)) {
      const value = sourceRecord[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
};

const normalizeFileName = (source: RuntimeValue, keys: string[], fallbackFileName: string) => {
  const directValue = getSourceMetadataValue(source, keys);
  if (directValue !== undefined) return String(directValue);
  const nestedFile = getSourceMetadataValue(source, ["_file", "file"]) as { name?: RuntimeValue } | undefined;
  if (
    nestedFile &&
    typeof nestedFile === "object" &&
    nestedFile.name !== undefined &&
    nestedFile.name !== null &&
    nestedFile.name !== ""
  )
    return String(nestedFile.name);
  return fallbackFileName;
};

const getFileExtension = (fileName: string) => {
  const normalized = String(fileName || "").split(FILE_QUERY_OR_HASH_SPLIT_REGEX, 1)[0] || "";
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
};

const normalizeSourceFileSize = (source: RuntimeValue, getFileSize?: WasmToolSourceOptions["getFileSize"]) => {
  if (typeof getFileSize === "function") {
    const explicitSize = getFileSize(source);
    if (typeof explicitSize === "number" && Number.isFinite(explicitSize)) return explicitSize;
  }
  const sourceRecord =
    source && (typeof source === "object" || typeof source === "function")
      ? (source as Record<string, RuntimeValue>)
      : null;
  if (!sourceRecord) return null;
  const fileSize = sourceRecord.fileSize;
  if (typeof fileSize === "number" && Number.isFinite(fileSize)) return fileSize;
  const nestedFile = sourceRecord._file as { size?: RuntimeValue } | undefined;
  if (nestedFile && typeof nestedFile.size === "number" && Number.isFinite(nestedFile.size)) return nestedFile.size;
  const sourceBytes = sourceRecord._u8array;
  if (sourceBytes instanceof Uint8Array) return sourceBytes.byteLength;
  return null;
};

const normalizeWasmToolSource = (source: RuntimeValue, options: WasmToolSourceOptions): WasmToolSource => {
  const fallbackFileName = String(options.fallbackFileName || "input.bin");
  const fileName = normalizeFileName(source, options.fileNameKeys || ["fileName", "name"], fallbackFileName);
  const extension =
    typeof options.getExtension === "function"
      ? String(options.getExtension(source, fileName) || "")
      : getFileExtension(fileName);
  const sourceRecord =
    source && (typeof source === "object" || typeof source === "function")
      ? (source as Record<string, RuntimeValue>)
      : null;
  const inputPath = options.inputPath || null;
  const outputPath = options.outputPath || null;
  const archiveEntryName =
    typeof sourceRecord?._archiveEntryName === "string" && sourceRecord._archiveEntryName
      ? sourceRecord._archiveEntryName
      : null;
  const archiveFileName =
    typeof sourceRecord?._archiveFileName === "string" && sourceRecord._archiveFileName
      ? sourceRecord._archiveFileName
      : null;
  const sourceDisplayFileName = archiveEntryName || fileName;
  const shouldStageInput = typeof options.shouldStageInput === "boolean" ? options.shouldStageInput : !inputPath;
  const allowInputBuffering = options.allowInputBuffering === true;
  const bytes = shouldStageInput && typeof options.getBytes === "function" ? options.getBytes(source) || null : null;

  return {
    allowInputBuffering,
    archiveEntryName,
    archiveFileName,
    bytes,
    extension,
    fileName,
    fileSize: normalizeSourceFileSize(source, options.getFileSize),
    inputPath,
    metadata: sourceRecord || {},
    outputPath,
    shouldStageInput,
    source,
    sourceDisplayFileName,
  };
};

const requireMountedInputOrBytes = (source: WasmToolSource, message: string) => {
  if (!source.shouldStageInput) return;
  if (source.allowInputBuffering !== true) throw new Error(message);
};

const formatArchiveSourceFileName = (source: WasmToolSource) =>
  source.archiveFileName
    ? `${source.archiveFileName} / ${source.archiveEntryName || source.fileName}`
    : source.archiveEntryName || source.fileName;

const createWasmToolOutput = <TMetadata extends object>(options: WasmToolOutputOptions<TMetadata>) => {
  const { PatchFileClass, outputData, outputName, readOutput, metadata, source } = options;
  if (!readOutput) return Object.assign({ fileName: outputName }, metadata);

  const outputFile = new PatchFileClass(toArrayBufferCopy(outputData)) as Record<string, RuntimeValue>;
  outputFile.fileName = outputName;
  if (typeof options.applyMetadata === "function") options.applyMetadata(outputFile, metadata);
  else Object.assign(outputFile, metadata);
  if (!Object.hasOwn(outputFile, "_sourceDisplayFileName"))
    outputFile._sourceDisplayFileName = source.sourceDisplayFileName;
  return outputFile;
};

const normalizeProgressLabel = (label: string) =>
  String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const normalizeProgressAliases = (labels: Array<string | null | undefined>) => {
  const normalized: string[] = [];
  for (const item of labels) {
    const label = normalizeProgressLabel(String(item || ""));
    if (!label || normalized.indexOf(label) !== -1) continue;
    normalized.push(label);
  }
  return normalized;
};

const createNormalizedProgressEvent = (
  label: string,
  percent: number | null,
  options?: {
    aliases?: Array<string | null | undefined>;
    resolvedFileName?: string;
    sourceDisplayFileName?: string | null;
  },
): NormalizedProgressEvent => ({
  aliases: normalizeProgressAliases([label, ...(options?.aliases || [])]),
  label,
  normalizedLabel: normalizeProgressLabel(label),
  percent: typeof percent === "number" ? percent : null,
  ...(options?.resolvedFileName ? { resolvedFileName: options.resolvedFileName } : {}),
  ...(options?.sourceDisplayFileName ? { sourceDisplayFileName: options.sourceDisplayFileName } : {}),
});

const matchesProgressLabel = (
  progress:
    | { label?: RuntimeValue; aliases?: RuntimeValue; normalizedLabel?: RuntimeValue; percent?: RuntimeValue }
    | null
    | undefined,
  matchers: Array<string | RegExp>,
) => {
  if (!progress || typeof progress !== "object") return false;
  if (typeof progress.percent !== "number" || !Number.isFinite(progress.percent)) return false;
  const aliases = Array.isArray(progress.aliases)
    ? (progress.aliases as RuntimeValue[]).filter((alias): alias is string => typeof alias === "string")
    : [];
  const labels = [progress.normalizedLabel, ...aliases, normalizeProgressLabel(String(progress.label || ""))].filter(
    (value): value is string => typeof value === "string" && !!value,
  );
  for (const matcher of matchers) {
    if (typeof matcher === "string") {
      const normalizedMatcher = normalizeProgressLabel(matcher);
      if (labels.indexOf(normalizedMatcher) !== -1) return true;
      continue;
    }
    if (matcher instanceof RegExp && labels.some((label) => matcher.test(label))) return true;
  }
  return false;
};

const removeIfExists = (tool: WasmTool, filePath: string) => {
  if (tool.exists(filePath)) tool.unlink(filePath);
};

const safeRemoveIfExists = (tool: WasmTool, filePath: string) => {
  try {
    removeIfExists(tool, filePath);
  } catch (_err) {
    /* ignore cleanup errors */
  }
};

const getErrorMessage = (error: RuntimeValue) => {
  if (!error) return "";
  if (error instanceof Error && typeof error.message === "string") return error.message.trim();
  const message = String(error).trim();
  return message === "[object Object]" ? "" : message;
};

const cleanDiagnosticText = (value: RuntimeValue) =>
  String(value || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");

const getWasmToolName = (tool: WasmTool, fallbackMessage?: string) => {
  if (typeof tool?.wasmToolName === "string" && tool.wasmToolName.trim()) return tool.wasmToolName.trim();
  const fallback = String(fallbackMessage || "")
    .replace(FAILED_SUFFIX_REGEX, "")
    .trim();
  return fallback || "wasm tool";
};

const getWasmToolSelectionReason = (tool: WasmTool) => {
  if (typeof tool?.selectionReason === "string") return tool.selectionReason;
  if (typeof tool?.__wasmToolSelectionReason === "string") return tool.__wasmToolSelectionReason;
  return "";
};

const getWasmToolThreaded = (tool: WasmTool) => {
  if (typeof tool?.threaded === "boolean") return tool.threaded;
  if (typeof tool?.__wasmToolThreaded === "boolean") return tool.__wasmToolThreaded;
  return null;
};

const createWasmToolError = ({
  tool,
  argv,
  status,
  stdout,
  stderr,
  fallbackMessage,
  phase,
  cause,
}: {
  tool: WasmTool;
  argv: string[];
  status: number | null;
  stdout?: string;
  stderr?: string;
  fallbackMessage?: string;
  phase?: string;
  cause?: RuntimeValue;
}) => {
  const toolName = getWasmToolName(tool, fallbackMessage);
  const abortInfo = tool?.__romWeaverWasmAbort || null;
  const abortMessage = cleanDiagnosticText(abortInfo?.message || "");
  const diagnosticMessage =
    cleanDiagnosticText(stderr) || cleanDiagnosticText(stdout) || abortMessage || getErrorMessage(cause);
  const statusText = typeof status === "number" && Number.isFinite(status) ? ` with status ${status}` : "";
  const phaseText = phase ? ` while ${phase}` : "";
  const commandText = argv.length ? ` (${argv.join(" ")})` : "";
  const message = `${toolName} failed${phaseText}${statusText}${commandText}: ${
    diagnosticMessage || fallbackMessage || "no diagnostic output"
  }`;
  const error = new Error(message) as WasmToolError;
  error.wasmTool = {
    abortMessage,
    argv: argv.slice(),
    diagnosticMessage: diagnosticMessage || "",
    phase: phase || "",
    selectionReason: getWasmToolSelectionReason(tool),
    status: typeof status === "number" && Number.isFinite(status) ? status : null,
    stderr: String(stderr || ""),
    stdout: String(stdout || ""),
    threadCount:
      typeof tool?.threadCount === "number" && Number.isFinite(tool.threadCount) ? Math.floor(tool.threadCount) : null,
    threaded: getWasmToolThreaded(tool),
    toolName,
  };
  if (cause !== undefined) error.cause = cause;
  return error;
};

const runWasmTool = (tool: WasmTool, argv: string[], options?: WasmToolRunOptions, fallbackMessage?: string) => {
  const resolvedOptions = options || {};
  const runOptions: Record<string, RuntimeValue> = {};
  for (const optionName in resolvedOptions) {
    if (Object.hasOwn(resolvedOptions, optionName) && optionName !== "onOutput" && optionName !== "wasmToolPhase")
      runOptions[optionName] = resolvedOptions[optionName];
  }

  if (typeof resolvedOptions.onOutput === "function" && tool.supportsOnOutput === true) {
    runOptions.onOutput = resolvedOptions.onOutput;
  }

  return tool.run(argv, runOptions).then(
    (result) => {
      if (result.status !== 0) {
        throw createWasmToolError({
          argv,
          fallbackMessage,
          phase: String(resolvedOptions.wasmToolPhase || ""),
          status: result.status,
          stderr: result.stderr,
          stdout: result.stdout,
          tool,
        });
      }
      return result;
    },
    (error) => {
      throw createWasmToolError({
        argv,
        cause: error,
        fallbackMessage,
        phase: String(resolvedOptions.wasmToolPhase || ""),
        status: null,
        tool,
      });
    },
  );
};

const getProgressPercent = (text: string, pattern: RegExp) => {
  const chunks = String(text || "").split(LINE_BREAK_REGEX);
  let percent: number | null = null;
  for (const item of chunks) {
    const match = item?.match(pattern);
    if (match) {
      const parsedPercent = parseFloat(match[1] || "");
      if (Number.isFinite(parsedPercent)) percent = Math.max(0, Math.min(100, parsedPercent));
    }
  }
  return percent;
};

const notifyProgress = (options: ProgressOptions | undefined, label: string, percent?: number | null) => {
  if (options && typeof options.onProgress === "function") {
    options.onProgress({
      ...(percent === undefined ? { hasProgress: false } : {}),
      label: label,
      percent: typeof percent === "number" ? percent : null,
    });
  }
};

const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent));
const normalizeProgressPercent = (percent: number) => Math.floor(clampPercent(percent));

const getProgressEventKey = (progress: ProgressEvent) =>
  [progress.label || "", progress.progressSource || "", progress.progressStream || "", progress.type || ""]
    .map((value) => String(value))
    .join("\0");

const createUniquePercentProgressCallback = (
  onProgress: ProgressOptions["onProgress"] | null | undefined,
): ProgressOptions["onProgress"] => {
  if (typeof onProgress !== "function") return undefined;
  const emittedPercents = new Map<string, Set<number>>();
  return (progress) => {
    if (typeof progress.percent !== "number") {
      onProgress(progress);
      return;
    }
    const normalizedProgress = {
      ...progress,
      percent: normalizeProgressPercent(progress.percent),
    };
    const key = getProgressEventKey(normalizedProgress as ProgressEvent);
    let percents = emittedPercents.get(key);
    if (!percents) {
      percents = new Set<number>();
      emittedPercents.set(key, percents);
    }
    if (percents.has(normalizedProgress.percent)) return;
    percents.add(normalizedProgress.percent);
    onProgress(normalizedProgress);
  };
};

const mapBytesToPercentRange = (completedBytes: number, totalBytes: number, startPercent = 0, endPercent = 100) => {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return clampPercent(startPercent);
  const clampedCompleted = Math.max(0, Math.min(totalBytes, completedBytes));
  const ratio = clampedCompleted / totalBytes;
  return clampPercent(startPercent + ratio * (endPercent - startPercent));
};

const createCoveredByteRangeTracker = (totalSize: number): CoveredByteRangeTracker => {
  const total = Number.isFinite(totalSize) ? Math.max(0, totalSize) : 0;
  let ranges: Array<{ start: number; end: number }> = [];
  let coveredBytes = 0;

  const recalculateCoveredBytes = () => {
    coveredBytes = 0;
    for (const current of ranges) coveredBytes += current.end - current.start;
  };

  const addClampedRange = (rangeStart: number, rangeEnd: number) => {
    let nextStart = rangeStart;
    let nextEnd = rangeEnd;
    const nextRanges: Array<{ start: number; end: number }> = [];
    let inserted = false;

    for (const current of ranges) {
      if (current.end < nextStart) {
        nextRanges.push(current);
        continue;
      }
      if (nextEnd < current.start) {
        if (!inserted) {
          nextRanges.push({ end: nextEnd, start: nextStart });
          inserted = true;
        }
        nextRanges.push(current);
        continue;
      }

      nextStart = Math.min(nextStart, current.start);
      nextEnd = Math.max(nextEnd, current.end);
    }

    if (!inserted) nextRanges.push({ end: nextEnd, start: nextStart });
    ranges = nextRanges;
    recalculateCoveredBytes();
    return coveredBytes;
  };

  return {
    add: (rangeStart: number, rangeEnd: number) => {
      if (!(total > 0) || rangeEnd <= rangeStart) return null;
      const clampedStart = Math.max(0, Math.min(total, rangeStart));
      const clampedEnd = Math.max(clampedStart, Math.min(total, rangeEnd));
      return addClampedRange(clampedStart, clampedEnd);
    },
    getTotal: () => total,
  };
};

const createMonotonicProgressEmitter = (
  options: ProgressOptions | undefined,
  label: string,
  config?: {
    minIntervalMs?: number;
    minPercentDelta?: number;
    baseFields?: ProgressExtraFields;
  },
): MonotonicProgressEmitter => {
  let lastPercent = -1;
  let sawIntermediate = false;
  const baseFields = config?.baseFields || {};
  const emitProgress = createUniquePercentProgressCallback(options?.onProgress);

  return {
    emit: (percent: number | null, extra?: ProgressExtraFields) => {
      if (percent === null) return;
      const nextPercent = normalizeProgressPercent(percent);
      if (nextPercent <= lastPercent) return;
      lastPercent = nextPercent;
      if (nextPercent > 0 && nextPercent < 100) sawIntermediate = true;
      if (emitProgress) {
        const progress: ProgressEvent = {
          ...baseFields,
          ...(extra || {}),
          label,
          percent: nextPercent,
        };
        emitProgress(progress);
      }
    },
    getLastPercent: () => Math.max(0, lastPercent),
    hasIntermediate: () => sawIntermediate,
  };
};

const extractProgressPercents = (text: string, pattern: RegExp) => {
  const chunks = String(text || "").split(LINE_BREAK_REGEX);
  const percents: number[] = [];
  let lastPercent = -1;
  for (const item of chunks) {
    const chunk = item || "";
    pattern.lastIndex = 0;
    let match = pattern.exec(chunk);
    while (match) {
      const currentMatch = match;
      match = pattern.exec(chunk);
      const parsedPercent = parseFloat(currentMatch[1] || "");
      if (!Number.isFinite(parsedPercent)) continue;
      const percent = normalizeProgressPercent(parsedPercent);
      if (percent <= lastPercent) continue;
      percents.push(percent);
      lastPercent = percent;
    }
  }
  return percents;
};

const hasUsableIntermediateProgress = (percents: number[]) => percents.some((percent) => percent > 0 && percent < 100);

const createProgressHandler = (
  options: ProgressOptions | undefined,
  label: string,
  getPercent: (text: string) => number | null,
) => {
  let lastPercent = -1;
  const emitProgress = createUniquePercentProgressCallback(options?.onProgress);

  return (text: string) => {
    const parsedPercent = getPercent(text);
    if (parsedPercent === null) return;
    const percent = normalizeProgressPercent(parsedPercent);
    if (percent <= lastPercent) return;
    lastPercent = percent;
    emitProgress?.({ label, percent });
  };
};

const yieldProgress = (delayMs = 0) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  });

export type { NormalizedProgressEvent, WasmToolOutputOptions, WasmToolSource, WasmToolSourceOptions };
export {
  clampPercent,
  createCoveredByteRangeTracker,
  createMonotonicProgressEmitter,
  createNormalizedProgressEvent,
  createProgressHandler,
  createUniquePercentProgressCallback,
  createWasmToolError,
  createWasmToolOutput,
  extractProgressPercents,
  formatArchiveSourceFileName,
  getFileExtension,
  getPatchFileClass,
  getProgressPercent,
  hasUsableIntermediateProgress,
  mapBytesToPercentRange,
  matchesProgressLabel,
  normalizeProgressAliases,
  normalizeProgressLabel,
  normalizeWasmToolSource,
  notifyProgress,
  removeIfExists,
  requireMountedInputOrBytes,
  runWasmTool,
  safeRemoveIfExists,
  toArrayBufferCopy,
  toUint8ArrayCopy,
  yieldProgress,
};
