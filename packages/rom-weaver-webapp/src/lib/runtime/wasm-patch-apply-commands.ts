import { getBrowserStorageEstimateState } from "../../storage/browser/browser-storage-estimate.ts";
import type {
  RuntimePatchApplyWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimeWorkerIo,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { PatchBasisMode } from "../../wasm/index.ts";
import { getRomWeaverRunEventFormat } from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { getPathBaseName } from "../path-utils.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import {
  getPatchApplyOutputFileName,
  normalizePatchValidationChecksumEntries,
  resolvePatchApplyThreadArg,
} from "./patch-run-resolution.ts";
import { emitRuntimeTrace, isTraceEnabled, toRomWeaverOptions } from "./run-options.ts";
import { runWithRomWeaverOutputScope } from "./run-output-paths.ts";
import { asRecord, getEmittedFileDetails, getLastEvent, getRunResultTiming } from "./run-result-parsing.ts";
import {
  runRomWeaverJson,
  relaySimpleProgress,
  appendBrowserStorageContext,
  normalizeN64ByteOrder,
  normalizePatchBasisMode,
} from "./wasm-command-shared.ts";
import type { RomWeaverJsonResult } from "./wasm-command-shared.ts";

const getPatchApplyN64ByteOrders = (options: Record<string, unknown> | null) => {
  if (Array.isArray(options?.n64ByteOrders)) return options.n64ByteOrders;
  if (Array.isArray(options?.n64_byte_order)) return options.n64_byte_order;
  return options?.n64ByteOrder ? [options.n64ByteOrder] : [];
};

// Unrecognized modes fall back to `auto` at every position, matching the CLI
// default. A first-patch `keep` fallback would discard the engine's basis
// inference for exactly the patches that need it - the checksumless ones.
const normalizePatchApplyHeaderMode = (mode: unknown): "keep" | "strip" | "auto" =>
  mode === "keep" || mode === "strip" || mode === "auto" ? mode : "auto";

const getPatchApplyHeaderModes = (options: Record<string, unknown> | null, removeHeader: boolean) => {
  if (removeHeader) return ["strip"] as ("keep" | "strip" | "auto")[];
  const rawModes = Array.isArray(options?.headerModes) ? options.headerModes : [];
  return rawModes.map(normalizePatchApplyHeaderMode);
};

const getPatchApplyOutputHeader = (
  options: Record<string, unknown> | null,
  removeHeader: boolean,
  addHeader: boolean,
): "keep" | "strip" | "auto" => {
  if (removeHeader) return addHeader ? "keep" : "strip";
  const outputHeader = options?.outputHeader ?? options?.output_header;
  return outputHeader === "keep" || outputHeader === "strip" ? outputHeader : "auto";
};

const getPatchApplyCommandOptions = (input: RuntimePatchApplyWorkerInput) => {
  const options = asRecord(input.options);
  const removeHeader = Boolean((input.options as { removeHeader?: unknown } | undefined)?.removeHeader);
  const addHeader = Boolean((input.options as { addHeader?: unknown } | undefined)?.addHeader);
  return {
    cheatRecords: Array.isArray(options?.cheatRecords)
      ? options.cheatRecords
      : Array.isArray(options?.cheat_records)
        ? options.cheat_records
        : [],
    cheatPositions: Array.isArray(options?.cheatPositions)
      ? options.cheatPositions
      : Array.isArray(options?.cheat_positions)
        ? options.cheat_positions
        : [],
    headerModes: getPatchApplyHeaderModes(options, removeHeader),
    ignoreChecksumValidation:
      (input.options as { requireInputChecksumMatch?: unknown } | undefined)?.requireInputChecksumMatch !== true,
    n64ByteOrders: getPatchApplyN64ByteOrders(options).map((mode) => normalizeN64ByteOrder(mode) || "auto"),
    outputHeader: getPatchApplyOutputHeader(options, removeHeader, addHeader),
    defaultPatchBasis: normalizePatchApplyDefaultBasis(input.options),
    patchBasis: Array.isArray(options?.patchBasis)
      ? (options.patchBasis as PatchBasisMode[])
      : Array.isArray(options?.patch_basis)
        ? (options.patch_basis as PatchBasisMode[])
        : [],
    patchIds: Array.isArray(options?.patchIds)
      ? options.patchIds.map((value) => String(value || ""))
      : Array.isArray(options?.patch_id)
        ? options.patch_id.map((value) => String(value || ""))
        : [],
    patchInputs: Array.isArray(options?.patchInputs)
      ? options.patchInputs
      : Array.isArray(options?.patch_input)
        ? options.patch_input
        : [],
    patchTargets: Array.isArray(options?.patchTargets)
      ? options.patchTargets
      : Array.isArray(options?.patch_target)
        ? options.patch_target
        : [],
    patchInputChecks: Array.isArray(options?.patchInputChecks)
      ? options.patchInputChecks.map((value) => String(value || ""))
      : Array.isArray(options?.patch_input_check)
        ? options.patch_input_check.map((value) => String(value || ""))
        : [],
    patchOutputChecks: Array.isArray(options?.patchOutputChecks)
      ? options.patchOutputChecks.map((value) => String(value || ""))
      : Array.isArray(options?.patch_output_check)
        ? options.patch_output_check.map((value) => String(value || ""))
        : [],
    repairChecksum: Boolean((input.options as { fixChecksum?: unknown } | undefined)?.fixChecksum),
    requestedThreadArg: toThreadBudget((input.options as { threads?: unknown } | undefined)?.threads),
    validateWithChecksums: normalizePatchValidationChecksumEntries(
      options?.validateWithChecksums ?? options?.validate_with_checksums,
    ),
    validateWithOutputChecksums: normalizePatchValidationChecksumEntries(
      options?.validateWithOutputChecksums ?? options?.validate_with_output_checksums,
    ),
  };
};

