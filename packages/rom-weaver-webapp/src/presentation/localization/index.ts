import { type I18n, type Messages, setupI18n } from "@lingui/core";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatList,
  getByteUnitSystem,
  normalizeByteUnitSystem,
} from "../formatting/index.ts";
import {
  DEFAULT_LOCALE,
  getCatalogVersion,
  isShippedLocale,
  loadCatalog,
  LOCALE_OPTIONS,
  type LocaleCode,
  MESSAGE_CATALOGS,
  type MessageId,
  subscribeCatalogs,
} from "./catalog.ts";
import type { ByteUnitSystem } from "../../types/settings.ts";

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

const resolveCatalogLocale = (locale: LocaleCode): LocaleCode => {
  if (isShippedLocale(locale)) return locale;
  const base = baseLocale(locale);
  if (isShippedLocale(base)) return base;
  return DEFAULT_LOCALE;
};

const negotiateLocale = (locales: readonly string[] = []): LocaleCode => {
  for (const locale of locales) {
    const normalizedLocale = normalizeLocale(locale);
    if (isShippedLocale(normalizedLocale) || isShippedLocale(baseLocale(normalizedLocale))) {
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
 * Per-locale Lingui instances, cached. Each locale's table starts as a copy of
 * the English source, and its own catalog is merged over it: Lingui 6 resolves
 * ids only in the active locale's table, so this copy is what makes any gap
 * (which `lingui compile --strict` forbids at build time) degrade to English
 * rather than a raw id. A locale whose catalog is not in memory yet serves that
 * English copy while its chunk loads, then `load` merges the translations into
 * the same instance, so every `Localizer` built on it reads them from then on.
 * The UI consumes the `Localizer` facade below - not Lingui's
 * `<Trans>`/`useLingui` - so no `<I18nProvider>` is needed; `useUiLocalizer`
 * subscribes to catalog arrivals and re-renders.
 */
const i18nCache = new Map<LocaleCode, I18n>();

const getI18n = (catalogLocale: LocaleCode): I18n => {
  const cached = i18nCache.get(catalogLocale);
  if (cached) return cached;
  const localeMessages = MESSAGE_CATALOGS[catalogLocale];
  const i18n = setupI18n({
    locale: catalogLocale,
    messages: { [catalogLocale]: { ...FALLBACK_MESSAGES, ...localeMessages } },
  });
  i18nCache.set(catalogLocale, i18n);
  if (!localeMessages) {
    loadCatalog(catalogLocale).then(
      (messages) => i18n.load(catalogLocale, messages),
      () => undefined,
    );
  }
  return i18n;
};

/**
 * Fetches the catalog a locale resolves to, so a render after it settles is
 * translated on its first frame instead of flashing English. An empty locale
 * reads the browser's languages, as `createBrowserLocalizer` does. Resolves
 * even when the fetch fails: the localizer falls back to English on its own.
 */
const preloadCatalog = async (locale?: string): Promise<void> => {
  const catalogLocale = resolveCatalogLocale(negotiateLocale(locale ? [locale] : getBrowserLocaleCandidates()));
  await loadCatalog(catalogLocale).then(
    () => undefined,
    () => undefined,
  );
};

const createLocalizer = (locale?: string, byteUnitSystem?: ByteUnitSystem): Localizer => {
  const normalizedLocale = negotiateLocale([locale || ""]);
  const normalizedByteUnitSystem = normalizeByteUnitSystem(byteUnitSystem ?? getByteUnitSystem());
  const i18n = getI18n(resolveCatalogLocale(normalizedLocale));
  return {
    formatBytes: (bytes) => formatBytes(bytes, normalizedLocale, normalizedByteUnitSystem),
    formatCount: (count, unit) => formatCount(count, normalizedLocale, unit),
    formatDuration: (milliseconds) => formatDuration(milliseconds, normalizedLocale),
    formatList: (items) => formatList(items, normalizedLocale),
    locale: normalizedLocale,
    message: (id, values) => i18n._(id, values),
    messageCount: (id, count, values) => i18n._(id, { ...values, count, n: count }),
  };
};

const createBrowserLocalizer = (locale?: string, byteUnitSystem?: ByteUnitSystem): Localizer =>
  createLocalizer(locale || negotiateLocale(getBrowserLocaleCandidates()), byteUnitSystem);

export type { Localizer };
export {
  createBrowserLocalizer,
  createLocalizer,
  getBrowserLocaleCandidates,
  getCatalogVersion,
  LOCALE_OPTIONS,
  negotiateLocale,
  preloadCatalog,
  subscribeCatalogs,
};
