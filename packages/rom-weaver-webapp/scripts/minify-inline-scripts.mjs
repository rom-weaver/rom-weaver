import { minifySync } from "vite";
import { documentNodes, parseDocument, replaceSourceRanges } from "./html-document.mjs";

const EXECUTABLE_TYPES = new Set(["", "module", "text/javascript"]);

const isMinifiableScript = (node) => {
  if (node.attrs.some((attribute) => attribute.name === "src")) return false;
  const type = node.attrs.find((attribute) => attribute.name === "type")?.value ?? "";
  return EXECUTABLE_TYPES.has(type);
};

/**
 * Minify executable inline scripts; leave data scripts such as JSON-LD unchanged.
 *
 * @param {string} html
 * @param {string} label file name used in minifier diagnostics
 * @returns {string}
 */
export const minifyInlineScripts = (html, label = "document.html") => {
  const edits = [];
  for (const node of documentNodes(parseDocument(html))) {
    if (node.tagName !== "script" || !isMinifiableScript(node)) continue;
    const location = node.sourceCodeLocation;
    if (!location?.startTag) continue;
    const start = location.startTag.endOffset;
    const end = location.endTag?.startOffset ?? location.endOffset;
    const code = html.slice(start, end);
    if (!code) continue;
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
    edits.push({ start, end, text: minified });
  }
  return replaceSourceRanges(html, edits);
};