const normalizePatchApplyDefaultBasis = (options: RuntimePatchApplyWorkerInput["options"]) => {
  const record = asRecord(options);
  return normalizePatchBasisMode(record?.defaultPatchBasis ?? record?.default_patch_basis);
};

const throwPatchApplyFailure = async ({
  forceSingleThreadReason,
  forcedSingleThread,
  hasBpsPatch,
  hasXdeltaPatch,
  input,
  result,
  threadArg,
}: {
  forceSingleThreadReason: string;
  forcedSingleThread: boolean;
  hasBpsPatch: boolean;
  hasXdeltaPatch: boolean;
  input: RuntimePatchApplyWorkerInput;
  result: RomWeaverJsonResult;
  threadArg: ReturnType<typeof toThreadBudget>;
}): Promise<never> => {
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
};

const getPatchApplyExecution = (input: RuntimePatchApplyWorkerInput, outputPath: string) => {
  const commandOptions = getPatchApplyCommandOptions(input);
  const threadOptions = resolvePatchApplyThreadArg(
    commandOptions.requestedThreadArg,
    input.patchFiles,
    input.inputSize,
  );
  const disableDefaultThreadArgInjection =
    threadOptions.singleThreadNoPool || (threadOptions.hasBpsPatch && !threadOptions.threadArg);
  const syncAccessMode = threadOptions.hasBpsPatch ? "readwrite-unsafe" : undefined;
  const command = createRomWeaverCommand("patch-apply", {
    ...(commandOptions.cheatRecords.length ? { cheat_records: commandOptions.cheatRecords } : {}),
    ...(commandOptions.cheatPositions.length ? { cheat_positions: commandOptions.cheatPositions } : {}),
    ...(commandOptions.headerModes.length ? { patch_header: commandOptions.headerModes } : {}),
    ignore_checksum_validation: commandOptions.ignoreChecksumValidation,
    input: input.romFilePath,
    output_header: commandOptions.outputHeader,
    ...(commandOptions.defaultPatchBasis ? { default_patch_basis: commandOptions.defaultPatchBasis } : {}),
    ...(commandOptions.patchBasis.length ? { patch_basis: commandOptions.patchBasis } : {}),
    ...(commandOptions.patchIds.length ? { patch_id: commandOptions.patchIds } : {}),
    ...(commandOptions.patchInputs.length ? { patch_input: commandOptions.patchInputs } : {}),
    ...(commandOptions.patchTargets.length ? { patch_target: commandOptions.patchTargets } : {}),
    ...(commandOptions.patchInputChecks.length ? { patch_input_check: commandOptions.patchInputChecks } : {}),
    ...(commandOptions.patchOutputChecks.length ? { patch_output_check: commandOptions.patchOutputChecks } : {}),
    ...(commandOptions.n64ByteOrders.length ? { n64_byte_order: commandOptions.n64ByteOrders } : {}),
    no_compress: true,
    output: outputPath,
    filter: ["rom", "patch"],
    patches: input.patchFiles.map((patch) => patch.patchFilePath),
    repair_checksum: commandOptions.repairChecksum,
    ...(threadOptions.threadArg ? { threads: threadOptions.threadArg } : {}),
    ...(commandOptions.validateWithChecksums.length ? { expect_in: commandOptions.validateWithChecksums } : {}),
    ...(commandOptions.validateWithOutputChecksums.length
      ? { expect_out: commandOptions.validateWithOutputChecksums }
      : {}),
  });
  return {
    ...threadOptions,
    command,
    disableDefaultThreadArgInjection,
    syncAccessMode,
    virtualOnlyMounts: threadOptions.hasBpsPatch,
    outputPath,
    ...commandOptions,
  };
};

const runPatchApplyCommand = async (
  input: RuntimePatchApplyWorkerInput,
  execution: ReturnType<typeof getPatchApplyExecution>,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
) => {
  const {
    command,
    disableDefaultThreadArgInjection,
    forceSingleThreadReason,
    forcedSingleThread,
    hasBpsPatch,
    hasXdeltaPatch,
    n64ByteOrders,
    outputPath,
    requestedThreadArg,
    singleThreadNoPool,
    syncAccessMode,
    threadArg,
    virtualOnlyMounts,
  } = execution;
  emitRuntimeTrace({ logLevel: input.logLevel, onLog }, "runJson patch-apply dispatch", {
    command,
    disableDefaultThreadArgInjection,
    forcedSingleThread,
    forceSingleThreadReason,
    hasBpsPatch,
    hasXdeltaPatch,
    n64ByteOrders,
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
      onEvent: relaySimpleProgress(onProgress),
      onLog,
      signal: input.signal,
      syncAccessMode,
      virtualOnlyMounts,
    }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    await throwPatchApplyFailure({
      forceSingleThreadReason,
      forcedSingleThread,
      hasBpsPatch,
      hasXdeltaPatch,
      input,
      result,
      threadArg,
    });
  }
  return result;
};

const createPatchApplyResult = (
  input: RuntimePatchApplyWorkerInput,
  outputFileName: string,
  outputPath: string,
  result: RomWeaverJsonResult,
) => {
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
    fileName: emitted?.path ? getPathBaseName(emitted.path, outputFileName) : outputFileName,
    filePath: emitted?.path || outputPath,
    size: emitted?.sizeBytes,
    timing: getRunResultTiming(result),
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
      const execution = getPatchApplyExecution(input, outputPath);
      const result = await runPatchApplyCommand(input, execution, onProgress, onLog);
      return createPatchApplyResult(input, outputFileName, outputPath, result);
    },
  );
};

export { normalizePatchApplyDefaultBasis, invokeRomWeaverPatchApplyWorker };
