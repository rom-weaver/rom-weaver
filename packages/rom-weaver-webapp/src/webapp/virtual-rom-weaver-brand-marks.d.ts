declare module "virtual:rom-weaver-brand-marks" {
  /**
   * Pre-tinted masthead logo URLs keyed by accent value, emitted by
   * scripts/brand-mark-assets.mjs. Relative to the document (`./assets/...`),
   * like every other built asset reference.
   */
  export const BRAND_MARK_SRC: Readonly<Record<string, string>>;
}
