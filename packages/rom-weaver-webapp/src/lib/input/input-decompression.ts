import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { RomWeaverError } from "../errors.ts";
import { emitTraceLog } from "../logging.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { isLazyExternalPatchFile } from "./binary-service.ts";
import type { InputAsset, InputParentCompression, PreparedSidecarPatch } from "./input-assets.ts";
import {
  attachInputPreparationMetrics,
  getInputPreparationMetrics,
  makeInputId,
  makeRomAsset,
} from "./input-assets.ts";
import { classifyPatcherInput } from "./input-classification.ts";
import {
  attachBareRomIngestMetadata,
  describeArchiveFileForTrace,
  resolveArchiveInput,
  resolveArchiveInputAssets,
} from "./input-preparation-archive.ts";
import type { InputPreparationRuntime } from "./input-preparation-compression.ts";
import { normalizeArchiveEntryName, stripFileNameQuery } from "./path-utils.ts";

type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationRuntimeLike = InputPreparationRuntime | Pick<WorkflowRuntime, "name">;
const DEFAULT_INPUT_PREPARATION_RUNTIME: Pick<WorkflowRuntime, "name"> = { name: "browser" };
type PreparedInputFileResult = {
  file: PatchFileInstance;
  sourceSize: number;
  decompressionTimeMs: number;
  wasDecompressed: boolean;
  parentCompressions: InputParentCompression[];
};

const MAX_DECOMPRESSION_PASSES = 12;

const traceInputDecompression = (
  options: InputPreparationOptions,
  message: string,
  details: Record<string, unknown> = {},
) => {
  if (options?.logging?.level !== "trace") return;
  emitTraceLog({ logLevel: "trace", namespace: "workflow:input-decompression", onLog: options.onLog }, message, {
    ...details,
    operation: "input-decompression",
  });
};

const throwDecompressionLimitExceeded = (): never => {
  throw new RomWeaverError("COMPRESSION_FAILED", "Recursive input decompression exceeded the supported limit", {
    details: { maxDecompressionPasses: MAX_DECOMPRESSION_PASSES },
  });
};

const throwRecursiveDecompressionStall = (file: PatchFileInstance): never => {
  throw new RomWeaverError(
    "COMPRESSION_FAILED",
    "Recursive input decompression stalled on the same compressed output",
    {
      details: {
        fileName: file.fileName || "input.bin",
        fileSize: typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : undefined,
      },
    },
  );
};

const finalizeContainerDisabledInput = ({
  current,
  decompressionTimeMs,
  harvestedSidecarPatches,
  options,
  parentCompressions,
  pass,
  sourceIndex,
  sourceSize,
  wasDecompressed,
}: {
  current: PatchFileInstance;
  decompressionTimeMs: number;
  harvestedSidecarPatches: PreparedSidecarPatch[];
  options: ApplyWorkflowOptions | undefined;
  parentCompressions: InputParentCompression[];
  pass: number;
  sourceIndex: number;
  sourceSize: number;
  wasDecompressed: boolean;
}) => {
  traceInputDecompression(options, "input.decompression.assets.finalize", {
    file: describeArchiveFileForTrace(current),
    pass,
    reason: "container-inputs-disabled",
    sourceIndex,
  });
  return finalizePreparedInputAssets(
    [makeRomAsset(makeInputId(sourceIndex, current.fileName, normalizeArchiveEntryName), current)],
    sourceSize,
    wasDecompressed,
    decompressionTimeMs,
    parentCompressions,
    harvestedSidecarPatches,
  );
};

