import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import { createPreactAliases } from "./scripts/preact-aliases.mjs";
import baseConfig, { coverageBase } from "./vitest.config.base.mjs";

const PREACT_REACT_STUB = fileURLToPath(new URL("./tests/browser/stubs/preact-react.mjs", import.meta.url));
const PREACT_TESTING_LIBRARY = fileURLToPath(new URL("./tests/unit/preact-testing-library.mjs", import.meta.url));
const LUCIDE_STUB_ID = "\0rom-weaver-preact-lucide-stub";
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * lucide-react publishes no `exports` map, so the node environment resolves its CommonJS `main`,
 * whose `require("react")` loads outside Vite's module graph - the preact aliases never reach it and
 * every icon comes back as a real React `forwardRef` object, which preact renders as a literal
 * `<[object Object]>` element. `ssr.noExternal`, `deps.inline`, and pointing `mainFields` at the ESM
 * build all fail to pull it back in, so the node suite substitutes the icon boundary instead; the
 * browser suite exercises the real SVGs.
 *
 * The export list is READ FROM the installed package rather than written out here. A hand-kept list
 * silently breaks the suite with an unhelpful "no such export" the first time source imports an icon
 * nobody remembered to add.
 */
const preactLucideStub = () => ({
  enforce: "pre",
  async load(id) {
    if (id !== LUCIDE_STUB_ID) return undefined;
    const real = await import("lucide-react/dist/esm/lucide-react.mjs");
    const names = Object.keys(real).filter((name) => name !== "createLucideIcon" && IDENTIFIER_PATTERN.test(name));
    return [
      'import { createElement } from "preact";',
      'const iconStub = (props) => createElement("svg", { viewBox: "0 0 24 24", ...props });',
      "const createLucideIcon = () => iconStub;",
      "export { createLucideIcon };",
      ...names.map((name) => `export const ${name} = iconStub;`),
    ].join("\n");
  },
  name: "rom-weaver-preact-lucide-stub",
  resolveId: (id) => (id === "lucide-react" ? LUCIDE_STUB_ID : undefined),
});

// Node-environment unit tests for the patcher state layer (pure reducers, view-model
// projections, normalizers, and store/state-machine helpers). These run without a
// browser so the state machines can be refactored under a fast, deterministic safety
// net; the browser suite (vitest.browser.config.mjs) still covers end-to-end behavior.
export default mergeConfig(baseConfig, {
  plugins: [preactLucideStub()],
  resolve: {
    alias: [
      { find: /^@testing-library\/react$/, replacement: PREACT_TESTING_LIBRARY },
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
