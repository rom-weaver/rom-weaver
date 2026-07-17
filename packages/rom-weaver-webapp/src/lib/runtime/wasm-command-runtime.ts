import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { BundleHeaderMode, ParsedBundleCreateResult, ParsedBundleParseResult } from "../../types/bundle.ts";
import type { ParsedIngestResult } from "../../types/ingest.ts";
import type { LogLevel } from "../../types/logging.ts";
import type {
  PatchValidatePerPatchVerdict,
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
import type { CompressionProbeResult } from "../../types/workflow-runtime-types.ts";
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
import { parseBundleCreateResult, parseBundleParseResult } from "./bundle-result.ts";
import {
  isChdCompressionFormat,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  normalizeCompressionLevelProfile,
} from "./compression-codec-args.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { parseIngestResult } from "./ingest-result.ts";
import {
  getPatchApplyOutputFileName,
  getPatchValidationRequirements,
  normalizePatchValidationChecksumEntries,
  readPatchCreateFormatCandidates,
  resolvePatchApplyThreadArg,
  toOptionalInt,
  toOptionalUint32Hex,
} from "./patch-run-resolution.ts";
import { emitRuntimeTrace, isTraceEnabled, toRomWeaverOptions } from "./run-options.ts";
import { getTrimOutputFileName, runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import type { RomWeaverRunJsonResult } from "./run-result-parsing.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getContainerEntriesFromProbe,
  getEmittedFileDetails,
  getEmittedFiles,
  getLastEvent,
  getRunResultTiming,
  getTerminalEvent,
  toSimpleProgress,
} from "./run-result-parsing.ts";

const appendBrowserStorageContext = async (message: string, operationLabel: string) => {
  const contextualized = await withBrowserOutputStorageFailureContext(new Error(message), { operationLabel });
  if (!(contextualized instanceof Error) || contextualized.name !== "OutputStorageError") return message;
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
  return runWithRomWeaverOutputScope(inputPaths[0] || "", input.outputFileName, inputPaths, async (outputPath) => {
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
  });
};

// Enumerate a container's selectable entries without extracting, via the `probe` command's
// metadata-only (`no_extract`) path. Replaces the former `list` command - `probe` is a strict
// superset (it reports the same `details.container.entries`) and auto-detects the handler, so no
// per-format dispatch is needed.
const runRomWeaverProbeWorker = async (
  input: {
    logLevel?: LogLevel | string;
    romFilter?: boolean;
    patchFilter?: boolean;
    sourcePath: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ entries: CompressionProbeResult["entries"] }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Container probe source path is required");
  const command = createRomWeaverCommand("probe", {
    ...(input.romFilter ? { rom_filter: true } : {}),
    ...(input.patchFilter ? { patch_filter: true } : {}),
    no_extract: true,
    source: sourcePath,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson probe dispatch", {
    command,
    patchFilter: !!input.patchFilter,
    romFilter: !!input.romFilter,
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
    const failureMessage = getRomWeaverFailureMessage(result, "Container probe failed");
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
  }
  return { entries: getContainerEntriesFromProbe(result) };
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

// Match loose RetroArch/libretro sidecar patches through ingest, so archive-bundled and sibling files
// share the same Rust matcher and report shape.
const runRomWeaverIngestSidecarsWorker = async (
  input: { romName: string; patchNames: string[]; logLevel?: LogLevel | string; signal?: AbortSignal },
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<LibretroSidecarMatch[]> => {
  const romName = String(input.romName || "").trim();
  if (!(romName && input.patchNames.length)) return [];
  const command = createRomWeaverCommand("ingest", {
    out_dir: "/work/sidecar-match",
    sidecar_names: input.patchNames,
    sidecar_only: true,
    source: romName,
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson ingest sidecar dispatch", {
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

// Read the independent-mode per-patch verdicts from a patch-validate terminal event's
// `details.patch_validation.per_patch`. The chained (default) path emits no such array, so the
// result is empty and the caller falls back to its single whole-call verdict.
const parsePatchValidatePerPatch = (terminal: ReturnType<typeof getTerminalEvent>): PatchValidatePerPatchVerdict[] => {
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const validation = asRecord(details?.patch_validation);
  const rawPerPatch = validation?.per_patch;
  if (!Array.isArray(rawPerPatch)) return [];
  const verdicts: PatchValidatePerPatchVerdict[] = [];
  for (const raw of rawPerPatch) {
    const record = asRecord(raw);
    if (!record) continue;
    const index = Number(record.index);
    if (!Number.isInteger(index) || index < 0) continue;
    verdicts.push({
      index,
      ...(typeof record.format === "string" ? { format: record.format } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
      ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
      status: record.status === "failed" ? "failed" : "passed",
    });
  }
  return verdicts;
};

const invokeRomWeaverPatchValidateWorker = async (
  input: RuntimePatchValidateWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{ message?: string; perPatch?: PatchValidatePerPatchVerdict[]; status: "passed" | "mixed" }> => {
  const independent = Boolean((input.options as { independent?: unknown } | undefined)?.independent);
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
  // pool - without it the engine spawns from an empty pool and panics (os error 6). The rest (PPF/
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
    ...(independent ? { independent: true } : {}),
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
      "validate patch output",
    );
    throw withRomWeaverFailureKind(new Error(failureMessage), result);
  }

  const terminal = getTerminalEvent(result);
  const perPatch = parsePatchValidatePerPatch(terminal);
  const status = perPatch.some((verdict) => verdict.status === "failed") ? "mixed" : "passed";
  return {
    message: terminal ? getRomWeaverRunEventLabel(terminal) : "Patch validation passed",
    ...(perPatch.length ? { perPatch } : {}),
    status,
  };
};

const invokeRomWeaverPatchApplyWorker = async (
  input: RuntimePatchApplyWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPatchApplyOutputFileName(input);
  return runWithRomWeaverOutputScope(
    input.romFilePath,
    outputFileName,
    input.patchFiles.map((patch) => patch.patchFilePath),
    async (outputPath) => {
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
      // One header mode per patch (chain order). The browser resolved the FIRST patch
      // against the staged checksum variants, so entry 0 is always concrete ("keep"/
      // "strip") and suppresses an engine re-hash of the OPFS input; later entries may
      // be "auto" - the engine decides those per step from its own local intermediates.
      // Legacy compatibility booleans (settings.compatibility add/remove header) remap
      // onto the same enums: removeHeader => strip for the whole chain, with the
      // output-header choosing whether the header returns.
      const rawHeaderModes = Array.isArray(applyOptionRecord?.headerModes) ? applyOptionRecord.headerModes : [];
      const headerModes: ("keep" | "strip" | "auto")[] = removeHeader
        ? ["strip"]
        : rawHeaderModes.map((mode, index) =>
            mode === "keep" || mode === "strip" || mode === "auto"
              ? mode
              : index === 0
                ? ("keep" as const)
                : ("auto" as const),
          );
      const outputHeaderRaw = applyOptionRecord?.outputHeader ?? applyOptionRecord?.output_header;
      const outputHeader = removeHeader
        ? addHeader
          ? ("keep" as const)
          : ("strip" as const)
        : outputHeaderRaw === "keep" || outputHeaderRaw === "strip"
          ? outputHeaderRaw
          : ("auto" as const);
      const requestedThreadArg = toThreadBudget(
        (input.options as { workerThreads?: unknown } | undefined)?.workerThreads,
      );
      const {
        forceSingleThreadReason,
        forcedSingleThread,
        hasBpsPatch,
        hasXdeltaPatch,
        singleThreadNoPool,
        threadArg,
      } = resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles, input.inputSize);
      const disableDefaultThreadArgInjection = singleThreadNoPool || (hasBpsPatch && !threadArg);
      const virtualOnlyMounts = hasBpsPatch;
      const syncAccessMode = hasBpsPatch ? "readwrite-unsafe" : undefined;
      const command = createRomWeaverCommand("patch-apply", {
        ...(headerModes.length ? { patch_header: headerModes } : {}),
        ignore_checksum_validation: ignoreChecksumValidation,
        input: input.romFilePath,
        output_header: outputHeader,
        ...(n64ByteOrder ? { n64_byte_order: n64ByteOrder } : {}),
        no_compress: true,
        output: outputPath,
        patch_filter: true,
        patches: input.patchFiles.map((patch) => patch.patchFilePath),
        repair_checksum: repairChecksum,
        rom_filter: true,
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
          getRomWeaverFailureMessage(result, "Patch apply failed"),
          "apply patch output",
        );
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
        // Follow the engine's emitted name: it adjusts the extension when the final
        // header state changes the ROM's conventional extension (.smc vs .sfc).
        fileName: emitted?.path ? getPathBaseName(emitted.path, outputFileName) : outputFileName,
        filePath: emitted?.path || outputPath,
        size: emitted?.sizeBytes,
        timing: getRunResultTiming(result),
      };
    },
  );
};

const invokeRomWeaverCreatePatchCandidatesWorker = async (
  input: RuntimePatchCreateCandidatesWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RuntimePatchCreateFormatCandidates> => {
  const threadArg = toThreadBudget(input.workerThreads);
  const command = createRomWeaverCommand("patch-create", {
    modified: input.modifiedFilePath,
    original: input.originalFilePath,
    plan: true,
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-create plan dispatch", {
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
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPathBaseName(
    input.outputName || `patch.${String(input.format || "bin").toLowerCase()}`,
    `patch.${String(input.format || "bin").toLowerCase()}`,
  );
  return runWithRomWeaverOutputScope(
    input.modifiedFilePath || input.originalFilePath,
    outputFileName,
    [input.originalFilePath, input.modifiedFilePath],
    async (outputPath) => {
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
    },
  );
};

const invokeRomWeaverTrimWorker = async (
  input: RuntimeTrimWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const sourceFilePath = String(input.sourceFilePath || "").trim();
  if (!sourceFilePath) throw new Error("Trim source path is required");
  const outputFileName = getTrimOutputFileName(sourceFilePath, input.outputName);
  return runWithRomWeaverOutputScope(sourceFilePath, outputFileName, [sourceFilePath], async (outputPath) => {
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
    ensureRomWeaverSuccess(result, "Trim failed");

    const emitted = getEmittedFileDetails(result);
    return {
      fileName: outputFileName,
      filePath: emitted?.path || outputPath,
      size: emitted?.sizeBytes,
      timing: getRunResultTiming(result),
    };
  });
};

const invokeRomWeaverPpfUndoWorker = async (input: {
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  outputName: string;
  patchFilePath: string;
  romFilePath: string;
  signal?: AbortSignal;
}): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const outputFileName = getPathBaseName(input.outputName, "restored-rom.bin");
  return runWithRomWeaverOutputScope(
    input.romFilePath,
    outputFileName,
    [input.romFilePath, input.patchFilePath],
    async (outputPath) => {
      const command = createRomWeaverCommand("tools-ppf-undo", {
        output: outputPath,
        patch: input.patchFilePath,
        rom: input.romFilePath,
      });
      emitRuntimeTrace({ logLevel: input.logLevel }, "runJson tools-ppf-undo dispatch", {
        command,
        outputPath,
        patchFilePath: input.patchFilePath,
        romFilePath: input.romFilePath,
      });
      const result = await runRomWeaverJson(
        command,
        toRomWeaverOptions({
          knownInputPaths: input.knownInputPaths,
          logLevel: input.logLevel,
          signal: input.signal,
        }),
      );
      ensureRomWeaverSuccess(result, "PPF undo failed");
      const emitted = getEmittedFileDetails(result);
      return {
        fileName: outputFileName,
        filePath: emitted?.path || outputPath,
        size: emitted?.sizeBytes,
        timing: getRunResultTiming(result),
      };
    },
  );
};

// Classify a dropped source as ROM or patch, nested-extract + checksum ROMs (in place for bare
// ROMs), and describe patches - the consolidated `ingest` command. One round-trip replaces the
// webapp's separate classify → descend → checksum (ROM) and classify → describe (patch) calls.
const invokeRomWeaverIngestWorker = async (
  input: {
    checksumAlgorithms?: string[];
    interactiveSelectionEnabled?: boolean;
    invalidateMountCacheBeforeRun?: boolean;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    noIgnore?: boolean;
    noNestedExtract?: boolean;
    outDirPath: string;
    select?: string[];
    signal?: AbortSignal;
    sourcePath: string;
    // For a multi-track CHD CD: force per-track split BIN (true) or a single merged BIN (false).
    // Omit to let the ingest command ask the host interactively when the disc offers the choice.
    splitBin?: boolean;
    workerThreads?: RuntimeThreadBudgetInput;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedIngestResult & { timing: ReturnType<typeof getRunResultTiming> }> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Ingest source path is required");
  const outDirPath = String(input.outDirPath || "").trim();
  if (!outDirPath) throw new Error("Ingest output directory is required");
  const select: string[] = [];
  for (const selected of Array.isArray(input.select) ? input.select : []) {
    const value = String(selected || "").trim();
    if (value) select.push(value);
  }
  const checksum: string[] = [];
  for (const algorithm of Array.isArray(input.checksumAlgorithms) ? input.checksumAlgorithms : []) {
    const value = String(algorithm || "")
      .trim()
      .toLowerCase();
    if (value) checksum.push(value);
  }
  const threadArg = toThreadBudget(input.workerThreads);
  const command = createRomWeaverCommand("ingest", {
    out_dir: outDirPath,
    source: sourcePath,
    ...(select.length ? { select } : {}),
    ...(input.noIgnore ? { no_ignore: true } : {}),
    ...(input.noNestedExtract ? { no_nested_extract: true } : {}),
    ...(typeof input.splitBin === "boolean" ? { split_bin: input.splitBin } : {}),
    ...(checksum.length ? { checksum } : {}),
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson ingest dispatch", {
    checksum,
    command,
    outDirPath,
    selectCount: select.length,
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
      signal: input.signal,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwRomWeaverFailureWithBrowserOutputContext(
      result,
      "Ingest failed",
      `ingest \`${getPathBaseName(sourcePath)}\``,
    );
  }
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseIngestResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Ingest result was missing or malformed"), result);
  }
  return { ...parsed, timing: getRunResultTiming(result) };
};

// Parse a rom-weaver-bundle.json bundle (plain, compressed, or bundled in an archive) via the `bundle parse`
// command. Bundled ROM/patch members are extracted into `extractDirPath`; the parsed result's
// `extracted` source refs point at those leaves.
const invokeRomWeaverBundleParseWorker = async (
  input: {
    extractDirPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    signal?: AbortSignal;
    sourcePath: string;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedBundleParseResult> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Bundle parse source path is required");
  const extractDirPath = String(input.extractDirPath || "").trim();
  const command = createRomWeaverCommand("bundle-parse", {
    source: sourcePath,
    ...(extractDirPath ? { extract_dir: extractDirPath } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson bundle-parse dispatch", {
    command,
    extractDirPath,
    sourcePath,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Bundle parse failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseBundleParseResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Bundle parse result was missing or malformed"), result);
  }
  return parsed;
};

// Write a rom-weaver-bundle.json bundle (and optional everything-bundle archive) from staged session files via
// the `bundle create` command. Cached ROM checks are forwarded when available;
// Rust hashes only as a compatibility fallback. Per-patch metadata arrays are
// index-aligned with `patchPaths` (or empty).
const invokeRomWeaverBundleCreateWorker = async (
  input: {
    bundlePath?: string;
    bundleRomPath?: string;
    knownInputPaths?: string[];
    logLevel?: LogLevel | string;
    noBundleRom?: boolean;
    /** Expected final-output checksums once the full chain is applied ("algo=hex", comma-separable). */
    outputCheck?: string;
    outputHeader?: BundleHeaderMode;
    romChecksums?: string;
    romSize?: number;
    outputName?: string;
    outputPath: string;
    patchDescriptions?: string[];
    patchHeaders?: BundleHeaderMode[];
    /** Index-aligned per-patch expected pre-apply checksums ("algo=hex", comma-separable; empty for none). */
    patchInputChecks?: string[];
    patchLabels?: string[];
    patchNames?: string[];
    patchPaths: string[];
    patchOptionals?: boolean[];
    patchOutputChecks?: string[];
    romPath?: string;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<ParsedBundleCreateResult> => {
  const outputPath = String(input.outputPath || "").trim();
  if (!outputPath) throw new Error("Bundle create output path is required");
  const patchPaths = (input.patchPaths || []).map((path) => String(path || "").trim()).filter((path) => !!path);
  if (!patchPaths.length) throw new Error("Bundle create requires at least one patch path");
  const romPath = String(input.romPath || "").trim();
  const bundlePath = String(input.bundlePath || "").trim();
  const bundleRomPath = String(input.bundleRomPath || "").trim();
  // The Rust side requires each metadata array to match the patch count exactly (or be empty), so a
  // partially-filled array is padded with empty strings; empty values round-trip as absent metadata.
  const alignedStrings = (values: string[] | undefined): string[] | undefined => {
    const normalized = (values || []).map((value) => String(value ?? "").trim());
    if (!normalized.some((value) => !!value)) return undefined;
    while (normalized.length < patchPaths.length) normalized.push("");
    return normalized.slice(0, patchPaths.length);
  };
  const patchNames = alignedStrings(input.patchNames);
  const patchDescriptions = alignedStrings(input.patchDescriptions);
  const patchLabels = alignedStrings(input.patchLabels);
  const patchInputChecks = alignedStrings(input.patchInputChecks);
  const patchOutputChecks = alignedStrings(input.patchOutputChecks);
  const outputCheck = String(input.outputCheck || "").trim();
  const patchOptionals =
    input.patchOptionals && input.patchOptionals.length === patchPaths.length && input.patchOptionals.some(Boolean)
      ? input.patchOptionals
      : undefined;
  const patchHeaders =
    input.patchHeaders?.length && input.patchHeaders.some((mode) => mode !== "auto")
      ? patchPaths.map((_, index) => input.patchHeaders?.[index] || "auto")
      : undefined;
  const command = createRomWeaverCommand("bundle-create", {
    output: outputPath,
    patch: patchPaths,
    ...(romPath ? { rom: romPath } : {}),
    ...(bundlePath ? { bundle: bundlePath } : {}),
    ...(bundleRomPath ? { bundle_rom: bundleRomPath } : {}),
    ...(input.outputName ? { output_name: input.outputName } : {}),
    ...(input.outputHeader && input.outputHeader !== "auto" ? { output_header: input.outputHeader } : {}),
    ...(input.romChecksums ? { rom_checksums: [input.romChecksums] } : {}),
    ...(typeof input.romSize === "number" ? { rom_size: input.romSize } : {}),
    ...(outputCheck ? { output_check: [outputCheck] } : {}),
    ...(patchNames ? { patch_name: patchNames } : {}),
    ...(patchDescriptions ? { patch_description: patchDescriptions } : {}),
    ...(patchLabels ? { patch_label: patchLabels } : {}),
    ...(patchOptionals ? { patch_optional: patchOptionals } : {}),
    ...(patchHeaders ? { patch_header: patchHeaders } : {}),
    ...(patchInputChecks ? { patch_input_check: patchInputChecks } : {}),
    ...(patchOutputChecks ? { patch_output_check: patchOutputChecks } : {}),
    ...(input.noBundleRom ? { no_bundle_rom: true } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson bundle-create dispatch", {
    bundlePath,
    command,
    outputPath,
    patchCount: patchPaths.length,
    romPath,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: (event) => {
        const progress = toSimpleProgress(event);
        if (progress) onProgress?.(progress);
      },
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Bundle create failed");
  const terminal = getLastEvent(result);
  const details = terminal ? getRomWeaverRunEventDetails(terminal) : undefined;
  const parsed = parseBundleCreateResult(details);
  if (!parsed) {
    throw withRomWeaverFailureKind(new Error("Bundle create result was missing or malformed"), result);
  }
  return parsed;
};

export {
  invokeRomWeaverBundleCreateWorker,
  invokeRomWeaverBundleParseWorker,
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverIngestWorker,
  invokeRomWeaverPatchApplyWorker,
  invokeRomWeaverPatchValidateWorker,
  invokeRomWeaverPpfUndoWorker,
  invokeRomWeaverTrimWorker,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  resolvePatchApplyThreadArg,
  runRomWeaverIngestSidecarsWorker,
  runRomWeaverProbeWorker,
};
