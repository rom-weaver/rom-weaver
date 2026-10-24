/**
 * Shared vocabulary for the editable weave verification fields:
 * the three hash algorithms plus the exact byte size, with the input
 * normalization/validation the patch cards and the ROM weave-checks editor
 * both apply before committing a value.
 */
import {
  ROM_WEAVER_CHECKSUM_ALGORITHMS,
  ROM_WEAVER_STANDARD_CHECKSUM_ALGORITHMS,
} from "../../../../wasm/generated/rom-weaver-format-metadata.ts";

const CHECK_ALGORITHMS = ROM_WEAVER_STANDARD_CHECKSUM_ALGORITHMS;
const CHECK_FIELDS = ["crc32", "md5", "sha1", "bytes"] as const;
/** Render order for editable check grids: CRC32 pairs with BYTES on one grid
 * row (the short values), the long hashes follow full-width. */
const CHECK_FIELDS_PAIRED = ["crc32", "bytes", "md5", "sha1"] as const;
const algorithmInfo = (id: CheckAlgorithm) => {
  const info = ROM_WEAVER_CHECKSUM_ALGORITHMS.find((algorithm) => algorithm.id === id);
  if (!info) throw new Error(`Unknown checksum algorithm: ${id}`);
  return info;
};
const CHECK_LABELS = {
  bytes: "BYTES",
  crc32: algorithmInfo("crc32").label,
  md5: algorithmInfo("md5").label,
  sha1: algorithmInfo("sha1").label,
} as const;
const CHECK_HEX_LENGTHS = {
  crc32: algorithmInfo("crc32").hexLength,
  md5: algorithmInfo("md5").hexLength,
  sha1: algorithmInfo("sha1").hexLength,
} as const;

type CheckAlgorithm = (typeof CHECK_ALGORITHMS)[number];
type CheckField = (typeof CHECK_FIELDS)[number];

/** The two fields short enough to share a grid row; the rest take the full width. */
const isHalfRowField = (field: CheckField): boolean => field === "crc32" || field === "bytes";

/** The two long hashes, which share a grid row only on drawers wide enough to
 * hold a 40-character value at half width. */
const isHashRowField = (field: CheckField): boolean => field === "md5" || field === "sha1";

const normalizeCheckInput = (raw: string) => raw.trim().toLowerCase().replace(/^0x/, "");

const isValidCheckValue = (algorithm: CheckAlgorithm, value: string) =>
  value.length === CHECK_HEX_LENGTHS[algorithm] && /^[0-9a-f]+$/.test(value);

export {
  CHECK_ALGORITHMS,
  CHECK_FIELDS,
  CHECK_FIELDS_PAIRED,
  CHECK_HEX_LENGTHS,
  CHECK_LABELS,
  type CheckAlgorithm,
  type CheckField,
  isHalfRowField,
  isHashRowField,
  isValidCheckValue,
  normalizeCheckInput,
};
