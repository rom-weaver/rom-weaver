import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { WorkflowKind, WorkflowProgress, WorkflowProgressRole } from "../../types/progress.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import type { InputAsset, InputParentCompression } from "../input/input-assets.ts";
import { adoptStagedInput, resolveInputWriteToPath } from "../input/input-opfs-staging.ts";
import { createChecksumSource, DEFAULT_CHECKSUMS, isRecord } from "./controller-utils.ts";

type StandardWorkflowChecksums = Record<(typeof DEFAULT_CHECKSUMS)[number], string>;
type StandardChecksumParentCompression = InputParentCompression;
type ChecksumCalculateInput = Parameters<NonNullable<WorkflowRuntime["checksum"]["calculate"]>>[0];
type StandardChecksumState = {
  decompressionTimeMs?: number;
  fileName?: string;
  id: string;
  order?: number;
  parentCompressions?: StandardChecksumParentCompression[];
  size?: number;
  sourceSize?: number;
  wasDecompressed?: boolean;
};
type StandardChecksumProgressEvent = {
  details?: Record<string, unknown>;
  id: string;
  label: string;
  percent?: number | null;
  role: WorkflowProgressRole;
  stage: WorkflowProgress["stage"];
  workflow: WorkflowKind;
};
type StandardChecksumOptions = {
  emitProgress: (event: StandardChecksumProgressEvent) => void;
  file: PatchFileInstance;
  logLevel?: LogLevel;
  onLog?: ChecksumCalculateInput["onLog"];
  progressId?: string;
  role: WorkflowProgressRole;
  runtime: WorkflowRuntime;
  state: StandardChecksumState;
  workflow: WorkflowKind;
};

const getPatchFilePrecomputedChecksums = (
  file: PatchFileInstance | undefined,
): StandardWorkflowChecksums | undefined => {
  const checksums = (file as (PatchFileInstance & { checksums?: unknown }) | undefined)?.checksums;
  if (!isRecord(checksums)) return undefined;
  const out = {} as StandardWorkflowChecksums;
  for (const algorithm of DEFAULT_CHECKSUMS) {
    const value = checksums[algorithm];
    if (typeof value !== "string" || !value.trim()) return undefined;
    out[algorithm] = value.trim().toLowerCase();
  }
  return out;
};

// Disc sheets (cue/gdi) are sidecars, not ROM data — never checksum them.
const isChecksummableInputAsset = (asset: InputAsset) => asset.kind !== "cue" && asset.kind !== "gdi";

const getInputAssetChecksums = (asset: InputAsset | undefined): StandardWorkflowChecksums | undefined => {
  if (!asset) return undefined;
  return (asset.checksums as StandardWorkflowChecksums | undefined) || getPatchFilePrecomputedChecksums(asset.file);
};

const getAssetParentCompressions = (
  asset: InputAsset,
  fallback: StandardChecksumParentCompression[],
): StandardChecksumParentCompression[] =>
  (asset.preparation?.parentCompressions || fallback).map((entry) => ({
    ...entry,
  }));

const getAssetDecompressionTimeMs = (asset: InputAsset, fallback?: number) =>
  typeof asset.preparation?.decompressionTimeMs === "number" && Number.isFinite(asset.preparation.decompressionTimeMs)
    ? asset.preparation.decompressionTimeMs
    : fallback;

const getAssetSourceSize = (asset: InputAsset, fallback?: number) =>
  typeof asset.preparation?.sourceSize === "number" && Number.isFinite(asset.preparation.sourceSize)
    ? asset.preparation.sourceSize
    : fallback;

const getPrimaryInputAsset = (assets: InputAsset[]) =>
  assets.find((asset) => asset.patchable) || assets.find(isChecksummableInputAsset) || assets[0];

const cloneChecksumRomProbe = (romProbe: ChecksumRomProbe | undefined): ChecksumRomProbe | undefined =>
  romProbe
    ? {
        trim: {
          ...romProbe.trim,
        },
      }
    : undefined;

const cloneRomType = (romType: RomTypeTag | undefined): RomTypeTag | undefined =>
  romType ? { ...romType } : undefined;

