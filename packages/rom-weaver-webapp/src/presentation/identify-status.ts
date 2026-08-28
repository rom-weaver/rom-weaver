import type { IdentifyCondition, IdentifyQuality, IdentifyStatus } from "../types/identify.ts";

/**
 * The four identification outcomes, in the words the workflow status, the
 * activity strip, and the result cards all use. Keeping them in one table stops
 * "ROM identified" from leaking onto an ambiguous or unavailable result.
 */
const IDENTIFY_STATUS_LABEL: Readonly<Record<IdentifyStatus, string>> = {
  ambiguous: "Possible matches found",
  matched: "ROM identified",
  unavailable: "Identification unavailable",
  unknown: "No checksum match",
};

/**
 * Short state marker for a result card. `glyph` carries the state without
 * colour (WCAG 1.4.1), `label` is the text a screen reader announces, and
 * `tone` maps onto the shared card verdict borders.
 */
type IdentifyStatusMark = {
  glyph: string;
  label: string;
  tone?: "ok" | "warn" | "bad";
};

const IDENTIFY_STATUS_MARK: Readonly<Record<IdentifyStatus, IdentifyStatusMark>> = {
  ambiguous: { glyph: "?", label: "Possible match", tone: "warn" },
  matched: { glyph: "✓", label: "Identified", tone: "ok" },
  unavailable: { glyph: "!", label: "Identification unavailable", tone: "warn" },
  unknown: { glyph: "–", label: "No checksum match", tone: "bad" },
};

/**
 * Match-quality badges for set-aware (RWFP2) results. `metadata_only` is the
 * weakest claim - the database knew the title but could not verify the bytes -
 * so its wording never says "verified".
 */
const IDENTIFY_QUALITY_LABEL: Readonly<Record<IdentifyQuality, string>> = {
  exact: "Exact match",
  metadata_only: "Metadata only",
  partial: "Partial match",
};

const IDENTIFY_QUALITY_MARK: Readonly<Record<IdentifyQuality, IdentifyStatusMark>> = {
  exact: { glyph: "✓", label: "Exact match", tone: "ok" },
  metadata_only: { glyph: "≈", label: "Metadata only", tone: "warn" },
  partial: { glyph: "◐", label: "Partial match", tone: "warn" },
};

/**
 * Structured non-match causes. Both are actionable states, distinct from a
 * plain "no match": the database is missing, or the media shape has no
 * canonicalization profile yet.
 */
const IDENTIFY_CONDITION_LABEL: Readonly<Record<IdentifyCondition, string>> = {
  database_required: "Database required",
  unsupported_media_profile: "Media profile not supported",
};

/** Reader-facing source names for the machine source ids the packs carry. */
const identifySourceLabel = (source: string): string =>
  source === "libretro" ? "Libretro" : source === "opengood" ? "OpenGood" : source === "redump" ? "Redump" : source;

/** "3 of 4 required components matched" - the denominator must stay visible. */
const identifyComponentEvidenceLabel = (matched: number, total: number): string =>
  `${matched} of ${total} required component${total === 1 ? "" : "s"} matched`;

/** "1 possible match" / "3 possible matches" - the count must be visible, not implied. */
const identifyMatchCountLabel = (count: number): string => `${count} possible ${count === 1 ? "match" : "matches"}`;

/**
 * Old results only report a pack file name. New results carry structured
 * provenance, while synthetic database names pass through.
 */
const formatIdentifySource = (database: string): string => (database.endsWith(".pack") ? "OpenGood" : database);

export {
  formatIdentifySource,
  IDENTIFY_CONDITION_LABEL,
  IDENTIFY_QUALITY_LABEL,
  IDENTIFY_QUALITY_MARK,
  IDENTIFY_STATUS_LABEL,
  IDENTIFY_STATUS_MARK,
  identifyComponentEvidenceLabel,
  identifyMatchCountLabel,
  identifySourceLabel,
};