const recordDecompressionMetrics = ({
  assets,
  current,
  durationMs,
  parentCompressions,
}: {
  assets: InputAsset[];
  current: PatchFileInstance;
  durationMs: number;
  parentCompressions: InputParentCompression[];
}) => {
  const nestedPreparation = getInputPreparationMetrics(assets);
  const nestedSteps = [...(nestedPreparation?.parentCompressions || [])].sort(
    (left, right) => left.depth - right.depth,
  );
  if (nestedSteps.length) {
    for (const entry of nestedSteps) parentCompressions.push({ ...entry, depth: parentCompressions.length });
    const nestedDurationMs =
      typeof nestedPreparation?.decompressionTimeMs === "number" &&
      Number.isFinite(nestedPreparation.decompressionTimeMs)
        ? nestedPreparation.decompressionTimeMs
        : getKnownDecompressionTimeMs(nestedSteps);
    return typeof nestedDurationMs === "number" && Number.isFinite(nestedDurationMs) ? nestedDurationMs : durationMs;
  }
  parentCompressions.push({
    decompressionTimeMs: durationMs,
    depth: parentCompressions.length,
    fileName: current.fileName || "input.bin",
    kind: getCompressionKind(current),
    outputSize: assets.reduce((total, asset) => total + asset.size, 0),
    sourceSize: current.fileSize,
  });
  return durationMs;
};

const hasSameFileIdentity = (previous: PatchFileInstance, next: PatchFileInstance) =>
  previous === next ||
  (String(previous.fileName || "") === String(next.fileName || "") &&
    Number(previous.fileSize || 0) === Number(next.fileSize || 0) &&
    String(previous.filePath || "") === String(next.filePath || ""));

const getCompressedIdentityKey = (
  file: PatchFileInstance,
  classification: ReturnType<typeof getCompressionClassification>,
) =>
  [
    classification.kind === "compression" ? classification.compressionFormat : "raw",
    String(file.fileName || ""),
    Number(file.fileSize || 0),
    isRomSpecificDecompressionOutput(file) ? "" : String(file.filePath || ""),
  ].join("|");

const finalizePreparedInputAssets = (
  assets: InputAsset[],
  sourceSize: number,
  wasDecompressed: boolean,
  decompressionTimeMs: number,
  parentCompressions: InputParentCompression[],
  sidecarPatches: PreparedSidecarPatch[] = [],
) => {
  // Re-attach the sidecar patches the descent harvested in an earlier pass: each later pass rebuilds
  // the asset (e.g. a nested zip→chd), so they ride the loop's accumulator and land on the final asset.
  if (sidecarPatches.length && assets[0]) {
    assets[0].sidecarPatches = [...(assets[0].sidecarPatches ?? []), ...sidecarPatches];
  }
  return attachInputPreparationMetrics(assets, {
    ...(Number.isFinite(sourceSize) ? { sourceSize } : {}),
    ...(parentCompressions.length ? { parentCompressions: parentCompressions.map((entry) => ({ ...entry })) } : {}),
    ...(wasDecompressed ? { decompressionTimeMs, wasDecompressed: true } : { wasDecompressed: false }),
  });
};

const getKnownDecompressionTimeMs = (entries: InputParentCompression[]): number | undefined => {
  let total = 0;
  let found = false;
  for (const entry of entries) {
    if (typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)) {
      total += entry.decompressionTimeMs;
      found = true;
    }
  }
  return found ? total : undefined;
};

const getActiveExtractTimeMs = (file: PatchFileInstance, fallbackMs: number): number => {
  const reported = (file as PatchFileInstance & { _extractTimeMs?: number })._extractTimeMs;
  return typeof reported === "number" && Number.isFinite(reported) ? reported : fallbackMs;
};

const getFileExtension = (fileName: string | undefined) => {
  const normalized = stripFileNameQuery(fileName || "");
  const index = normalized.lastIndexOf(".");
  return index === -1 ? "" : normalized.slice(index + 1).toLowerCase();
};

const getCompressionClassification = (file: PatchFileInstance) => classifyPatcherInput(file);

const isRomSpecificDecompressionOutput = (file: PatchFileInstance) =>
  !!(file as { _romSpecificDecompressionOutput?: boolean })._romSpecificDecompressionOutput;

const canProbeRomSpecificMagicSynchronously = (file: PatchFileInstance) =>
  file._u8array instanceof Uint8Array ||
  (!(file as { _browserFileBacked?: boolean })._browserFileBacked && typeof file.readIntoAt === "function");

