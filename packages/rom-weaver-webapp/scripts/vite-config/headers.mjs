import fs from "node:fs";
import path from "node:path";
import {
  API_CATALOG_CONTENT_TYPE,
  API_CATALOG_PATH,
  OPENAPI_PATH,
  WEBAPP_URL_SESSION_DOC_PATH,
} from "../../src/webapp/api-catalog.mjs";
import { MARKDOWN_ROUTES } from "../../functions/markdown-routes.js";
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
        "Content-Signal": `ai-train=${channel === "prod" ? "yes" : "no"}, search=${channel === "prod" ? "yes" : "no"}, ai-input=${channel === "prod" ? "yes" : "no"}`,
        ...(channel === "prod" ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
      };
      const distDir = path.resolve(rootDir, outDir);
      const outputPath = path.join(distDir, "_headers");
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join("\n");
      // Prod only: other channels get `noindex, nofollow` from `/*`. robots.txt
      // MUST NOT block these paths, or crawlers never see the noindex.
      const noindex = channel === "prod" ? "  X-Robots-Tag: noindex\n" : "";
      // The attribution files are named `LICENSE-APACHE`, `COPYING`, `NOTICE`
      // and so on. With no extension Cloudflare types them as a binary
      // download, which both skips its on-the-fly compression (2.1 MB of text
      // over the wire) and makes a browser download rather than display them.
      const licenseHeaders = `/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8\n${noindex}\n/NOTICE\n  Content-Type: text/plain; charset=utf-8\n${noindex}\n/WEBAPP_NOTICE\n  Content-Type: text/plain; charset=utf-8\n${noindex}`;
      const installerContentType = "/install.sh\n  Content-Type: text/plain; charset=utf-8\n";
      // The catalog file has no extension, so Cloudflare would serve it as a
      // binary download. The Link header satisfies the RFC 9727 HEAD response.
      const apiCatalogHeaders = `${API_CATALOG_PATH}\n  Content-Type: ${API_CATALOG_CONTENT_TYPE}\n  Link: <${API_CATALOG_PATH}>; rel="api-catalog"\n\n`;
      const discoveryLinks = [
        `<${API_CATALOG_PATH}>; rel="api-catalog"`,
        `<${OPENAPI_PATH}>; rel="service-desc"; type="application/json"`,
        `<${WEBAPP_URL_SESSION_DOC_PATH}>; rel="service-doc"; type="text/html"`,
        '</llms.txt>; rel="describedby"; type="text/plain"',
      ].join(", ");
      // Pages applies at most 100 rules, so the middleware sends the other workflow
      // pages' Markdown alternate Link; sws.toml mirrors this homepage rule.
      const homeDiscoveryHeaders = `/\n  Link: ${discoveryLinks}, </index.md>; rel="alternate"; type="text/markdown"\n`;
      // Exact rules, not `:page` placeholders: a placeholder also matches missing
      // Markdown URLs and would serve their HTML 404 page as text/markdown.
      const authMarkdownHeaders = `/auth.md\n  Content-Type: text/markdown; charset=utf-8\n${noindex}\n`;
      // Docs pages share one wildcard, so a new page adds no rule.
      // Missing docs Markdown URLs also return a text/markdown 404.
      const markdownPatterns = [
        ...MARKDOWN_ROUTES.map(({ markdownPath }) => markdownPath).filter(
          (markdownPath) => !markdownPath.startsWith("/docs/"),
        ),
        "/docs/*.md",
      ];
      // No canonical Link here: noindex plus a canonical pointing at the HTML page risks the
      // noindex being applied to, or cancelled for, the page that must stay indexed.
      const markdownHeaders = markdownPatterns
        .map((pattern) => `${pattern}\n  Content-Type: text/markdown; charset=utf-8\n${noindex}`)
        .join("\n");
      // The Markdown copies and JSON schemas stay fetchable for LLMs and tools but out of
      // search results. The Markdown rules above carry their noindex, which keeps
      // _headers within Pages' 100-rule cap; one wildcard covers the schemas.
      const noindexHeaders = channel === "prod" ? "\n/*.schema.json\n  X-Robots-Tag: noindex\n" : "";
      fs.writeFileSync(
        outputPath,
        `/*\n${headerLines}\n  ! Link\n\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n\n${licenseHeaders}\n${installerContentType}\n${homeDiscoveryHeaders}\n${apiCatalogHeaders}${authMarkdownHeaders}${markdownHeaders}${noindexHeaders}`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-cloudflare-headers-asset",
  };
};
