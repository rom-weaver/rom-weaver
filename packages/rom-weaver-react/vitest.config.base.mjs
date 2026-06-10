import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "0.1.0"),
    __COMMIT_HASH__: JSON.stringify("dev"),
    __DIRTY_HASH__: JSON.stringify(""),
    __GIT_BRANCH__: JSON.stringify("dev"),
    __SERVICE_WORKER_ENABLED__: "false",
    __SERVICE_WORKER_UPDATE_INTERVAL_MS__: "0",
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
