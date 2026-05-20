import { parseIntegerInRange } from "../compression/compression-option-utils.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";

const compressionManager = OutputCompressionManager;

type CompressionSettingsSource = {
  compressionProfile?: string | null;
  rvzCompression?: string | null;
  rvzCompressionLevel?: string | number | null;
  z3dsCompressionLevel?: string | number | "default" | null;
  sevenZipCodec?: string | null;
  sevenZipLevel?: string | number | null;
  zipCodec?: string | null;
  zipLevel?: string | number | null;
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
  const normalized = compressionManager.normalizeCompressionProfile(profile, "max");
  return normalized === "min"
    ? "Min"
    : (() => {
        if (normalized === "low") {
          return "Low";
        }
        if (normalized === "medium") {
          return "Medium";
        }
        if (normalized === "high") {
          return "High";
        }
        return "Max";
      })();
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
  const rvzCompression = compressionManager.normalizeRvzCompression(settings.rvzCompression || "zstd");
  const sevenZipCodec = compressionManager.normalizeSevenZipCodec(settings.sevenZipCodec, "lzma2");
  const zipCodec = compressionManager.normalizeZipCodec(settings.zipCodec, "deflate");
  const sevenZipMaxLevel = sevenZipCodec === "zstd" ? 22 : 9;

  return {
    compressionProfile: compressionProfile,
    rvzCompression: rvzCompression,
    rvzCompressionLevel: getOptionalCompressionLevel(
      settings.rvzCompressionLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, rvzCompression),
      0,
      22,
    ),
    sevenZipCodec: sevenZipCodec,
    sevenZipLevel: getOptionalCompressionLevel(
      settings.sevenZipLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, sevenZipCodec, "7z"),
      0,
      sevenZipMaxLevel,
    ),
    z3dsCompressionLevel:
      settings.z3dsCompressionLevel === "default"
        ? "default"
        : getOptionalCompressionLevel(
            settings.z3dsCompressionLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, "zstd"),
            0,
            22,
          ),
    zipCodec: zipCodec,
    zipLevel:
      zipCodec === "store"
        ? 9
        : getOptionalCompressionLevel(
            settings.zipLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, zipCodec, "zip"),
            0,
            9,
          ),
  };
};

export {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getOptionalCompressionLevel,
  resolveCompressionLevels,
};
