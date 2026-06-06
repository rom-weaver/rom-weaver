/**
 * Output "Options" panel model. Maps the selected output format to the editable
 * compression controls (codec / level / codec-lists), with values defaulting to
 * the active settings and edits applied as per-job overrides.
 *
 * The override target is the same flat settings shape the run consumes (top-level
 * `zipCodec`, `sevenZipCodec`, `compressionProfile`, `rvzCodec`, …), so
 * editing here simply overrides Settings for this one job.
 */

import { getChdAutoCreateMode } from "../../lib/input/rom-specific-file-utils.ts";
import { getSettingsLabel } from "../../presentation/settings.ts";

type SettingsLike = Record<string, unknown>;
type SourceLike = {
  _chdCuePath?: string;
  _chdCueText?: string;
  _chdMode?: string;
  fileName?: string;
  getExtension?: () => string;
};

type CompressFieldOption = { value: string; label: string };
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
const PROFILE_LABELS = ["Min", "Very Low", "Low", "Medium", "High", "Very High", "Max"] as const;
const PROFILE_VALUES = ["min", "very-low", "low", "medium", "high", "very-high", "max"] as const;

const STANDARD_PROFILE_LEVELS = [0, 2, 3, 5, 7, 8, 9] as const;
const ZSTD_PROFILE_LEVELS = [0, 4, 7, 11, 15, 19, 22] as const;
const PROFILE_LEVEL_MAP: CompressFieldLevelMapRow[] = PROFILE_LABELS.map((profile, index) => ({
  profile,
  standard: STANDARD_PROFILE_LEVELS[index] ?? 9,
  zstd: ZSTD_PROFILE_LEVELS[index] ?? 22,
}));

const COMPRESSION_PROFILE_FIELD_INFO: CompressFieldInfo = {
  items: [
    "This profile controls codec levels unless a codec list includes an explicit codec:level entry.",
    "The standard column applies to 7z LZMA2, ZIP Deflate, ZIP zstd, zlib, cdlz, and cdzl.",
    "The zstd column applies to RVZ, z3ds, CHD zstd, and CD zstd.",
  ],
  levelMap: PROFILE_LEVEL_MAP,
  summary: "Profile to numeric compression-level mapping.",
  title: getSettingsLabel("compressionProfile"),
};

