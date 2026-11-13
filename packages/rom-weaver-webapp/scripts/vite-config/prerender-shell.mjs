import { DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";
import { readDocsSlugFromPathname } from "../../src/webapp/docs-routing.mjs";
import { LEGACY_WORKFLOW_ROUTES, WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";

const PRERENDER_RUNTIME_SLOT = '<span class="shell-identity" hidden=""></span>';
const PRERENDER_THREADS_SLOT = '<span class="shell-threads-identity" hidden=""></span>';
const PRERENDER_RUNTIME_RESOLVER =
  "<script>try{window.ROM_WEAVER_RESOLVE_SHELL_IDENTITY()}finally{document.currentScript.remove()}</script>";
const DOC_SHELF_STATE_KEY = "rom-weaver-docs-shelves";
// Restore the reader's docs shelves while the parser is still handling the
// prerendered shell. The first client render reads the same storage value, so
// hydration never paints the server's default closed state first.
const PRERENDER_DOC_SHELF_RESTORER = `<script>
try {
  const stored = JSON.parse(sessionStorage.getItem(${JSON.stringify(DOC_SHELF_STATE_KEY)}) || "{}");
  for (const shelf of document.querySelectorAll(".guide-shelf, .docs-index-shelf")) {
    const title = shelf.querySelector(".guide-shelf-title, .docs-index-title")?.textContent?.trim() || "";
    if (typeof stored[title] === "boolean") shelf.open = stored[title];
  }
} catch {}
</script>`;

const PRERENDER_ROOT = (shell) => {
  const shelfRestorer = /class="[^"]*\b(?:guide-shelf|docs-index-shelf)\b/.test(shell)
    ? PRERENDER_DOC_SHELF_RESTORER
    : "";
  return `<div id="webapp-root" aria-busy="true">${shell
    .replace(PRERENDER_RUNTIME_SLOT, `${PRERENDER_RUNTIME_SLOT}${PRERENDER_RUNTIME_RESOLVER}`)
    .replace(PRERENDER_THREADS_SLOT, `${PRERENDER_THREADS_SLOT}${PRERENDER_RUNTIME_RESOLVER}`)}</div>${shelfRestorer}`;
};

// Ship the landing shell's real markup inside #webapp-root so the browser can
// paint it as soon as the stylesheet arrives, instead of a blank page until the
// bundle executes and React mounts. Rendered from the actual components via
// react-dom/server (scripts/prerender.mjs), so there is no hand-copied markup
// to drift. The client hydrates the shell in place.
export const PRERENDER_MOUNT_POINT = '<div id="webapp-root" aria-busy="true"></div>';

/** Puts `shell` in the mount point of `html`. A replacer function keeps `$` sequences in the shell literal. */
export const injectPrerenderedShell = (html, shell) => html.replace(PRERENDER_MOUNT_POINT, () => PRERENDER_ROOT(shell));

// Which prerendered variant a dev request gets, mirroring the app router.
const devPrerenderRoute = (url) => {
  const pathname = String(url || "").split(/[?#]/)[0];
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const slug = segments.at(-1) || "";
  if (segments.includes("docs")) return { docsSlug: readDocsSlugFromPathname(pathname) ?? "docs", view: "docs" };
  // No route segment is the app base itself, which serves the landing page.
  if (!slug) return { docsSlug: "docs", view: "home" };
  const routeSlug = slug.replace(/\.html$/, "");
  if (Object.hasOwn(WORKFLOW_ENTRY_ROUTES, routeSlug)) {
    return { docsSlug: "docs", view: WORKFLOW_ENTRY_ROUTES[routeSlug].view, workflowEntry: routeSlug };
  }
  const directView = {
    "create-m3u-playlist": "playlist",
    "ppf-undo": "ppf-undo",
    "save-editor": "save-editor",
    "rom-save-editor": "save-editor",
    tools: "ppf-undo",
    "trim-rom": "trim",
    "whats-new": "whats-new",
  }[routeSlug];
  if (directView) return { docsSlug: "docs", view: directView };
  const canonical = Object.hasOwn(LEGACY_WORKFLOW_ROUTES, routeSlug) ? LEGACY_WORKFLOW_ROUTES[routeSlug] : routeSlug;
  const view = Object.entries(WORKFLOW_SEO_ROUTES).find(([, route]) => route.slug === canonical)?.[0] ?? "patcher";
  return { docsSlug: "docs", view };
};

/** Renders each page shell with `channel` in its masthead and `buildInfo` as its build. */
export const renderPrerenderedShells = async ({ buildInfo, channel, channelLabel }) => {
  const prerender = await import("../prerender.mjs");
  const shells = new Map();
  // build-channel.ts and build-version.ts read these while the SSR server loads
  // them; a browser reads <html data-channel> and <html data-build-info>.
  globalThis.ROM_WEAVER_PRERENDER_CHANNEL = { channel, label: channelLabel };
  globalThis.__ROM_WEAVER_BUILD_INFO__ = buildInfo;
  try {
    await prerender.withPrerenderServer(async (server) => {
      const render = (view, notFound, docsSlug, workflowEntry) =>
        prerender.renderLandingShellWithServer(server, view, notFound, docsSlug, workflowEntry);
      for (const view of [
        "home",
        "patcher",
        "weave",
        "creator",
        "checksum",
        "compress",
        "identify",
        "extract",
        "trim",
        "ppf-undo",
        "playlist",
        "save-editor",
        "test",
        "whats-new",
      ]) {
        shells.set(view, await render(view));
      }
      shells.set("notFound", await render("patcher", true));
      for (const route of Object.values(WORKFLOW_ENTRY_ROUTES)) {
        shells.set(route.slug, await render(route.view, false, "docs", route.slug));
      }
      for (const route of DOC_ROUTES) {
        shells.set(route.slug, await render("docs", false, route.slug));
      }
    });
  } finally {
    delete globalThis.ROM_WEAVER_PRERENDER_CHANNEL;
    delete globalThis.__ROM_WEAVER_BUILD_INFO__;
  }
  return shells;
};

// A build leaves the mount point empty. The channel stamp fills it per page.
export const prerenderWebappShell = ({ buildInfo, channel, channelLabel }) => ({
  name: "rom-weaver-prerender-shell",
  transformIndexHtml: {
    async handler(html, ctx) {
      // Dev serves every HTML file in the package, not just the app entry
      // (mobile-safari-matrix.html is the on-device diagnostic harness), so a
      // missing mount point there is expected. It is still a hard build error:
      // index.html is the only HTML rollup input.
      if (!html.includes(PRERENDER_MOUNT_POINT)) {
        if (ctx.server) return html;
        throw new Error("rom-weaver-prerender-shell: #webapp-root mount point not found in index.html");
      }
      // Dev reuses the running dev server's SSR loader (no second Vite server
      // per request) so the shell - and its prerender->mount handoff - matches
      // production locally.
      if (ctx.server) {
        const prerender = await import("../prerender.mjs");
        globalThis.ROM_WEAVER_PRERENDER_CHANNEL = { channel, label: channelLabel };
        globalThis.__ROM_WEAVER_BUILD_INFO__ = buildInfo;
        const route = devPrerenderRoute(ctx.originalUrl ?? ctx.path);
        const shell = await prerender.renderLandingShellWithServer(
          ctx.server,
          route.view,
          false,
          route.docsSlug,
          route.workflowEntry,
        );
        const routeHtml = route.view === "docs" ? html.replace("<head>", '<head>\n    <base href="/" />') : html;
        // Production ships the bundled CSS as a render-blocking <link>, so its
        // prerendered shell paints styled. Dev serves CSS as HMR'd JS modules
        // that only apply after the bundle runs, which would flash the shell
        // unstyled. Inject the same stylesheets render-blocking (Vite serves
        // ?direct as real text/css). index.css pulls in style.css and declares
        // the layer order; the deferred and docs sheets load lazily in
        // production but are linked here so every dev shell paints complete -
        // cascade layers make the double application harmless.
        // These links are outside the module graph, so a CSS edit only reaches
        // them on a full reload; until then the HMR'd <style> (appended after
        // them, so it wins) carries the change and a *deleted* rule lingers.
        return {
          html: injectPrerenderedShell(routeHtml, shell),
          tags: [
            "/src/webapp/design-system/index.css",
            "/src/webapp/design-system/deferred.css",
            "/src/webapp/design-system/docs-route.css",
          ].map((href) => ({
            attrs: { href: `${href}?direct`, rel: "stylesheet" },
            injectTo: "head",
            tag: "link",
          })),
        };
      }
      return html;
    },
    order: "post",
  },
});
