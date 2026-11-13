/** Escapes `value` for HTML text and double-quoted attribute values. @param {unknown} value */
export const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
