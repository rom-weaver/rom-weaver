import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  base: "./",
  oxc: {
    jsx: {
      importSource: "react",
      runtime: "automatic",
    },
  },
  publicDir: false,
  test: {
    hookTimeout: 180000,
    testTimeout: 180000,
  },
  worker: {
    format: "es",
  },
});
