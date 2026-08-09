const URL_TOKEN_PATTERN = /[a-z][a-z0-9+.-]*:[^\s<>'"`]+/gi;
const URL_TRAILING_PUNCTUATION = /[),.;!?]+$/;
const SAFE_URL_SCHEMES = new Set(["file:", "http:", "https:"]);

/** Keep URL diagnostics useful without exposing credentials, queries, or rejected URL payloads. */
const sanitizeUrlText = (value: unknown): string => {
  const text = String(value ?? "");
  return text.replace(URL_TOKEN_PATTERN, (match) => {
    const trailing = match.match(URL_TRAILING_PUNCTUATION)?.[0] || "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    if (/^[a-z]:[\\/]/i.test(candidate)) return match;
    const scheme = candidate.match(/^[a-z][a-z0-9+.-]*:/i)?.[0].toLowerCase();
    if (!(scheme && SAFE_URL_SCHEMES.has(scheme))) return `[redacted URL]${trailing}`;
    if ((scheme === "http:" || scheme === "https:") && !/^https?:\/\/[^/]+/i.test(candidate))
      return `[redacted URL]${trailing}`;
    try {
      const url = new URL(candidate);
      const prefix = scheme === "file:" ? "file://" : url.origin;
      if (!prefix || (scheme !== "file:" && url.origin === "null")) return `[redacted URL]${trailing}`;
      const redacted = `${prefix}${url.pathname}${url.search ? "?…" : ""}`;
      return `${redacted}${trailing}`;
    } catch {
      return `[redacted URL]${trailing}`;
    }
  });
};

export { sanitizeUrlText };
