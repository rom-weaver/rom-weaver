import type { WebappView } from "./webapp-state-types.ts";

const VIEW_TO_ROUTE_SLUG: Record<WebappView, string> = {
  weave: "weave-patches",
  creator: "create-rom-patch",
  checksum: "checksum",
  compress: "compress",
  // The landing page is the app base itself, so its slug is empty and
  // writeWorkflowViewToPath resolves it back to readAppBaseUrl.
  home: "",
  docs: "docs",
  extract: "extract",
  identify: "identify-rom",
  patcher: "apply-patches",
  "ppf-undo": "ppf-undo",
  "save-editor": "save-editor",
  test: "test-rom",
  trim: "trim-rom",
  "whats-new": "whats-new",
};
const ROUTE_SLUG_TO_VIEW: Record<string, WebappView> = {
  "apply-cheats": "patcher",
  "create-rom-cheat-patch": "creator",
  "create-rom-patch": "creator",
  "apply-patches": "patcher",
  "bundle-patches": "weave",
  bundle: "weave",
  "weave-patches": "weave",
  "apply-patch": "patcher",
  weave: "weave",
  "create-patch": "creator",
  checksum: "checksum",
  compress: "compress",
  extract: "extract",
  "identify-rom": "identify",
  "test-rom": "test",
  "trim-rom": "trim",
  apply: "patcher",
  create: "creator",
  docs: "docs",
  identify: "identify",
  "ppf-undo": "ppf-undo",
  "save-editor": "save-editor",
  test: "test",
  trim: "trim",
  "whats-new": "whats-new",
  // Keep old links usable when a host has not applied the server redirect.
  tools: "ppf-undo",
};

const lookupWorkflowRoute = (slug: string): WebappView | null => {
  if (slug.endsWith(".html")) {
    slug = slug.slice(0, -5);
    if (slug === "ppf-undo" || slug === "save-editor" || slug === "tools") return null;
  }
  return Object.hasOwn(ROUTE_SLUG_TO_VIEW, slug) ? (ROUTE_SLUG_TO_VIEW[slug] ?? null) : null;
};

const readRouteSegments = (pathname?: string): string[] => {
  const path = pathname ?? (typeof window === "undefined" ? "" : window.location.pathname);
  const segments = path.trim().toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  return segments;
};

const readWorkflowViewFromPath = (pathname?: string): WebappView | null => {
  const segments = readRouteSegments(pathname);
  if (segments.includes("docs")) return "docs";
  const slug = segments.at(-1) || "";
  // No route segment left means the app base itself, which is the landing page.
  // This only resolves at the apex: a sub-path deployment's own base
  // ("/rom-weaver/") is indistinguishable from a missing page by pathname
  // alone, so it stays unresolved and callers fall back to DEFAULT_WORKFLOW_VIEW.
  if (!slug) return "home";
  return lookupWorkflowRoute(slug);
};

/**
 * Where the app itself is served, with the route segment stripped: `/apply/`
 * and `/create` both resolve to `/`, and a sub-path deployment keeps its
 * prefix. Anything the app addresses by a bare name - route links, `?weave=`
 * targets, sample assets - has to resolve against this rather than
 * `location.href`, which points inside the current route.
 */
const readAppBaseUrl = (): string => {
  if (typeof window === "undefined") return "/";
  // The 404 page is served at whatever path missed, so its location says
  // nothing about the app base. The build stamps that page with a <base>
  // tag for the same reason, and its assets already resolve through it.
  if (document.documentElement.dataset.page === "not-found") return document.baseURI;
  const baseUrl = new URL(window.location.href);
  const pathSegments = baseUrl.pathname.split("/");
  while (pathSegments.at(-1) === "") pathSegments.pop();
  if (pathSegments.at(-1) === "index.html") pathSegments.pop();
  const docsIndex = pathSegments.lastIndexOf("docs");
  if (docsIndex >= 0) pathSegments.splice(docsIndex);
  else {
    const currentSlug = (pathSegments.at(-1) || "").toLowerCase();
    if (lookupWorkflowRoute(currentSlug)) pathSegments.pop();
  }
  baseUrl.pathname = `${pathSegments.join("/")}/`;
  baseUrl.hash = "";
  baseUrl.search = "";
  return baseUrl.href;
};

type CreatorMode = "cheats" | "rom";

/** `?mode=rom` or `?mode=cheats` asks Create to switch how the modification is supplied. */
const readCreatorModeFromSearch = (search: string): CreatorMode | null => {
  const mode = new URLSearchParams(search).get("mode");
  return mode === "cheats" || mode === "rom" ? mode : null;
};

const appendCreatorMode = (href: string, mode: CreatorMode | undefined): string =>
  mode ? `${href}?mode=${mode}` : href;

/** Drops `mode` from a raw query string; URLSearchParams would re-encode the other values. */
const removeCreatorModeFromSearch = (search: string): string =>
  search
    .replace(/^\?/u, "")
    .split("&")
    .filter((part) => part !== "mode" && !part.startsWith("mode="))
    .join("&");

export {
  appendCreatorMode,
  type CreatorMode,
  readAppBaseUrl,
  readCreatorModeFromSearch,
  removeCreatorModeFromSearch,
  readRouteSegments,
  readWorkflowViewFromPath,
  VIEW_TO_ROUTE_SLUG,
};
