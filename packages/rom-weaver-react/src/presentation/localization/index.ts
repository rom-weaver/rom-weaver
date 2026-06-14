import { formatBytes, formatCount, formatDuration, formatList } from "../formatting/index.ts";
import {
  DEFAULT_LOCALE,
  type LocaleCode,
  MESSAGE_CATALOGS,
  type MessageId,
  type PartialMessageCatalog,
} from "./catalog.ts";

type Localizer = {
  locale: LocaleCode;
  message: (id: MessageId, values?: Record<string, unknown>) => string;
  /** Plural-aware lookup: resolves `${id}.one` / `${id}.other` via Intl.PluralRules. */
  messageCount: (id: MessageId, count: number, values?: Record<string, unknown>) => string;
  formatBytes: (bytes: number) => string;
  formatDuration: (milliseconds: number) => string;
  formatCount: (count: number, unit?: string) => string;
  formatList: (items: string[]) => string;
};

const normalizeLocale = (locale?: string): LocaleCode => {
  const rawLocale = typeof locale === "string" ? locale.trim() : "";
  if (!rawLocale) return DEFAULT_LOCALE;
  try {
    if (typeof Intl.Locale === "function") return new Intl.Locale(rawLocale).baseName.toLowerCase();
  } catch {
    return DEFAULT_LOCALE;
  }
  return rawLocale.toLowerCase();
};

const getCatalog = (locale: LocaleCode): PartialMessageCatalog => {
  const normalizedLocale = normalizeLocale(locale);
  return (
    MESSAGE_CATALOGS[normalizedLocale] ||
    MESSAGE_CATALOGS[normalizedLocale.split("-")[0] || ""] ||
    (MESSAGE_CATALOGS.en as PartialMessageCatalog)
  );
};

const negotiateLocale = (locales: readonly string[] = []): LocaleCode => {
  for (const locale of locales) {
    const normalizedLocale = normalizeLocale(locale);
    if (MESSAGE_CATALOGS[normalizedLocale] || MESSAGE_CATALOGS[normalizedLocale.split("-")[0] || ""]) {
      return normalizedLocale;
    }
  }
  return DEFAULT_LOCALE;
};

const getBrowserLocaleCandidates = (): string[] => {
  if (typeof navigator === "undefined") return [];
  const languages = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
  if (languages.length) return languages;
  return typeof navigator.language === "string" ? [navigator.language] : [];
};

const stringifyMessageValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const interpolateMessage = (template: string, values: Record<string, unknown> = {}) =>
  template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, key: string) => stringifyMessageValue(values[key]));

const isDevelopmentLike = () =>
  ["development", "test"].includes(
    ((import.meta as { env?: { MODE?: unknown } }).env?.MODE || "").toString().toLowerCase(),
  );

const createLocalizer = (locale?: string): Localizer => {
  const normalizedLocale = negotiateLocale([locale || ""]);
  const catalog = getCatalog(normalizedLocale);
  let pluralRules: Intl.PluralRules | undefined;
  const message: Localizer["message"] = (id, values) => {
    const template = catalog[id] || (MESSAGE_CATALOGS.en as PartialMessageCatalog)[id];
    if (!template) return isDevelopmentLike() ? `[[${id}]]` : String(id);
    return interpolateMessage(template, values);
  };
  return {
    formatBytes: (bytes) => formatBytes(bytes, normalizedLocale),
    formatCount: (count, unit) => formatCount(count, normalizedLocale, unit),
    formatDuration: (milliseconds) => formatDuration(milliseconds, normalizedLocale),
    formatList: (items) => formatList(items, normalizedLocale),
    locale: normalizedLocale,
    message,
    messageCount: (id, count, values) => {
      pluralRules ??= new Intl.PluralRules(normalizedLocale);
      const category = pluralRules.select(count);
      const pluralId = `${id}.${category}` as MessageId;
      const fallbackId = `${id}.other` as MessageId;
      const resolvedId =
        catalog[pluralId] || (MESSAGE_CATALOGS.en as PartialMessageCatalog)[pluralId] ? pluralId : fallbackId;
      return message(resolvedId, { ...values, count, n: count });
    },
  };
};

const createBrowserLocalizer = (locale?: string): Localizer =>
  createLocalizer(locale || negotiateLocale(getBrowserLocaleCandidates()));

export type { Localizer };
export { createBrowserLocalizer, createLocalizer, getBrowserLocaleCandidates, negotiateLocale };
