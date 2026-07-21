import { coverageConfigDefaults, defineConfig } from "vitest/config";

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
    __APP_CHANNEL__: JSON.stringify("dev"),
    __APP_CHANNEL_LABEL__: JSON.stringify("dev"),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "0.1.0"),
    __COMMIT_HASH__: JSON.stringify("dev"),
    __DIRTY_HASH__: JSON.stringify(""),
    __GIT_BRANCH__: JSON.stringify("dev"),
    __SERVICE_WORKER_ENABLED__: "false",
    __SERVICE_WORKER_UPDATE_INTERVAL_MS__: "0",
    __VERSION_IS_TAGGED__: JSON.stringify(false),
  },
  oxc: {
    jsx: {
      importSource: "react",
      runtime: "automatic",
    },
  },
  publicDir: false,
  test: {
    hookTimeout: 60000,
    testTimeout: 60000,
  },
  worker: {
    format: "es",
  },
});
