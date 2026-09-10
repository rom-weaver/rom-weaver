import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";

/**
 * Re-dye the logo's accent band for the channel icon pipeline. The web masthead
 * no longer uses this: its mark is inlined and dyed by `--thread` in CSS, so a
 * per-accent image (and the prerender/hydrate `src` mismatch it caused) is gone.
 */
const tintBrandMark = (svg, accent) => {
  const base = ACCENTS.find((entry) => entry.value === DEFAULT_ACCENT);
  if (!base) throw new Error(`brand marks: unknown default accent '${DEFAULT_ACCENT}'`);
  if (!svg.includes(base.swatch)) throw new Error("brand marks: source is missing the accent band");
  return svg.replaceAll(base.swatch, accent.swatch);
};

export { tintBrandMark };
