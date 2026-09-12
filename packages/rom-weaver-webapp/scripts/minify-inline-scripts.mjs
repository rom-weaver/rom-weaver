import { minifySync } from "vite";

// Parser-time scripts stay inline so the shell can use their state before the
// module bundle runs. Minify them after rendering without changing HTML whitespace.
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
 * Minify executable inline scripts; leave data scripts such as JSON-LD unchanged.
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
    // A literal `</script` closes the HTML element even inside a JavaScript string.
    // Reject it so the remaining source cannot become HTML markup.
    if (/<\/script/i.test(minified)) {
      throw new Error(`${label}: minified inline script contains a literal "</script"`);
    }
    return `<script${attributes}>${minified}</script>`;
  });
