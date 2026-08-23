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

type ParsedIdentifyTitleMatch = {
  algorithm: string;
  database: string;
  name: string;
  platform: string;
  variant: string;
};

/** Compact title lookup attached to an ingest asset or patch descriptor. */
type ParsedIdentifyLookupResult = {
  matches: ParsedIdentifyTitleMatch[];
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
  detectedPlatform?: string;
  matches: ParsedIdentifyTitleMatch[];
  /** Member path inside the archive, or the input file name for a bare ROM. */
  path: string;
  status: IdentifyStatus;
};

type ParsedIdentifyResult = {
  /** Set only when the input was an archive the ROM candidates came out of. */
  archiveName?: string;
  candidates: ParsedIdentifyCandidate[];
  input: string;
  /** Aggregate over `candidates`; `unavailable` whenever the packs never loaded. */
  status: IdentifyStatus;
  unavailableReason?: string;
};

const isIdentifyLookupStatus = (value: unknown): value is IdentifyLookupStatus =>
  value === "matched" || value === "ambiguous" || value === "unknown";

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

export { aggregateIdentifyStatus, isIdentifyLookupStatus };
export type {
  IdentifyStatus,
  ParsedIdentifyCandidate,
  ParsedIdentifyLookupResult,
  ParsedIdentifyResolution,
  ParsedIdentifyResult,
  ParsedIdentifyTitleMatch,
};
