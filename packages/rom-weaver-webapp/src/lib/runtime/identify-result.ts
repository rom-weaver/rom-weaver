import type { ChecksumMap } from "../../types/checksum.ts";
import type { ParsedIdentifyResult, ParsedIdentifyTitleMatch } from "../../types/identify.ts";
import type { IdentifyResult, IdentifyTitleMatch } from "../../wasm/generated/rom-weaver-rust-types.d.ts";
import { parseChecksumVariants, type WireRecord } from "./run-result-parsing.ts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const checksumMap = (value: unknown): ChecksumMap => {
  const record = asRecord(value);
  if (!record) return {} as ChecksumMap;
  return Object.fromEntries(
    Object.entries(record).flatMap(([algorithm, value]) => {
      const checksum = text(value);
      return checksum ? [[algorithm.toLowerCase(), checksum]] : [];
    }),
  ) as ChecksumMap;
};

const parseMatch = (value: unknown): ParsedIdentifyTitleMatch | undefined => {
  const match = asRecord(value) as WireRecord<IdentifyTitleMatch> | undefined;
  if (!match) return undefined;
  const name = text(match.name);
  const platform = text(match.platform);
  if (!(name && platform)) return undefined;
  return {
    algorithm: text(match.algorithm),
    database: text(match.database),
    name,
    platform,
    variant: text(match.variant) || "raw",
  };
};

export const parseIdentifyResult = (details: unknown): ParsedIdentifyResult | undefined => {
  const identify = asRecord(asRecord(details)?.identify) as WireRecord<IdentifyResult> | undefined;
  if (!identify) return undefined;
  const status = identify.status;
  if (!(status === "matched" || status === "ambiguous" || status === "unknown")) return undefined;
  const input = text(identify.input);
  if (!input) return undefined;
  const result: ParsedIdentifyResult = {
    checksumVariants: parseChecksumVariants(identify) ?? [],
    checksums: checksumMap(identify.checksums),
    input,
    matches: Array.isArray(identify.matches)
      ? identify.matches.map(parseMatch).filter((match): match is ParsedIdentifyTitleMatch => match !== undefined)
      : [],
    status,
  };
  const detectedPlatform = text(identify.detected_platform);
  if (detectedPlatform) result.detectedPlatform = detectedPlatform;
  return result;
};
