// Parse the `details.ingest` payload of a terminal `ingest` event into a webapp-facing result.
//
// The generated wire types (`IngestResult`/`IngestRomAsset`/`PatchDescriptor`) carry `u64` fields as
// `bigint`, but `JSON.parse` yields plain `number`s; this module coerces to a `number`-based,
// camelCase shape the webapp consumes directly (and drops `null`/absent optionals). It is the single
// boundary between the Rust contract and the input/patch state the apply workflow builds.
import type { ChecksumMap } from "../../types/checksum.ts";
import type { ParsedIngestResult, ParsedIngestRomAsset, ParsedPatchDescriptor } from "../../types/ingest.ts";
import type { IngestResult, IngestRomAsset, PatchDescriptor } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { parseChecksumVariants, type WireRecord } from "./run-result-parsing.ts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const toStringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const toNumberValue = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  return undefined;
};

const toChecksumMap = (value: unknown): ChecksumMap => {
  const record = asRecord(value);
  if (!record) return {} as ChecksumMap;
  const map: Record<string, string> = {};
  for (const [algorithm, raw] of Object.entries(record)) {
    if (typeof raw === "string" && raw) map[algorithm.toLowerCase()] = raw;
  }
  return map as ChecksumMap;
};

const parseRomAsset = (value: unknown): ParsedIngestRomAsset | undefined => {
  const record = asRecord(value) as WireRecord<IngestRomAsset> | undefined;
  if (!record) return undefined;
  const path = toStringValue(record.path);
  if (!path) return undefined;
  const asset: ParsedIngestRomAsset = {
    checksums: toChecksumMap(record.checksums),
    checksumVariants: parseChecksumVariants(record) ?? [],
    copiedInPlace: record.copied_in_place === true,
    fileName: toStringValue(record.file_name) || path,
    path,
    sizeBytes: toNumberValue(record.size_bytes) ?? 0,
  };
  const kind = toStringValue(record.kind);
  if (kind !== undefined) asset.kind = kind;
  const platform = toStringValue(record.platform);
  if (platform !== undefined) asset.platform = platform;
  const discFormat = toStringValue(record.disc_format);
  if (discFormat !== undefined) asset.discFormat = discFormat;
  const discGroupId = toStringValue(record.disc_group_id);
  if (discGroupId !== undefined) asset.discGroupId = discGroupId;
  const trackNumber = toNumberValue(record.track_number);
  if (trackNumber !== undefined) asset.trackNumber = trackNumber;
  const cueText = toStringValue(record.cue_text);
  if (cueText !== undefined) asset.cueText = cueText;
  const gdiText = toStringValue(record.gdi_text);
  if (gdiText !== undefined) asset.gdiText = gdiText;
  const extractTimeMs = toNumberValue(record.extract_time_ms);
  if (extractTimeMs !== undefined) asset.extractTimeMs = extractTimeMs;
  const checksumMs = toNumberValue(record.checksum_ms);
  if (checksumMs !== undefined) asset.checksumMs = checksumMs;
  return asset;
};

const parsePatchDescriptor = (value: unknown): ParsedPatchDescriptor | undefined => {
  const record = asRecord(value) as WireRecord<PatchDescriptor> | undefined;
  if (!record) return undefined;
  const leafPath = toStringValue(record.leaf_path);
  if (!leafPath) return undefined;
  const descriptor: ParsedPatchDescriptor = {
    fileName: toStringValue(record.file_name) || leafPath,
    filenameChecksums: toChecksumMap(record.filename_checksums),
    format: toStringValue(record.format) || "unknown",
    isValidPatch: record.is_valid_patch === true,
    leafPath,
    sizeBytes: toNumberValue(record.size_bytes) ?? 0,
  };
  const patchCrc32 = toNumberValue(record.patch_crc32);
  if (patchCrc32 !== undefined) descriptor.patchCrc32 = patchCrc32;
  const sourceSize = toNumberValue(record.source_size);
  if (sourceSize !== undefined) descriptor.sourceSize = sourceSize;
  const targetSize = toNumberValue(record.target_size);
  if (targetSize !== undefined) descriptor.targetSize = targetSize;
  const sourceCrc32 = toNumberValue(record.source_crc32);
  if (sourceCrc32 !== undefined) descriptor.sourceCrc32 = sourceCrc32;
  const targetCrc32 = toNumberValue(record.target_crc32);
  if (targetCrc32 !== undefined) descriptor.targetCrc32 = targetCrc32;
  const minimumSourceSize = toNumberValue(record.minimum_source_size);
  if (minimumSourceSize !== undefined) descriptor.minimumSourceSize = minimumSourceSize;
  const recordCount = toNumberValue(record.record_count);
  if (recordCount !== undefined) descriptor.recordCount = recordCount;
  const filenameSize = toNumberValue(record.filename_size);
  if (filenameSize !== undefined) descriptor.filenameSize = filenameSize;
  const sidecarOrder = toNumberValue(record.sidecar_order);
  if (sidecarOrder !== undefined) descriptor.sidecarOrder = sidecarOrder;
  return descriptor;
};

/**
 * Parse the `ingest` object from a terminal event's `details`. Returns `undefined` when the payload
 * is missing or malformed (so callers can fail loudly rather than route on a half-formed result).
 */
export const parseIngestResult = (details: unknown): ParsedIngestResult | undefined => {
  const ingest = asRecord(asRecord(details)?.ingest) as WireRecord<IngestResult> | undefined;
  if (!ingest) return undefined;
  const kind = ingest.kind === "patch" ? "patch" : ingest.kind === "rom" ? "rom" : undefined;
  if (!kind) return undefined;
  const assets = Array.isArray(ingest.assets)
    ? ingest.assets.map(parseRomAsset).filter((asset): asset is ParsedIngestRomAsset => asset !== undefined)
    : [];
  const patches = Array.isArray(ingest.patches)
    ? ingest.patches
        .map(parsePatchDescriptor)
        .filter((descriptor): descriptor is ParsedPatchDescriptor => descriptor !== undefined)
    : [];
  return {
    assets,
    isRom: ingest.is_rom === true,
    kind,
    patches,
    sourceFileName: toStringValue(ingest.source_file_name) || "",
  };
};
