const WORKFLOW_DOCUMENT_NAMES = ["apply", "create", "trim", "tools"];

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

export const documentSidecarPaths = (pathname) => {
  const path = String(pathname || "");
  if (path === "/") return ["/index.html.br"];
  if (!path.startsWith("/") || path.includes(".br")) return [];
  if (path === "/index.html" || /\/index\.html$/i.test(path)) return [`${path}.br`];
  if (path.endsWith("/")) {
    const route = path.slice(0, -1);
    return [`${path}index.html.br`, `${route}.html.br`];
  }
  if (path.endsWith(".html")) {
    const route = path.slice(0, -".html".length);
    return [`${path}.br`, `${route}/index.html.br`];
  }
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (segment.includes(".")) return [];
  return [`${path}/index.html.br`, `${path}.html.br`];
};

export const documentSidecarPath = (pathname) => documentSidecarPaths(pathname)[0] ?? null;
