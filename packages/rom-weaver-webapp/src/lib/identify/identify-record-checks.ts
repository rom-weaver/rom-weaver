/**
 * What the identification database says the matched ROM's checks are, shaped
 * for the Checks drawer.
 *
 * A matched record knows every algorithm and the exact byte size before any
 * byte is hashed, so it can complete a drawer the local run left half empty -
 * a bare-checksum lookup computes exactly one digest, and a file staged with a
 * narrowed algorithm set computes only those. The values are claims, not
 * measurements, so callers MUST keep them distinguishable from computed rows.
 *
 * `variantId` is the part that keeps the fill honest: a record matched through
 * the `remove-header` transform describes the stripped bytes, so its hashes
 * belong to that variant's group and to no other.
 *
 * Callers take the algorithms they have a place for; a consumer with no SHA-256
 * row simply never reads that key.
 */
import type { ParsedIdentifyLookupResult } from "../../types/identify.ts";

const RECORD_CHECK_ALGORITHMS = ["crc32", "md5", "sha1", "sha256"] as const;

type IdentifyRecordChecks = {
  checksums: Record<string, string>;
  size?: number;
  /** Checksum-variant id the record matched through; `raw` means the base group. */
  variantId: string;
};

/**
 * The record's checks for an unambiguous match. `undefined` for anything that
 * cannot name one expected file: an ambiguous or unmatched lookup, and a
 * multi-component record (a multi-track disc), whose components describe
 * several files rather than the one this drawer is about.
 */
const identifyRecordChecks = (
  identification: ParsedIdentifyLookupResult | undefined,
): IdentifyRecordChecks | undefined => {
  if (identification?.status !== "matched") return undefined;
  // Only an exact match speaks for the artifact. `partial` means a required
  // component did not match or the artifact carries components the record does
  // not explain, and `metadata_only` means no hash matched at all - in both the
  // record describes a dump this file demonstrably is not.
  if (identification.quality && identification.quality !== "exact") return undefined;
  const match = identification.matches[0];
  const components = match?.expectedComponents;
  const component = components?.length === 1 ? components[0] : undefined;
  if (!(match && component)) return undefined;
  const checksums: Record<string, string> = {};
  for (const algorithm of RECORD_CHECK_ALGORITHMS) {
    const value = component[algorithm];
    if (value) checksums[algorithm] = value;
  }
  const size = typeof component.size === "number" && Number.isFinite(component.size) ? component.size : undefined;
  if (!(Object.keys(checksums).length || size !== undefined)) return undefined;
  return { checksums, ...(size === undefined ? {} : { size }), variantId: match.variant || "raw" };
};

export { identifyRecordChecks, type IdentifyRecordChecks };