const cloneChecksumVariants = (variants: ChecksumVariant[] | undefined): ChecksumVariant[] | undefined =>
  variants?.map((variant) => ({
    ...variant,
    applyCompatibility: variant.applyCompatibility ? { ...variant.applyCompatibility } : undefined,
    checksums: { ...variant.checksums },
    transforms: variant.transforms ? { ...variant.transforms } : undefined,
  }));

const getPatchFilePrecomputedChecksumVariants = (
  file: PatchFileInstance | undefined,
): ChecksumVariant[] | undefined => {
  const variants = (file as (PatchFileInstance & { checksumVariants?: unknown }) | undefined)?.checksumVariants;
  return Array.isArray(variants) ? cloneChecksumVariants(variants as ChecksumVariant[]) : undefined;
};

const getPatchFilePrecomputedRomType = (file: PatchFileInstance | undefined): RomTypeTag | undefined => {
  const romType = (file as (PatchFileInstance & { romType?: unknown }) | undefined)?.romType;
  return romType && typeof romType === "object" ? cloneRomType(romType as RomTypeTag) : undefined;
};

const createChecksumProgressDetails = (state: StandardChecksumState) => ({
  decompressionTimeMs: state.decompressionTimeMs,
  fileName: state.fileName,
  order: state.order,
  parentCompressions: state.parentCompressions?.map((entry) => ({ ...entry })),
  size: state.size,
  sourceId: state.id,
  sourceSize: state.sourceSize,
  wasDecompressed: state.wasDecompressed,
});

const calculateStandardInputChecksumsForFile = async ({
  emitProgress,
  file,
  logLevel,
  onLog,
  progressId,
  role,
  runtime,
  state,
  workflow,
}: StandardChecksumOptions): Promise<{
  checksums: StandardWorkflowChecksums;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  variants?: ChecksumVariant[];
}> => {
  if (!runtime.checksum.calculate) return { checksums: {} as StandardWorkflowChecksums };
  const details = createChecksumProgressDetails(state);
  const id = `${progressId || state.id}:checksum`;
  // Every Blob-backed input is copied to OPFS DURING the checksum (one pass via the command's write_to):
  // the interleaved writes keep a large WebKit/iOS Blob read from OOM-reloading the tab, and the copy is
  // reused by the later apply. null only when there is no Blob to copy or the input is already staged.
  const writeToPath = resolveInputWriteToPath(file, { logLevel, onLog });
  emitProgress({
    details,
    id,
    label: "Calculating checksums...",
    percent: null,
    role,
    stage: "checksum",
    workflow,
  });
  const result = await runtime.checksum.calculate({
    algorithms: [...DEFAULT_CHECKSUMS],
    logLevel,
    onLog,
    onProgress: (progress) =>
      emitProgress({
        details,
        id,
        label: String(progress.label || progress.message || "Calculating checksums..."),
        percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
        role,
        stage: "checksum",
        workflow,
      }),
    source: createChecksumSource(file, state.fileName) as never,
    ...(writeToPath ? { writeTo: writeToPath } : {}),
  });
  // The checksum succeeded and wrote the input to OPFS; point the input at that copy so apply reuses it.
  if (writeToPath) adoptStagedInput(file, writeToPath, file.fileSize, { logLevel, onLog });
  return {
    checksums: {
      crc32: Number(result.crc32 || 0)
        .toString(16)
        .padStart(8, "0"),
      md5: result.md5 || "",
      sha1: result.sha1 || "",
    },
    romProbe: cloneChecksumRomProbe(result.romProbe),
    romType: cloneRomType(result.romType),
    variants: cloneChecksumVariants(result.variants),
  };
};

export type { StandardWorkflowChecksums };
export {
  calculateStandardInputChecksumsForFile,
  cloneChecksumRomProbe,
  cloneChecksumVariants,
  cloneRomType,
  getAssetDecompressionTimeMs,
  getAssetParentCompressions,
  getAssetSourceSize,
  getInputAssetChecksums,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedChecksumVariants,
  getPatchFilePrecomputedRomType,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
};
