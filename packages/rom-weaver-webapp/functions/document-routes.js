export const WORKFLOW_DOCUMENT_NAMES = ["apply", "create", "trim", "tools"];

// These patterns are deliberately compact. Cloudflare Pages limits the total
// number of _routes.json include and exclude entries to 100.
export const DOCUMENT_ROUTE_INCLUDES = [
  "/",
  "/index.html",
  "/404.html",
  ...WORKFLOW_DOCUMENT_NAMES.flatMap((name) => [`/${name}`, `/${name}/`, `/${name}.html`, `/${name}/index.html`]),
  "/docs",
  "/docs/*",
];

export const DOCUMENT_ROUTE_EXCLUDES = ["/docs/screenshots/*"];

const htmlSidecarPaths = (htmlPath) => {
  return [`/assets/html${htmlPath.slice(0, -".html".length)}.br`];
};

export const documentSidecarPaths = (pathname) => {
  const path = String(pathname || "");
  if (path === "/") return htmlSidecarPaths("/index.html");
  if (!path.startsWith("/") || path.includes(".br")) return [];
  if (path === "/index.html" || /\/index\.html$/i.test(path)) return htmlSidecarPaths(path);
  if (path.endsWith("/")) {
    const route = path.slice(0, -1);
    return [...htmlSidecarPaths(`${path}index.html`), ...htmlSidecarPaths(`${route}.html`)];
  }
  if (path.endsWith(".html")) {
    const route = path.slice(0, -".html".length);
    return [...htmlSidecarPaths(path), ...htmlSidecarPaths(`${route}/index.html`)];
  }
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (segment.includes(".")) return [];
  return [...htmlSidecarPaths(`${path}/index.html`), ...htmlSidecarPaths(`${path}.html`)];
};

export const documentSidecarPath = (pathname) => documentSidecarPaths(pathname)[0] ?? null;
