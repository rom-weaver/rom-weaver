// Parse the `details.ingest` payload of a terminal `ingest` event into a webapp-facing result.
//
// The generated wire types (`IngestResult`/`IngestRomAsset`/`PatchDescriptor`) carry `u64` fields as
// `bigint`, but `JSON.parse` yields plain `number`s; this module coerces to a `number`-based,
// camelCase shape the webapp consumes directly (and drops `null`/absent optionals). It is the single
// boundary between the Rust contract and the input/patch state the apply workflow builds.
import type { ChecksumMap, ChecksumVariant } from "../../types/checksum.ts";
import { isIdentifyLookupStatus } from "../../types/identify.ts";
import type { ParsedIdentifyLookupResult, ParsedIdentifyTitleMatch } from "../../types/identify.ts";
import type { ParsedIngestResult, ParsedIngestRomAsset, ParsedPatchDescriptor } from "../../types/ingest.ts";
import type {
  IdentifyLookupResult,
  IdentifyResult,
  IdentifyTitleMatch,
  IngestResult,
  IngestRomAsset,
  PatchDescriptor,
} from "../../wasm/generated/rom-weaver-rust-types.d.ts";
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

const parseIdentifyMatch = (value: unknown): ParsedIdentifyTitleMatch | undefined => {
  const match = asRecord(value) as WireRecord<IdentifyTitleMatch> | undefined;
  if (!match) return undefined;
  const name = toStringValue(match.name);
  const platform = toStringValue(match.platform);
  if (!(name && platform)) return undefined;
  return {
    algorithm: toStringValue(match.algorithm) || "",
    database: toStringValue(match.database) || "",
    name,
    platform,
    variant: toStringValue(match.variant) || "raw",
  };
};

const parseIdentifyLookup = (value: unknown): ParsedIdentifyLookupResult | undefined => {
  const lookup = asRecord(value) as WireRecord<IdentifyLookupResult> | undefined;
  if (!lookup) return undefined;
  const status = lookup.status;
  if (!isIdentifyLookupStatus(status)) return undefined;
  const matches = Array.isArray(lookup.matches)
    ? lookup.matches.map(parseIdentifyMatch).filter((match): match is ParsedIdentifyTitleMatch => match !== undefined)
    : [];
  if (status === "matched" && matches.length !== 1) return undefined;
  if (status === "ambiguous" && matches.length < 2) return undefined;
  if (status === "unknown" && matches.length) return undefined;
  return { matches, status };
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
  const recommendedFormat = toStringValue(record.recommended_format);
  if (recommendedFormat !== undefined) asset.recommendedFormat = recommendedFormat;
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
  const identification = parseIdentifyLookup(record.identification);
  if (identification) asset.identification = identification;
  return asset;
};

/** Parse one wire `PatchDescriptor` record (shared with the bundle-parse result reader). */
export const parsePatchDescriptor = (value: unknown): ParsedPatchDescriptor | undefined => {
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
  const sourceIdentification = parseIdentifyLookup(record.source_identification);
  if (sourceIdentification) descriptor.sourceIdentification = sourceIdentification;
  const sourceChecksumVariants = Array.isArray(record.source_checksum_variants)
    ? record.source_checksum_variants.map(toChecksumMap).filter((checksums) => Object.keys(checksums).length > 0)
    : [];
  if (sourceChecksumVariants.length) descriptor.sourceChecksumVariants = sourceChecksumVariants;
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

export type ParsedIdentifyCommandResult = {
  checksumVariants: ChecksumVariant[];
  checksums: ChecksumMap;
  input: string;
  matches: ParsedIdentifyTitleMatch[];
  status: "matched" | "ambiguous" | "unknown";
};

/**
 * Parse the `identify` object from a terminal `identify` command event's `details`. Returns
 * `undefined` when the payload is missing or malformed.
 */
export const parseIdentifyCommandResult = (details: unknown): ParsedIdentifyCommandResult | undefined => {
  const identify = asRecord(asRecord(details)?.identify) as WireRecord<IdentifyResult> | undefined;
  if (!identify) return undefined;
  const status = identify.status;
  if (!isIdentifyLookupStatus(status)) return undefined;
  const matches = Array.isArray(identify.matches)
    ? identify.matches.map(parseIdentifyMatch).filter((match): match is ParsedIdentifyTitleMatch => match !== undefined)
    : [];
  return {
    checksumVariants: parseChecksumVariants(identify) ?? [],
    checksums: toChecksumMap(identify.checksums),
    input: toStringValue(identify.input) || "",
    matches,
    status,
  };
};
