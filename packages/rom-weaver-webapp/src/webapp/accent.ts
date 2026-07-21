import { createLogger } from "../lib/logging.ts";

/**
 * Accent dye lots. The accent is the second theme axis alongside dark/light:
 * it re-dyes the `--thread` tokens (design-system/accents.css) without touching
 * chassis, plate or ink. Madder is the baseline defined in tokens.css.
 *
 * The active accent is reflected on `<html data-accent>`; madder clears the
 * attribute so the untouched tokens.css values apply. The value itself lives in
 * the settings store (`accent` field) - this module only owns the vocabulary
 * and the DOM application.
 */

const logger = createLogger("accent");

/** Value order is the settings picker's order. */
const ACCENTS = [
  { label: "Madder", swatch: "#d9690f", value: "madder" },
  { label: "Woad", swatch: "#6d7ce8", value: "woad" },
  { label: "Violet", swatch: "#9a6ae0", value: "violet" },
  { label: "Verdigris", swatch: "#3faa72", value: "verdigris" },
  { label: "Teal", swatch: "#2aa0a8", value: "teal" },
  { label: "Plum", swatch: "#cb63a5", value: "plum" },
] as const;

type Accent = (typeof ACCENTS)[number]["value"];

const DEFAULT_ACCENT: Accent = "madder";
const ACCENT_VALUES: readonly string[] = ACCENTS.map((accent) => accent.value);

const isAccent = (value: unknown): value is Accent => typeof value === "string" && ACCENT_VALUES.includes(value);

/**
 * Reflect the accent on the document root. Unknown values fall back to the
 * baseline rather than leaving a stale dye on the element.
 */
const applyAccent = (value: unknown) => {
  if (typeof document === "undefined" || !document.documentElement) return;
  const accent = isAccent(value) ? value : DEFAULT_ACCENT;
  if (accent === DEFAULT_ACCENT) document.documentElement.removeAttribute("data-accent");
  else document.documentElement.setAttribute("data-accent", accent);
  logger.trace("Applied accent", { accent, requested: value });
};

export { ACCENTS, applyAccent };
export type { Accent };
