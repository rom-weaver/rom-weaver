import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vitest/config";
import baseConfig, { coverageBase } from "./vitest.config.base.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
// In a git worktree, node_modules entries are symlinks into the main checkout
// (scripts/setup-worktree.sh); vite checks real paths against fs.allow and
// 403s them, silently hanging browser tests, unless the main root is allowed.
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
  optimizeDeps: {
    include: ["@bjorn3/browser_wasi_shim"],
  },
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
      provider: playwright(),
      screenshotFailures: false,
      viewport: {
        height: 900,
        width: 1280,
      },
    },
    coverage: {
      ...coverageBase,
      reportsDirectory: fileURLToPath(new URL("../../dist/coverage/react-browser", import.meta.url)),
    },
    include: ["tests/browser/**/*.browser.test.js"],
  },
});
