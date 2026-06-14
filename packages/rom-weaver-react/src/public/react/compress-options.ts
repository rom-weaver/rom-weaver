/**
 * Output "Options" panel model. Maps the selected output format to the editable
 * compression controls (codec / level / codec-lists), with values defaulting to
 * the active settings and edits applied as per-job overrides.
 *
 * The override target is the same flat settings shape the run consumes (top-level
 * `zipCodec`, `sevenZipCodec`, `compressionProfile`, `rvzCodec`, …), so
 * editing here simply overrides Settings for this one job.
 */

import {
  type CompressionCodecOption,
  getCompressionCodecLevelMax,
  getCompressionCodecLevelMin,
  getCompressionCodecOptions,
  getCompressionCodecSuggestions,
  hasCompressionCodecLevelOverride,
} from "../../lib/compression/codec-fields.ts";
import { parseCompressionCodecEntry } from "../../lib/compression/codec-parser.ts";
import {
  COMPRESSION_DEFAULTS,
  COMPRESSION_PROFILE_LABELS,
  COMPRESSION_PROFILE_LEVELS,
  COMPRESSION_PROFILE_NAMES,
  getGeneratedCompressionCodecLevelMax,
  getGeneratedCompressionCodecLevelMin,
} from "../../lib/compression/compression-metadata.ts";
import { getChdAutoCreateMode, getDiscKind, getDiscKindLabel } from "../../lib/input/rom-specific-file-utils.ts";
import { getSettingsLabel } from "../../presentation/settings.ts";

type SettingsLike = Record<string, unknown>;
type SourceLike = {
  _chdCuePath?: string;
  _chdCueText?: string;
  _chdMode?: string;
  fileName?: string;
  getExtension?: () => string;
};

type CompressFieldOption = { value: string; label: string; disabled?: boolean };
type CompressFieldLevelMapRow = { profile: string; standard: number; zstd: number };
type CompressFieldInfo = {
  title: string;
  summary?: string;
  items?: string[];
  levelMap?: CompressFieldLevelMapRow[];
};

type CompressField =
  | {
      kind: "select";
      key: string;
      label: string;
      value: string;
      options: CompressFieldOption[];
      info?: CompressFieldInfo;
    }
  | {
      kind: "codec";
      key: string;
      label: string;
      value: string;
      options: CompressionCodecOption[];
      suggestions?: CompressionCodecOption[];
      multiple?: boolean;
      placeholder?: string;
      mono?: boolean;
      info?: CompressFieldInfo;
    }
  | {
      kind: "text";
      key: string;
      label: string;
      value: string;
      placeholder?: string;
      mono?: boolean;
      info?: CompressFieldInfo;
    };

type CompressPanelModel = { summary: string; fields: CompressField[] };

// Compression-profile scale (shared "Level" control), index 0..6.
const PROFILE_LABELS = [...COMPRESSION_PROFILE_LABELS];
const PROFILE_VALUES = [...COMPRESSION_PROFILE_NAMES];
const PROFILE_LEVEL_MAP: CompressFieldLevelMapRow[] = PROFILE_VALUES.map((profileValue, index) => ({
  profile: PROFILE_LABELS[index] || profileValue,
  standard: COMPRESSION_PROFILE_LEVELS.standard[profileValue],
  zstd: COMPRESSION_PROFILE_LEVELS.zstd[profileValue],
}));
const STANDARD_PROFILE_MAX = COMPRESSION_PROFILE_LEVELS.standard.max;
const ZSTD_PROFILE_MIN = COMPRESSION_PROFILE_LEVELS.zstd.min;
const ZSTD_PROFILE_MAX = COMPRESSION_PROFILE_LEVELS.zstd.max;
const CHD_CD_DEFAULT_CODECS = COMPRESSION_DEFAULTS.chdCreateCdCodecs;
const CHD_DVD_DEFAULT_CODECS = COMPRESSION_DEFAULTS.chdCreateDvdCodecs;
const codecValuesText = (fieldKey: string): string =>
  getCompressionCodecOptions(fieldKey)
    .map((option) => option.value)
    .join(", ");
const codecLevelRangesText = (fieldKey: string): string =>
  getCompressionCodecOptions(fieldKey)
    .map((option) =>
      option.maxLevel === null ? option.value : `${option.value} ${option.minLevel ?? 0}..${option.maxLevel}`,
    )
    .join(", ");

