import { parseCompressionCodecEntry } from "../compression/codec-parser.ts";
import { isCompressionLevelProfile } from "../path-utils.ts";

const normalizeCodecEntries = (value: unknown): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string) => {
    const normalized = String(entry || "").trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  const collectString = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    if (trimmed.includes(",")) for (const entry of trimmed.split(",")) collect(entry);
    else if (trimmed.includes("+")) for (const entry of trimmed.split("+")) collect(entry);
    else push(trimmed);
  };
  const collectObject = (candidate: Record<string, unknown>) => {
    for (const [codecName, codecValue] of Object.entries(candidate)) {
      const name = codecName.trim();
      if (!name || codecValue == null || codecValue === false) continue;
      if (codecValue === true) {
        push(name);
        continue;
      }
      if (typeof codecValue === "number") {
        if (Number.isFinite(codecValue)) push(`${name}:${Math.floor(codecValue)}`);
        continue;
      }
      if (typeof codecValue === "string") {
        const normalized = codecValue.trim();
        if (!normalized || normalized === "0" || normalized.toLowerCase() === "false") continue;
        if (normalized.toLowerCase() === "true") push(name);
        else push(`${name}:${normalized}`);
      }
    }
  };
  const collect = (candidate: unknown) => {
    if (candidate == null) return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) collect(entry);
      return;
    }
    if (typeof candidate === "string") {
      collectString(candidate);
      return;
    }
    if (typeof candidate === "number") {
      if (Number.isFinite(candidate)) push(String(Math.floor(candidate)));
      return;
    }
    if (typeof candidate === "object") collectObject(candidate as Record<string, unknown>);
  };
  collect(value);
  return out;
};

const normalizeCompressionLevelProfile = (value: unknown): string | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return isCompressionLevelProfile(normalized) ? normalized : null;
};

const normalizeChdCodecArgs = (codecs: string[]) => {
  const explicitLevels = new Set<string>();
  const strippedCodecs: string[] = [];
  const strippedSeen = new Set<string>();
  for (const codecEntry of codecs) {
    const trimmed = String(codecEntry || "").trim();
    if (!trimmed) continue;
    const parsed = parseCompressionCodecEntry(trimmed);
    if (!parsed) {
      if (!strippedSeen.has(trimmed)) {
        strippedSeen.add(trimmed);
        strippedCodecs.push(trimmed);
      }
      continue;
    }
    const codecName = parsed.codec || trimmed;
    if (parsed.levelText !== null) explicitLevels.add(parsed.levelText);
    if (!strippedSeen.has(codecName)) {
      strippedSeen.add(codecName);
      strippedCodecs.push(codecName);
    }
  }

  // CHD codec sets cannot mix per-codec levels; keep user codec order but remove level suffixes on conflicts.
  if (explicitLevels.size <= 1) return { codecs, stripped: false };
  return { codecs: strippedCodecs, stripped: true };
};

const isChdCompressionFormat = (format: string): boolean => {
  const normalized = format.trim().toLowerCase();
  return normalized === "chd" || normalized.startsWith("chd-");
};

export { isChdCompressionFormat, normalizeChdCodecArgs, normalizeCodecEntries, normalizeCompressionLevelProfile };
