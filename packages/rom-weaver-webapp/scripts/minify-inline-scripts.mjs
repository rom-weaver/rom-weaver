import { minifySync } from "vite";

// The inline scripts resolve the theme, the wall clock and the click buffer
// before the prerendered shell paints, so they cannot move to a cached asset -
// every route document carries the same ~9.7 kB of them, comments included.
// Those comments address a reader of this repository, not a browser: stripping
// them from the shipped bytes saves ~5.3 kB raw and ~1.5 kB brotli on every
// document, which is 12-18% of a route page's transfer. Vite re-exports
// rolldown's minifier, so this costs no new dependency.
//
// Vite minifies the bundled JavaScript and lightningcss minifies the CSS
// (including the inline `<style>` in index.html), so those are already minimal
// here. Nothing else in a built document is worth compressing: HTML comments
// total 64 bytes and two of them are React's hydration markers, and collapsing
// the remaining inter-tag whitespace measured at ~30 bytes brotli against the
// risk of eating a significant space between inline elements in prose.
const INLINE_SCRIPT = /<script([^>]*)>([\s\S]+?)<\/script>/g;
const SCRIPT_TYPE = /\btype\s*=\s*"([^"]*)"/;
// A classic script and a module both minify; anything else (`application/ld+json`
// above all) is data this must not rewrite.
const EXECUTABLE_TYPES = new Set(["", "module", "text/javascript"]);

/** @param {string} attributes */
const isMinifiableScript = (attributes) => {
  if (/\bsrc\s*=/.test(attributes)) return false;
  return EXECUTABLE_TYPES.has(SCRIPT_TYPE.exec(attributes)?.[1] ?? "");
};

/**
 * Strips comments and dead whitespace from every inline `<script>` of a built
 * HTML document.
 *
 * @param {string} html
 * @param {string} label file name used in minifier diagnostics
 * @returns {string}
 */
export const minifyInlineScripts = (html, label = "document.html") =>
  html.replace(INLINE_SCRIPT, (match, attributes, code) => {
    if (!isMinifiableScript(attributes)) return match;
    const result = minifySync(`${label}.inline.js`, code);
    if (result.errors?.length) {
      throw new Error(`${label}: inline script failed to minify: ${result.errors.map(String).join("; ")}`);
    }
    const minified = result.code.trim();
    // A minified string or regex literal that ends up holding `</script` would
    // close the tag early and turn the rest of the document into script source.
    if (/<\/script/i.test(minified)) {
      throw new Error(`${label}: minified inline script contains a literal "</script"`);
    }
    return `<script${attributes}>${minified}</script>`;
  });