const getPreparedInputFinalizeReason = (
  file: PatchFileInstance,
  classification: ReturnType<typeof getCompressionClassification>,
) =>
  isRomSpecificDecompressionOutput(file) && !canProbeRomSpecificMagicSynchronously(file)
    ? "disc-output-non-probeable"
    : isLazyExternalPatchFile(file) && classification.kind !== "compression"
      ? "lazy-non-compression"
      : null;

const getCompressionKind = (file: PatchFileInstance) => {
  const classification = getCompressionClassification(file);
  if (classification.kind === "compression") return classification.compressionFormat;
  const extension = getFileExtension(file.fileName);
  if (extension === "zip" || extension === "zipx") return "zip";
  if (extension === "7z") return "7z";
  if (extension === "rar") return "rar";
  return "compression";
};

const getInputDecompressionStartLabel = (file: PatchFileInstance, options: InputPreparationOptions): string | null => {
  if (options?.input?.containerInputsEnabled === false) return null;
  const classification = getCompressionClassification(file);
  if (classification.kind !== "compression") return null;
  const fileName = stripFileNameQuery(file.fileName || "");
  if (fileName) return `Extracting ${fileName}...`;
  if (classification.compressionFormat === "chd") return "Preparing CHD extraction...";
  if (classification.compressionFormat === "rvz") return "Preparing RVZ extraction...";
  if (classification.compressionFormat === "z3ds") return "Preparing Z3DS extraction...";
  return "Extracting archive entry...";
};

const reportInputDecompressionStart = (file: PatchFileInstance, options: InputPreparationOptions) => {
  const label = getInputDecompressionStartLabel(file, options);
  if (!label) return;
  reportProgress(options, {
    label,
    percent: null,
    stage: "input",
  });
};

const finalizePreparedInputFile = (
  file: PatchFileInstance,
  sourceSize: number,
  wasDecompressed: boolean,
  decompressionTimeMs: number,
  parentCompressions: InputParentCompression[],
): PreparedInputFileResult => ({
  decompressionTimeMs,
  file,
  parentCompressions: parentCompressions.map((entry) => ({ ...entry })),
  sourceSize,
  wasDecompressed,
});

/**
 * One unwrap step, with the four traces that bracket it. `.before`/`.after` and
 * `.extract.start`/`.extract.finish` are separate event names that downstream
 * readers key on, so both pairs stay.
 */
const extractOneDecompressionPass = async (input: {
  compressedIdentity: string;
  current: PatchFileInstance;
  options: InputPreparationOptions;
  pass: number;
  role: "rom" | "patch";
  runtime: InputPreparationRuntimeLike;
  selectedEntryName: string | undefined;
  sourceIndex: number;
}) => {
  const { compressedIdentity, current, options, pass, role, sourceIndex } = input;
  const before = {
    compressedIdentity,
    file: describeArchiveFileForTrace(current),
    pass,
    role,
    selectedEntryName: input.selectedEntryName || "",
    sourceIndex,
  };
  traceInputDecompression(options, "input.decompression.extract.start", before);
  traceInputDecompression(options, "input.decompression.before", before);
  const startedAt = Date.now();
  const extracted = await resolveArchiveInput(
    current,
    role,
    options,
    input.runtime,
    input.selectedEntryName,
    sourceIndex,
  );
  const durationMs = getActiveExtractTimeMs(extracted, Date.now() - startedAt);
  const after = {
    compressedIdentity,
    decompressionTimeMs: durationMs,
    extracted: describeArchiveFileForTrace(extracted),
    pass,
    role,
    sourceIndex,
  };
  traceInputDecompression(options, "input.decompression.after", after);
  traceInputDecompression(options, "input.decompression.extract.finish", after);
  return { durationMs, extracted };
};

/**
 * One asset-producing unwrap step. Sidecar patches the descent harvested move onto
 * the caller's accumulator here: a later pass rebuilds the asset, so finalize
 * re-attaches them to whatever asset is ultimately returned.
 */
