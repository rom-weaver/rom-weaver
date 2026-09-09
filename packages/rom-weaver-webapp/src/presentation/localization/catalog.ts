import type { Messages } from "@lingui/core";
import { messages as enMessages } from "./locales/en.ts";

type LocaleCode = string;

type MessageId = `candidate.${string}` | `error.${string}` | `settings.${string}` | `ui.${string}`;

const DEFAULT_LOCALE: LocaleCode = "en";

/*
 * The catalogs are the `lingui compile`d output of the `.po` files in
 * `./locales`; the English source-of-truth lives in `./messages.ts` (read by
 * `lingui extract`). Only English ships in the main bundle: it is the fallback
 * every other locale degrades to, so it is needed at first paint. Every other
 * catalog is its own chunk, fetched the first time its locale is resolved, so
 * a visitor pays for one language rather than all of them.
 */
const CATALOG_LOADERS: Record<LocaleCode, () => Promise<Messages>> = {
  de: () => import("./locales/de.ts").then((module) => module.messages),
  es: () => import("./locales/es.ts").then((module) => module.messages),
};

/** Catalogs available synchronously. English is present from module load. */
const MESSAGE_CATALOGS: Record<LocaleCode, Messages> = { [DEFAULT_LOCALE]: enMessages };

const SHIPPED_LOCALES: readonly LocaleCode[] = [DEFAULT_LOCALE, ...Object.keys(CATALOG_LOADERS)];

const isShippedLocale = (locale: string): boolean =>
  Object.hasOwn(MESSAGE_CATALOGS, locale) || Object.hasOwn(CATALOG_LOADERS, locale);

const isCatalogLoaded = (locale: LocaleCode): boolean => Object.hasOwn(MESSAGE_CATALOGS, locale);

const catalogLoads = new Map<LocaleCode, Promise<Messages>>();
const catalogListeners = new Set<() => void>();
let catalogVersion = 0;

/** Bumps once per catalog that lands; consumers re-read messages when it changes. */
const getCatalogVersion = (): number => catalogVersion;

const subscribeCatalogs = (listener: () => void): (() => void) => {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
};

/**
 * Resolves with the locale's messages, fetching its chunk once. A failed fetch
 * is forgotten so the next call retries; callers MUST treat a rejection as
 * "English for now", never as fatal. Locales that do not ship reject.
 */
const loadCatalog = (locale: LocaleCode): Promise<Messages> => {
  const loaded = MESSAGE_CATALOGS[locale];
  if (loaded) return Promise.resolve(loaded);
  const pending = catalogLoads.get(locale);
  if (pending) return pending;
  const loader = CATALOG_LOADERS[locale];
  if (!loader) return Promise.reject(new Error(`No message catalog ships for locale "${locale}"`));
  const load = loader().then(
    (messages) => {
      MESSAGE_CATALOGS[locale] = messages;
      catalogVersion += 1;
      for (const listener of catalogListeners) listener();
      return messages;
    },
    (error: unknown) => {
      catalogLoads.delete(locale);
      throw error;
    },
  );
  catalogLoads.set(locale, load);
  return load;
};

/** Endonyms for the shipped catalogs - a language is named in its own words. */
const LOCALE_LABELS: Record<LocaleCode, string> = {
  de: "Deutsch",
  en: "English",
  es: "Español",
};

// The default locale leads (it is the fallback every other catalog degrades to);
// the rest sort by code so the order is stable as catalogs are added.
const compareLocales = (left: LocaleCode, right: LocaleCode): number => {
  if (left === right) return 0;
  if (left === DEFAULT_LOCALE) return -1;
  if (right === DEFAULT_LOCALE) return 1;
  return left.localeCompare(right);
};

/**
 * The language picker's options, derived from the catalogs that actually ship.
 * Offering a locale without a catalog is offering English under another name -
 * every lookup falls through to `FALLBACK_MESSAGES` - so the list is generated
 * rather than hand-maintained and cannot drift into that state.
 */
const LOCALE_OPTIONS: readonly { label: string; value: LocaleCode }[] = [...SHIPPED_LOCALES]
  .sort(compareLocales)
  .map((value) => ({ label: LOCALE_LABELS[value] ?? value, value }));

export type { LocaleCode, MessageId };
export {
  DEFAULT_LOCALE,
  getCatalogVersion,
  isCatalogLoaded,
  isShippedLocale,
  loadCatalog,
  LOCALE_OPTIONS,
  MESSAGE_CATALOGS,
  SHIPPED_LOCALES,
  subscribeCatalogs,
};
