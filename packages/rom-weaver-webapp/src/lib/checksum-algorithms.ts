import { ROM_WEAVER_STANDARD_CHECKSUM_ALGORITHMS } from "../wasm/generated/rom-weaver-format-metadata.ts";

/** The standard input checksum set every workflow computes and the staging reuse guard requires
 * (crc32 + md5 + sha1). Generated from the Rust `STANDARD_ALGORITHMS` so that checksums emitted inline during extraction
 * exactly match the set `getPatchFilePrecomputedChecksums` expects, letting the apply/trim/create
 * staging paths reuse them instead of re-reading and re-hashing the extracted output. */
const STANDARD_CHECKSUM_ALGORITHMS = ROM_WEAVER_STANDARD_CHECKSUM_ALGORITHMS;

export { STANDARD_CHECKSUM_ALGORITHMS };