const extractOneAssetPass = async (input: {
  compressedIdentity: string;
  current: PatchFileInstance;
  harvestedSidecarPatches: PreparedSidecarPatch[];
  options: ApplyWorkflowOptions | undefined;
  pass: number;
  runtime: InputPreparationRuntimeLike;
  selectedEntryName: string | undefined;
  sourceIndex: number;
}) => {
  const { compressedIdentity, current, options, pass, sourceIndex } = input;
  const before = {
    compressedIdentity,
    file: describeArchiveFileForTrace(current),
    pass,
    selectedEntryName: input.selectedEntryName || "",
    sourceIndex,
  };
  traceInputDecompression(options, "input.decompression.assets.extract.start", before);
  traceInputDecompression(options, "input.decompression.assets.before", before);
  const startedAt = Date.now();
  const assets = await resolveArchiveInputAssets(current, options, sourceIndex, input.runtime, input.selectedEntryName);
  const durationMs = Date.now() - startedAt;
  for (const asset of assets) {
    if (asset.sidecarPatches?.length) {
      input.harvestedSidecarPatches.push(...asset.sidecarPatches);
      asset.sidecarPatches = undefined;
    }
  }
  const after = {
    compressedIdentity,
    decompressionTimeMs: durationMs,
    outputAssetCount: assets.length,
    outputKinds: assets.map((asset) => asset.kind),
    pass,
    sourceIndex,
  };
  traceInputDecompression(options, "input.decompression.assets.after", after);
  traceInputDecompression(options, "input.decompression.assets.extract.finish", after);
  return { assets, durationMs };
};

/** Only a lone ROM is worth another unwrap pass; anything else is the final result. */
const isSingleRomResult = (assets: InputAsset[]): assets is [InputAsset] =>
  assets.length === 1 && assets[0]?.kind === "rom";

/** A container that unwraps to itself would loop forever; stop with a clear error. */
const assertNoRepeatedIdentity = (
  seen: Set<string>,
  compressedIdentity: string,
  ctx: { current: PatchFileInstance; options: ApplyWorkflowOptions | undefined; pass: number; sourceIndex: number },
) => {
  if (!seen.has(compressedIdentity)) return;
  traceInputDecompression(ctx.options, "input.decompression.assets.stall", {
    compressedIdentity,
    file: describeArchiveFileForTrace(ctx.current),
    pass: ctx.pass,
    reason: "repeat-compressed-identity",
    sourceIndex: ctx.sourceIndex,
  });
  throwRecursiveDecompressionStall(ctx.current);
};

/** The same guard on the other side: an unwrap that returned its own input. */
const assertMadeProgress = (
  current: PatchFileInstance,
  extracted: PatchFileInstance,
  ctx: { options: ApplyWorkflowOptions | undefined; pass: number; sourceIndex: number },
) => {
  if (!hasSameFileIdentity(current, extracted)) return;
  traceInputDecompression(ctx.options, "input.decompression.assets.stall", {
    file: describeArchiveFileForTrace(current),
    pass: ctx.pass,
    reason: "extracted-same-file-identity",
    sourceIndex: ctx.sourceIndex,
  });
  throwRecursiveDecompressionStall(extracted);
};

/** One shape for every "stop unwrapping here" trace, so the loop reads as steps. */
const traceInputFinalize = (
  options: InputPreparationOptions,
  input: {
    classificationKind?: string;
    current: PatchFileInstance;
    pass: number;
    reason: string;
    role: "rom" | "patch";
    sourceIndex: number;
  },
) => {
  traceInputDecompression(options, "input.decompression.finalize", {
    ...(input.classificationKind === undefined ? {} : { classificationKind: input.classificationKind }),
    file: describeArchiveFileForTrace(input.current),
    pass: input.pass,
    reason: input.reason,
    role: input.role,
    sourceIndex: input.sourceIndex,
  });
};

