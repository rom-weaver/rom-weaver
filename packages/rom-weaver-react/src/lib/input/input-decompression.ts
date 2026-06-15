import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { RomWeaverError } from "../errors.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { isLazyExternalPatchFile } from "./binary-service.ts";
import type { InputAsset, InputParentCompression } from "./input-assets.ts";
import {
  attachInputPreparationMetrics,
  getInputPreparationMetrics,
  makeInputId,
  makeRomAsset,
} from "./input-assets.ts";
import { classifyPatcherInput } from "./input-classification.ts";
import {
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
  options.onLog?.({
    details: {
      ...details,
      operation: "input-decompression",
    },
    level: "trace",
    message,
    namespace: "workflow:input-decompression",
    timestamp: new Date().toISOString(),
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
) =>
  attachInputPreparationMetrics(assets, {
    ...(Number.isFinite(sourceSize) ? { sourceSize } : {}),
    ...(parentCompressions.length ? { parentCompressions: parentCompressions.map((entry) => ({ ...entry })) } : {}),
    ...(wasDecompressed ? { decompressionTimeMs, wasDecompressed: true } : { wasDecompressed: false }),
  });

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
  for (let pass = 0; pass < MAX_DECOMPRESSION_PASSES; pass += 1) {
    if (options?.input?.containerInputsEnabled === false) {
      traceInputDecompression(options, "input.decompression.finalize", {
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "container-inputs-disabled",
        role,
        sourceIndex,
      });
      return finalizePreparedInputFile(current, sourceSize, wasDecompressed, decompressionTimeMs, parentCompressions);
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
      traceInputDecompression(options, "input.decompression.finalize", {
        classificationKind: classification.kind,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: finalizeReason,
        role,
        sourceIndex,
      });
      return finalizePreparedInputFile(current, sourceSize, wasDecompressed, decompressionTimeMs, parentCompressions);
    }
    if (classification.kind !== "compression") {
      traceInputDecompression(options, "input.decompression.finalize", {
        classificationKind: classification.kind,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "not-compression",
        role,
        sourceIndex,
      });
      return finalizePreparedInputFile(current, sourceSize, wasDecompressed, decompressionTimeMs, parentCompressions);
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
    traceInputDecompression(options, "input.decompression.extract.start", {
      compressedIdentity,
      file: describeArchiveFileForTrace(current),
      pass,
      role,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    traceInputDecompression(options, "input.decompression.before", {
      compressedIdentity,
      file: describeArchiveFileForTrace(current),
      pass,
      role,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    const startedAt = Date.now();
    const extracted = await resolveArchiveInput(current, role, options, runtime, selectedEntryName, sourceIndex);
    const durationMs = Date.now() - startedAt;
    traceInputDecompression(options, "input.decompression.after", {
      compressedIdentity,
      decompressionTimeMs: durationMs,
      extracted: describeArchiveFileForTrace(extracted),
      pass,
      role,
      sourceIndex,
    });
    traceInputDecompression(options, "input.decompression.extract.finish", {
      compressedIdentity,
      decompressionTimeMs: durationMs,
      extracted: describeArchiveFileForTrace(extracted),
      pass,
      role,
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
  const seenCompressedInputs = new Set<string>();
  let wasDecompressed = false;
  const sourceSize = file.fileSize;
  for (let pass = 0; pass < MAX_DECOMPRESSION_PASSES; pass += 1) {
    if (options?.input?.containerInputsEnabled === false) {
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
      );
    }
    const classification = getCompressionClassification(current);
    traceInputDecompression(options, "input.decompression.assets.pass", {
      classificationKind: classification.kind,
      compressionFormat: classification.kind === "compression" ? classification.compressionFormat : "raw",
      file: describeArchiveFileForTrace(current),
      pass,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    const finalizeReason = getPreparedInputFinalizeReason(current, classification);
    if (finalizeReason) {
      traceInputDecompression(options, "input.decompression.assets.finalize", {
        classificationKind: classification.kind,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: finalizeReason,
        sourceIndex,
      });
      return finalizePreparedInputAssets(
        [makeRomAsset(makeInputId(sourceIndex, current.fileName, normalizeArchiveEntryName), current)],
        sourceSize,
        wasDecompressed,
        decompressionTimeMs,
        parentCompressions,
      );
    }
    if (classification.kind !== "compression")
      return finalizePreparedInputAssets(
        [makeRomAsset(makeInputId(sourceIndex, current.fileName, normalizeArchiveEntryName), current)],
        sourceSize,
        wasDecompressed,
        decompressionTimeMs,
        parentCompressions,
      );
    const compressedIdentity = getCompressedIdentityKey(current, classification);
    if (seenCompressedInputs.has(compressedIdentity)) {
      traceInputDecompression(options, "input.decompression.assets.stall", {
        compressedIdentity,
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "repeat-compressed-identity",
        sourceIndex,
      });
      throwRecursiveDecompressionStall(current);
    }
    seenCompressedInputs.add(compressedIdentity);
    reportInputDecompressionStart(current, options);
    traceInputDecompression(options, "input.decompression.assets.extract.start", {
      compressedIdentity,
      file: describeArchiveFileForTrace(current),
      pass,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    traceInputDecompression(options, "input.decompression.assets.before", {
      compressedIdentity,
      file: describeArchiveFileForTrace(current),
      pass,
      selectedEntryName: selectedEntryName || "",
      sourceIndex,
    });
    const startedAt = Date.now();
    const assets = await resolveArchiveInputAssets(current, options, sourceIndex, runtime, selectedEntryName);
    const durationMs = Date.now() - startedAt;
    traceInputDecompression(options, "input.decompression.assets.after", {
      compressedIdentity,
      decompressionTimeMs: durationMs,
      outputAssetCount: assets.length,
      outputKinds: assets.map((asset) => asset.kind),
      pass,
      sourceIndex,
    });
    traceInputDecompression(options, "input.decompression.assets.extract.finish", {
      compressedIdentity,
      decompressionTimeMs: durationMs,
      outputAssetCount: assets.length,
      outputKinds: assets.map((asset) => asset.kind),
      pass,
      sourceIndex,
    });
    wasDecompressed = true;
    const nestedPreparation = getInputPreparationMetrics(assets);
    const nestedSteps = [...(nestedPreparation?.parentCompressions || [])].sort(
      (left, right) => left.depth - right.depth,
    );
    if (nestedSteps.length) {
      for (const entry of nestedSteps) {
        parentCompressions.push({
          ...entry,
          depth: parentCompressions.length,
        });
      }
      const nestedDurationMs =
        typeof nestedPreparation?.decompressionTimeMs === "number" &&
        Number.isFinite(nestedPreparation.decompressionTimeMs)
          ? nestedPreparation.decompressionTimeMs
          : getKnownDecompressionTimeMs(nestedSteps);
      decompressionTimeMs +=
        typeof nestedDurationMs === "number" && Number.isFinite(nestedDurationMs) ? nestedDurationMs : durationMs;
    } else {
      decompressionTimeMs += durationMs;
      parentCompressions.push({
        decompressionTimeMs: durationMs,
        depth: parentCompressions.length,
        fileName: current.fileName || "input.bin",
        kind: getCompressionKind(current),
        outputSize: assets.reduce((total, asset) => total + asset.size, 0),
        sourceSize: current.fileSize,
      });
    }
    selectedEntryName = undefined;
    if (assets.length !== 1 || assets[0]?.kind !== "rom") {
      traceInputDecompression(options, "input.decompression.assets.finalize", {
        outputAssetCount: assets.length,
        outputKinds: assets.map((asset) => asset.kind),
        pass,
        reason: "non-single-rom-assets",
        sourceIndex,
      });
      return finalizePreparedInputAssets(assets, sourceSize, wasDecompressed, decompressionTimeMs, parentCompressions);
    }
    if (hasSameFileIdentity(current, assets[0].file)) {
      traceInputDecompression(options, "input.decompression.assets.stall", {
        file: describeArchiveFileForTrace(current),
        pass,
        reason: "extracted-same-file-identity",
        sourceIndex,
      });
      throwRecursiveDecompressionStall(assets[0].file);
    }
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
export { resolveCompressedInputAssets, resolveCompressedInputFile };