const COMPRESSION_PROFILE_FIELD_INFO: CompressFieldInfo = {
  items: [
    "This profile controls codec levels unless a codec list includes an explicit codec:level entry.",
    "The standard column applies to 7z LZMA2, ZIP Deflate, zlib, cdlz, and cdzl.",
    "The zstd column applies to ZIP zstd, RVZ, z3ds, CHD zstd, and CD zstd.",
  ],
  levelMap: PROFILE_LEVEL_MAP,
  summary: "Profile to numeric compression-level mapping.",
  title: getSettingsLabel("compressionProfile"),
};
const OVERRIDDEN_PROFILE_VALUE = "__overridden";

const FIELD_INFO: Record<string, CompressFieldInfo> = {
  chdCreateCdCodecs: {
    items: [
      `Valid values: ${codecValuesText("chdCreateCdCodecs")}.`,
      `Optional levels: ${codecLevelRangesText("chdCreateCdCodecs")}.`,
      "Entries without a level use the Level profile.",
    ],
    title: getSettingsLabel("chdCreateCdCodecs"),
  },
  chdCreateDvdCodecs: {
    items: [
      `Valid values: ${codecValuesText("chdCreateDvdCodecs")}.`,
      `Optional levels: ${codecLevelRangesText("chdCreateDvdCodecs")}.`,
      "huff has no level. Entries without a level use the Level profile.",
    ],
    title: getSettingsLabel("chdCreateDvdCodecs"),
  },
  compressionProfile: COMPRESSION_PROFILE_FIELD_INFO,
  rvzBlockSize: {
    items: [`Default: ${COMPRESSION_DEFAULTS.rvzBlockSize}.`, "Valid values: 1-2147483647."],
    title: getSettingsLabel("rvzBlockSize"),
  },
  rvzCodec: {
    items: [
      `Default: ${COMPRESSION_DEFAULTS.rvzCodec}.`,
      `Optional level: ${COMPRESSION_DEFAULTS.rvzCodec}:${
        getGeneratedCompressionCodecLevelMin(COMPRESSION_DEFAULTS.rvzCodec) ?? ZSTD_PROFILE_MIN
      } through ${COMPRESSION_DEFAULTS.rvzCodec}:${
        getGeneratedCompressionCodecLevelMax(COMPRESSION_DEFAULTS.rvzCodec) ?? ZSTD_PROFILE_MAX
      }.`,
    ],
    title: getSettingsLabel("rvzCodec"),
  },
  sevenZipCodec: {
    items: [`7z output currently uses ${codecValuesText("sevenZipCodec").toUpperCase()}.`],
    title: getSettingsLabel("sevenZipCodec"),
  },
  zipCodec: {
    items: [
      `Valid values: ${codecValuesText("zipCodec")}.`,
      "zstd writes ZIP-compatible .zip output.",
      "Store keeps files uncompressed and ignores Level.",
    ],
    title: getSettingsLabel("zipCodec"),
  },
};

const OUTPUT_FORMAT_INFO: CompressFieldInfo = {
  items: [
    "Select the compressed output type for this job.",
    "None leaves the output uncompressed.",
    "Other choices use the option labels below for codec and level.",
  ],
  title: "Type",
};

const str = (settings: SettingsLike, key: string, fallback = ""): string => {
  const value = settings[key];
  return value === undefined || value === null || value === "" ? fallback : String(value);
};

const editableStr = (settings: SettingsLike, key: string, fallback = ""): string => {
  if (!Object.hasOwn(settings, key)) return fallback;
  const value = settings[key];
  return value === undefined || value === null ? fallback : String(value);
};

/** Normalize a stored compression-profile value to its scale index (defaults to Max). */
const profileIndex = (settings: SettingsLike): number => {
  const raw = str(settings, "compressionProfile", "max").toLowerCase();
  const byValue = PROFILE_VALUES.indexOf(raw as (typeof PROFILE_VALUES)[number]);
  if (byValue >= 0) return byValue;
  const byLabel = PROFILE_LABELS.findIndex((label) => label.toLowerCase() === raw);
  return byLabel >= 0 ? byLabel : PROFILE_VALUES.length - 1;
};

