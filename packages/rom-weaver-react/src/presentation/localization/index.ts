import { type I18n, type Messages, setupI18n } from "@lingui/core";
import { formatBytes, formatCount, formatDuration, formatList } from "../formatting/index.ts";
import { DEFAULT_LOCALE, type LocaleCode, MESSAGE_CATALOGS, type MessageId } from "./catalog.ts";

type Localizer = {
  locale: LocaleCode;
  message: (id: MessageId, values?: Record<string, unknown>) => string;
  /** Plural-aware lookup: resolves the message's ICU `{count, plural, ...}` form. */
  messageCount: (id: MessageId, count: number, values?: Record<string, unknown>) => string;
  formatBytes: (bytes: number) => string;
  formatDuration: (milliseconds: number) => string;
  formatCount: (count: number, unit?: string) => string;
  formatList: (items: string[]) => string;
};

const FALLBACK_MESSAGES: Messages = MESSAGE_CATALOGS[DEFAULT_LOCALE] ?? {};

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

const baseLocale = (locale: LocaleCode): string => locale.split("-")[0] || "";

const hasCatalog = (locale: string): boolean => Object.hasOwn(MESSAGE_CATALOGS, locale);

const resolveCatalogLocale = (locale: LocaleCode): LocaleCode => {
  if (hasCatalog(locale)) return locale;
  const base = baseLocale(locale);
  if (hasCatalog(base)) return base;
  return DEFAULT_LOCALE;
};

const negotiateLocale = (locales: readonly string[] = []): LocaleCode => {
  for (const locale of locales) {
    const normalizedLocale = normalizeLocale(locale);
    if (hasCatalog(normalizedLocale) || hasCatalog(baseLocale(normalizedLocale))) {
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

/*
 * Per-locale Lingui instances, cached. Each loads its own compiled catalog plus
 * the English source as a fallback so any gap (which `lingui compile --strict`
 * forbids at build time) degrades to English rather than showing a raw id. The
 * UI consumes the `Localizer` facade below — not Lingui's `<Trans>`/`useLingui`
 * — so no `<I18nProvider>` is needed; `useUiLocalizer`'s memo on the language
 * setting already re-renders consumers on a locale switch.
 */
const i18nCache = new Map<LocaleCode, I18n>();

const getI18n = (catalogLocale: LocaleCode): I18n => {
  const cached = i18nCache.get(catalogLocale);
  if (cached) return cached;
  const localeMessages = MESSAGE_CATALOGS[catalogLocale] ?? FALLBACK_MESSAGES;
  const i18n = setupI18n({
    locale: catalogLocale,
    messages: { [DEFAULT_LOCALE]: FALLBACK_MESSAGES, [catalogLocale]: localeMessages },
    ...(catalogLocale === DEFAULT_LOCALE ? {} : { fallbackLocales: { [catalogLocale]: DEFAULT_LOCALE } }),
  });
  i18nCache.set(catalogLocale, i18n);
  return i18n;
};

const createLocalizer = (locale?: string): Localizer => {
  const normalizedLocale = negotiateLocale([locale || ""]);
  const i18n = getI18n(resolveCatalogLocale(normalizedLocale));
  return {
    formatBytes: (bytes) => formatBytes(bytes, normalizedLocale),
    formatCount: (count, unit) => formatCount(count, normalizedLocale, unit),
    formatDuration: (milliseconds) => formatDuration(milliseconds, normalizedLocale),
    formatList: (items) => formatList(items, normalizedLocale),
    locale: normalizedLocale,
    message: (id, values) => i18n._(id, values),
    messageCount: (id, count, values) => i18n._(id, { ...values, count, n: count }),
  };
};

const createBrowserLocalizer = (locale?: string): Localizer =>
  createLocalizer(locale || negotiateLocale(getBrowserLocaleCandidates()));

export type { Localizer };
export { createBrowserLocalizer, createLocalizer, getBrowserLocaleCandidates, negotiateLocale };
