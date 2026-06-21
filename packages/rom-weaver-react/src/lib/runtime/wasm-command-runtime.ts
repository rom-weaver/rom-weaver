import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { ChecksumResult } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
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
import type { CompressionListResult } from "../../types/workflow-runtime-types.ts";
import type { CompressionLevelProfile } from "../../wasm/index.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventFormat,
  getRomWeaverRunEventLabel,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import {
  getRomWeaverFailureMessage,
  runRomWeaverJson,
  withRomWeaverFailureKind,
} from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { getPathBaseName } from "../path-utils.ts";
import {
  parseChecksumDetails,
  parseChecksumLabel,
  parseChecksumRomProbeLabel,
  parseChecksumRomType,
} from "./checksum-output-parsing.ts";
import {
  isChdCompressionFormat,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  normalizeCompressionLevelProfile,
} from "./compression-codec-args.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import type { RomWeaverProbePatchDetails } from "./patch-run-resolution.ts";
import {
  getPatchApplyOutputFileName,
  getPatchDetailsFromProbe,
  getPatchValidationRequirements,
  normalizePatchValidationChecksumEntries,
  readPatchCreateFormatCandidates,
  resolvePatchApplyThreadArg,
  toOptionalInt,
  toOptionalUint32Hex,
} from "./patch-run-resolution.ts";
import { emitRuntimeTrace, isTraceEnabled, toRomWeaverOptions } from "./run-options.ts";
import { getTrimOutputFileName, selectRomWeaverOutputPath } from "./run-output-paths.ts";
import type { RomWeaverEmittedFile, RomWeaverRunJsonResult } from "./run-result-parsing.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getChdMediaKindFromList,
  getContainerEntriesFromList,
  getEmittedFileDetails,
  getEmittedFiles,
  getLastEvent,
  getRunResultTiming,
  getTerminalEvent,
  parseChecksumVariants,
  toSimpleProgress,
} from "./run-result-parsing.ts";

// Raw inputs below this size never benefit from worker threads: the Rust core single-threads their
// checksum (a few-MB hash is fast serial), so injecting the default thread budget only makes the
// browser thread pool eagerly pre-warm ~20 workers (~900 ms cold) on the operation's critical path for
// threads the run never uses. Suppressing the default for small inputs lets the op start as soon as the
// wasm is instantiated. Mirrors the patch-apply `disableDefaultThreadArgInjection` gate. Applied to
// the checksum path only — for a raw input the byte size IS the data size, so the gate is exact. The
// extract path is NOT gated: a small archive can decompress to plenty of thread-worthy data, and
// gating it would single-thread the extract and drop its threaded decode/checksum timing.
const CHECKSUM_THREAD_POOL_FLOOR_BYTES = 4 * 1024 * 1024;

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
  const contextualized = await withBrowserOutputStorageFailureContext(new Error(message), {
    operationLabel,
  });
  const error = contextualized instanceof Error ? contextualized : new Error(String(contextualized || message));
  throw withRomWeaverFailureKind(error, result);
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
  // The zip+zstd browser memory thread cap is enforced authoritatively in Rust
  // (zip.rs create_thread_capability -> plan_threads negotiates the requested
  // count down to achievable.min(memory_cap)); forward the requested budget and
  // let the engine cap it. See docs/ts-rust-unification-plan.md (Task C).
  const threadArg = toThreadBudget(input.workerThreads);
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
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
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
    select?: string[];
    romFilter?: boolean;
    patchFilter?: boolean;
    checksumAlgorithms?: string[];
    /** Like `checksumAlgorithms` but only ROM-like outputs are hashed (sidecar/non-ROM entries
     * are skipped). Safe to always pass; ignored when `checksumAlgorithms` is also set. */
    checksumRomAlgorithms?: string[];
    /** Fold container/platform probe metadata into the result (and fail a single-payload
     * disc image that resolves to no known platform). Lets a caller skip a separate probe. */
    probe?: boolean;
    sourcePath: string;
    signal?: AbortSignal;
    splitBin?: boolean;
    workerThreads?: RuntimeThreadBudgetInput;
    /** When false, let the Rust core recursively descend nested containers in this one extract
     * (resolving a single payload per level via the interactive callback). Defaults to true, which
     * keeps the legacy single-level extract behaviour for existing per-entry callers. */
    noNestedExtract?: boolean;
    /** When false, suppress the host selection prompt for ambiguous containers so a multi-branch
     * archive auto-extracts every branch instead of pausing for input. Defaults to the runner's
     * interactive behaviour (prompt). */
    interactiveSelectionEnabled?: boolean;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ emittedFiles: RomWeaverEmittedFile[]; timing: ReturnType<typeof getRunResultTiming> }> => {
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
  const checksumRom: string[] = [];
  for (const algorithm of Array.isArray(input.checksumRomAlgorithms) ? input.checksumRomAlgorithms : []) {
    const value = String(algorithm || "").trim();
    if (value) checksumRom.push(value);
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
    ...(checksumRom.length ? { checksum_rom: checksumRom } : {}),
    ...(input.probe ? { probe: true } : {}),
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
      ...(typeof input.interactiveSelectionEnabled === "boolean"
        ? { interactiveSelectionEnabled: input.interactiveSelectionEnabled }
        : {}),
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
    // Run-level elapsed time for the whole extract; the runtime does not report per-file timing, so
    // callers attach this to each emitted file as its extract time.
    timing: getRunResultTiming(result),
  };
};

