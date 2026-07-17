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

export type { LocaleCode, MessageId };
export { DEFAULT_LOCALE, MESSAGE_CATALOGS };
