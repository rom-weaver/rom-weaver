import { ROM_WEAVER_COMPRESSION_METADATA } from "../../wasm/generated/rom-weaver-format-metadata.ts";

type GeneratedCompressionMetadata = typeof ROM_WEAVER_COMPRESSION_METADATA;
type GeneratedCompressionProfile = GeneratedCompressionMetadata["profiles"][number]["name"];
type GeneratedCompressionCodecFieldKey = keyof GeneratedCompressionMetadata["codecFields"];
type CompressionCodecLevelRange = { readonly min: number; readonly max: number };
type CompressionCodecMetadataEntry = {
  readonly aliases: readonly string[];
  readonly level: CompressionCodecLevelRange | null;
  readonly profileKind: string;
};
type CompressionCodecFieldPreset = {
  readonly kind: string;
  readonly codecs: string;
};
type CompressionCodecFieldMetadataEntry = {
  readonly allowMultiple: boolean;
  readonly codecs: readonly string[];
  readonly defaultCodec: string | null;
  readonly defaultCodecs: string | null;
  readonly presets: readonly CompressionCodecFieldPreset[];
};

const COMPRESSION_METADATA = ROM_WEAVER_COMPRESSION_METADATA;
const COMPRESSION_DEFAULTS = COMPRESSION_METADATA.defaults;
const GENERATED_CODECS = COMPRESSION_METADATA.codecs as unknown as Readonly<
  Record<string, CompressionCodecMetadataEntry>
>;
const GENERATED_CODEC_FIELDS = COMPRESSION_METADATA.codecFields as unknown as Readonly<
  Record<string, CompressionCodecFieldMetadataEntry>
>;
const COMPRESSION_PROFILE_NAMES = COMPRESSION_METADATA.profiles.map(
  (profile) => profile.name,
) as GeneratedCompressionProfile[];
const COMPRESSION_PROFILE_LABELS = COMPRESSION_METADATA.profiles.map((profile) => profile.label);
const DEFAULT_COMPRESSION_PROFILE = "max" satisfies GeneratedCompressionProfile;
const COMPRESSION_PROFILE_LEVELS = {
  standard: Object.fromEntries(
    COMPRESSION_METADATA.profiles.map((profile) => [profile.name, profile.standardLevel]),
  ) as Record<GeneratedCompressionProfile, number>,
  zstd: Object.fromEntries(COMPRESSION_METADATA.profiles.map((profile) => [profile.name, profile.zstdLevel])) as Record<
    GeneratedCompressionProfile,
    number
  >,
};
const CODEC_ALIASES = Object.fromEntries(
  Object.entries(GENERATED_CODECS).flatMap(([codec, metadata]) =>
    metadata.aliases.map((alias) => [alias.toLowerCase(), codec]),
  ),
) as Record<string, string>;

const normalizeGeneratedCompressionProfile = (
  value: string | number | boolean | null | undefined,
  fallback: string | null | undefined = DEFAULT_COMPRESSION_PROFILE,
): GeneratedCompressionProfile => {
  const normalized = String(value || fallback || DEFAULT_COMPRESSION_PROFILE)
    .trim()
    .toLowerCase();
  if (COMPRESSION_PROFILE_NAMES.includes(normalized as GeneratedCompressionProfile))
    return normalized as GeneratedCompressionProfile;
  const normalizedFallback = String(fallback || DEFAULT_COMPRESSION_PROFILE)
    .trim()
    .toLowerCase();
  return COMPRESSION_PROFILE_NAMES.includes(normalizedFallback as GeneratedCompressionProfile)
    ? (normalizedFallback as GeneratedCompressionProfile)
    : DEFAULT_COMPRESSION_PROFILE;
};

const getGeneratedCompressionProfileLabel = (profile: string | null | undefined): string => {
  const normalized = normalizeGeneratedCompressionProfile(profile);
  return COMPRESSION_METADATA.profiles.find((candidate) => candidate.name === normalized)?.label || "Max";
};

