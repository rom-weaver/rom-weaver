import { coverageConfigDefaults, defineConfig } from "vitest/config";
import { compileLinguiCatalogs } from "./scripts/compile-lingui-catalogs.mjs";
import { docsVirtualModule } from "./scripts/docs-virtual-module.mjs";

// Coverage is collected by the v8 provider in browser mode (V8 precise coverage
// over CDP - low overhead, not source instrumentation). It is gated on
// ROM_WEAVER_COVERAGE so normal/bench runs are unaffected. Each suite's config
// spreads this and sets its own `reportsDirectory` to keep the two reports
// separate (cross-config merging is out of scope).
export const coverageBase = {
  enabled: process.env.ROM_WEAVER_COVERAGE === "1",
  exclude: [...coverageConfigDefaults.exclude, "src/wasm/generated/**", "src/**/*.d.ts", "tests/**"],
  include: ["src/**/*.{ts,tsx}"],
  provider: "v8",
  reporter: ["text", "html", "lcov"],
};

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  base: "./",
  define: {
    // What a deployment stamps over src/webapp/build-version.ts's global.
    "globalThis.__ROM_WEAVER_BUILD_INFO__": JSON.stringify({
      commitHash: "dev",
      commitsSinceVersion: 0,
      dirtyHash: "",
      gitBranch: "dev",
      version: process.env.npm_package_version || "0.1.0",
      versionBranch: "dev",
      versionIsTagged: false,
    }),
    __IDENTIFY_MANIFEST_FILES__: JSON.stringify({
      catalog: "identify-catalog-test.json",
      index: "identify-index-test.json",
    }),
    __SERVICE_WORKER_ENABLED__: "false",
    __SERVICE_WORKER_UPDATE_INTERVAL_MS__: "0",
  },
  oxc: {
    jsx: {
      importSource: "react",
      runtime: "automatic",
    },
  },
  // The docs route imports its rendered guides from `virtual:rom-weaver-docs`.
  plugins: [compileLinguiCatalogs(), docsVirtualModule()],
  publicDir: false,
  test: {
    hookTimeout: 60000,
    testTimeout: 60000,
  },
  worker: {
    format: "es",
  },
});
