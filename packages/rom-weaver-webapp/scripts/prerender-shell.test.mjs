import assert from "node:assert/strict";
import test from "node:test";
import { injectPrerenderedShell, PRERENDER_MOUNT_POINT } from "./vite-config/prerender-shell.mjs";

test("injectPrerenderedShell keeps replacement patterns in the shell literal", () => {
  // The channel badge renders the label into the shell, so a label can carry `$&`.
  const shell = '<button aria-label="QA $& $1, v1.0.0">QA</button>';
  const html = injectPrerenderedShell(`<body>${PRERENDER_MOUNT_POINT}</body>`, shell);
  assert.equal(html.split('id="webapp-root"').length - 1, 1);
  assert.ok(html.includes(shell), html);
});
