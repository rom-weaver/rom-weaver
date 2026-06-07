import { CHD_CODEC_LEVEL_MAX } from "./compression-option-utils.ts";
import OutputCompressionManager from "./output-compression-manager.ts";

type CompressionCodecFieldKey = "chdCreateCdCodecs" | "chdCreateDvdCodecs" | "rvzCodec" | "sevenZipCodec" | "zipCodec";

type CompressionCodecOption = {
  value: string;
  label: string;
  maxLevel: number | null;
};

type CompressionCodecValidation = {
  valid: boolean;
  message?: string;
};

const CODEC_ENTRY_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/;
const CODEC_LEVEL_SUFFIX_REGEX = /:(\d+)$/;

const codecOption = (value: string, maxLevel: number | null): CompressionCodecOption => ({
  label: value,
  maxLevel,
  value,
});

const COMPRESSION_CODEC_OPTIONS: Record<CompressionCodecFieldKey, CompressionCodecOption[]> = {
  chdCreateCdCodecs: ["cdzs", "cdlz", "cdzl", "cdfl"].map((codec) =>
    codecOption(codec, CHD_CODEC_LEVEL_MAX[codec] ?? null),
  ),
  chdCreateDvdCodecs: ["zstd", "lzma", "zlib", "huff", "flac"].map((codec) =>
    codecOption(codec, CHD_CODEC_LEVEL_MAX[codec] ?? null),
  ),
  rvzCodec: [codecOption("zstd", 22)],
  sevenZipCodec: OutputCompressionManager.SEVEN_ZIP_COMPRESSION_METHODS.map((codec) => codecOption(codec, 9)),
  zipCodec: OutputCompressionManager.ZIP_COMPRESSION_METHODS.map((codec) =>
    codecOption(codec, codec === "zstd" ? 22 : codec === "deflate" ? 9 : null),
  ),
};

const isCompressionCodecFieldKey = (fieldKey: string): fieldKey is CompressionCodecFieldKey =>
  Object.hasOwn(COMPRESSION_CODEC_OPTIONS, fieldKey);

const getCompressionCodecOptions = (fieldKey: string): CompressionCodecOption[] =>
  isCompressionCodecFieldKey(fieldKey) ? COMPRESSION_CODEC_OPTIONS[fieldKey].map((option) => ({ ...option })) : [];

const getCompressionCodecValues = (fieldKey: string): string[] =>
  getCompressionCodecOptions(fieldKey).map((option) => option.value);

const getCompressionCodecLevelMax = (fieldKey: string, codec: string): number | null => {
  const normalizedCodec = codec.trim().toLowerCase();
  return getCompressionCodecOptions(fieldKey).find((option) => option.value === normalizedCodec)?.maxLevel ?? null;
};

const hasCompressionCodecLevelOverride = (value: string | null | undefined): boolean =>
  String(value || "")
    .split(",")
    .some((entry) => CODEC_LEVEL_SUFFIX_REGEX.test(entry.trim().toLowerCase()));

const stripCompressionCodecLevelOverrides = (value: string | null | undefined): string =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(CODEC_LEVEL_SUFFIX_REGEX, ""))
    .filter(Boolean)
    .join(",");

const validateCompressionCodecValue = (
  value: string | null | undefined,
  options: readonly CompressionCodecOption[],
  {
    allowMultiple = false,
    label = "codec",
  }: {
    allowMultiple?: boolean;
    label?: string;
  } = {},
): CompressionCodecValidation => {
  const rawValue = String(value || "")
    .trim()
    .toLowerCase();
  if (!rawValue) return { valid: true };

  const validOptions = options.map((option) => ({ ...option, value: option.value.trim().toLowerCase() }));
  const validValues = validOptions.map((option) => option.value);
  const entries = allowMultiple ? rawValue.split(",") : [rawValue];
  if (!allowMultiple && rawValue.includes(",")) {
    return { message: `${label} accepts one codec.`, valid: false };
  }

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const match = entry.match(CODEC_ENTRY_REGEX);
    if (!match) {
      return { message: `${label} must be a codec or codec:level.`, valid: false };
    }

    const codec = match[1] || "";
    const option = validOptions.find((candidate) => candidate.value === codec);
    if (!option) {
      return { message: `${label} valid values: ${validValues.join(", ")}.`, valid: false };
    }

    const levelText = match[2];
    if (levelText === undefined) continue;
    if (option.maxLevel === null) {
      return { message: `${codec} does not use a level.`, valid: false };
    }
    const level = Number.parseInt(levelText, 10);
    if (!Number.isFinite(level) || level < 0 || level > option.maxLevel) {
      return { message: `${codec} level must be 0-${option.maxLevel}.`, valid: false };
    }
  }

  return { valid: true };
};

export {
  type CompressionCodecFieldKey,
  type CompressionCodecOption,
  type CompressionCodecValidation,
  getCompressionCodecLevelMax,
  getCompressionCodecOptions,
  getCompressionCodecValues,
  hasCompressionCodecLevelOverride,
  isCompressionCodecFieldKey,
  stripCompressionCodecLevelOverrides,
  validateCompressionCodecValue,
};
