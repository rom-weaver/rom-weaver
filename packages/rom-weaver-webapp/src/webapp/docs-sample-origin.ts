import { resolveAssetUrl } from "../public/react/asset-url.ts";
import { SITE_ORIGIN } from "./docs-routing.mjs";

/** The base the guides are authored against, and what the served document was rendered with. */
const AUTHORED_SAMPLE_BASE = `${SITE_ORIGIN}/`;

// Only the shell samples. Prose and links are deliberately left alone: the
// links are already root-relative, and prose that names the domain means the
// project rather than the deployment being read.
const PRE_BLOCK = /<pre\b[^>]*>[\s\S]*?<\/pre>/g;
const SAMPLE_URL = new RegExp(`${SITE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9._-]+)`, "g");

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
  return html.replace(PRE_BLOCK, (block) => block.replace(SAMPLE_URL, (_match, name) => resolveAssetUrl(base, name)));
};

export { AUTHORED_SAMPLE_BASE, retargetSampleUrls };
