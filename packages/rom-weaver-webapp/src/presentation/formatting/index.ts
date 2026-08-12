import type { LocaleCode } from "../localization/catalog.ts";
import type { ByteUnitSystem } from "../../types/settings.ts";

const DEFAULT_BYTE_UNIT_SYSTEM: ByteUnitSystem = "decimal";
const BYTE_UNIT_SYSTEMS = {
  binary: { base: 1024, units: ["KiB", "MiB", "GiB", "TiB"] },
  decimal: { base: 1000, units: ["KB", "MB", "GB", "TB"] },
} as const satisfies Record<ByteUnitSystem, { base: number; units: readonly string[] }>;
const BYTE_FRACTION_DIGITS = {
  maximumFractionDigits: 2,
  minimumFractionDigits: 1,
} as const;

let activeByteUnitSystem: ByteUnitSystem = DEFAULT_BYTE_UNIT_SYSTEM;

const normalizeByteUnitSystem = (value: unknown): ByteUnitSystem =>
  value === "binary" ? "binary" : DEFAULT_BYTE_UNIT_SYSTEM;

const setByteUnitSystem = (value: unknown): ByteUnitSystem => {
  activeByteUnitSystem = normalizeByteUnitSystem(value);
  return activeByteUnitSystem;
};

const getByteUnitSystem = (): ByteUnitSystem => activeByteUnitSystem;

const getNumberFormatter = (locale: LocaleCode, options: Intl.NumberFormatOptions = {}) =>
  new Intl.NumberFormat(locale, options);

const formatBytes = (
  bytes: number,
  locale: LocaleCode,
  byteUnitSystem: ByteUnitSystem = getByteUnitSystem(),
): string => {
  const unitConfig = BYTE_UNIT_SYSTEMS[normalizeByteUnitSystem(byteUnitSystem)];
  const normalizedBytes = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0;
  if (normalizedBytes < unitConfig.base) return `${getNumberFormatter(locale).format(normalizedBytes)} B`;
  let value = normalizedBytes / unitConfig.base;
  let unitIndex = 0;
  while (value >= unitConfig.base && unitIndex < unitConfig.units.length - 1) {
    value /= unitConfig.base;
    unitIndex++;
  }
  return `${getNumberFormatter(locale, BYTE_FRACTION_DIGITS).format(value)} ${unitConfig.units[unitIndex]}`;
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

export {
  formatBytes,
  formatCount,
  formatDuration,
  formatList,
  getByteUnitSystem,
  normalizeByteUnitSystem,
  setByteUnitSystem,
};
