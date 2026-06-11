import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.base.mjs";

// Node-environment unit tests for the patcher state layer (pure reducers, view-model
// projections, normalizers, and store/state-machine helpers). These run without a
// browser so the state machines can be refactored under a fast, deterministic safety
// net; the browser suite (vitest.browser.config.mjs) still covers end-to-end behavior.
export default mergeConfig(baseConfig, {
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
