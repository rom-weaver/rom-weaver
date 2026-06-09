/** The standard input checksum set every workflow computes and the staging reuse guard requires
 * (crc32 + md5 + sha1). Single source of truth so that checksums emitted inline during extraction
 * exactly match the set `getPatchFilePrecomputedChecksums` expects, letting the apply/trim/create
 * staging paths reuse them instead of re-reading and re-hashing the extracted output. */
const STANDARD_CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1"] as const;

export { STANDARD_CHECKSUM_ALGORITHMS };
