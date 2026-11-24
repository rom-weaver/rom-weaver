import { SITE_ORIGIN } from "../src/webapp/docs-routing.mjs";
import { PRECACHE_REQUEST_HEADER } from "../src/webapp/pwa/precache-request-header.mjs";
import { MARKDOWN_ROUTES } from "./markdown-routes.js";

const mergeVary = (existing, ...tokens) => {
  const vary = new Set(
    (existing ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const token of tokens) vary.add(token);
  return [...vary].join(", ");
};

const wantsMarkdown = (accept) => {
  const ranges = accept
    .toLowerCase()
    .split(",")
    .map((item) => {
      const [type, ...parameters] = item.trim().split(";");
      const parameter = parameters.find((value) => value.trim().startsWith("q="));
      const raw = parameter?.trim().slice(2) ?? "1";
      const quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
      return { type: type.trim(), quality };
    });
  const markdown = ranges.find(({ type }) => type === "text/markdown")?.quality ?? 0;
  const html =
    ranges.find(({ type }) => type === "text/html")?.quality ??
    ranges.find(({ type }) => type === "text/*")?.quality ??
    ranges.find(({ type }) => type === "*/*")?.quality ??
    0;
  return markdown > 0 && markdown >= html;
};

const handleTrailingSlash = async (request, url, next) => {
  if (url.pathname.length <= 1 || !url.pathname.endsWith("/")) return null;
  const canonicalRoute = MARKDOWN_ROUTES.find(({ path }) => path === url.pathname.slice(0, -1));
  if (!canonicalRoute) return null;
  if (request.headers.get(PRECACHE_REQUEST_HEADER) !== "1") {
    // Canonicalize trailing-slash duplicates to the extensionless URL while keeping
    // precache directory fetches working below. Location stays relative so previews keep their host.
    return new Response(null, {
      status: 301,
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
        Location: `${canonicalRoute.path}${url.search}`,
        Vary: PRECACHE_REQUEST_HEADER,
      },
    });
  }
  const response = await next();
  const headers = new Headers(response.headers);
  // The offline copy stores and serves this header, so it must not block the back/forward cache.
  headers.set("Cache-Control", "no-cache");
  headers.set("Vary", mergeVary(headers.get("Vary"), PRECACHE_REQUEST_HEADER));
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const fetchMarkdownTwin = async (request, url, route, env) => {
  const assetUrl = new URL(route.markdownPath, url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
  const contentType = response.headers.get("Content-Type") ?? "";
  return response.ok && contentType.startsWith("text/markdown") ? response : null;
};

const applyNegotiatedHeaders = (response, url, route, markdown) => {
  const headers = new Headers(response.headers);
  // The `.md` rule's noindex belongs to the /<page>.md URL. This response is the page URL
  // itself, so drop it; the non-production `noindex, nofollow` from the `/*` rule stays.
  if (markdown && headers.get("X-Robots-Tag") === "noindex") headers.delete("X-Robots-Tag");
  // _headers stays under Pages' 100-rule cap by leaving these page Links to the middleware.
  if (!markdown && response.ok && route.alternateLink) {
    headers.append("Link", `<${route.markdownPath}>; rel="alternate"; type="text/markdown"`);
  }
  // A query string never names a different page (`?guide=weave` opens a guide on the
  // same document), so say so in the header too, for crawlers that read it before the HTML.
  if (!markdown && response.ok && url.search) {
    headers.append("Link", `<${SITE_ORIGIN}${route.path}>; rel="canonical"`);
  }
  headers.set("Vary", mergeVary(headers.get("Vary"), "Accept"));
  // Stable URLs MUST expire even if a deployment purge fails.
  const cacheable = response.status === 200 && !url.search && !headers.has("Set-Cookie");
  headers.set("Cache-Control", cacheable ? "public, max-age=0, s-maxage=3600, must-revalidate" : "no-store");
  headers.delete("Pragma");
  headers.delete("Expires");
  return headers;
};

export const onRequest = async ({ request, env, next }) => {
  if (!["GET", "HEAD"].includes(request.method)) return next();
  const url = new URL(request.url);
  const slashResponse = await handleTrailingSlash(request, url, next);
  if (slashResponse) return slashResponse;
  const route = MARKDOWN_ROUTES.find(({ path }) => path === url.pathname);
  if (!route) return next();
  const markdown = wantsMarkdown(request.headers.get("Accept") ?? "");
  const response = markdown ? await fetchMarkdownTwin(request, url, route, env) : await next();
  if (!response) return next();
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: applyNegotiatedHeaders(response, url, route, markdown),
  });
};
