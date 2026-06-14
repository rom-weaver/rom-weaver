import type { LocaleCode } from "../localization/catalog.ts";

const BYTE_UNIT_BASE = 1000;
const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;
const BYTE_FRACTION_DIGITS = {
  maximumFractionDigits: 2,
  minimumFractionDigits: 1,
} as const;

const getNumberFormatter = (locale: LocaleCode, options: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(locale, options);

const formatBytes = (bytes: number, locale: LocaleCode): string => {
  const normalizedBytes = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  if (normalizedBytes < BYTE_UNIT_BASE) return `${getNumberFormatter(locale).format(normalizedBytes)} B`;
  let value = normalizedBytes / BYTE_UNIT_BASE;
  let unitIndex = 0;
  while (value >= BYTE_UNIT_BASE && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTE_UNIT_BASE;
    unitIndex++;
  }
  return `${getNumberFormatter(locale, BYTE_FRACTION_DIGITS).format(value)} ${BYTE_UNITS[unitIndex]}`;
};

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

export { formatBytes, formatCount, formatDuration, formatList };
