/**
 * The webapp's URL API: `?bundle=<url>` points at a rom-weaver-bundle.json (plain,
 * compressed, or an archive carrying one), while `?rom=<url>` plus repeatable
 * `?patch=<url>` params describe a session directly. `bundle` wins when both
 * are present. Parsed once at boot; the params stay in the address bar so the
 * session URL remains shareable.
 */

type UrlSessionRequest =
  | { kind: "bundle"; bundleUrl: string }
  | { kind: "direct"; romUrl: string | null; patchUrls: string[] };

type UrlSessionParseResult = {
  request: UrlSessionRequest | null;
  /** Non-fatal problems (bad scheme, unparseable URL, ignored params). */
  warnings: string[];
};

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function resolveSessionUrl(raw: string, baseHref: string, label: string, warnings: string[]): string | null {
  const value = raw.trim();
  if (!value) return null;
  let resolved: URL;
  try {
    resolved = new URL(value, baseHref);
  } catch {
    warnings.push(`${label} URL is not parseable: ${value}`);
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) {
    warnings.push(`${label} URL must use http(s): ${value}`);
    return null;
  }
  return resolved.toString();
}

function readUrlSessionRequest(search: string, baseHref: string): UrlSessionParseResult {
  const warnings: string[] = [];
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { request: null, warnings };
  }
  const bundleRaw = params.get("bundle");
  const romRaw = params.get("rom");
  const patchRaws = params.getAll("patch");

  if (bundleRaw !== null) {
    if (romRaw !== null || patchRaws.length > 0) {
      warnings.push("bundle= takes precedence; rom=/patch= params are ignored");
    }
    const bundleUrl = resolveSessionUrl(bundleRaw, baseHref, "bundle", warnings);
    return { request: bundleUrl ? { bundleUrl, kind: "bundle" } : null, warnings };
  }

  if (romRaw === null && patchRaws.length === 0) {
    return { request: null, warnings };
  }
  const romUrl = romRaw === null ? null : resolveSessionUrl(romRaw, baseHref, "rom", warnings);
  const patchUrls = patchRaws
    .map((raw) => resolveSessionUrl(raw, baseHref, "patch", warnings))
    .filter((url): url is string => url !== null);
  if (!romUrl && patchUrls.length === 0) {
    return { request: null, warnings };
  }
  return { request: { kind: "direct", patchUrls, romUrl }, warnings };
}

export type { UrlSessionParseResult, UrlSessionRequest };
export { readUrlSessionRequest };
