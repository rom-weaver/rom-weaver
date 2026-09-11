import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";

// Static icons MUST carry the channel accent without depending on the app's CSS.
const tintBrandMark = (svg, accent) => {
  const base = ACCENTS.find((entry) => entry.value === DEFAULT_ACCENT);
  if (!base) throw new Error(`brand marks: unknown default accent '${DEFAULT_ACCENT}'`);
  if (!svg.includes(base.swatch)) throw new Error("brand marks: source is missing the accent tab");
  return svg.replaceAll(base.swatch, accent.swatch);
};

export { tintBrandMark };
