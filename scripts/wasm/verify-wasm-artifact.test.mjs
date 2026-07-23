import assert from "node:assert/strict";
import test from "node:test";

import { getRequiredArtifactFiles } from "./verify-wasm-artifact.mjs";

test("development artifacts do not require the production Brotli sibling", () => {
  assert.deepEqual(getRequiredArtifactFiles({ dev: true }), ["rom-weaver-app.wasm", "NOTICE"]);
  assert.ok(getRequiredArtifactFiles().includes("rom-weaver-app.wasm.br"));
});
