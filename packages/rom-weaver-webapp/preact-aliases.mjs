/**
 * The single definition of the React -> Preact swap, shared by the production Vite build
 * (vite.config.mjs), the browser suite (vitest.browser.config.mjs), and the node unit suite
 * (vitest.unit.config.mjs) so no config can drift onto a different runtime.
 *
 * Source keeps importing `react` / `react-dom` everywhere; only resolution changes. That is also why
 * `react` and `react-dom` stay declared in package.json - `@types/react` is still the type surface
 * `tsc` checks - so neither is an unused dependency to clean up. `checkReactRuntimeExclusion` in
 * scripts/check-size-budget.mjs fails the build if real React reaches a bundle, or if Preact does not.
 *
 * Every specifier the codebase imports is listed. The patterns are anchored, so order is not
 * load-bearing; `react-dom` precedes `react` for readability only. See "Webapp React runtime
 * (Preact compat)" in docs/development/ARCHITECTURE.md for the behavioural differences this implies.
 *
 * @param reactReplacement Overrides the `react` target so test configs can point at a stub that
 *   re-exports preact/compat plus `act` from preact/test-utils.
 */
const createPreactAliases = (reactReplacement = "preact/compat") => [
  { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
  { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
  { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
  { find: /^react-dom\/server$/, replacement: "preact/compat/server" },
  { find: /^react-dom$/, replacement: "preact/compat" },
  { find: /^react$/, replacement: reactReplacement },
];

export { createPreactAliases };
