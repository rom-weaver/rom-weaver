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
 * Point a guide's `curl` samples at the deployment serving the page.
 *
 * The guides name the production site, which is what makes the Markdown read
 * correctly on GitHub and keeps the prerendered HTML - what a crawler or a
 * reader without JavaScript gets - pointing at a host that exists. But a reader
 * on beta, nightly, or a PR preview should download that deployment's sample
 * files: they are generated from the same commit as the page, and the digest
 * printed beside them is that commit's, so mixing the two is how somebody ends
 * up chasing a checksum that was never going to match.
 *
 * Links solve this by rewriting to a root-relative path at build time. Shell
 * samples cannot: `curl` needs an absolute URL, and the preview origin is not
 * knowable at build time anyway, since Cloudflare resolves it only once the
 * built bundle has been uploaded.
 *
 * Each sample name goes back through `resolveAssetUrl`, so a guide and the
 * button beside it resolve the same asset the same way, base semantics
 * included.
 *
 * Returns HTML rather than editing the DOM, because `dangerouslySetInnerHTML`
 * reasserts itself on later renders and silently undoes any patch applied
 * behind React's back.
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
