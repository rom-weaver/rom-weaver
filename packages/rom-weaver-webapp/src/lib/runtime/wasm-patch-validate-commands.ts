import type {
  PatchValidatePerPatchVerdict,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  WorkflowRuntimeLog,
} from "../../types/workflow-runtime-adapter.ts";
import { createRomWeaverCommand } from "../../wasm/index.ts";
import type { PatchBasisMode, PatchValidationPlan } from "../../wasm/index.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventLabel,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import { toThreadBudget } from "./compression-thread-budget.ts";
import {
  getPatchValidationRequirements,
  normalizePatchValidationChecksumEntries,
  resolvePatchApplyThreadArg,
  toOptionalInt,
  toOptionalUint32Hex,
} from "./patch-run-resolution.ts";
import { emitRuntimeTrace, toRomWeaverOptions } from "./run-options.ts";
import { asRecord, getTerminalEvent } from "./run-result-parsing.ts";
import {
  runRomWeaverJson,
  relaySimpleProgress,
  appendBrowserStorageContext,
  normalizeN64ByteOrder,
  normalizePatchBasisMode,
} from "./wasm-command-shared.ts";

// Fold expected-input checksum tokens plus optional exact/minimum size gates
// into the `--expect-in` token list (`algo=hex`, `size=N`, `min-size=N`).
const expectInTokens = (checksums: readonly string[], size?: number, minSize?: number): string[] => {
  const tokens = [...checksums];
  if (size !== undefined) tokens.push(`size=${size}`);
  if (minSize !== undefined) tokens.push(`min-size=${minSize}`);
  return tokens;
};

// Read the independent-mode per-patch verdicts from a patch-validate terminal event's
// `details.patch_validation.per_patch`. The chained (default) path emits no such array, so the
// result is empty and the caller falls back to its single whole-call verdict.
const parsePatchValidatePerPatchEntry = (raw: unknown): PatchValidatePerPatchVerdict | null => {
  const record = asRecord(raw);
  if (!record) return null;
  const index = Number(record.index);
  if (!Number.isInteger(index) || index < 0) return null;
  return {
    index,
    ...(typeof record.format === "string" ? { format: record.format } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.patch === "string" ? { patch: record.patch } : {}),
    status: record.status === "failed" ? "failed" : "passed",
  };
};

const parsePatchValidatePerPatch = (terminal: ReturnType<typeof getTerminalEvent>): PatchValidatePerPatchVerdict[] => {
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const validation = asRecord(details?.patch_validation);
  const rawPerPatch = validation?.per_patch;
  if (!Array.isArray(rawPerPatch)) return [];
  const verdicts: PatchValidatePerPatchVerdict[] = [];
  for (const raw of rawPerPatch) {
    const verdict = parsePatchValidatePerPatchEntry(raw);
    if (verdict) verdicts.push(verdict);
  }
  return verdicts;
};

// Read the typed verification plan from a plan-mode terminal event. The payload is our own
// serializer's output, so shape-checking the discriminant + per_patch array is sufficient.
const parsePatchValidatePlan = (terminal: ReturnType<typeof getTerminalEvent>): PatchValidationPlan | undefined => {
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const validation = asRecord(details?.patch_validation);
  if (validation?.plan !== true || !Array.isArray(validation.per_patch)) return undefined;
  return validation as unknown as PatchValidationPlan;
};

const isPatchValidationChecksumIgnored = (options: unknown) => {
  const record = options as { ignoreChecksumValidation?: unknown; ignore_checksum_validation?: unknown } | undefined;
  return Boolean(record?.ignoreChecksumValidation || record?.ignore_checksum_validation);
};

/** Only the flags the caller actually set reach the CLI command. */
const buildPatchValidateCommand = (args: {
  checksumCache: string[];
  defaultPatchBasis?: PatchBasisMode;
  effectiveThreadArg: ReturnType<typeof toThreadBudget> | null;
  expectIn: string[];
  ignoreChecksumValidation: boolean;
  independent: boolean;
  input: RuntimePatchValidateWorkerInput;
  n64ByteOrder: ReturnType<typeof normalizeN64ByteOrder>;
  patchBasis: PatchBasisMode[];
  patchInputChecks: string[];
  patchOutputChecks: string[];
  plan: boolean;
  removeHeader: boolean;
}) =>
  createRomWeaverCommand("patch-validate", {
    ...(args.checksumCache.length ? { assume_in: args.checksumCache } : {}),
    ...(args.defaultPatchBasis ? { default_patch_basis: args.defaultPatchBasis } : {}),
    ...(args.independent ? { independent: true } : {}),
    ...(args.plan ? { plan: true } : {}),
    ...(args.patchBasis.length ? { patch_basis: args.patchBasis } : {}),
    ...(args.patchInputChecks.length ? { patch_input_check: args.patchInputChecks } : {}),
    ...(args.patchOutputChecks.length ? { patch_output_check: args.patchOutputChecks } : {}),
    ignore_checksum_validation: args.ignoreChecksumValidation,
    input: args.input.romFilePath,
    ...(args.n64ByteOrder ? { n64_byte_order: args.n64ByteOrder } : {}),
    no_extract: true,
    filter: ["rom", "patch"],
    patches: args.input.patchFiles.map((patch) => patch.patchFilePath),
    strip_header: args.removeHeader,
    ...(args.effectiveThreadArg ? { threads: args.effectiveThreadArg } : {}),
    ...(args.expectIn.length ? { expect_in: args.expectIn } : {}),
  });

