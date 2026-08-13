import type { ChecksumMap, ChecksumVariant } from "./checksum.ts";

export type IdentifyStatus = "matched" | "ambiguous" | "unknown";

export type ParsedIdentifyTitleMatch = {
  algorithm: string;
  database: string;
  name: string;
  platform: string;
  variant: string;
};

/** Compact title lookup attached to an ingest asset or patch descriptor. */
export type ParsedIdentifyLookupResult = {
  matches: ParsedIdentifyTitleMatch[];
  status: IdentifyStatus;
};

/** Apply and patch workflows use the same compact lookup shape. */
export type ParsedIdentifyResolution = ParsedIdentifyLookupResult;

export type ParsedIdentifyResult = {
  checksumVariants: ChecksumVariant[];
  checksums: ChecksumMap;
  detectedPlatform?: string;
  input: string;
  matches: ParsedIdentifyTitleMatch[];
  status: IdentifyStatus;
};
