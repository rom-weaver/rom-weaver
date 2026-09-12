import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vitest/config";
import { createFirstSampleAssetFiles } from "./scripts/first-sample-assets.mjs";
import { generatedChannelAssetPath } from "./scripts/generated-icon-assets.mjs";
import baseConfig, { coverageBase } from "./vitest.config.base.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Allow linked files that resolve into the main checkout as well as this worktree.
// setup-worktree installs local node_modules; it does not create dependency symlinks.
const GIT_COMMON_ROOT = (() => {
  try {
    const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(commonDir);
  } catch {
    return REPO_ROOT;
  }
})();
const VIRTUAL_PWA_REGISTER_STUB = fileURLToPath(
  new URL("./tests/browser/stubs/virtual-pwa-register.js", import.meta.url),
);
const BROWSER_INSTANCES_BY_NAME = {
  chromium: { browser: "chromium" },
  webkit: { browser: "webkit" },
};
const firstSampleAssetFiles = createFirstSampleAssetFiles();
const testIdentifyAssetFiles = new Map([
  ["assets/identify-index.json", JSON.stringify({ format: "rom-weaver-identify-system-pack-v1", systems: [] })],
  ["assets/identify-catalog.json", JSON.stringify({ format: "rom-weaver-identify-catalog-v1", platforms: [] })],
]);
const generatedRootIconAssets = new Map(
  [
    ["/apple-touch-icon.png", "apple-touch-icon.png"],
    ["/favicon.ico", "favicon.ico"],
    ["/icon-maskable-192.png", "icon-maskable-192.png"],
    ["/icon-maskable-512.png", "icon-maskable-512.png"],
    ["/logo.svg", "logo.svg"],
  ].map(([requestPath, name]) => [requestPath, generatedChannelAssetPath("dev", name)]),
);
const generatedRootIconContentType = (requestPath) => {
  if (requestPath.endsWith(".ico")) return "image/x-icon";
  if (requestPath.endsWith(".svg")) return "image/svg+xml";
  return "image/png";
};
const serveGeneratedRootIconAssets = {
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const requestPath = request.url?.split("?")[0] ?? "";
      const sourcePath = generatedRootIconAssets.get(requestPath);
      if (!sourcePath) {
        next();
        return;
      }
      response.setHeader("Content-Type", generatedRootIconContentType(requestPath));
      response.end(fs.readFileSync(sourcePath));
    });
  },
  enforce: "pre",
  name: "rom-weaver-generated-root-icons",
};
const serveFirstSampleAssets = {
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const requestPath = request.url?.split("?")[0] ?? "";
      const source = firstSampleAssetFiles.get(requestPath.slice(1));
      if (!source) {
        next();
        return;
      }
      response.setHeader("Content-Type", requestPath.endsWith(".zip") ? "application/zip" : "application/octet-stream");
      response.end(source);
    });
  },
  name: "rom-weaver-first-sample-assets",
};
// Browser tests MUST use a valid local identify index so missing generated data
// cannot fall through to Vite's HTML shell and turn into a timing-sensitive
// application error.
const serveTestIdentifyAssets = {
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const requestPath = request.url?.split("?")[0] ?? "";
      const source = testIdentifyAssetFiles.get(requestPath.slice(1));
      if (source === undefined) {
        next();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(source);
    });
  },
  name: "rom-weaver-test-identify-assets",
};

const createBrowserInstances = () => {
  const rawSelection = process.env.ROM_WEAVER_BROWSER || "chromium";
  const selectedNames =
    rawSelection.trim().toLowerCase() === "all"
      ? Object.keys(BROWSER_INSTANCES_BY_NAME)
      : rawSelection
          .split(",")
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean);

  if (selectedNames.length === 0) return [BROWSER_INSTANCES_BY_NAME.chromium];

  return selectedNames.map((name) => {
    const instance = BROWSER_INSTANCES_BY_NAME[name];
    if (!instance) {
      throw new Error(`Unsupported ROM_WEAVER_BROWSER value "${name}". Expected chromium, webkit, or all.`);
    }
    return instance;
  });
};

const readDownloadStream = (stream, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    let capturedSize = 0;
    stream.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      if (!maxBytes || capturedSize < maxBytes) {
        const remaining = maxBytes ? maxBytes - capturedSize : buffer.length;
        chunks.push(buffer.subarray(0, remaining));
        capturedSize += Math.min(buffer.length, remaining);
      }
      totalSize += buffer.length;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({
        content: Buffer.concat(chunks),
        totalSize,
      });
    });
  });

export default mergeConfig(baseConfig, {
  // Missing assets MUST return 404 so browser tests cannot parse the app shell as data.
  appType: "mpa",
  optimizeDeps: {
    include: ["@bjorn3/browser_wasi_shim"],
  },
  plugins: [serveGeneratedRootIconAssets, serveFirstSampleAssets, serveTestIdentifyAssets],
  publicDir: fileURLToPath(new URL("./src/assets/app/root", import.meta.url)),
  resolve: {
    alias: {
      "virtual:pwa-register": VIRTUAL_PWA_REGISTER_STUB,
    },
    preserveSymlinks: true,
  },
  server: {
    fs: {
      allow: [...new Set([REPO_ROOT, GIT_COMMON_ROOT])],
    },
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  test: {
    expect: {
      // Browser-worker state can take longer than Vitest's 1s poll default
      // when the file runner has several Chrome processes active.
      poll: { timeout: 30_000 },
    },
    browser: {
      commands: {
        async clickAndReadDownload(context, selector, options) {
          const frame = await context.frame();
          const downloadPromise = context.page.waitForEvent("download", { timeout: 60000 });
          const clickDeadline = Date.now() + 180000;
          let clicked = false;
          let lastError = null;
          while (!clicked && Date.now() < clickDeadline) {
            try {
              await frame.click(selector, { timeout: 1200 });
              clicked = true;
            } catch (error) {
              lastError = error;
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
          }
          if (!clicked)
            throw new Error(
              `Download trigger was never clickable: ${selector}${lastError ? ` (${String(lastError)})` : ""}`,
            );
          const download = await downloadPromise;
          const stream = await download.createReadStream();
          if (!stream) throw new Error("Playwright did not expose a download stream");
          const result = await readDownloadStream(stream, options?.maxBytes);
          return {
            contentBase64: result.content.toString("base64"),
            size: result.totalSize,
            suggestedFilename: download.suggestedFilename(),
          };
        },
      },
      enabled: true,
      headless: true,
      instances: createBrowserInstances(),
      provider: playwright(
        process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { launchOptions: { channel: "chrome" } } : undefined,
      ),
      screenshotFailures: false,
      viewport: {
        height: 900,
        width: 1280,
      },
    },
    coverage: {
      ...coverageBase,
      reporter: process.env.ROM_WEAVER_COVERAGE_SHARD === "1" ? ["lcov"] : coverageBase.reporter,
      reportsDirectory: process.env.ROM_WEAVER_COVERAGE_DIR
        ? resolve(process.env.ROM_WEAVER_COVERAGE_DIR)
        : fileURLToPath(new URL("../../dist/coverage/react-browser", import.meta.url)),
    },
    include: ["tests/browser/**/*.browser.test.js"],
    setupFiles: ["./tests/setup/browser-defines.js"],
  },
});
