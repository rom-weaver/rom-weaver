import { resolveAssetUrl } from "../public/react/asset-url.ts";
import { SAMPLE_URL_PATTERN, SITE_ORIGIN } from "./docs-routing.mjs";

/** The base the guides are authored against, and what the served document was rendered with. */
const AUTHORED_SAMPLE_BASE = `${SITE_ORIGIN}/`;

// Shell samples and links whose origin is exactly the production site. Prose
// is deliberately left alone: prose that names the domain means the project
// rather than the deployment being read. Rendered guides already turn
// production links into root-relative ones (docs-content.mjs), so the link pass
// is the backstop that also keeps a sub-path deployment on its own base.
const PRE_BLOCK = /<pre\b[^>]*>[\s\S]*?<\/pre>/g;
const SAMPLE_URL = SAMPLE_URL_PATTERN;

const ANCHOR_HREF = /(<a\b[^>]*?\shref=")([^"]*)(")/gi;

/** Resolve a production-origin href against the deployment base, or return null to leave it alone. */
const retargetHref = (href: string, base: string): string | null => {
  const decoded = href.replaceAll("&amp;", "&");
  // Parsed origins, never string prefixes: `rom-weaver.com.example` and
  // `rom-weaver.com@example.test` are different origins.
  if (!URL.canParse(decoded)) return null;
  const url = new URL(decoded);
  if (url.origin !== SITE_ORIGIN) return null;
  return new URL(`${url.pathname.slice(1)}${url.search}${url.hash}`, base).href.replaceAll("&", "&amp;");
};

/**
 * Use the current deployment for sample commands so downloaded files match the guide's build.
 * Return rewritten HTML for React to render; each asset uses the same base resolution as its download link.
 */
const retargetSampleUrls = (html: string, assetBaseUrl: string | undefined): string => {
  const base = assetBaseUrl?.trim();
  if (!base || base === AUTHORED_SAMPLE_BASE) return html;
  // A base `resolveAssetUrl` cannot parse makes it fall back to a root-absolute
  // path, which is no use to curl. Leave the published host instead.
  try {
    new URL(base);
  } catch {
    return html;
  }
  const withSamples = html.replace(PRE_BLOCK, (block) =>
    block.replace(SAMPLE_URL, (_match, name) => resolveAssetUrl(base, name)),
  );
  return withSamples.replace(ANCHOR_HREF, (match, open, href, close) => {
    const retargeted = retargetHref(href, base);
    return retargeted === null ? match : `${open}${retargeted}${close}`;
  });
};

const IMAGE_TAG = /<(?:img|source)\b[^>]*>/gi;
const IMAGE_URL_ATTRIBUTE = /(\b(?:src|srcset)=(["']))(.*?)(\2)/gi;
// A lone leading slash at the start of a URL candidate; `//host` is protocol-relative and stays.
const ROOT_PATH_PREFIX = /(^|[\s,])\/(?!\/)/g;

/**
 * Keep a sub-path deployment on its own prefix: guides link to sibling pages and tools
 * by root-absolute path (`/docs/faq`, `/apply-rom-patches`) and to screenshots by
 * `/docs/screenshots/...`, which would otherwise leave `appBaseUrl`. Protocol-relative,
 * fragment, query, and external URLs stay as authored.
 */
const rebaseRootUrls = (html: string, appBaseUrl: string): string => {
  const basePath = new URL(appBaseUrl, "https://app.invalid").pathname;
  if (basePath === "/") return html;
  const withLinks = html.replace(ANCHOR_HREF, (match, open, href, close) =>
    href.startsWith("/") && !href.startsWith("//") ? `${open}${basePath}${href.slice(1)}${close}` : match,
  );
  return withLinks.replace(IMAGE_TAG, (tag) =>
    tag.replace(
      IMAGE_URL_ATTRIBUTE,
      (_attribute, open, _quote, value, close) =>
        `${open}${value.replace(ROOT_PATH_PREFIX, (_prefix: string, lead: string) => `${lead}${basePath}`)}${close}`,
    ),
  );
};

export { AUTHORED_SAMPLE_BASE, rebaseRootUrls, retargetSampleUrls };
