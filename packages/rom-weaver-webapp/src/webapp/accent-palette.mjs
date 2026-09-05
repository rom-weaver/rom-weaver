/**
 * The dye lots, in the settings picker's order. Source of truth for the
 * `--thread` / `--thread-hi` literals in design-system/accents.css (asserted by
 * tests/unit/accent-palette.test.ts), for the per-channel app icons that
 * scripts/generate-channel-icons.mjs rasterizes, and for the pre-tinted brand
 * marks scripts/brand-mark-assets.mjs emits.
 *
 * Plain data in an .mjs (rather than accent.ts) so build tooling can import
 * the palette without a TypeScript loader; accent.ts re-exports it for the app.
 *
 * `highlight` is the light accent fill: hue and saturation of the swatch at
 * `l + (100 - l) * 0.6`. Madder keeps the hand-picked value it has always
 * shipped (the rule would land 4 points off) so the stock mark is unchanged.
 */

/** @typedef {"madder" | "woad" | "violet" | "verdigris" | "teal" | "plum"} Accent */
/** @typedef {{ highlight: string, label: string, swatch: string, value: Accent }} AccentDefinition */

/** @type {readonly AccentDefinition[]} */
const ACCENTS = Object.freeze([
  Object.freeze({ highlight: "#fccb90", label: "Madder", swatch: "#d9690f", value: "madder" }),
  Object.freeze({ highlight: "#c5cbf6", label: "Woad", swatch: "#6d7ce8", value: "woad" }),
  Object.freeze({ highlight: "#d7c3f3", label: "Violet", swatch: "#9a6ae0", value: "violet" }),
  Object.freeze({ highlight: "#aee1c6", label: "Verdigris", swatch: "#3faa72", value: "verdigris" }),
  Object.freeze({ highlight: "#9fe2e7", label: "Teal", swatch: "#2aa0a8", value: "teal" }),
  Object.freeze({ highlight: "#eac1db", label: "Plum", swatch: "#cb63a5", value: "plum" }),
]);

/** @type {Accent} */
const DEFAULT_ACCENT = "madder";

export { ACCENTS, DEFAULT_ACCENT };
