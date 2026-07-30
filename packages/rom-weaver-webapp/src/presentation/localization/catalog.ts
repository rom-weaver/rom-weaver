import type { Messages } from "@lingui/core";
import { messages as deMessages } from "./locales/de.ts";
import { messages as enMessages } from "./locales/en.ts";
import { messages as esMessages } from "./locales/es.ts";

type LocaleCode = string;

type MessageId = `candidate.${string}` | `error.${string}` | `settings.${string}` | `ui.${string}`;

const DEFAULT_LOCALE: LocaleCode = "en";

/**
 * Runtime message catalogs, keyed by locale. These are the `lingui compile`d
 * output of the `.po` files in `./locales`; the English source-of-truth lives
 * in `./messages.ts` (read by `lingui extract`). Regenerate after editing
 * messages with `npm run i18n:extract && npm run i18n:compile`.
 */
const MESSAGE_CATALOGS: Record<LocaleCode, Messages> = {
  de: deMessages,
  en: enMessages,
  es: esMessages,
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
const LOCALE_OPTIONS: readonly { label: string; value: LocaleCode }[] = Object.keys(MESSAGE_CATALOGS)
  .sort(compareLocales)
  .map((value) => ({ label: LOCALE_LABELS[value] ?? value, value }));

export type { LocaleCode, MessageId };
export { DEFAULT_LOCALE, LOCALE_OPTIONS, MESSAGE_CATALOGS };
