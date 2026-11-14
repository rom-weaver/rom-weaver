/** Escapes `value` for HTML text and double-quoted attribute values. @param {unknown} value */
export const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Guide-derived text can contain `$`, which `String.replace` reads as a match
// reference in a replacement *string* - every substitution here goes through a
// replacer function so the content is inserted literally.
/** @param {string} html @param {RegExp} pattern @param {string} content */
export const replaceBetween = (html, pattern, content) =>
  html.replace(pattern, (_match, open, close) => `${open}${escapeHtml(content)}${close}`);

/** @param {string} html @param {string} attribute @param {string} name @param {string} content */
export const replaceMetaContent = (html, attribute, name, content) =>
  replaceBetween(html, new RegExp(`(<meta\\s+${attribute}="${name}"\\s+content=")[^"]*(")`), content);