const getProfileOptions = (overridden: boolean): CompressFieldOption[] => [
  ...(overridden ? [{ disabled: true, label: "Overridden", value: OVERRIDDEN_PROFILE_VALUE }] : []),
  ...PROFILE_LABELS.map((label, index) => ({ label, value: PROFILE_VALUES[index] as string })),
];

const levelField = (settings: SettingsLike, overridden = false): CompressField => ({
  info: FIELD_INFO.compressionProfile,
  key: "compressionProfile",
  kind: "select",
  label: getSettingsLabel("compressionProfile"),
  options: getProfileOptions(overridden),
  value: overridden ? OVERRIDDEN_PROFILE_VALUE : (PROFILE_VALUES[profileIndex(settings)] as string),
});

const getProfileLevelForCodec = (settings: SettingsLike, minLevel: number, maxLevel: number): number => {
  const index = profileIndex(settings);
  const profile = PROFILE_VALUES[index] || "max";
  const profileLevels =
    maxLevel > STANDARD_PROFILE_MAX ? COMPRESSION_PROFILE_LEVELS.zstd : COMPRESSION_PROFILE_LEVELS.standard;
  const profileLevel = profileLevels[profile] ?? maxLevel;
  return Math.max(minLevel, Math.min(maxLevel, profileLevel));
};

const codecProfileSummary = (fieldKey: string, codecSummary: string, settings: SettingsLike): string => {
  if (!codecSummary) return "";
  return codecSummary
    .split(",")
    .map((rawEntry) => {
      const entry = rawEntry.trim().toLowerCase();
      if (!entry) return "";
      const parsed = parseCompressionCodecEntry(entry);
      if (!parsed) return entry;
      const codec = parsed.codec;
      if (parsed.hasLevel) return `${codec}:${parsed.levelText}`;
      const maxLevel = getCompressionCodecLevelMax(fieldKey, codec);
      const minLevel = getCompressionCodecLevelMin(fieldKey, codec) ?? 0;
      return maxLevel === null ? codec : `${codec}:${getProfileLevelForCodec(settings, minLevel, maxLevel)}`;
    })
    .filter(Boolean)
    .join(",");
};

/** Build the compress-panel model for a normalized output format, or null when the format isn't compressed. */
const resolveChdPanelMode = (settings: SettingsLike, source?: unknown): "cd" | "dvd" | null => {
  const configuredMode = str(settings, "chdOutputMode", "auto").toLowerCase();
  if (configuredMode === "cd" || configuredMode === "dvd") return configuredMode;
  if (!source) return null;
  const resolvedMode = getChdAutoCreateMode(source as SourceLike);
  return resolvedMode === "cd" || resolvedMode === "dvd" ? resolvedMode : null;
};

