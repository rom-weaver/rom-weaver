import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Node exposes navigator.hardwareConcurrency, which would bake the build
// machine's core count into the masthead. Force the "unknown environment"
// rendering (no thread count) so the prerendered HTML is deterministic.
const forceDeterministicNavigator = () => {
  Object.defineProperty(globalThis.navigator, "hardwareConcurrency", {
    configurable: true,
    value: 0,
  });
};

const ensureIdentifyData = () => {
  const script = fileURLToPath(new URL("../../../scripts/ensure-identify-data.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    cwd: path.dirname(path.dirname(script)),
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("failed to prepare ROM identify data");
};

// Render the shell through an already-running Vite server's SSR loader. The dev
// server reuses this so the prerendered shell matches production without
// standing up a second Vite server per index.html request.
const renderLandingShellWithServer = async (server, view = "patcher", notFound = false, docsSlug = "docs") => {
  forceDeterministicNavigator();
  const entry = await server.ssrLoadModule("/src/webapp/prerender-entry.tsx");
  // renderLandingShellHtml resolves the requested tab's lazy route chunk before
  // rendering, so it is async - renderToString cannot suspend.
  return await entry.renderLandingShellHtml(view, notFound, docsSlug);
};

// Runs `render` against one throwaway SSR server. Standing a server up costs
// seconds, so every shell a build needs is rendered inside a single call rather
// than one server per shell.
const withPrerenderServer = async (render) => {
  ensureIdentifyData();
  const server = await createServer({
    appType: "custom",
    configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  try {
    return await render(server);
  } finally {
    await server.close();
  }
};

// Renders the landing shell (src/webapp/prerender-entry.tsx) through Vite's
// SSR pipeline so the real config (defines, react/lingui babel plugin) applies.
// Standalone usage prints the HTML for inspection: node scripts/prerender.mjs
const renderLandingShell = async (view = "patcher", notFound = false, docsSlug = "docs") =>
  await withPrerenderServer((server) => renderLandingShellWithServer(server, view, notFound, docsSlug));

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  renderLandingShell().then(
    (html) => {
      process.stdout.write(`${html}\n`);
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

export { renderLandingShellWithServer, withPrerenderServer };