/**
 * Some validates fan worker threads across the source: bps block-check CRCs,
 * xdelta's per-window decode, or a caller-requested source-checksum verification.
 * Those MUST keep the runner's worker pool - without it the engine spawns from an
 * empty pool and panics (os error 6). The rest (PPF/IPS/UPS structural + block
 * checks) read a few hundred bytes single-threaded, so the pool spin-up is pure
 * setup/teardown and is skipped. The apply path keeps its own input-size gate
 * since it always reads+writes the source.
 */
const resolvePatchValidateThreading = (input: RuntimePatchValidateWorkerInput, hasSourceChecksums: boolean) => {
  const requestedThreadArg = toThreadBudget((input.options as { threads?: unknown } | undefined)?.threads);
  const { forceSingleThreadReason, forcedSingleThread, hasBpsPatch, hasXdeltaPatch, singleThreadNoPool, threadArg } =
    resolvePatchApplyThreadArg(requestedThreadArg, input.patchFiles, input.inputSize);
  const validateUsesThreadPool = hasBpsPatch || hasXdeltaPatch || hasSourceChecksums;
  const noWorkerPool = singleThreadNoPool || !validateUsesThreadPool;
  const effectiveThreadArg = noWorkerPool ? null : threadArg;
  return {
    disableDefaultThreadArgInjection: noWorkerPool || (hasBpsPatch && !effectiveThreadArg),
    effectiveThreadArg,
    forceSingleThreadReason,
    forcedSingleThread,
    hasBpsPatch,
    hasXdeltaPatch,
    noWorkerPool,
    requestedThreadArg,
    syncAccessMode: hasBpsPatch ? ("readwrite-unsafe" as const) : undefined,
    virtualOnlyMounts: hasBpsPatch,
  };
};

/**
 * The caller's options arrive untyped and in both camelCase and snake_case, so
 * every field is normalized once here rather than at each use.
 */
const readPatchValidateOptions = (options: RuntimePatchValidateWorkerInput["options"]) => {
  const record = asRecord(options);
  const requirements = getPatchValidationRequirements(options);
  const readArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  const sourceCrc32 = toOptionalUint32Hex(requirements?.sourceCrc32 ?? requirements?.source_crc32);
  return {
    checksumCache: normalizePatchValidationChecksumEntries(record?.checksumCache ?? record?.checksum_cache),
    defaultPatchBasis: normalizePatchBasisMode(record?.defaultPatchBasis ?? record?.default_patch_basis),
    ignoreChecksumValidation: isPatchValidationChecksumIgnored(options),
    independent: Boolean(record?.independent),
    n64ByteOrder: normalizeN64ByteOrder(record?.n64ByteOrder ?? record?.n64_byte_order),
    patchBasis: readArray<PatchBasisMode>(record?.patchBasis),
    patchInputChecks: readArray<string>(record?.patchInputChecks),
    patchOutputChecks: readArray<string>(record?.patchOutputChecks),
    plan: Boolean(record?.plan),
    removeHeader: Boolean(record?.removeHeader),
    validateWithChecksums: [
      ...normalizePatchValidationChecksumEntries(record?.validateWithChecksums ?? record?.validate_with_checksums),
      ...(sourceCrc32 ? [`crc32=${sourceCrc32}`] : []),
    ],
    validateWithMinSize: toOptionalInt(requirements?.minimumSourceSize ?? requirements?.minimum_source_size),
    validateWithSize: toOptionalInt(requirements?.sourceSize ?? requirements?.source_size),
  };
};

const invokeRomWeaverPatchValidateWorker = async (
  input: RuntimePatchValidateWorkerInput,
  onProgress?: (progress: RuntimePatchWorkerProgress) => void,
  onLog?: (log: WorkflowRuntimeLog) => void,
): Promise<{
  message?: string;
  perPatch?: PatchValidatePerPatchVerdict[];
  plan?: PatchValidationPlan;
  status: "passed" | "mixed";
}> => {
  const {
    checksumCache,
    defaultPatchBasis,
    ignoreChecksumValidation,
    independent,
    n64ByteOrder,
    patchBasis,
    patchInputChecks,
    patchOutputChecks,
    plan,
    removeHeader,
    validateWithChecksums,
    validateWithMinSize,
    validateWithSize,
  } = readPatchValidateOptions(input.options);
  const {
    disableDefaultThreadArgInjection,
    effectiveThreadArg,
    forceSingleThreadReason,
    forcedSingleThread,
    hasBpsPatch,
    hasXdeltaPatch,
    noWorkerPool,
    requestedThreadArg,
    syncAccessMode,
    virtualOnlyMounts,
  } = resolvePatchValidateThreading(input, validateWithChecksums.length > 0);
  const expectIn = expectInTokens(validateWithChecksums, validateWithSize, validateWithMinSize);
  const command = buildPatchValidateCommand({
    checksumCache,
    defaultPatchBasis,
    effectiveThreadArg,
    expectIn,
    ignoreChecksumValidation,
    independent,
    input,
    n64ByteOrder,
    patchBasis,
    patchInputChecks,
    patchOutputChecks,
    plan,
    removeHeader,
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
      onEvent: relaySimpleProgress(onProgress),
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
  const chainPlan = parsePatchValidatePlan(terminal);
  // Plan-mode entries carry input_verdicts, not the independent-mode pass/fail
  // statuses - consumers read the plan itself.
  const perPatch = chainPlan ? [] : parsePatchValidatePerPatch(terminal);
  const status =
    chainPlan?.status === "mixed" || perPatch.some((verdict) => verdict.status === "failed") ? "mixed" : "passed";
  return {
    message: terminal ? getRomWeaverRunEventLabel(terminal) : "Patch validation passed",
    ...(perPatch.length ? { perPatch } : {}),
    ...(chainPlan ? { plan: chainPlan } : {}),
    status,
  };
};

export { invokeRomWeaverPatchValidateWorker };
