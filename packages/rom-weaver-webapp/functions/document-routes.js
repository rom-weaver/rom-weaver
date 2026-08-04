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

export const documentSidecarPath = (pathname) => {
  const path = String(pathname || "");
  if (path === "/") return "/index.html.br";
  if (!path.startsWith("/") || path.includes(".br")) return null;
  if (path.endsWith("/")) return `${path}index.html.br`;
  if (path.endsWith(".html")) return `${path}.br`;
  return `${path}.html.br`;
};
