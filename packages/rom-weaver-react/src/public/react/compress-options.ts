/**
 * Output "Compress" panel model (prototype `.outopts`). Maps the selected output
 * format to the editable compression controls (codec / level / codec-lists), with
 * values defaulting to the active settings and edits applied as per-job overrides.
 *
 * The override target is the same flat settings shape the run consumes (top-level
 * `zipCodec`, `sevenZipCodec`, `compressionProfile`, `rvzCompression`, …), so
 * editing here simply overrides Settings for this one job.
 */

import { getChdAutoCreateMode } from "../../lib/input/disc-file-utils.ts";

type SettingsLike = Record<string, unknown>;
type SourceLike = {
  _chdCuePath?: string;
  _chdCueText?: string;
  _chdMode?: string;
  fileName?: string;
  getExtension?: () => string;
};

type CompressFieldOption = { value: string; label: string };

type CompressField =
  | { kind: "select"; key: string; label: string; value: string; options: CompressFieldOption[] }
  | { kind: "text"; key: string; label: string; value: string; placeholder?: string; mono?: boolean };

type CompressPanelModel = { summary: string; fields: CompressField[] };

// Compression-profile scale (shared "Level" control), index 0..6.
const PROFILE_LABELS = ["Min", "Very Low", "Low", "Medium", "High", "Very High", "Max"] as const;
const PROFILE_VALUES = ["min", "very-low", "low", "medium", "high", "very-high", "max"] as const;

const ZIP_CODECS: CompressFieldOption[] = [
  { label: "Deflate", value: "deflate" },
  { label: "Store", value: "store" },
  { label: "Zstandard", value: "zstd" },
];
const SEVEN_ZIP_CODECS: CompressFieldOption[] = [
  { label: "LZMA2", value: "lzma2" },
  { label: "Zstandard", value: "zstd" },
];
const RVZ_CODECS: CompressFieldOption[] = [
  { label: "zstd", value: "zstd" },
  { label: "lzma", value: "lzma" },
  { label: "lzma2", value: "lzma2" },
  { label: "bzip2", value: "bzip2" },
  { label: "None", value: "none" },
];

const str = (settings: SettingsLike, key: string, fallback = ""): string => {
  const value = settings[key];
  return value === undefined || value === null || value === "" ? fallback : String(value);
};

const stripChdCodecLevels = (value: string): string =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/:\d+$/u, ""))
    .join(",");

/** Normalize a stored compression-profile value to its scale index (defaults to Max). */
const profileIndex = (settings: SettingsLike): number => {
  const raw = str(settings, "compressionProfile", "max").toLowerCase();
  const byValue = PROFILE_VALUES.indexOf(raw as (typeof PROFILE_VALUES)[number]);
  if (byValue >= 0) return byValue;
  const byLabel = PROFILE_LABELS.findIndex((label) => label.toLowerCase() === raw);
  return byLabel >= 0 ? byLabel : PROFILE_VALUES.length - 1;
};

const levelField = (settings: SettingsLike): CompressField => ({
  key: "compressionProfile",
  kind: "select",
  label: "Level",
  options: PROFILE_LABELS.map((label, index) => ({ label, value: PROFILE_VALUES[index] as string })),
  value: PROFILE_VALUES[profileIndex(settings)] as string,
});

const codecLabel = (options: CompressFieldOption[], value: string): string =>
  options.find((option) => option.value === value)?.label || value;

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
      fields: [{ key: "zipCodec", kind: "select", label: "Codec", options: ZIP_CODECS, value: codec }, level],
      summary: `${codecLabel(ZIP_CODECS, codec)} · ${levelSummary}`,
    };
  }
  if (normalized === "7z") {
    const codec = str(settings, "sevenZipCodec", "lzma2");
    return {
      fields: [
        { key: "sevenZipCodec", kind: "select", label: "Codec", options: SEVEN_ZIP_CODECS, value: codec },
        level,
      ],
      summary: `${codecLabel(SEVEN_ZIP_CODECS, codec)} · ${levelSummary}`,
    };
  }
  if (normalized === "rvz") {
    const codec = str(settings, "rvzCompression", "zstd");
    return {
      fields: [
        { key: "rvzCompression", kind: "select", label: "Codec", options: RVZ_CODECS, value: codec },
        {
          key: "rvzBlockSize",
          kind: "text",
          label: "Block size",
          mono: true,
          placeholder: "131072",
          value: str(settings, "rvzBlockSize"),
        },
        level,
      ],
      summary: `${codecLabel(RVZ_CODECS, codec)} · ${levelSummary}`,
    };
  }
  if (normalized === "chd") {
    const mode = resolveChdPanelMode(settings, source);
    const cd = stripChdCodecLevels(str(settings, "chdCreateCdCodecs", "cdlz,cdzl,cdfl"));
    const dvd = stripChdCodecLevels(str(settings, "chdCreateDvdCodecs", "lzma,zlib,huff,flac"));
    const codecKey = mode === "cd" ? "chdCreateCdCodecs" : "chdCreateDvdCodecs";
    const codecLabel = mode === "cd" ? "CD codecs" : mode === "dvd" ? "DVD codecs" : "Codecs";
    const codecValue = mode === "cd" ? cd : mode === "dvd" ? dvd : "";
    return {
      fields: [
        {
          key: codecKey,
          kind: "text",
          label: codecLabel,
          mono: true,
          placeholder: mode === "cd" ? "cdlz,cdzl,cdfl" : "lzma,zlib,huff,flac",
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

export { buildCompressPanel, type CompressField, type CompressFieldOption, type CompressPanelModel };
