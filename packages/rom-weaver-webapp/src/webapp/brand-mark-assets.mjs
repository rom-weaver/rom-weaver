import { ACCENTS, DEFAULT_ACCENT } from "./accent-palette.mjs";

/** @typedef {"responsive" | "light" | "dark"} BrandMarkTheme */

/** @type {readonly ("light" | "dark")[]} */
const BRAND_MARK_THEMES = Object.freeze(["light", "dark"]);
const BRAND_MARK_VIEWBOX = "0 0 64 64";
const BRAND_MARK_TIGHT_VIEWBOX = "8 4 48 56";
/** @type {Readonly<Record<"light" | "dark", string>>} */
const BRAND_MARK_COLORS = Object.freeze({ light: "#20282d", dark: "#f6ecda" });

/** @param {string | { value: string }} accent */
const resolveAccent = (accent) => {
  const value = typeof accent === "string" ? accent : accent?.value;
  const resolved = ACCENTS.find((entry) => entry.value === value);
  if (!resolved) throw new Error(`brand marks: unknown accent '${value ?? ""}'`);
  return resolved;
};

/** @param {string} svg */
const assertBrandMarkMaster = (svg) => {
  for (const part of ["cartridge", "accent"]) {
    if (!svg.includes(`class="brand-mark-${part}"`)) {
      throw new Error(`brand marks: source is missing the ${part} shape`);
    }
  }
};

/** @param {string} svg @param {string} className @param {string} fill */
const replacePathFill = (svg, className, fill) => {
  const pattern = new RegExp(`(<path\\s+class="${className}"[^>]*\\s)fill="[^"]*"`);
  if (!pattern.test(svg)) throw new Error(`brand marks: source is missing the ${className} fill`);
  return svg.replace(pattern, `$1fill="${fill}"`);
};

/**
 * Apply a theme and accent to the colorless brand-mark master.
 *
 * The responsive theme is for the public favicon and keeps the two browser
 * color schemes in one SVG. Explicit themes are used for rasterized outputs.
 *
 * @param {string} svg
 * @param {{ accent?: string | { value: string }, theme?: BrandMarkTheme, viewBox?: string }} [options]
 */
const renderBrandMark = (svg, { accent = DEFAULT_ACCENT, theme = "responsive", viewBox = BRAND_MARK_VIEWBOX } = {}) => {
  assertBrandMarkMaster(svg);
  const resolvedAccent = resolveAccent(accent);
  if (theme !== "responsive" && !BRAND_MARK_THEMES.includes(theme)) {
    throw new Error(`brand marks: unknown theme '${theme}'`);
  }
  const cartridge = theme === "responsive" ? "var(--brand-cartridge)" : BRAND_MARK_COLORS[theme];
  const style =
    theme === "responsive"
      ? `<style>.brand-mark { --brand-cartridge: ${BRAND_MARK_COLORS.light}; } @media (prefers-color-scheme: dark) { .brand-mark { --brand-cartridge: ${BRAND_MARK_COLORS.dark}; } }</style>`
      : "";
  let rendered = svg.replace(/(<svg\b[^>]*)(>)/, '$1 class="brand-mark"$2');
  rendered = rendered.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`);
  rendered = replacePathFill(rendered, "brand-mark-cartridge", cartridge);
  rendered = replacePathFill(rendered, "brand-mark-accent", resolvedAccent.swatch);
  return rendered.replace("</svg>", `${style}</svg>`);
};

export { BRAND_MARK_COLORS, BRAND_MARK_THEMES, BRAND_MARK_TIGHT_VIEWBOX, renderBrandMark };
