import os from "node:os";
import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = process.cwd();
const repoRoot = path.resolve(rootDir, "../..");
const securityHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  Expires: "0",
  Pragma: "no-cache",
};
const runtimeScratchIgnorePatterns = [
  "**/.rpjs-vfs",
  "**/.rpjs-vfs/**",
  path.join(os.tmpdir(), "rpjs-vfs*").replace(/\\/g, "/"),
];

const suppressNestedWorkerFactoryBundling = () => {
  const workerFactoriesPath = path.join(rootDir, "src", "workers", "protocol", "worker-factories.ts");
  const nestedWorkerPattern = /new Worker\(\s*new URL\(/g;
  return {
    apply: "build",
    enforce: "pre",
    name: "rom-weaver-suppress-nested-worker-factory-bundling",
    transform(code, id) {
      const filePath = id.split("?")[0];
      if (path.normalize(filePath) !== workerFactoriesPath) return null;
      if (!nestedWorkerPattern.test(code)) return null;
      nestedWorkerPattern.lastIndex = 0;
      return {
        code: code.replace(nestedWorkerPattern, "new Worker(new URL(/* @vite-ignore */ "),
        map: null,
      };
    },
  };
};

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  base: "./",
  build: {
    assetsInlineLimit: 0,
    cssMinify: "lightningcss",
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: path.resolve(rootDir, "index.html"),
    },
    target: "es2022",
  },
  clearScreen: false,
  css: {
    transformer: "lightningcss",
  },
  optimizeDeps: {
    include: ["@bjorn3/browser_wasi_shim", "@zenfs/core", "@zenfs/dom", "react", "react-dom", "react-dom/client"],
  },
  plugins: [react(), tailwindcss()],
  preview: {
    headers: securityHeaders,
    host: "0.0.0.0",
  },
  publicDir: false,
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    fs: {
      allow: [rootDir, repoRoot],
    },
    headers: securityHeaders,
    host: "0.0.0.0",
    watch: {
      ignored: runtimeScratchIgnorePatterns,
    },
  },
  worker: {
    format: "es",
    plugins: () => [suppressNestedWorkerFactoryBundling()],
  },
});
