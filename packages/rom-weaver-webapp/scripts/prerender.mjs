import process from "node:process";
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

// Render the shell through an already-running Vite server's SSR loader. The dev
// server reuses this so the prerendered shell matches production without
// standing up a second Vite server per index.html request.
const renderLandingShellWithServer = async (server, view = "patcher") => {
  forceDeterministicNavigator();
  const entry = await server.ssrLoadModule("/src/webapp/prerender-entry.tsx");
  // renderLandingShellHtml resolves the requested tab's lazy route chunk before
  // rendering, so it is async - renderToString cannot suspend.
  return await entry.renderLandingShellHtml(view);
};

// Renders the landing shell (src/webapp/prerender-entry.tsx) through Vite's
// SSR pipeline so the real config (defines, react/lingui babel plugin) applies.
// Standalone usage prints the HTML for inspection: node scripts/prerender.mjs
const renderLandingShell = async (view = "patcher") => {
  const server = await createServer({
    appType: "custom",
    configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
    logLevel: "warn",
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { hmr: false, middlewareMode: true, watch: null },
  });
  try {
    return await renderLandingShellWithServer(server, view);
  } finally {
    await server.close();
  }
};

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

export { renderLandingShell, renderLandingShellWithServer };
