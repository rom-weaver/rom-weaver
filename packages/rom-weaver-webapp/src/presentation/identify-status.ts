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
 * Match-quality badges for set-aware results. `metadata_only` is the
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

/** Reader-facing source names for the machine source ids the packs carry.
 * Provenance entries name their upstream repository ("SnowflakePowered/
 * opengood"), which is too long for a drawer row, so the owner segment is
 * dropped before the lookup. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  libretro: "Libretro",
  "no-intro": "No-Intro",
  opengood: "OpenGood",
  redump: "Redump",
  tosec: "TOSEC",
};

const identifySourceLabel = (source: string): string => {
  const trimmed = source.trim();
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return SOURCE_LABELS[name.toLowerCase()] ?? trimmed;
};

const DUMP_TAG_LABELS: Readonly<Record<string, string>> = {
  "!": "Verified dump",
  "!p": "Pending dump",
  a: "Alternative version",
  b: "Bad dump",
  c: "Faulty checksum routine",
  f: "Fixed dump",
  h: "Hacked ROM",
  o: "Overdumped ROM",
  p: "Pirated version",
  t: "Trained version",
  x: "Bad checksum",
};

const DUMP_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  alb: "Albanian",
  ara: "Arabic",
  bra: "Brazilian Portuguese",
  can: "Canadian French",
  chi: "Chinese",
  chs: "Simplified Chinese",
  cht: "Traditional Chinese",
  cro: "Croatian",
  dan: "Danish",
  dut: "Dutch",
  eng: "English",
  esp: "Esperanto",
  fil: "Filipino",
  fin: "Finnish",
  fre: "French",
  ger: "German",
  gre: "Greek",
  heb: "Hebrew",
  ita: "Italian",
  jap: "Japanese",
  kor: "Korean",
  lat: "Latvian",
  lee: "Leetspeak",
  lit: "Lithuanian",
  nor: "Norwegian",
  pol: "Polish",
  por: "Portuguese",
  rom: "Romanian",
  rum: "Romanian",
  rus: "Russian",
  ser: "Serbian",
  spa: "Spanish",
  swe: "Swedish",
  tai: "Thai",
  tur: "Turkish",
  uru: "Uruguay Spanish",
};

const identifyDumpTagLabel = (tag: string): string => {
  const trimmed = tag.trim();
  const normalized = trimmed.toLowerCase();
  const direct = DUMP_TAG_LABELS[normalized];
  if (direct) return direct;

  const numbered = normalized.match(/^([abcfhoptx])(\d+)$/u);
  const numberedCode = numbered?.[1];
  const numberedIndex = numbered?.[2];
  if (numberedCode && numberedIndex) {
    const label = DUMP_TAG_LABELS[numberedCode];
    if (label) return `${label} ${numberedIndex}`;
  }

  const translation = trimmed.match(/^T([+-])(.+)$/iu);
  const translationDirection = translation?.[1];
  const translationCode = translation?.[2];
  if (translationDirection && translationCode) {
    const language = DUMP_LANGUAGE_LABELS[translationCode.toLowerCase()] ?? translationCode;
    return `${language} translation${translationDirection === "-" ? " (obsolete)" : ""}`;
  }

  return `Other tag: ${trimmed}`;
};

/** "3 of 4 required components matched" - the denominator must stay visible. */
const identifyComponentEvidenceLabel = (matched: number, total: number): string =>
  `${matched} of ${total} required component${total === 1 ? "" : "s"} matched`;

/** "1 possible match" / "3 possible matches" - the count must be visible, not implied. */
const identifyMatchCountLabel = (count: number): string => `${count} possible ${count === 1 ? "match" : "matches"}`;

export {
  IDENTIFY_CONDITION_LABEL,
  IDENTIFY_QUALITY_LABEL,
  IDENTIFY_QUALITY_MARK,
  IDENTIFY_STATUS_LABEL,
  IDENTIFY_STATUS_MARK,
  identifyComponentEvidenceLabel,
  identifyDumpTagLabel,
  identifyMatchCountLabel,
  identifySourceLabel,
};
