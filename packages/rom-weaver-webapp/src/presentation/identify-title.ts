import type { ParsedIdentifyResolution, ParsedIdentifyTitleMatch } from "../types/identify.ts";

const ATOMIC_REGION_LABELS: Readonly<Record<string, string>> = {
  A: "Australia",
  B: "Brazil",
  C: "China",
  D: "Netherlands",
  E: "Europe",
  F: "France",
  G: "Germany",
  H: "Holland",
  I: "Italy",
  J: "Japan",
  K: "Korea",
  S: "Spain",
  T: "Taiwan",
  U: "USA",
  W: "World",
};

const REGION_LABELS: Readonly<Record<string, string>> = {
  ...ATOMIC_REGION_LABELS,
  "1": "Japan, Korea",
  "4": "USA, Brazil",
  CH: "China",
  FC: "French Canadian",
  FN: "Finland",
  GR: "Greece",
  HK: "Hong Kong",
  NL: "Netherlands",
  SC: "Scandinavia",
  SW: "Sweden",
  UB: "USA, Brazil",
  UE: "USA, Europe",
  UK: "United Kingdom",
  UNK: "Unknown Country",
};

const REGION_NAMES = new Set(Object.values(REGION_LABELS).flatMap((label) => label.split(", ")));
const COMPACT_REGION_CODES = Object.keys(ATOMIC_REGION_LABELS);

const expandCompactRegionCode = (value: string): string[] | undefined => {
  const labels: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const code = COMPACT_REGION_CODES.find((candidate) => value.startsWith(candidate, offset));
    if (!code) return undefined;
    const label = ATOMIC_REGION_LABELS[code];
    if (!label) return undefined;
    labels.push(label);
    offset += code.length;
  }
  return labels;
};

const normalizeRegionGroup = (value: string): string | undefined => {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  const direct = REGION_LABELS[normalized];
  if (direct) return direct;
  const tokens = normalized.split(/[\s,/+]+/u).filter(Boolean);
  if (!tokens.length) return undefined;
  if (tokens.some((token) => REGION_NAMES.has(token))) return undefined;
  const expandedTokens = tokens.map((token) =>
    REGION_LABELS[token] ? [REGION_LABELS[token]] : expandCompactRegionCode(token),
  );
  if (expandedTokens.some((token) => !token)) return undefined;
  return expandedTokens.flat().join(", ");
};

/** Expand GoodTools region codes and remove only its verified-dump marker. */
const formatIdentifyTitle = (name: string): string => {
  let formatted = name.trim().replace(/\s*\[!\]/gu, "");
  formatted = formatted.replace(/\(([^()]*)\)/gu, (whole, value: string) => {
    const region = normalizeRegionGroup(value);
    return region ? `(${region})` : whole;
  });
  return formatted.replace(/\s{2,}/gu, " ").trim();
};

/**
 * The identified title as a filename stem: control characters and the
 * characters no filesystem accepts are removed, and the extension is left to
 * the caller's format selector. Brackets stay - a GoodTools tag like `[T+Eng]`
 * is part of the name a reader recognizes.
 */
const identifyOutputBaseName = (name: string): string =>
  Array.from(formatIdentifyTitle(name))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/[<>:"/\\|?*]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

/** Explain GoodTools's parenthesized program revision markers without changing source names. */
const identifyGoodToolsRevisionLabels = (names: readonly string[]): string[] => {
  const labels = new Set<string>();
  for (const name of names) {
    for (const match of name.matchAll(/\((PRG(\d+))\)/giu)) {
      const code = match[1]?.toUpperCase();
      const revision = match[2];
      if (code && revision) labels.add(`${code}: Program revision ${revision}`);
    }
  }
  return [...labels];
};

const uniqueIdentifyTitles = (names: readonly string[]): string[] => [
  ...new Set(names.map(formatIdentifyTitle).filter(Boolean)),
];

/** Every title a lookup provides, with source names first and readable forms preserved. */
const uniqueIdentifyDisplayNames = (
  matches: readonly Pick<ParsedIdentifyTitleMatch, "name" | "alternateNames">[],
): string[] => {
  const sourceNames = matches.flatMap((match) => [match.name, ...(match.alternateNames ?? [])]);
  const readableNames = matches.map((match) => formatIdentifyTitle(match.name));
  return [...new Set([...sourceNames, ...readableNames].map((name) => name.trim()).filter(Boolean))];
};

/**
 * The base name automatic output names use when the ROM was identified, or
 * nothing. Only a single confident match qualifies: an ambiguous result has no
 * one answer, and `unknown`/`unavailable` carry no title at all.
 */
const identifiedOutputBaseName = (identification: ParsedIdentifyResolution | undefined): string | null => {
  if (identification?.status !== "matched") return null;
  const titles = uniqueIdentifyTitles(identification.matches.map((match) => match.name));
  if (titles.length !== 1) return null;
  return identifyOutputBaseName(titles[0] || "") || null;
};

export {
  formatIdentifyTitle,
  identifiedOutputBaseName,
  identifyGoodToolsRevisionLabels,
  uniqueIdentifyDisplayNames,
  uniqueIdentifyTitles,
};
