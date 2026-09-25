import fs from "node:fs";
import path from "node:path";
import { API_CATALOG_CONTENT_TYPE, API_CATALOG_PATH } from "../../src/webapp/api-catalog.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";
import { rootDir } from "./paths.mjs";

// SharedArrayBuffer (the wasm thread pool) needs a cross-origin isolated page: COOP/COEP on the
// document and COEP on every dedicated-worker script, so these apply to every response. Also the
// source for the deployed _headers file - see writeCloudflareHeadersAsset.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
export const securityHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  ...crossOriginIsolationHeaders,
  Expires: "0",
  Pragma: "no-cache",
};

// Emit isolation headers for Pages' static responses; Functions set their own.
// Hosts without header control use the service worker's isolation fallback.
export const writeCloudflareHeadersAsset = (channel) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const headers = {
        ...crossOriginIsolationHeaders,
        // Deploys replace the whole asset set, so HTML held past a redeploy
        // references hashed URLs that now 404 - force revalidation on every
        // document load. The service worker script needs the same treatment and
        // inherits it from here; only /assets/* detaches it below.
        "Cache-Control": "no-cache",
        "Content-Signal": `ai-train=no, search=${channel === "prod" ? "yes" : "no"}, ai-input=yes`,
        ...(channel === "prod" ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
      };
      const distDir = path.resolve(rootDir, outDir);
      const outputPath = path.join(distDir, "_headers");
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join("\n");
      // The attribution files are named `LICENSE-APACHE`, `COPYING`, `NOTICE`
      // and so on. With no extension Cloudflare types them as a binary
      // download, which both skips its on-the-fly compression (2.1 MB of text
      // over the wire) and makes a browser download rather than display them.
      const licenseContentType =
        "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8\n\n/NOTICE\n  Content-Type: text/plain; charset=utf-8\n\n/WEBAPP_NOTICE\n  Content-Type: text/plain; charset=utf-8\n";
      const installerContentType = "/install.sh\n  Content-Type: text/plain; charset=utf-8\n";
      // The catalog file has no extension, so Cloudflare would serve it as a
      // binary download. The Link header satisfies the RFC 9727 HEAD response.
      const apiCatalogHeaders = `${API_CATALOG_PATH}\n  Content-Type: ${API_CATALOG_CONTENT_TYPE}\n  Link: <${API_CATALOG_PATH}>; rel="api-catalog"\n\n`;
      const markdownHeaders = DOC_SOURCES.map(
        ({ slug }) =>
          `/${slug}.md\n  Content-Type: text/markdown; charset=utf-8\n  Link: <https://rom-weaver.com/${slug}>; rel="canonical"\n`,
      ).join("\n");
      fs.writeFileSync(
        outputPath,
        `/*\n${headerLines}\n  ! Link\n\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n\n${licenseContentType}\n${installerContentType}\n${apiCatalogHeaders}${markdownHeaders}`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-cloudflare-headers-asset",
  };
};