const runRomWeaverListWorker = async (
  input: {
    logLevel?: LogLevel | string;
    romFilter?: boolean;
    patchFilter?: boolean;
    sourcePath: string;
    signal?: AbortSignal;
    splitBin?: boolean;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ chdMediaKind?: string; entries: CompressionListResult["entries"] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Compression list source path is required");
  const command = createRomWeaverCommand("list", {
    ...(input.romFilter ? { rom_filter: true } : {}),
    ...(input.patchFilter ? { patch_filter: true } : {}),
    source: sourcePath,
    ...(input.splitBin ? { split_bin: true } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson list dispatch", {
    command,
    patchFilter: !!input.patchFilter,
    romFilter: !!input.romFilter,
    sourcePath,
    splitBin: !!input.splitBin,
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
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
  }
  const entries = getContainerEntriesFromList(result);
  return { chdMediaKind: getChdMediaKindFromList(result), entries };
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
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
  }
  return getPatchDetailsFromProbe(result);
};

type LibretroSidecarMatch = { name: string; order: number };

const getSidecarMatchesFromResult = (result: RomWeaverRunJsonResult): LibretroSidecarMatch[] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const raw = details?.sidecar_matches;
  if (!Array.isArray(raw)) return [];
  const matches: LibretroSidecarMatch[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name : "";
    if (!name) continue;
    const order = Number(record?.order);
    matches.push({ name, order: Number.isFinite(order) ? order : 0 });
  }
  return matches;
};

// Match RetroArch/libretro sidecar patches against a ROM via Rust's `match-sidecars` command, so the
// browser shares the native matcher instead of re-implementing the `<rom-stem>.<patch-ext>` rule. Pure
// name logic — no I/O — returning the matched patches in Rust's apply order.
const runRomWeaverMatchSidecarsWorker = async (
  input: { romName: string; patchNames: string[]; logLevel?: LogLevel | string; signal?: AbortSignal },
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<LibretroSidecarMatch[]> => {
  const romName = String(input.romName || "").trim();
  if (!(romName && input.patchNames.length)) return [];
  const command = createRomWeaverCommand("match-sidecars", {
    patch_names: input.patchNames,
    rom_name: romName,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson match-sidecars dispatch", {
    patchCount: input.patchNames.length,
    romName,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({ logLevel: input.logLevel, onLog, signal: input.signal }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    throw withRomWeaverFailureKind(new Error(getRomWeaverFailureMessage(result, "Sidecar match failed")), result);
  }
  return getSidecarMatchesFromResult(result);
};

const normalizeN64ByteOrder = (value: unknown): "big-endian" | "little-endian" | "byte-swapped" | undefined => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "big-endian" || normalized === "little-endian" || normalized === "byte-swapped"
    ? normalized
    : undefined;
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
  const n64ByteOrder = normalizeN64ByteOrder(optionRecord?.n64ByteOrder ?? optionRecord?.n64_byte_order);
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
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, singleThreadNoPool, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles, input.inputSize);
  // Some validates fan worker threads across the source: bps block-check CRCs, xdelta's per-window
  // decode, or a caller-requested source-checksum verification. Those MUST keep the runner's worker
  // pool — without it the engine spawns from an empty pool and panics (os error 6). The rest (PPF/
  // IPS/UPS structural + block checks) read a few hundred bytes single-threaded, so the pool spin-up
  // is pure setup/teardown and is skipped. The apply path keeps its own input-size gate since it
  // always reads+writes the source.
  const validateUsesThreadPool = hasBpsPatch || hasXdeltaPatch || validateWithChecksums.length > 0;
  const noWorkerPool = singleThreadNoPool || !validateUsesThreadPool;
  const effectiveThreadArg = noWorkerPool ? null : threadArg;
  const disableDefaultThreadArgInjection = noWorkerPool || (hasBpsPatch && !effectiveThreadArg);
  const virtualOnlyMounts = hasBpsPatch;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command = createRomWeaverCommand("patch-validate", {
    ...(checksumCache.length ? { checksum_cache: checksumCache } : {}),
    ignore_checksum_validation: ignoreChecksumValidation,
    input: input.romFilePath,
    ...(n64ByteOrder ? { n64_byte_order: n64ByteOrder } : {}),
    no_extract: true,
    patch_filter: true,
    patches: input.patchFiles.map((patch) => patch.patchFilePath),
    rom_filter: true,
    strip_header: removeHeader,
    ...(effectiveThreadArg ? { threads: effectiveThreadArg } : {}),
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
    n64ByteOrder,
    patchCount: input.patchFiles.length,
    requestedThreadArg,
    romFilePath: input.romFilePath,
    singleThreadNoPool: noWorkerPool,
    syncAccessMode: syncAccessMode || "",
    threadArg: effectiveThreadArg,
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
      signal: input.signal,
      syncAccessMode,
      virtualOnlyMounts,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    const failureMessage = await appendBrowserStorageContext(
      getRomWeaverFailureMessage(result, "Patch validation failed"),
    );
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
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
  const n64ByteOrder = normalizeN64ByteOrder(applyOptionRecord?.n64ByteOrder ?? applyOptionRecord?.n64_byte_order);
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
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, singleThreadNoPool, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles, input.inputSize);
  const disableDefaultThreadArgInjection = singleThreadNoPool || (hasBpsPatch && !threadArg);
  const virtualOnlyMounts = hasBpsPatch;
  const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command = createRomWeaverCommand("patch-apply", {
    add_header: addHeader,
    ignore_checksum_validation: ignoreChecksumValidation,
    input: input.romFilePath,
    ...(n64ByteOrder ? { n64_byte_order: n64ByteOrder } : {}),
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
    n64ByteOrder,
    outputPath,
    patchCount: input.patchFiles.length,
    requestedThreadArg,
    romFilePath: input.romFilePath,
    singleThreadNoPool,
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
      if (traceTail)
        throw withRomWeaverFailureKind(new Error(`${failureMessage}${traceContext} [trace: ${traceTail}]`), result);
    }
    throw withRomWeaverFailureKind(new Error(`${failureMessage}${traceContext}`), result);
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
    ...(input.checksumName ? { checksum_name: true } : {}),
    ...(input.sourceCrc32 ? { source_crc32: input.sourceCrc32 } : {}),
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
    // Rust may rename the output (e.g. `--checksum-name` embeds the source crc32),
    // so the emitted path is authoritative for the final file name.
    fileName: emitted?.path ? getPathBaseName(emitted.path, outputFileName) : outputFileName,
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

const runRomWeaverChecksumWorker = async (
  input: {
    checksumAlgorithms: string[];
    checksumStartOffset?: number;
    fileName?: string;
    filePath?: string;
    fileSize?: number;
    logLevel?: string;
    /** Fail the checksum unless the source resolves to a known platform. Off by default —
     * plain checksum happily hashes unidentified bytes. */
    probe?: boolean;
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
  // Sub-floor inputs hash fast single-threaded (the Rust core parallelizes only above the MT-floor),
  // so suppress the default thread budget to keep the browser thread pool from pre-warming for a
  // checksum that won't use it (see CHECKSUM_THREAD_POOL_FLOOR_BYTES).
  const suppressDefaultThreadPool =
    typeof input.fileSize === "number" && input.fileSize >= 0 && input.fileSize < CHECKSUM_THREAD_POOL_FLOOR_BYTES;
  // Cap the worker pool at the algorithm count. A checksum fans its algorithms across threads (and the
  // variant engine caps each variant at the algorithm count), so it can never use more than one worker
  // per algorithm — warming the full core count ("auto") just stands up wasm worker instances the hash
  // can't use, and each reserves a thread stack in shared linear memory. On memory-constrained
  // WebKit/iOS tabs that extra pile of instances OOMs the worker, which tears the runner down and
  // rebuilds it (the "page reloaded / lost my work" symptom). Extract escapes this because it runs
  // through the memory/thread-aware scheduler, which throttles its pool to a fraction of the cores.
  const checksumThreadBudget = suppressDefaultThreadPool ? 0 : Math.max(1, algorithms.length);
  const command = createRomWeaverCommand("checksum", {
    algo: algorithms,
    no_extract: true,
    source: filePath,
    ...(checksumStart === undefined ? {} : { start: checksumStart }),
    ...(input.probe ? { probe: true } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson checksum dispatch", {
    algorithms,
    command,
    filePath,
    startOffset: input.checksumStartOffset,
    suppressDefaultThreadPool,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      defaultThreads: checksumThreadBudget,
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
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const checksums = {
    ...parseChecksumLabel(label),
    ...parseChecksumDetails(details),
  };
  const variants = parseChecksumVariants(details);
  const romType = parseChecksumRomType(details);
  return {
    checksums: {
      crc32: checksums.crc32 || 0,
      md5: checksums.md5 || "",
      romProbe: parseChecksumRomProbeLabel(label),
      sha1: checksums.sha1 || "",
      ...(checksums.adler32 === undefined ? {} : { adler32: checksums.adler32 }),
      ...(romType ? { romType } : {}),
      ...(variants ? { variants } : {}),
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
  resolvePatchApplyThreadArg,
  runRomWeaverChecksumWorker,
  runRomWeaverListWorker,
  runRomWeaverMatchSidecarsWorker,
  runRomWeaverProbePatchWorker,
  selectRomWeaverOutputPath,
};
