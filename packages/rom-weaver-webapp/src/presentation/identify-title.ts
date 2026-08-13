const REGION_LABELS: Readonly<Record<string, string>> = {
  A: "Australia",
  C: "China",
  E: "Europe",
  F: "France",
  G: "Germany",
  GR: "Greece",
  H: "Holland",
  I: "Italy",
  J: "Japan",
  K: "Korea",
  S: "Spain",
  SC: "Scandinavia",
  SW: "Sweden",
  U: "USA",
  UB: "USA, Brazil",
  UE: "USA, Europe",
  UK: "United Kingdom",
  W: "World",
};

const normalizeRegionGroup = (value: string): string | undefined => {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return undefined;
  const direct = REGION_LABELS[normalized];
  if (direct) return direct;
  const tokens = normalized.split(/[\s,/+]+/u).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !REGION_LABELS[token])) return undefined;
  return tokens.map((token) => REGION_LABELS[token]).join(", ");
};

/** Convert GoodTools' compact suffixes into a readable standard display name. */
const formatIdentifyTitle = (name: string): string => {
  let formatted = name
    .trim()
    .replace(/\s*\[[^\]]*\]/gu, "")
    .replace(/\s+\(M\d+\)/giu, "");
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
