import { ACCENTS, DEFAULT_ACCENT } from "./accent-palette.mjs";

/** @typedef {"responsive" | "light" | "dark"} BrandMarkTone */

/** @type {readonly ("light" | "dark")[]} */
const BRAND_MARK_TONES = Object.freeze(["dark", "light"]);
const BRAND_MARK_VIEWBOX = "0 0 64 64";
const BRAND_MARK_TIGHT_VIEWBOX = "8 4 48 56";
/** @type {Readonly<Record<"light" | "dark", string>>} */
const BRAND_MARK_TONE_COLORS = Object.freeze({ dark: "#20282d", light: "#f6ecda" });

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
 * Apply a logo tone and accent to the colorless brand-mark master.
 *
 * The responsive tone is for the public favicon and keeps the two browser
 * color schemes in one SVG. Explicit tones are used for static outputs.
 *
 * @param {string} svg
 * @param {{ accent?: string | { value: string }, tone?: BrandMarkTone, viewBox?: string }} [options]
 */
const renderBrandMark = (svg, { accent = DEFAULT_ACCENT, tone = "responsive", viewBox = BRAND_MARK_VIEWBOX } = {}) => {
  assertBrandMarkMaster(svg);
  const resolvedAccent = resolveAccent(accent);
  if (tone !== "responsive" && !BRAND_MARK_TONES.includes(tone)) {
    throw new Error(`brand marks: unknown tone '${tone}'`);
  }
  const cartridge = tone === "responsive" ? "var(--brand-cartridge)" : BRAND_MARK_TONE_COLORS[tone];
  const style =
    tone === "responsive"
      ? `<style>.brand-mark { --brand-cartridge: ${BRAND_MARK_TONE_COLORS.dark}; } @media (prefers-color-scheme: dark) { .brand-mark { --brand-cartridge: ${BRAND_MARK_TONE_COLORS.light}; } }</style>`
      : "";
  let rendered = svg.replace(/(<svg\b[^>]*)(>)/, '$1 class="brand-mark"$2');
  rendered = rendered.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}"`);
  rendered = replacePathFill(rendered, "brand-mark-cartridge", cartridge);
  rendered = replacePathFill(rendered, "brand-mark-accent", resolvedAccent.swatch);
  return rendered.replace("</svg>", `${style}</svg>`);
};

/**
 * Fill a square favicon viewport without clipping the cartridge geometry.
 * The mark is narrower than it is tall, so the favicon MUST scale each axis
 * independently to touch all four edges.
 *
 * @param {string} svg
 * @param {{ accent?: string | { value: string }, tone?: BrandMarkTone }} [options]
 */
const renderFavicon = (svg, options) =>
  renderBrandMark(svg, { ...options, viewBox: BRAND_MARK_TIGHT_VIEWBOX }).replace(
    "<svg ",
    '<svg width="64" height="64" preserveAspectRatio="none" ',
  );

export { BRAND_MARK_TIGHT_VIEWBOX, BRAND_MARK_TONE_COLORS, BRAND_MARK_TONES, renderBrandMark, renderFavicon };
