import type { LocaleCode } from "../localization/catalog.ts";

const BYTE_UNITS = ["KiB", "MiB", "GiB", "TiB"] as const;

const getNumberFormatter = (locale: LocaleCode, options: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(locale, options);

const formatBytes = (bytes: number, locale: LocaleCode): string => {
  const normalizedBytes = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  if (normalizedBytes < 1024) return `${getNumberFormatter(locale).format(normalizedBytes)} B`;
  let value = normalizedBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${getNumberFormatter(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value)} ${BYTE_UNITS[unitIndex]}`;
};

const formatPercent = (value: number, locale: LocaleCode, digits = 1): string =>
  `${getNumberFormatter(locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value)}%`;

const formatDuration = (milliseconds: number, locale: LocaleCode): string => {
  const normalizedMilliseconds = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  if (normalizedMilliseconds < 1000) {
    return `${getNumberFormatter(locale).format(Math.round(normalizedMilliseconds))}ms`;
  }
  return `${getNumberFormatter(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(normalizedMilliseconds / 1000)}s`;
};

const formatCount = (count: number, locale: LocaleCode, unit?: string): string => {
  const formattedCount = getNumberFormatter(locale).format(count);
  if (!unit) return formattedCount;
  const pluralRules = new Intl.PluralRules(locale);
  return `${formattedCount} ${pluralRules.select(count) === "one" ? unit : `${unit}s`}`;
};

const formatList = (items: string[], locale: LocaleCode): string => {
  if (typeof Intl.ListFormat === "function") {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  }
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
};

export { formatBytes, formatCount, formatDuration, formatList, formatPercent };
