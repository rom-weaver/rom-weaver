import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import baseConfig, { coverageBase } from "./vitest.config.base.mjs";

// Node-environment unit tests for the patcher state layer (pure reducers, view-model
// projections, normalizers, and store/state-machine helpers). These run without a
// browser so the state machines can be refactored under a fast, deterministic safety
// net; the browser suite (vitest.browser.config.mjs) still covers end-to-end behavior.
export default mergeConfig(baseConfig, {
  test: {
    coverage: {
      ...coverageBase,
      reportsDirectory: fileURLToPath(new URL("../../dist/coverage/react-unit", import.meta.url)),
    },
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/unit/setup.ts"],
  },
});