const FIELD_INFO: Record<string, CompressFieldInfo> = {
  chdCreateCdCodecs: {
    items: [
      "Valid values: cdzs, cdlz, cdzl, cdfl.",
      "Optional levels: cdzs 0-22, cdlz 0-9, cdzl 0-9, cdfl 0-8.",
      "Entries without a level use the Level profile.",
    ],
    title: getSettingsLabel("chdCreateCdCodecs"),
  },
  chdCreateDvdCodecs: {
    items: [
      "Valid values: zstd, lzma, zlib, huff, flac.",
      "Optional levels: zstd 0-22, lzma 0-9, zlib 0-9, flac 0-8.",
      "huff has no level. Entries without a level use the Level profile.",
    ],
    title: getSettingsLabel("chdCreateDvdCodecs"),
  },
  compressionProfile: COMPRESSION_PROFILE_FIELD_INFO,
  rvzBlockSize: {
    items: ["Default: 131072.", "Valid values: 1-2147483647."],
    title: getSettingsLabel("rvzBlockSize"),
  },
  rvzCodec: {
    items: ["Default: zstd.", "Optional level: zstd:0 through zstd:22."],
    title: getSettingsLabel("rvzCodec"),
  },
  sevenZipCodec: {
    items: ["7z output currently uses LZMA2."],
    title: getSettingsLabel("sevenZipCodec"),
  },
  zipCodec: {
    items: ["zstd writes ZIP-compatible .zip output.", "Store keeps files uncompressed and ignores Level."],
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

/** Normalize a stored compression-profile value to its scale index (defaults to Max). */
const profileIndex = (settings: SettingsLike): number => {
  const raw = str(settings, "compressionProfile", "max").toLowerCase();
  const byValue = PROFILE_VALUES.indexOf(raw as (typeof PROFILE_VALUES)[number]);
  if (byValue >= 0) return byValue;
  const byLabel = PROFILE_LABELS.findIndex((label) => label.toLowerCase() === raw);
  return byLabel >= 0 ? byLabel : PROFILE_VALUES.length - 1;
};

const levelField = (settings: SettingsLike): CompressField => ({
  info: FIELD_INFO.compressionProfile,
  key: "compressionProfile",
  kind: "select",
  label: getSettingsLabel("compressionProfile"),
  options: PROFILE_LABELS.map((label, index) => ({ label, value: PROFILE_VALUES[index] as string })),
  value: PROFILE_VALUES[profileIndex(settings)] as string,
});

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
  const level = levelField(settings);
  const levelSummary = PROFILE_LABELS[profileIndex(settings)] ?? "Max";

  if (normalized === "zip") {
    const codec = str(settings, "zipCodec", "deflate");
    return {
      fields: [
        {
          info: FIELD_INFO.zipCodec,
          key: "zipCodec",
          kind: "text",
          label: getSettingsLabel("zipCodec"),
          placeholder: "deflate:9",
          value: codec,
        },
        level,
      ],
      summary: `${codec || "deflate"} · ${levelSummary}`,
    };
  }
  if (normalized === "7z") {
    const codec = str(settings, "sevenZipCodec", "lzma2");
    return {
      fields: [
        {
          info: FIELD_INFO.sevenZipCodec,
          key: "sevenZipCodec",
          kind: "text",
          label: getSettingsLabel("sevenZipCodec"),
          placeholder: "lzma2:9",
          value: codec,
        },
        level,
      ],
      summary: `${codec || "lzma2"} · ${levelSummary}`,
    };
  }
  if (normalized === "rvz") {
    const codec = str(settings, "rvzCodec", str(settings, "rvzCompression", "zstd"));
    return {
      fields: [
        {
          info: FIELD_INFO.rvzCodec,
          key: "rvzCodec",
          kind: "text",
          label: getSettingsLabel("rvzCodec"),
          placeholder: "zstd:22",
          value: codec,
        },
        {
          info: FIELD_INFO.rvzBlockSize,
          key: "rvzBlockSize",
          kind: "text",
          label: getSettingsLabel("rvzBlockSize"),
          mono: true,
          placeholder: "131072",
          value: str(settings, "rvzBlockSize"),
        },
        level,
      ],
      summary: `${codec || "zstd"} · ${levelSummary}`,
    };
  }
  if (normalized === "chd") {
    const mode = resolveChdPanelMode(settings, source);
    const cd = str(settings, "chdCreateCdCodecs", "cdlz,cdzl,cdfl");
    const dvd = str(settings, "chdCreateDvdCodecs", "lzma,zlib,huff,flac");
    const codecKey = mode === "cd" ? "chdCreateCdCodecs" : "chdCreateDvdCodecs";
    const codecValue = mode === "cd" ? cd : mode === "dvd" ? dvd : "";
    return {
      fields: [
        {
          info: FIELD_INFO[codecKey],
          key: codecKey,
          kind: "text",
          label:
            codecKey === "chdCreateCdCodecs"
              ? getSettingsLabel("chdCreateCdCodecs")
              : getSettingsLabel("chdCreateDvdCodecs"),
          mono: true,
          placeholder: mode === "cd" ? "cdlz:9,cdzl:9,cdfl:8" : "lzma:9,zlib:9,huff,flac:8",
          value: codecValue,
        },
        level,
      ],
      summary: codecValue ? `${codecValue} · ${levelSummary}` : levelSummary,
    };
  }
  if (normalized === "z3ds") {
    return {
      fields: [level],
      summary: levelSummary,
    };
  }
  return null;
};

export {
  buildCompressPanel,
  COMPRESSION_PROFILE_FIELD_INFO,
  type CompressField,
  type CompressFieldInfo,
  type CompressFieldLevelMapRow,
  type CompressFieldOption,
  type CompressPanelModel,
  OUTPUT_FORMAT_INFO,
};
