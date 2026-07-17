/**
 * Shared vocabulary for the editable bundle verification fields:
 * the three hash algorithms plus the exact byte size, with the input
 * normalization/validation the patch cards and the ROM bundle-checks editor
 * both apply before committing a value.
 */
const CHECK_ALGORITHMS = ["crc32", "md5", "sha1"] as const;
const CHECK_FIELDS = ["crc32", "md5", "sha1", "bytes"] as const;
/** Render order for editable check grids: CRC32 pairs with BYTES on one grid
 * row (the short values), the long hashes follow full-width. */
const CHECK_FIELDS_PAIRED = ["crc32", "bytes", "md5", "sha1"] as const;
const CHECK_LABELS = { bytes: "BYTES", crc32: "CRC32", md5: "MD5", sha1: "SHA-1" } as const;
const CHECK_HEX_LENGTHS = { crc32: 8, md5: 32, sha1: 40 } as const;

type CheckAlgorithm = (typeof CHECK_ALGORITHMS)[number];
type CheckField = (typeof CHECK_FIELDS)[number];

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
  isValidCheckValue,
  normalizeCheckInput,
};
