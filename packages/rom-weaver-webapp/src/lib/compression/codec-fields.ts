import {
  hasCompressionCodecLevelOverride,
  parseCompressionCodecEntry,
  splitCompressionCodecEntries,
  stripCompressionCodecLevelOverrides,
} from "./codec-parser.ts";
import {
  type GeneratedCompressionCodecFieldKey,
  getGeneratedCompressionCodecFieldCodecs,
  getGeneratedCompressionCodecFieldPresets,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
  isGeneratedCompressionCodecFieldKey,
} from "./compression-metadata.ts";

type CompressionCodecFieldKey = GeneratedCompressionCodecFieldKey;

type CompressionCodecOption = {
  value: string;
  label: string;
  maxLevel: number | null;
  minLevel: number | null;
  replaceValue?: boolean;
  searchText?: string;
};

type CompressionCodecValidation = {
  valid: boolean;
  message?: string;
};

const codecOption = (value: string): CompressionCodecOption => ({
  label: value,
  maxLevel: getGeneratedCompressionCodecLevelMax(value),
  minLevel: getGeneratedCompressionCodecLevelMin(value),
  value,
});

const codecPresetOption = (label: string, value: string, searchText: string): CompressionCodecOption => ({
  label,
  maxLevel: null,
  minLevel: null,
  replaceValue: true,
  searchText,
  value,
});

// Preset combos come from the generated compression metadata (Rust owns the codec
// knowledge). searchText makes a preset findable by its family name and each codec;
// the Set dedupes the family when it is already one of the codecs (e.g. DVD zstd).
const getCompressionCodecPresetOptions = (fieldKey: CompressionCodecFieldKey): CompressionCodecOption[] =>
  getGeneratedCompressionCodecFieldPresets(fieldKey).map(({ codecs, kind }) =>
    codecPresetOption(`${kind} preset: ${codecs}`, codecs, [...new Set([kind, ...codecs.split(",")])].join(" ")),
  );

const isCompressionCodecFieldKey = (fieldKey: string): fieldKey is CompressionCodecFieldKey =>
  isGeneratedCompressionCodecFieldKey(fieldKey);

const getCompressionCodecOptions = (fieldKey: string): CompressionCodecOption[] =>
  isCompressionCodecFieldKey(fieldKey)
    ? getGeneratedCompressionCodecFieldCodecs(fieldKey).map((codec) => codecOption(codec))
    : [];

const getCompressionCodecSuggestions = (fieldKey: string): CompressionCodecOption[] =>
  isCompressionCodecFieldKey(fieldKey)
    ? [...getCompressionCodecPresetOptions(fieldKey), ...getCompressionCodecOptions(fieldKey)]
    : [];

const getCompressionCodecValues = (fieldKey: string): string[] =>
  getCompressionCodecOptions(fieldKey).map((option) => option.value);

const getCompressionCodecLevelMax = (fieldKey: string, codec: string): number | null => {
  const normalizedCodec = codec.trim().toLowerCase();
  return getCompressionCodecOptions(fieldKey).find((option) => option.value === normalizedCodec)?.maxLevel ?? null;
};

const getCompressionCodecLevelMin = (fieldKey: string, codec: string): number | null => {
  const normalizedCodec = codec.trim().toLowerCase();
  return getCompressionCodecOptions(fieldKey).find((option) => option.value === normalizedCodec)?.minLevel ?? null;
};

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
  const entries = allowMultiple ? splitCompressionCodecEntries(rawValue) : [rawValue];
  if (!allowMultiple && rawValue.includes(",")) {
    return { message: `${label} accepts one codec.`, valid: false };
  }

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const parsed = parseCompressionCodecEntry(entry);
    if (!parsed) {
      return { message: `${label} must be a codec or codec:level.`, valid: false };
    }

    const codec = parsed.codec;
    const option = validOptions.find((candidate) => candidate.value === codec);
    if (!option) {
      return { message: `${label} valid values: ${validValues.join(", ")}.`, valid: false };
    }

    if (!parsed.hasLevel) continue;
    if (option.maxLevel === null) {
      return { message: `${codec} does not use a level.`, valid: false };
    }
    const minLevel = option.minLevel ?? 0;
    const level = parsed.level ?? Number.NaN;
    if (!Number.isFinite(level) || level < minLevel || level > option.maxLevel) {
      return { message: `${codec} level must be ${minLevel}-${option.maxLevel}.`, valid: false };
    }
  }

  return { valid: true };
};

export {
  type CompressionCodecOption,
  getCompressionCodecLevelMax,
  getCompressionCodecLevelMin,
  getCompressionCodecOptions,
  getCompressionCodecSuggestions,
  getCompressionCodecValues,
  hasCompressionCodecLevelOverride,
  isCompressionCodecFieldKey,
  stripCompressionCodecLevelOverrides,
  validateCompressionCodecValue,
};