const resolveCompressedInputFile = async (
  file: PatchFileInstance,
  role: "rom" | "patch",
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
): Promise<PreparedInputFileResult> => {
  let current = file;
  let selectedEntryName = selectedArchiveEntry;
  let decompressionTimeMs = 0;
  const parentCompressions: InputParentCompression[] = [];
  const seenCompressedInputs = new Set<string>();
  let wasDecompressed = false;
  const sourceSize = file.fileSize;
  const finalizeHere = () =>
    finalizePreparedInputFile(current, sourceSize, wasDecompressed, decompressionTimeMs, parentCompressions);
  for (let pass = 0; pass < MAX_DECOMPRESSION_PASSES; pass += 1) {
    if (options?.input?.containerInputsEnabled === false) {
      traceInputFinalize(options, { current, pass, reason: "container-inputs-disabled", role, sourceIndex });
      return finalizeHere();
    }
    const classification = getCompressionClassification(current);
    traceInputDecompression(options, "input.decompression.pass", {
      classificationKind: classification.kind,
      compressionFormat: classification.kind === "compression" ? classification.compressionFormat : "raw",
      file: describeArchiveFileForTrace(current),
      pass,
      role,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    const finalizeReason = getPreparedInputFinalizeReason(current, classification);
    if (finalizeReason) {
      traceInputFinalize(options, {
        classificationKind: classification.kind,
        current,
        pass,
        reason: finalizeReason,
        role,
        sourceIndex,
      });
      return finalizeHere();
    }
    if (classification.kind !== "compression") {
      traceInputFinalize(options, {
        classificationKind: classification.kind,
        current,
        pass,
        reason: "not-compression",
        role,
        sourceIndex,
      });
      return finalizeHere();
    }
    const compressedIdentity = getCompressedIdentityKey(current, classification);
    if (seenCompressedInputs.has(compressedIdentity)) {
      traceInputDecompression(options, "input.decompression.stall", {
        compressedIdentity,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "repeat-compressed-identity",
        role,
        sourceIndex,
      });
      throwRecursiveDecompressionStall(current);
    }
    seenCompressedInputs.add(compressedIdentity);
    reportInputDecompressionStart(current, options);
    const { durationMs, extracted } = await extractOneDecompressionPass({
      compressedIdentity,
      current,
      options,
      pass,
      role,
      runtime,
      selectedEntryName,
      sourceIndex,
    });
    decompressionTimeMs += durationMs;
    wasDecompressed = true;
    parentCompressions.push({
      decompressionTimeMs: durationMs,
      depth: parentCompressions.length,
      fileName: current.fileName || "input.bin",
      kind: getCompressionKind(current),
      outputSize: extracted.fileSize,
      sourceSize: current.fileSize,
    });
    if (hasSameFileIdentity(current, extracted)) {
      traceInputDecompression(options, "input.decompression.stall", {
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "extracted-same-file-identity",
        role,
        sourceIndex,
      });
      throwRecursiveDecompressionStall(extracted);
    }
    current = extracted;
    selectedEntryName = undefined;
  }
  traceInputDecompression(options, "input.decompression.limit", {
    file: describeArchiveFileForTrace(current),
    maxPasses: MAX_DECOMPRESSION_PASSES,
    role,
    sourceIndex,
  });
  return throwDecompressionLimitExceeded();
};

const resolveCompressedInputAssets = async (
  file: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  sourceIndex: number,
  selectedInputEntryName?: string,
): Promise<InputAsset[]> => {
  let current = file;
  let selectedEntryName = selectedInputEntryName;
  let decompressionTimeMs = 0;
  const parentCompressions: InputParentCompression[] = [];
  const harvestedSidecarPatches: PreparedSidecarPatch[] = [];
  const seenCompressedInputs = new Set<string>();
  let wasDecompressed = false;
  const sourceSize = file.fileSize;
  for (let pass = 0; pass < MAX_DECOMPRESSION_PASSES; pass += 1) {
    if (options?.input?.containerInputsEnabled === false)
      return finalizeContainerDisabledInput({
        current,
        decompressionTimeMs,
        harvestedSidecarPatches,
        options,
        parentCompressions,
        pass,
        sourceIndex,
        sourceSize,
        wasDecompressed,
      });
    const classification = getCompressionClassification(current);
    traceInputDecompression(options, "input.decompression.assets.pass", {
      classificationKind: classification.kind,
      compressionFormat: classification.kind === "compression" ? classification.compressionFormat : "raw",
      file: describeArchiveFileForTrace(current),
      pass,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    // Finalize a bare (non-container) ROM: checksum it via `ingest` (in place, full thread budget,
    // shared variant engine) and attach the result as precomputed metadata, so the input-checksum step
    // reuses it instead of the standalone `checksum` command, which under-threaded multi-variant ROMs
    // (e.g. GBA: raw + fix-header → 1 thread per variant). Best-effort - on failure (or a source `ingest`
    // classifies as a patch) the file is left unchanged and checksummed the usual way downstream.
    const finalizeAsSingleRom = () =>
      finalizePreparedInputAssets(
        [makeRomAsset(makeInputId(sourceIndex, current.fileName, normalizeArchiveEntryName), current)],
        sourceSize,
        wasDecompressed,
        decompressionTimeMs,
        parentCompressions,
        harvestedSidecarPatches,
      );
    const finalizeBareRom = async (): Promise<InputAsset[]> => {
      await attachBareRomIngestMetadata(current, options, runtime);
      return finalizeAsSingleRom();
    };
    const finalizeReason = getPreparedInputFinalizeReason(current, classification);
    if (finalizeReason) {
      traceInputDecompression(options, "input.decompression.assets.finalize", {
        classificationKind: classification.kind,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: finalizeReason,
        sourceIndex,
      });
      // A large bare ROM is kept as a lazy browser source, so it lands here (`lazy-non-compression`)
      // rather than the plain non-compression branch below - ingest it too. A `disc-output-non-probeable`
      // file is a mid-pipeline decoded disc; leave it on the standard checksum path.
      return finalizeReason === "lazy-non-compression" ? finalizeBareRom() : finalizeAsSingleRom();
    }
    if (classification.kind !== "compression") return finalizeBareRom();
    const compressedIdentity = getCompressedIdentityKey(current, classification);
    assertNoRepeatedIdentity(seenCompressedInputs, compressedIdentity, { current, options, pass, sourceIndex });
    seenCompressedInputs.add(compressedIdentity);
    reportInputDecompressionStart(current, options);
    const { assets, durationMs } = await extractOneAssetPass({
      compressedIdentity,
      current,
      harvestedSidecarPatches,
      options,
      pass,
      runtime,
      selectedEntryName,
      sourceIndex,
    });
    wasDecompressed = true;
    decompressionTimeMs += recordDecompressionMetrics({ assets, current, durationMs, parentCompressions });
    selectedEntryName = undefined;
    if (!isSingleRomResult(assets)) {
      traceInputDecompression(options, "input.decompression.assets.finalize", {
        outputAssetCount: assets.length,
        outputKinds: assets.map((asset) => asset.kind),
        pass,
        reason: "non-single-rom-assets",
        sourceIndex,
      });
      return finalizePreparedInputAssets(
        assets,
        sourceSize,
        wasDecompressed,
        decompressionTimeMs,
        parentCompressions,
        harvestedSidecarPatches,
      );
    }
    assertMadeProgress(current, assets[0].file, { options, pass, sourceIndex });
    current = assets[0].file;
  }
  traceInputDecompression(options, "input.decompression.assets.limit", {
    file: describeArchiveFileForTrace(current),
    maxPasses: MAX_DECOMPRESSION_PASSES,
    sourceIndex,
  });
  return throwDecompressionLimitExceeded();
};

export type { PreparedInputFileResult };
export { getActiveExtractTimeMs, resolveCompressedInputAssets, resolveCompressedInputFile };
