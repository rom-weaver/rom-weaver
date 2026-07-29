import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import { createPreactAliases } from "./preact-aliases.mjs";
import baseConfig, { coverageBase } from "./vitest.config.base.mjs";

const PREACT_REACT_STUB = fileURLToPath(new URL("./tests/browser/stubs/preact-react.mjs", import.meta.url));
const PREACT_TESTING_LIBRARY = fileURLToPath(new URL("./tests/unit/preact-testing-library.mjs", import.meta.url));
const PREACT_LUCIDE_STUB = fileURLToPath(new URL("./tests/unit/preact-lucide.mjs", import.meta.url));

// Node-environment unit tests for the patcher state layer (pure reducers, view-model
// projections, normalizers, and store/state-machine helpers). These run without a
// browser so the state machines can be refactored under a fast, deterministic safety
// net; the browser suite (vitest.browser.config.mjs) still covers end-to-end behavior.
export default mergeConfig(baseConfig, {
  resolve: {
    alias: [
      { find: /^@testing-library\/react$/, replacement: PREACT_TESTING_LIBRARY },
      { find: /^lucide-react$/, replacement: PREACT_LUCIDE_STUB },
      ...createPreactAliases(PREACT_REACT_STUB),
    ],
  },
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
