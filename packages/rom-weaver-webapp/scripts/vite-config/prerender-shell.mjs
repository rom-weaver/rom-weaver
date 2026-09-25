import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
import { DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";
import { readDocsSlugFromPathname } from "../../src/webapp/docs-routing.mjs";
import { WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";
import { rootDir } from "./paths.mjs";
import { LEGACY_WORKFLOW_ROUTES } from "./root-static-assets.mjs";

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
// The hero loom starts while the parser is still in the prerendered home shell:
// src/webapp/home-loom-shell.ts is bundled as a standalone classic script and
// inlined right after the canvas, and HomeLoom adopts the running loop on
// mount. The document must carry it inline - a module script would wait for
// the HTML to finish parsing - so it is built here, once per source change,
// and only the shell that has the canvas pays for its bytes.
const SHELL_LOOM_ENTRY = path.resolve(rootDir, "src/webapp/home-loom-shell.ts");
const SHELL_LOOM_SOURCES = [SHELL_LOOM_ENTRY, path.resolve(rootDir, "src/webapp/home-loom-runtime.ts")];
const PRERENDER_LOOM_CANVAS = /<canvas\b[^>]*\bclass="home-loom-canvas"[^>]*><\/canvas>/;
let shellLoomScript = { html: "", stamp: "" };
const buildShellLoomScript = async () => {
  const stamp = SHELL_LOOM_SOURCES.map((file) => String(fs.statSync(file).mtimeMs)).join(":");
  if (shellLoomScript.stamp === stamp) return shellLoomScript.html;
  const result = await build({
    build: {
      emptyOutDir: false,
      lib: {
        entry: SHELL_LOOM_ENTRY,
        fileName: () => "home-loom-shell.js",
        formats: ["iife"],
        name: "romWeaverShellLoom",
      },
      minify: true,
      target: "es2022",
      write: false,
    },
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    root: rootDir,
  });
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((item) => item.type === "chunk");
  if (!chunk) throw new Error("rom-weaver-prerender-shell: the shell loom script produced no chunk");
  const code = chunk.code.trim();
  // A literal `</script` in the bundle would close the inline tag early.
  if (/<\/script/i.test(code)) throw new Error("rom-weaver-prerender-shell: the shell loom script contains </script");
  shellLoomScript = { html: `<script>${code}</script>`, stamp };
  return shellLoomScript.html;
};
// The home shell MUST carry the canvas the script attaches to; a silent
// non-match would ship the empty-canvas load this script exists to remove,
// and no later check (the size budget only bounds growth) would notice.
const assertShellLoomCanvas = (shell) => {
  if (!PRERENDER_LOOM_CANVAS.test(shell))
    throw new Error("rom-weaver-prerender-shell: the home shell has no home-loom canvas for the shell loom script");
};
// Callers MUST await buildShellLoomScript() first: closeBundle rebuilds these
// strings synchronously to find the home root in dist/index.html, so the loom
// script is read from the cache filled by transformIndexHtml.
export const PRERENDER_ROOT = (shell) =>
  `<div id="webapp-root" aria-busy="true">${shell
    .replace(PRERENDER_RUNTIME_SLOT, `${PRERENDER_RUNTIME_SLOT}${PRERENDER_RUNTIME_RESOLVER}`)
    .replace(PRERENDER_THREADS_SLOT, `${PRERENDER_THREADS_SLOT}${PRERENDER_RUNTIME_RESOLVER}`)
    .replace(
      PRERENDER_LOOM_CANVAS,
      (canvas) => `${canvas}${shellLoomScript.html}`,
    )}</div>${PRERENDER_DOC_SHELF_RESTORER}`;

// Ship the landing shell's real markup inside #webapp-root so the browser can
// paint it as soon as the stylesheet arrives, instead of a blank page until the
// bundle executes and React mounts. Rendered from the actual components via
// react-dom/server (scripts/prerender.mjs), so there is no hand-copied markup
// to drift. The client hydrates the shell in place.
const PRERENDER_MOUNT_POINT = '<div id="webapp-root" aria-busy="true"></div>';

// Which prerendered variant a dev request gets, mirroring the app router.
const devPrerenderRoute = (url) => {
  const pathname = String(url || "").split(/[?#]/)[0];
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const slug = segments.at(-1) || "";
  if (segments.includes("docs")) return { docsSlug: readDocsSlugFromPathname(pathname), view: "docs" };
  // No route segment is the app base itself, which serves the landing page.
  if (!slug) return { docsSlug: "docs", view: "home" };
  const routeSlug = slug.replace(/\.html$/, "");
  const directView = {
    "ppf-undo": "ppf-undo",
    "save-editor": "save-editor",
    tools: "ppf-undo",
    "trim-rom": "trim",
    "whats-new": "whats-new",
  }[routeSlug];
  if (directView) return { docsSlug: "docs", view: directView };
  const canonical = Object.hasOwn(LEGACY_WORKFLOW_ROUTES, routeSlug) ? LEGACY_WORKFLOW_ROUTES[routeSlug] : routeSlug;
  const view = Object.entries(WORKFLOW_SEO_ROUTES).find(([, route]) => route.slug === canonical)?.[0] ?? "patcher";
  return { docsSlug: "docs", view };
};

export const prerenderWebappShell = (prerenderedShells) => ({
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
      const prerender = await import("../prerender.mjs");
      await buildShellLoomScript();
      // Dev reuses the running dev server's SSR loader (no second Vite server
      // per request) so the shell - and its prerender->mount handoff - matches
      // production locally. Build renders the creator variant too, which
      // writeWebappStaticAssets emits as a second static entry point.
      if (ctx.server) {
        const route = devPrerenderRoute(ctx.originalUrl ?? ctx.path);
        const shell = await prerender.renderLandingShellWithServer(ctx.server, route.view, false, route.docsSlug);
        if (route.view === "home") assertShellLoomCanvas(shell);
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
          html: routeHtml.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(shell)),
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
      // One SSR server renders every shell the build needs; spinning one up per
      // shell would cost more than the rendering does.
      const homeShell = await prerender.withPrerenderServer(async (server) => {
        const render = (view, notFound, docsSlug) =>
          prerender.renderLandingShellWithServer(server, view, notFound, docsSlug);
        prerenderedShells.set("home", await render("home"));
        assertShellLoomCanvas(prerenderedShells.get("home"));
        prerenderedShells.set("patcher", await render("patcher"));
        prerenderedShells.set("bundle", await render("bundle"));
        prerenderedShells.set("creator", await render("creator"));
        prerenderedShells.set("identify", await render("identify"));
        prerenderedShells.set("trim", await render("trim"));
        prerenderedShells.set("ppf-undo", await render("ppf-undo"));
        prerenderedShells.set("save-editor", await render("save-editor"));
        prerenderedShells.set("test", await render("test"));
        prerenderedShells.set("whats-new", await render("whats-new"));
        prerenderedShells.set("notFound", await render("patcher", true));
        for (const route of DOC_ROUTES) {
          prerenderedShells.set(route.slug, await render("docs", false, route.slug));
        }
        return prerenderedShells.get("home");
      });
      // index.html is served at the apex, so it carries the landing shell; every
      // other route page is derived from it by swapping that root out.
      return html.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(homeShell));
    },
    order: "post",
  },
});
