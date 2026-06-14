import { parseIntegerInRange } from "../compression/compression-option-utils.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import { parseCompressionCodecEntry } from "./codec-parser.ts";
import {
  COMPRESSION_DEFAULTS,
  COMPRESSION_PROFILE_LEVELS,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
  getGeneratedCompressionProfileLabel,
} from "./compression-metadata.ts";

const compressionManager = OutputCompressionManager;

type CompressionSettingsSource = {
  compressionProfile?: string | null;
  rvzCodec?: string | null;
  rvzCompressionLevel?: string | number | null;
  z3dsCompressionLevel?: string | number | "default" | null;
  sevenZipCodec?: string | null;
  sevenZipLevel?: string | number | null;
  zipCodec?: string | null;
  zipLevel?: string | number | null;
};

type ParsedCodecLevel = {
  codec: string;
  level: number | null;
};

const parseCodecLevel = (
  value: string | null | undefined,
  fallback: string,
  normalizeCodec: (codec: string | null | undefined, fallback?: string) => string,
): ParsedCodecLevel => {
  const parsed = parseCompressionCodecEntry(value);
  if (!parsed) return { codec: normalizeCodec(value, fallback), level: null };
  return {
    codec: normalizeCodec(parsed.codec || fallback, fallback),
    level: parsed.level,
  };
};

const parseRvzCodecLevel = (value: string | null | undefined): ParsedCodecLevel => {
  const parsed = parseCompressionCodecEntry(value);
  if (!parsed)
    return { codec: compressionManager.normalizeRvzCompression(value || COMPRESSION_DEFAULTS.rvzCodec), level: null };
  return {
    codec: compressionManager.normalizeRvzCompression(parsed.codec || COMPRESSION_DEFAULTS.rvzCodec),
    level: parsed.level,
  };
};

const getCompressionProfileIndex = (validProfiles: string[], profile: string | null | undefined): number =>
  Math.max(0, validProfiles.indexOf(compressionManager.normalizeCompressionProfile(profile, "max")));

const getCompressionProfileFromIndex = (
  validProfiles: string[],
  value: string | number | null | undefined,
  fallback: string | null | undefined,
): string => {
  const index = parseInt(String(value), 10);
  return validProfiles[index] || compressionManager.normalizeCompressionProfile(fallback, "max");
};

const getCompressionProfileLabel = (profile: string | null | undefined): string => {
  return getGeneratedCompressionProfileLabel(profile);
};

const getOptionalCompressionLevel = (
  value: string | number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = parseIntegerInRange(value, {
    allowEmpty: true,
    failureMessage: `Unsupported compression level: ${value}`,
    max,
    min,
    requireExactString: true,
  });
  return parsed === null ? fallback : parsed;
};

const resolveCompressionLevels = (source?: CompressionSettingsSource | null) => {
  const settings = source || {};
  const compressionProfile = compressionManager.normalizeCompressionProfile(settings.compressionProfile, "max");
  const rvzCodecSetting = parseRvzCodecLevel(settings.rvzCodec);
  const sevenZipCodecSetting = parseCodecLevel(
    settings.sevenZipCodec,
    COMPRESSION_DEFAULTS.sevenZipCodec,
    compressionManager.normalizeSevenZipCodec,
  );
  const zipCodecSetting = parseCodecLevel(
    settings.zipCodec,
    COMPRESSION_DEFAULTS.zipCodec,
    compressionManager.normalizeZipCodec,
  );
  const rvzCodec = rvzCodecSetting.codec;
  const sevenZipCodec = sevenZipCodecSetting.codec;
  const zipCodec = zipCodecSetting.codec;
  const rvzLevelMax = getGeneratedCompressionCodecLevelMax(rvzCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.max;
  const rvzLevelMin = getGeneratedCompressionCodecLevelMin(rvzCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.min;
  const sevenZipLevelMax =
    getGeneratedCompressionCodecLevelMax(sevenZipCodec) ?? COMPRESSION_PROFILE_LEVELS.standard.max;
  const sevenZipLevelMin =
    getGeneratedCompressionCodecLevelMin(sevenZipCodec) ?? COMPRESSION_PROFILE_LEVELS.standard.min;
  const z3dsLevelMax =
    getGeneratedCompressionCodecLevelMax(COMPRESSION_DEFAULTS.z3dsCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.max;
  const z3dsLevelMin =
    getGeneratedCompressionCodecLevelMin(COMPRESSION_DEFAULTS.z3dsCodec) ?? COMPRESSION_PROFILE_LEVELS.zstd.min;
  const zipLevelMax = getGeneratedCompressionCodecLevelMax(zipCodec) ?? COMPRESSION_PROFILE_LEVELS.standard.max;
  const zipLevelMin = getGeneratedCompressionCodecLevelMin(zipCodec) ?? COMPRESSION_PROFILE_LEVELS.standard.min;

  return {
    compressionProfile: compressionProfile,
    rvzCodec: rvzCodec,
    rvzCompressionLevel: getOptionalCompressionLevel(
      rvzCodecSetting.level ?? settings.rvzCompressionLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, rvzCodec),
      rvzLevelMin,
      rvzLevelMax,
    ),
    sevenZipCodec: sevenZipCodec,
    sevenZipLevel: getOptionalCompressionLevel(
      sevenZipCodecSetting.level ?? settings.sevenZipLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, sevenZipCodec, "7z"),
      sevenZipLevelMin,
      sevenZipLevelMax,
    ),
    z3dsCompressionLevel:
      settings.z3dsCompressionLevel === "default"
        ? "default"
        : getOptionalCompressionLevel(
            settings.z3dsCompressionLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, COMPRESSION_DEFAULTS.z3dsCodec),
            z3dsLevelMin,
            z3dsLevelMax,
          ),
    zipCodec: zipCodec,
    zipLevel:
      zipCodec === "store"
        ? COMPRESSION_PROFILE_LEVELS.standard.max
        : getOptionalCompressionLevel(
            zipCodecSetting.level ?? settings.zipLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, zipCodec, "zip"),
            zipLevelMin,
            zipLevelMax,
          ),
  };
};

export {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  resolveCompressionLevels,
};
