import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.base.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VIRTUAL_PWA_REGISTER_STUB = fileURLToPath(
  new URL("./tests/browser/stubs/virtual-pwa-register.js", import.meta.url),
);

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
    // Serve rom-weaver-wasm from source instead of pre-bundling it. Vite keys its dep-optimize cache
    // on the lockfile/config, not this symlinked workspace dep's source, so after editing the wasm
    // worker protocol the pre-bundled main-thread client goes stale against the freshly loaded worker
    // and drops the runJson command (normalizeRunRequest throws). Excluding it keeps both in sync.
    exclude: ["rom-weaver-wasm"],
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
      allow: [REPO_ROOT],
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
      instances: [{ browser: "chromium" }],
      provider: playwright(),
      screenshotFailures: false,
      viewport: {
        height: 900,
        width: 1280,
      },
    },
    include: ["tests/browser/**/*.browser.test.js"],
  },
});
