type ParsedCompressionCodecEntry = {
  codec: string;
  hasLevel: boolean;
  level: number | null;
  levelText: string | null;
  value: string;
};

type ParseCompressionCodecEntryOptions = {
  allowLevel?: boolean;
};

const COMPRESSION_CODEC_ENTRY_REGEX = /^([a-z0-9_+-]+)(?::(-?\d+))?$/;

const parseCompressionCodecEntry = (
  value: string | null | undefined,
  options: ParseCompressionCodecEntryOptions = {},
): ParsedCompressionCodecEntry | null => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const match = raw.match(COMPRESSION_CODEC_ENTRY_REGEX);
  if (!match) return null;
  const levelText = match[2] ?? null;
  if (levelText !== null && options.allowLevel === false) return null;

  return {
    codec: match[1] || "",
    hasLevel: levelText !== null,
    level: levelText === null ? null : Number.parseInt(levelText, 10),
    levelText,
    value: raw,
  };
};

const splitCompressionCodecEntries = (value: string | null | undefined): string[] =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

const hasCompressionCodecLevelOverride = (value: string | null | undefined): boolean =>
  splitCompressionCodecEntries(value).some((entry) => parseCompressionCodecEntry(entry)?.hasLevel === true);

const stripCompressionCodecLevelOverrides = (value: string | null | undefined): string =>
  splitCompressionCodecEntries(value)
    .map((entry) => parseCompressionCodecEntry(entry)?.codec ?? entry)
    .filter(Boolean)
    .join(",");

export {
  hasCompressionCodecLevelOverride,
  type ParsedCompressionCodecEntry,
  parseCompressionCodecEntry,
  splitCompressionCodecEntries,
  stripCompressionCodecLevelOverrides,
};
