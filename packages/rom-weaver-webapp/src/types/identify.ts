import type { ChecksumMap, ChecksumVariant } from "./checksum.ts";

/**
 * Statuses the Rust identify lookup can report. The lookup only runs when at
 * least one pack parsed, so it never has to describe a missing database.
 */
type IdentifyLookupStatus = "matched" | "ambiguous" | "unknown";

/**
 * Adds the host-only `unavailable` state: the identification packs could not be
 * fetched, parsed, or validated, so nothing was classified. It MUST stay
 * distinct from `unknown`, which means the database answered and held no
 * matching record.
 */
type IdentifyStatus = IdentifyLookupStatus | "unavailable";

/** Match quality of a set-aware (RWFP2) match. */
type IdentifyQuality = "exact" | "metadata_only" | "partial";

/**
 * Structured non-match conditions. The status stays matched/ambiguous/unknown
 * for compatibility; the condition names WHY the lookup could not answer:
 * `database_required` (the routed platform's pack is not available locally)
 * or `unsupported_media_profile`.
 */
type IdentifyCondition = "database_required" | "unsupported_media_profile";

type ParsedIdentifyPlatformCandidate = {
  confidence: string;
  /** Human-readable evidence label (e.g. `header_magic`, `disc_serial: SLUS-…`). */
  evidence: string;
  platform: string;
};

type ParsedIdentifyEvidence = {
  layoutMatched?: boolean;
  /** Required components the artifact was missing, by label. */
  missing?: string[];
  requiredComponentsMatched?: number;
  requiredComponentsTotal?: number;
  /** Artifact components no database slot claimed, by label. */
  unexpected?: string[];
};

type ParsedIdentifyDatabaseInfo = {
  canonicalizationProfile?: string;
  packFormat?: string;
  /** `opengood` or `redump`. */
  source?: string;
};

type ParsedIdentifyTitleMatch = {
  algorithm: string;
  database: string;
  name: string;
  platform: string;
  variant: string;
  provenance?: ParsedIdentifyProvenance[];
  legacyVariant?: boolean;
  dumpTags?: string[];
};

type ParsedIdentifyProvenance = {
  license?: string;
  source: string;
  sourceCommit?: string;
  sourceName?: string;
  sourceUrl?: string;
};

/** Compact title lookup attached to an ingest asset or patch descriptor. */
type ParsedIdentifyLookupResult = {
  condition?: IdentifyCondition;
  database?: ParsedIdentifyDatabaseInfo;
  evidence?: ParsedIdentifyEvidence;
  /** Actionable text that accompanies a `condition`. */
  hint?: string;
  matches: ParsedIdentifyTitleMatch[];
  platformCandidates?: ParsedIdentifyPlatformCandidate[];
  quality?: IdentifyQuality;
  status: IdentifyStatus;
  /** Technical cause behind an `unavailable` status; shown in details, not as the headline. */
  unavailableReason?: string;
};

/** Apply and patch workflows use the same compact lookup shape. */
type ParsedIdentifyResolution = ParsedIdentifyLookupResult;

/**
 * One ROM candidate inside the identified input. A bare ROM contributes exactly
 * one; an archive contributes one per selectable ROM member, so a multi-ROM
 * archive is never collapsed into a single arbitrary answer.
 */
type ParsedIdentifyCandidate = {
  checksumVariants: ChecksumVariant[];
  checksums: ChecksumMap;
  condition?: IdentifyCondition;
  database?: ParsedIdentifyDatabaseInfo;
  detectedPlatform?: string;
  evidence?: ParsedIdentifyEvidence;
  hint?: string;
  matches: ParsedIdentifyTitleMatch[];
  /** Member path inside the archive, or the input file name for a bare ROM. */
  path: string;
  platformCandidates?: ParsedIdentifyPlatformCandidate[];
  quality?: IdentifyQuality;
  status: IdentifyStatus;
};

type ParsedIdentifyResult = {
  /** Set only when the input was an archive the ROM candidates came out of. */
  archiveName?: string;
  candidates: ParsedIdentifyCandidate[];
  /** Aggregate condition: set when the whole run hit a structured non-match cause. */
  condition?: IdentifyCondition;
  hint?: string;
  input: string;
  /** Aggregate over `candidates`; `unavailable` whenever the packs never loaded. */
  status: IdentifyStatus;
  unavailableReason?: string;
};

const isIdentifyLookupStatus = (value: unknown): value is IdentifyLookupStatus =>
  value === "matched" || value === "ambiguous" || value === "unknown";

const isIdentifyQuality = (value: unknown): value is IdentifyQuality =>
  value === "exact" || value === "partial" || value === "metadata_only";

const isIdentifyCondition = (value: unknown): value is IdentifyCondition =>
  value === "database_required" || value === "unsupported_media_profile";

/**
 * Fold per-candidate statuses into the one the workflow reports. An unloadable
 * database wins outright, then an ambiguous candidate, then any match.
 */
const aggregateIdentifyStatus = (statuses: readonly IdentifyStatus[]): IdentifyStatus => {
  if (!statuses.length) return "unknown";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("ambiguous")) return "ambiguous";
  return statuses.includes("matched") ? "matched" : "unknown";
};

export { aggregateIdentifyStatus, isIdentifyCondition, isIdentifyLookupStatus, isIdentifyQuality };
export type {
  IdentifyCondition,
  IdentifyQuality,
  IdentifyStatus,
  ParsedIdentifyCandidate,
  ParsedIdentifyEvidence,
  ParsedIdentifyLookupResult,
  ParsedIdentifyPlatformCandidate,
  ParsedIdentifyProvenance,
  ParsedIdentifyResolution,
  ParsedIdentifyResult,
  ParsedIdentifyTitleMatch,
};