const normalizeGeneratedCompressionCodecName = (codec: string | null | undefined): string => {
  const normalized =
    String(codec || "")
      .trim()
      .toLowerCase()
      .split(":")[0] || "";
  if (!normalized) return "";
  if (Object.hasOwn(GENERATED_CODECS, normalized)) return normalized;
  return CODEC_ALIASES[normalized] || normalized;
};

const getGeneratedCompressionCodecMetadata = (
  codec: string | null | undefined,
): CompressionCodecMetadataEntry | null => {
  const normalized = normalizeGeneratedCompressionCodecName(codec);
  return normalized ? (GENERATED_CODECS[normalized] ?? null) : null;
};

const getGeneratedCompressionCodecLevel = (codec: string | null | undefined): CompressionCodecLevelRange | null =>
  getGeneratedCompressionCodecMetadata(codec)?.level ?? null;

const getGeneratedCompressionCodecLevelMax = (codec: string | null | undefined): number | null =>
  getGeneratedCompressionCodecLevel(codec)?.max ?? null;

const getGeneratedCompressionCodecLevelMin = (codec: string | null | undefined): number | null =>
  getGeneratedCompressionCodecLevel(codec)?.min ?? null;

const getGeneratedCompressionCodecProfileKind = (codec: string | null | undefined): string =>
  getGeneratedCompressionCodecMetadata(codec)?.profileKind || "standard";

const getGeneratedCompressionCodecField = (fieldKey: string): CompressionCodecFieldMetadataEntry | null =>
  GENERATED_CODEC_FIELDS[fieldKey] ?? null;

const isGeneratedCompressionCodecFieldKey = (fieldKey: string): fieldKey is GeneratedCompressionCodecFieldKey =>
  Object.hasOwn(GENERATED_CODEC_FIELDS, fieldKey);

const getGeneratedCompressionCodecFieldCodecs = (fieldKey: string): string[] => [
  ...(getGeneratedCompressionCodecField(fieldKey)?.codecs ?? []),
];

const getGeneratedCompressionCodecFieldPresets = (fieldKey: string): CompressionCodecFieldPreset[] => [
  ...(getGeneratedCompressionCodecField(fieldKey)?.presets ?? []),
];

const getGeneratedCompressionCodecFieldDefault = (fieldKey: string): string => {
  const field = getGeneratedCompressionCodecField(fieldKey);
  return field?.defaultCodecs || field?.defaultCodec || "";
};

const getGeneratedCompressionProfileLevel = (
  profile: string | number | boolean | null | undefined,
  codecOrProfileKind: string | null | undefined,
): number => {
  const normalizedProfile = normalizeGeneratedCompressionProfile(profile);
  const kind =
    codecOrProfileKind === "zstd" || codecOrProfileKind === "standard" || codecOrProfileKind === "none"
      ? codecOrProfileKind
      : getGeneratedCompressionCodecProfileKind(codecOrProfileKind);
  return kind === "zstd"
    ? COMPRESSION_PROFILE_LEVELS.zstd[normalizedProfile]
    : COMPRESSION_PROFILE_LEVELS.standard[normalizedProfile];
};

export {
  COMPRESSION_DEFAULTS,
  COMPRESSION_PROFILE_LABELS,
  COMPRESSION_PROFILE_LEVELS,
  COMPRESSION_PROFILE_NAMES,
  type GeneratedCompressionCodecFieldKey,
  type GeneratedCompressionProfile,
  getGeneratedCompressionCodecFieldCodecs,
  getGeneratedCompressionCodecFieldDefault,
  getGeneratedCompressionCodecFieldPresets,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
  getGeneratedCompressionCodecProfileKind,
  getGeneratedCompressionProfileLabel,
  getGeneratedCompressionProfileLevel,
  isGeneratedCompressionCodecFieldKey,
  normalizeGeneratedCompressionProfile,
};
