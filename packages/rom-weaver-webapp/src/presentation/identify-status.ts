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
  unknown: "No title match",
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
  unknown: { glyph: "–", label: "No title match" },
};

/** "1 possible match" / "3 possible matches" - the count must be visible, not implied. */
const identifyMatchCountLabel = (count: number): string => `${count} possible ${count === 1 ? "match" : "matches"}`;

export { IDENTIFY_STATUS_LABEL, IDENTIFY_STATUS_MARK, identifyMatchCountLabel };
