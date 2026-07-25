import assert from "node:assert/strict";
import test from "node:test";

import { stripAiAttribution } from "./strip-ai-attribution.mjs";

test("removes AI credits while preserving meaningful spacing", () => {
  assert.equal(stripAiAttribution("title\n\nCo-authored-by: Codex <x>\n\nbody\n"), "title\n\n\nbody\n");
  assert.equal(stripAiAttribution("Generated with [Claude Code]\n"), "");
});
