/**
 * The dye lots, in the settings picker's order. Source of truth for the
 * `--thread` / `--thread-hi` literals in design-system/accent-values.css
 * (generated from this module and checked by tests/unit/accent-palette.test.ts).
 *
 * Plain data in an .mjs (rather than accent.ts) so build tooling can import
 * the palette without a TypeScript loader; accent.ts re-exports it for the app.
 *
 * Highlights MUST stay lighter than the swatches so the loom bands and
 * progress shuttle remain distinct.
 */

/** @typedef {"madder" | "woad" | "violet" | "verdigris" | "teal" | "plum"} Accent */
/**
 * @typedef {{
 *   highlight: string,
 *   label: string,
 *   swatch: string,
 *   threadInk: string,
 *   threadTextDark: string,
 *   threadTextLight: string,
 *   value: Accent,
 * }} AccentDefinition
 */

/** @type {readonly AccentDefinition[]} */
const ACCENTS = Object.freeze([
  Object.freeze({
    highlight: "#fccb90",
    label: "Madder",
    swatch: "#e87208",
    threadInk: "#1c1206",
    threadTextDark: "#f08439",
    threadTextLight: "#954600",
    value: "madder",
  }),
  Object.freeze({
    highlight: "#c5cbf6",
    label: "Woad",
    swatch: "#747bfa",
    threadInk: "#0b1030",
    threadTextDark: "#9ba6ff",
    threadTextLight: "#4947c3",
    value: "woad",
  }),
  Object.freeze({
    highlight: "#d7c3f3",
    label: "Violet",
    swatch: "#a45bea",
    threadInk: "#0b0516",
    threadTextDark: "#caa2fb",
    threadTextLight: "#773aae",
    value: "violet",
  }),
  Object.freeze({
    highlight: "#aee1c6",
    label: "Verdigris",
    swatch: "#149c46",
    threadInk: "#020c07",
    threadTextDark: "#71c582",
    threadTextLight: "#296a39",
    value: "verdigris",
  }),
  Object.freeze({
    highlight: "#9fe2e7",
    label: "Teal",
    swatch: "#009ba5",
    threadInk: "#020c0d",
    threadTextDark: "#45c3cd",
    threadTextLight: "#066970",
    value: "teal",
  }),
  Object.freeze({
    highlight: "#eac1db",
    label: "Plum",
    swatch: "#d548a0",
    threadInk: "#10020c",
    threadTextDark: "#e68abe",
    threadTextLight: "#a12876",
    value: "plum",
  }),
]);

/** @type {Accent} */
const DEFAULT_ACCENT = "madder";

export { ACCENTS, DEFAULT_ACCENT };
