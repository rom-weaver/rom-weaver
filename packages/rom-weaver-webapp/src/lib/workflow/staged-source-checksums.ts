import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "../../types/checksum.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { WorkflowKind, WorkflowProgress, WorkflowProgressRole } from "../../types/progress.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import type { InputAsset, InputParentCompression } from "../input/input-assets.ts";
import { romTypeFromEmittedFile } from "../runtime/run-result-parsing.ts";
import { createChecksumSource, DEFAULT_CHECKSUMS, isRecord } from "./controller-utils.ts";

type StandardWorkflowChecksums = Record<(typeof DEFAULT_CHECKSUMS)[number], string>;
type StandardChecksumParentCompression = InputParentCompression;
type IngestRunInput = Parameters<NonNullable<NonNullable<WorkflowRuntime["ingest"]>["run"]>>[0];
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
  onLog?: IngestRunInput["onLog"];
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

// Disc sheets (cue/gdi) are sidecars, not ROM data - never checksum them.
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

// Elapsed time of a precomputed checksum produced OUTSIDE an extract (a bare ROM checksummed in place
// via `ingest`). Absent for an archive leaf, whose checksum ran during extract (reported as 0 → the
// "from extract" timing label).
const getPatchFilePrecomputedChecksumMs = (file: PatchFileInstance | undefined): number | undefined => {
  const ms = (file as (PatchFileInstance & { _precomputedChecksumMs?: unknown }) | undefined)?._precomputedChecksumMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
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
  // Checksum the prepared input asset via `ingest`, not the standalone `checksum` command: ingest
  // classifies the (already-extracted) leaf as a bare ROM and hashes it in place with the SAME shared
  // variant engine - fed the full thread budget - so multi-variant ROMs (e.g. GBA raw + fix-header)
  // are not under-threaded the way the per-command checksum cap used to do. `romProbe` is absent
  // because ingest never produces it (the standalone path only ever emitted a `{ trim: { detected:
  // false } }` placeholder for these inputs).
  if (!runtime.ingest?.run) return { checksums: {} as StandardWorkflowChecksums };
  const details = createChecksumProgressDetails(state);
  const id = `${progressId || state.id}:checksum`;
  emitProgress({
    details,
    id,
    label: "Calculating checksums...",
    percent: null,
    role,
    stage: "checksum",
    workflow,
  });
  const { result } = await runtime.ingest.run({
    checksumAlgorithms: [...DEFAULT_CHECKSUMS],
    fileName: state.fileName,
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
    source: createChecksumSource(file, state.fileName),
  });
  const asset = result.isRom ? result.assets[0] : undefined;
  const assetChecksums = (asset?.checksums ?? {}) as Record<string, string | undefined>;
  const checksums = {} as StandardWorkflowChecksums;
  for (const algorithm of DEFAULT_CHECKSUMS) {
    const value = assetChecksums[algorithm];
    checksums[algorithm] = typeof value === "string" ? value.trim().toLowerCase() : "";
  }
  return {
    checksums,
    romProbe: undefined,
    romType: romTypeFromEmittedFile({
      discFormat: asset?.discFormat,
      platform: asset?.platform,
      recommendedFormat: asset?.recommendedFormat,
    }),
    variants: cloneChecksumVariants(asset?.checksumVariants),
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
  getPatchFilePrecomputedChecksumMs,
  getPatchFilePrecomputedChecksums,
  getPatchFilePrecomputedChecksumVariants,
  getPatchFilePrecomputedRomType,
  getPrimaryInputAsset,
  isChecksummableInputAsset,
};