const buildCompressPanel = (format: string, settings: SettingsLike, source?: unknown): CompressPanelModel | null => {
  const normalized = String(format || "").toLowerCase();

  if (normalized === "zip") {
    const codec = editableStr(settings, "zipCodec", COMPRESSION_DEFAULTS.zipCodec);
    const codecSummary = codec || COMPRESSION_DEFAULTS.zipCodec;
    const levelOverridden = hasCompressionCodecLevelOverride(codec);
    const level = levelField(settings, levelOverridden);
    return {
      fields: [
        {
          info: FIELD_INFO.zipCodec,
          key: "zipCodec",
          kind: "codec",
          label: getSettingsLabel("zipCodec"),
          options: getCompressionCodecOptions("zipCodec"),
          placeholder: COMPRESSION_DEFAULTS.zipCodec,
          value: codec,
        },
        level,
      ],
      summary: codecProfileSummary("zipCodec", codecSummary, settings),
    };
  }
  if (normalized === "7z") {
    const codec = editableStr(settings, "sevenZipCodec", COMPRESSION_DEFAULTS.sevenZipCodec);
    const codecSummary = codec || COMPRESSION_DEFAULTS.sevenZipCodec;
    const levelOverridden = hasCompressionCodecLevelOverride(codec);
    const level = levelField(settings, levelOverridden);
    return {
      fields: [
        {
          info: FIELD_INFO.sevenZipCodec,
          key: "sevenZipCodec",
          kind: "codec",
          label: getSettingsLabel("sevenZipCodec"),
          options: getCompressionCodecOptions("sevenZipCodec"),
          placeholder: COMPRESSION_DEFAULTS.sevenZipCodec,
          value: codec,
        },
        level,
      ],
      summary: codecProfileSummary("sevenZipCodec", codecSummary, settings),
    };
  }
  if (normalized === "rvz") {
    const codec = editableStr(settings, "rvzCodec", COMPRESSION_DEFAULTS.rvzCodec);
    const codecSummary = codec || COMPRESSION_DEFAULTS.rvzCodec;
    const levelOverridden = hasCompressionCodecLevelOverride(codec);
    const level = levelField(settings, levelOverridden);
    return {
      fields: [
        {
          info: FIELD_INFO.rvzCodec,
          key: "rvzCodec",
          kind: "codec",
          label: getSettingsLabel("rvzCodec"),
          options: getCompressionCodecOptions("rvzCodec"),
          placeholder: COMPRESSION_DEFAULTS.rvzCodec,
          value: codec,
        },
        {
          info: FIELD_INFO.rvzBlockSize,
          key: "rvzBlockSize",
          kind: "text",
          label: getSettingsLabel("rvzBlockSize"),
          mono: true,
          placeholder: String(COMPRESSION_DEFAULTS.rvzBlockSize),
          value: str(settings, "rvzBlockSize"),
        },
        level,
      ],
      summary: codecProfileSummary("rvzCodec", codecSummary, settings),
    };
  }
  if (normalized === "chd") {
    const mode = resolveChdPanelMode(settings, source);
    // GD-ROM media reuses the CD codec set; surface the detected disc type so the
    // output reflects the GD-vs-CD media the create will actually produce.
    const discLabel = source
      ? getDiscKindLabel(
          getDiscKind({
            cueText: (source as SourceLike)._chdCueText,
            fileName: (source as SourceLike).fileName,
          }),
        )
      : null;
    const cd = editableStr(settings, "chdCreateCdCodecs", CHD_CD_DEFAULT_CODECS);
    const dvd = editableStr(settings, "chdCreateDvdCodecs", CHD_DVD_DEFAULT_CODECS);
    const codecKey = mode === "cd" ? "chdCreateCdCodecs" : "chdCreateDvdCodecs";
    const codecValue = mode === "cd" ? cd : mode === "dvd" ? dvd : "";
    const codecSummary =
      codecValue || (mode === "cd" ? CHD_CD_DEFAULT_CODECS : mode === "dvd" ? CHD_DVD_DEFAULT_CODECS : "");
    const levelOverridden = hasCompressionCodecLevelOverride(codecValue);
    const level = levelField(settings, levelOverridden);
    return {
      fields: [
        {
          info: FIELD_INFO[codecKey],
          key: codecKey,
          kind: "codec",
          label:
            codecKey === "chdCreateCdCodecs"
              ? getSettingsLabel("chdCreateCdCodecs")
              : getSettingsLabel("chdCreateDvdCodecs"),
          mono: true,
          multiple: true,
          options: getCompressionCodecOptions(codecKey),
          placeholder: mode === "cd" ? CHD_CD_DEFAULT_CODECS : CHD_DVD_DEFAULT_CODECS,
          suggestions: getCompressionCodecSuggestions(codecKey),
          value: codecValue,
        },
        level,
      ],
      summary: discLabel
        ? `${discLabel} · ${codecProfileSummary(codecKey, codecSummary, settings)}`
        : codecProfileSummary(codecKey, codecSummary, settings),
    };
  }
  if (normalized === "z3ds") {
    const level = levelField(settings);
    const z3dsMaxLevel = getGeneratedCompressionCodecLevelMax(COMPRESSION_DEFAULTS.z3dsCodec) ?? ZSTD_PROFILE_MAX;
    const z3dsMinLevel = getGeneratedCompressionCodecLevelMin(COMPRESSION_DEFAULTS.z3dsCodec) ?? ZSTD_PROFILE_MIN;
    return {
      fields: [level],
      summary: `${COMPRESSION_DEFAULTS.z3dsCodec}:${getProfileLevelForCodec(settings, z3dsMinLevel, z3dsMaxLevel)}`,
    };
  }
  return null;
};

export {
  buildCompressPanel,
  COMPRESSION_PROFILE_FIELD_INFO,
  type CompressField,
  type CompressFieldInfo,
  type CompressPanelModel,
  OUTPUT_FORMAT_INFO,
  OVERRIDDEN_PROFILE_VALUE,
};
