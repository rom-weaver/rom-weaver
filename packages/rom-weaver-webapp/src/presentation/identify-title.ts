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

const uniqueIdentifyTitles = (names: readonly string[]): string[] => [
  ...new Set(names.map(formatIdentifyTitle).filter(Boolean)),
];

export { formatIdentifyTitle, uniqueIdentifyTitles };
