import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { trackedFiles } from "./lint-tracked.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const webapp = "packages/rom-weaver-webapp";

test("retired assets and design experiments stay out of the tracked tree", () => {
  const files = trackedFiles(root, [
    "design/social-preview.*",
    "design/icon-masters/*.svg",
    "design/logo-concepts/**",
    `${webapp}/prototypes/**`,
    `${webapp}/src/assets/powered_by_rom_patcher_js.png`,
  ]);
  assert.deepEqual(files, [], "Remove retired files; maintained design inputs belong in the webapp package");
});

test("build outputs stay out of the tracked tree", () => {
  // Generated TypeScript, published schemas, and fixed test fixtures MUST remain tracked.
  const files = trackedFiles(root, [
    "dist/**",
    "target/**",
    "docs/man/**",
    "docs/completions/**",
    "design/logo-variants/**",
    `${webapp}/dist/**`,
    `${webapp}/src/assets/app/root/channels/**`,
    `${webapp}/src/assets/app/root/*.png`,
    `${webapp}/src/assets/app/root/*.ico`,
    `${webapp}/src/wasm/*.wasm*`,
    `${webapp}/src/wasm/NOTICE`,
    `${webapp}/src/wasm/WEBAPP_NOTICE`,
    `${webapp}/src/wasm/notices.md`,
    `${webapp}/src/wasm/third_party/**`,
    `${webapp}/src/presentation/localization/locales/*.ts`,
    "crates/rom-weaver-cli/data/identify/v1/*.pack*",
    "crates/rom-weaver-cli/data/identify/v1/*.br",
    "crates/rom-weaver-cli/data/identify/v1/catalog.json",
    "crates/rom-weaver-cli/data/identify/v1/index.json",
    "crates/rom-weaver-cli/data/identify/v1/checksum-routes.bin",
    "crates/rom-weaver-cli/data/identify/v1/title-index.json",
    "crates/rom-weaver-cli/data/identify/v1/cheats-*.json",
  ]);
  assert.deepEqual(files, [], "Generate build outputs in ignored directories instead of committing them");
});
