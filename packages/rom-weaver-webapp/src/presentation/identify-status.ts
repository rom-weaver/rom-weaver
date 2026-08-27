import type { IdentifyStatus } from "../types/identify.ts";

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

/** "1 possible match" / "3 possible matches" - the count must be visible, not implied. */
const identifyMatchCountLabel = (count: number): string => `${count} possible ${count === 1 ? "match" : "matches"}`;

/**
 * The backend reports a match's database as the pack file name, which encodes
 * the platform, not the provenance. Every shipped pack is built from OpenGood
 * (scripts/build-hasheous-identify-index.mjs), so a `.pack` name reads as that;
 * synthetic databases ("patch requirement") pass through.
 */
const formatIdentifySource = (database: string): string => (database.endsWith(".pack") ? "OpenGood" : database);

export { formatIdentifySource, IDENTIFY_STATUS_LABEL, IDENTIFY_STATUS_MARK, identifyMatchCountLabel };
