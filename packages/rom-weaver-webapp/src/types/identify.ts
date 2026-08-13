import type { ChecksumMap, ChecksumVariant } from "./checksum.ts";

type IdentifyStatus = "matched" | "ambiguous" | "unknown";

export type ParsedIdentifyTitleMatch = {
  algorithm: string;
  database: string;
  name: string;
  platform: string;
  variant: string;
};

export type ParsedIdentifyResult = {
  checksumVariants: ChecksumVariant[];
  checksums: ChecksumMap;
  detectedPlatform?: string;
  input: string;
  matches: ParsedIdentifyTitleMatch[];
  status: IdentifyStatus;
};
