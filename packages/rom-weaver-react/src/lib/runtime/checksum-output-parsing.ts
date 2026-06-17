import type { ChecksumResult, ChecksumRomProbe, RomTypeTag } from "../../types/checksum.ts";
import { asRecord, readChecksumMap } from "./run-result-parsing.ts";

const CHECKSUM_PAIR_REGEX = /([a-z0-9_-]+)=([0-9a-f]+)/gi;

const normalizeChecksumResult = (
  checksums: Partial<ChecksumResult>,
  algorithm: string,
  value: string,
): Partial<ChecksumResult> => {
  const normalizedAlgorithm = algorithm.trim().toLowerCase();
  if (!normalizedAlgorithm) return checksums;
  if (normalizedAlgorithm === "crc32") {
    checksums.crc32 = Number.parseInt(value, 16) >>> 0;
    return checksums;
  }
  if (normalizedAlgorithm === "adler32") {
    checksums.adler32 = Number.parseInt(value, 16) >>> 0;
    return checksums;
  }
  if (normalizedAlgorithm === "md5") {
    checksums.md5 = value.toLowerCase();
    return checksums;
  }
  if (normalizedAlgorithm === "sha1") {
    checksums.sha1 = value.toLowerCase();
    return checksums;
  }
  return checksums;
};

const parseChecksumLabel = (label: string): Partial<ChecksumResult> => {
  const out: Partial<ChecksumResult> = {};
  for (const match of label.matchAll(CHECKSUM_PAIR_REGEX)) {
    const algorithm = match[1];
    const value = match[2];
    if (!(algorithm && value)) continue;
    normalizeChecksumResult(out, algorithm, value);
  }
  return out;
};

const parseChecksumRomProbeLabel = (label: string): ChecksumRomProbe => {
  const trimmedInputBytes = label.match(/\btrimmed_input_bytes=(\d+)\b/)?.[1];
  const mode = label.match(/\bmode=([^;\s]+)\b/)?.[1];
  const preservedDownloadPlayCert = label.match(/\bpreserved_download_play_cert=(true|false)\b/)?.[1];
  const detected = typeof trimmedInputBytes === "string";
  return {
    trim: {
      detected,
      ...(mode ? { mode } : {}),
      ...(preservedDownloadPlayCert ? { preservedDownloadPlayCert: preservedDownloadPlayCert === "true" } : {}),
      ...(detected ? { trimmedInputBytes: Number.parseInt(trimmedInputBytes, 10) } : {}),
    },
  };
};

const parseChecksumRomType = (details: unknown): RomTypeTag | undefined => {
  const record = asRecord(details);
  if (!record) return undefined;
  const platform = typeof record.platform === "string" && record.platform.trim() ? record.platform.trim() : undefined;
  const discFormat =
    typeof record.disc_format === "string" && record.disc_format.trim() ? record.disc_format.trim() : undefined;
  if (!(platform || discFormat)) return undefined;
  return { ...(platform ? { platform } : {}), ...(discFormat ? { discFormat } : {}) };
};

const parseChecksumDetails = (details: unknown): Partial<ChecksumResult> => {
  const checksums = readChecksumMap(asRecord(details)?.checksums);
  if (!checksums) return {};
  const out: Partial<ChecksumResult> = {};
  for (const [algorithm, value] of Object.entries(checksums)) {
    normalizeChecksumResult(out, algorithm, value);
  }
  return out;
};

export { parseChecksumDetails, parseChecksumLabel, parseChecksumRomProbeLabel, parseChecksumRomType };
