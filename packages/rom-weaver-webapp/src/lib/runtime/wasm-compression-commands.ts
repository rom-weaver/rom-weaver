import type { LogLevel } from "../../types/logging.ts";
import type {
  RuntimeThreadBudgetInput,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import type { CompressionProbeResult } from "../../types/workflow-runtime-types.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { CompressionLevelProfile } from "../../wasm/index.ts";
import { getRomWeaverRunEventDetails } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getPathBaseName } from "../path-utils.ts";
import {
  isChdCompressionFormat,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  normalizeCompressionLevelProfile,
} from "./compression-codec-args.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import {
  asRecord,
  ensureRomWeaverSuccess,
  getContainerEntriesFromProbe,
  getEmittedFiles,
  getRunResultTiming,
  getTerminalEvent,
} from "./run-result-parsing.ts";
import { runRomWeaverJson, relaySimpleProgress } from "./wasm-command-shared.ts";

// Build the `--filter rom|patch` payload field from the two legacy booleans.
// Returns an empty object when neither is set so it spreads to nothing.
const filterSpread = (romFilter?: boolean, patchFilter?: boolean): { filter?: ("rom" | "patch")[] } => {
  const filter: ("rom" | "patch")[] = [];
  if (romFilter) filter.push("rom");
  if (patchFilter) filter.push("patch");
  return filter.length > 0 ? { filter } : {};
};

const invokeRomWeaverCompressionCreateWorker = async (
  input: {
    codecs?: unknown;
    entryNames?: string[];
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
    threads?: RuntimeThreadBudgetInput;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const inputPaths = Array.isArray(input.inputPaths)
    ? input.inputPaths.map((pathValue) => String(pathValue || "").trim()).filter((pathValue) => !!pathValue)
    : [];
  if (!inputPaths.length) throw new Error("Compression create requires at least one input path");
  const entryNames = Array.isArray(input.entryNames)
    ? input.entryNames.map((entryName) => String(entryName || "").trim()).filter((entryName) => !!entryName)
    : [];
  if (entryNames.length && entryNames.length !== inputPaths.length) {
    throw new Error("Compression create entry names must align with input paths");
  }
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
    // Rust zip create_thread_capability applies the codec memory cap when planning threads.
    // Forward the requested budget so the engine owns that limit.
    const threadArg = toThreadBudget(input.threads);
    const command = createRomWeaverCommand("compress", {
      codec: codecs,
      ...(entryNames.length ? { entry_names: entryNames } : {}),
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
        onEvent: relaySimpleProgress(onProgress),
        onLog,
        signal: input.signal,
        virtualFiles: input.virtualFiles,
      }),
    );
    ensureRomWeaverSuccess(result, "Compression create failed");

    const emitted = getEmittedFiles(result)[0];
    return {
      fileName: input.outputFileName,
      filePath: emitted?.path || outputPath,
      size: emitted?.sizeBytes,
      timing: getRunResultTiming(result),
    };
  });
};

type RomWeaverExtractWorkerInput = {
  inputPath: string;
  interactiveSelectionEnabled?: boolean;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  noIgnore?: boolean;
  noNestedExtract?: boolean;
  outDirPath: string;
  select?: string[];
  signal?: AbortSignal;
  splitBin?: boolean;
  threads?: RuntimeThreadBudgetInput;
};
type RomWeaverExtractWorkerOutput = Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0] & { filePath: string };

const runRomWeaverExtractWorker = async (
  input: RomWeaverExtractWorkerInput,
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RomWeaverExtractWorkerOutput[]> => {
  const inputPath = String(input.inputPath || "").trim();
  if (!inputPath) throw new Error("Extract input path is required");
  const outDirPath = String(input.outDirPath || "").trim();
  if (!outDirPath) throw new Error("Extract output directory is required");
  const select = Array.isArray(input.select)
    ? input.select.map((entryName) => String(entryName || "").trim()).filter((entryName) => !!entryName)
    : [];
  const threadArg = toThreadBudget(input.threads);
  const command = createRomWeaverCommand("extract", {
    input: inputPath,
    output: outDirPath,
    ...(select.length ? { select } : {}),
    ...(input.noIgnore ? { no_ignore: true } : {}),
    ...(input.noNestedExtract ? { no_nested_extract: true } : {}),
    ...(typeof input.splitBin === "boolean" ? { split_bin: input.splitBin } : {}),
    ...(threadArg ? { threads: threadArg } : {}),
  });
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson extract dispatch", {
    command,
    inputPath,
    outDirPath,
    select,
    threadArg,
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({
      interactiveSelectionEnabled: input.interactiveSelectionEnabled,
      knownInputPaths: input.knownInputPaths,
      logLevel: input.logLevel,
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Extraction failed");
  const timing = getRunResultTiming(result);
  return getEmittedFiles(result).map((emitted) => ({
    fileName: emitted.fileName || getPathBaseName(emitted.path, "output.bin"),
    filePath: emitted.path,
    size: emitted.sizeBytes,
    timing,
  }));
};

const invokeRomWeaverExtractWorker = async (
  input: RomWeaverExtractWorkerInput,
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<Parameters<RuntimeWorkerIo["createWorkerOutput"]>[0]> => {
  const select = Array.isArray(input.select)
    ? input.select.map((entryName) => String(entryName || "").trim()).filter((entryName) => !!entryName)
    : [];
  const emitted = (await runRomWeaverExtractWorker(input, onProgress, onLog))[0];
  if (!emitted?.filePath) throw new Error("Extraction returned no output file");
  return { ...emitted, fileName: emitted.fileName || select[0] || "output.bin" };
};

const invokeRomWeaverExtractAllWorker = async (
  input: RomWeaverExtractWorkerInput,
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<RomWeaverExtractWorkerOutput[]> => {
  const emitted = await runRomWeaverExtractWorker(input, onProgress, onLog);
  if (!emitted.length) throw new Error("Extraction returned no output files");
  return emitted;
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
    splitBin?: boolean;
    signal?: AbortSignal;
  },
  onProgress?: (progress: { label?: string; message?: string; percent?: number | null }) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<CompressionProbeResult> => {
  const sourcePath = String(input.sourcePath || "").trim();
  if (!sourcePath) throw new Error("Container probe source path is required");
  const command = createRomWeaverCommand("probe", {
    ...filterSpread(input.romFilter, input.patchFilter),
    no_extract: true,
    input: sourcePath,
    ...(typeof input.splitBin === "boolean" ? { split_bin: input.splitBin } : {}),
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
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
    }),
  );
  ensureRomWeaverSuccess(result, "Container probe failed");
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const platform = typeof details?.platform === "string" ? details.platform.trim() : "";
  const chd = getChdProbeDetails(details?.chd);
  return { entries: getContainerEntriesFromProbe(result), ...(platform ? { platform } : {}), ...(chd ? { chd } : {}) };
};

// The CHD header's own digests: `raw_sha1` covers the decoded payload, `sha1` the payload plus
// metadata. Hosts use them to identify a CHD without decompressing it.
const getChdProbeDetails = (value: unknown): CompressionProbeResult["chd"] | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const rawSha1 = typeof record.raw_sha1 === "string" ? record.raw_sha1.trim() : "";
  const sha1 = typeof record.sha1 === "string" ? record.sha1.trim() : "";
  if (!(rawSha1 || sha1)) return undefined;
  return { ...(rawSha1 ? { rawSha1 } : {}), ...(sha1 ? { sha1 } : {}) };
};

export {
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverExtractAllWorker,
  invokeRomWeaverExtractWorker,
  runRomWeaverProbeWorker,
};
