import { SITE_ORIGIN } from "../src/webapp/docs-routing.mjs";
import { MARKDOWN_ROUTES } from "./markdown-routes.js";

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

export const onRequest = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const route = MARKDOWN_ROUTES.find(({ path }) => path === url.pathname);
  if (!(route && ["GET", "HEAD"].includes(request.method))) return next();
  const markdown = wantsMarkdown(request.headers.get("Accept") ?? "");
  let response;
  if (markdown) {
    const assetUrl = new URL(route.markdownPath, url);
    response = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
    if (!(response.ok && (response.headers.get("Content-Type") ?? "").startsWith("text/markdown"))) return next();
  } else {
    response = await next();
  }
  const headers = new Headers(response.headers);
  // _headers stays under Pages' 100-rule cap by leaving these page Links to the middleware.
  if (!markdown && response.ok && route.alternateLink) {
    headers.append("Link", `<${route.markdownPath}>; rel="alternate"; type="text/markdown"`);
  }
  // A query string never names a different page (`?guide=weave` opens a guide on the
  // same document), so say so in the header too, for crawlers that read it before the HTML.
  if (!markdown && response.ok && url.search) {
    headers.append("Link", `<${SITE_ORIGIN}${route.path}>; rel="canonical"`);
  }
  const vary = new Set(
    (headers.get("Vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  vary.add("Accept");
  headers.set("Vary", [...vary].join(", "));
  // Stable URLs MUST expire even if a deployment purge fails.
  headers.set(
    "Cache-Control",
    response.status === 200 && !url.search && !headers.has("Set-Cookie")
      ? "public, max-age=0, s-maxage=3600, must-revalidate"
      : "no-store",
  );
  headers.delete("Pragma");
  headers.delete("Expires");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
