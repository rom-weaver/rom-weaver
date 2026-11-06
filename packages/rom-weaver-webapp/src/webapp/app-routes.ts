import { APP_BASE_PATH } from "./app-base.ts";
import { readRoutePath } from "./app-route-path.mjs";
import { readDocsSlugFromPathname } from "./docs-routing.mjs";
import type { WebappView } from "./webapp-state-types.ts";

const VIEW_TO_ROUTE_SLUG: Record<WebappView, string> = {
  weave: "weave-rom-patches",
  creator: "create-rom-patch",
  checksum: "file-checksum",
  compress: "compress-files",
  // The landing page is the app base itself, so its slug is empty and
  // writeWorkflowViewToPath resolves it back to readAppBaseUrl.
  home: "",
  docs: "docs",
  extract: "extract-files",
  identify: "identify-rom",
  patcher: "apply-rom-patches",
  "ppf-undo": "ppf-undo",
  "save-editor": "rom-save-editor",
  test: "play-rom",
  trim: "trim-rom",
  "whats-new": "whats-new",
};
const ROUTE_SLUG_TO_VIEW: Record<string, WebappView> = {
  "apply-rom-patches": "patcher",
  "weave-rom-patches": "weave",
  "rom-save-editor": "save-editor",
  "file-checksum": "checksum",
  "compress-files": "compress",
  "extract-files": "extract",
  "play-rom": "test",
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
  identify: "identify",
  "ppf-undo": "ppf-undo",
  "save-editor": "save-editor",
  test: "test",
  trim: "trim",
  "whats-new": "whats-new",
  // Keep old links usable when a host has not applied the server redirect.
  tools: "ppf-undo",
};

/**
 * The view a pathname addresses below the app base, or `null` for a path the app does not serve.
 * The base itself is the landing page.
 */
const matchAppRoute = (pathname?: string, basePath = APP_BASE_PATH): WebappView | null => {
  const path = pathname ?? (typeof window === "undefined" ? "" : window.location.pathname);
  const route = readRoutePath(path, basePath);
  if (route === null) return null;
  if (route === "") return "home";
  const slug = route.replace(/\.html$/u, "");
  if (slug === "docs" || slug.startsWith("docs/")) return readDocsSlugFromPathname(path, basePath) ? "docs" : null;
  return Object.hasOwn(ROUTE_SLUG_TO_VIEW, slug) ? (ROUTE_SLUG_TO_VIEW[slug] ?? null) : null;
};

/**
 * Where the app itself is served, as an absolute URL ending in `/`. Anything the app addresses by a bare
 * name - route links, `?weave=` targets, sample assets - resolves against this rather than `location.href`,
 * which points inside the current route.
 */
const readAppBaseUrl = (): string =>
  typeof window === "undefined" ? "/" : new URL(APP_BASE_PATH, window.location.origin).href;

/**
 * Re-roots an in-app path (`/docs/faq#a`, `apply-rom-patches`) on the app base so
 * a sub-path deployment keeps its prefix. Leading slashes are dropped first: a
 * doubled slash would be a protocol-relative URL.
 */
const appPathHref = (href: string, appBaseUrl: string): string => {
  // The server render has no window, so its base is the bare "/"; the throwaway origin only lets that parse.
  const url = new URL(href.replace(/^\/+/, ""), new URL(appBaseUrl, "https://app.invalid"));
  return `${url.pathname}${url.search}${url.hash}`;
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
  appPathHref,
  type CreatorMode,
  matchAppRoute,
  readAppBaseUrl,
  readCreatorModeFromSearch,
  removeCreatorModeFromSearch,
  VIEW_TO_ROUTE_SLUG,
};
