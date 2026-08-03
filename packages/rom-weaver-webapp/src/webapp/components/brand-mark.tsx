import { BRAND_MARK_SRC } from "virtual:rom-weaver-brand-marks";
import { DEFAULT_ACCENT, useAccent } from "../accent.ts";

/**
 * The masthead logo, re-dyed to match the active accent.
 *
 * An `<img src="logo.svg">` is a separate document, so CSS could never reach
 * inside it and the mark stayed madder-orange in every dye lot. One tinted SVG
 * per accent is emitted at build time instead (scripts/brand-mark-assets.mjs),
 * so the mark follows the accent without the client carrying the SVG text and
 * the tinting code.
 *
 * `alt=""`: the brand word beside the mark already reads "rom-weaver", so a
 * second announcement of the same name is noise.
 */
const BrandMark = () => {
  const accent = useAccent();
  const src = BRAND_MARK_SRC[accent] ?? BRAND_MARK_SRC[DEFAULT_ACCENT];
  return <img alt="" className="brand-mark" height={44} src={src} width={44} />;
};

export { BrandMark };
