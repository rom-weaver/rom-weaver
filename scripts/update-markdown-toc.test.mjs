import assert from "node:assert/strict";
import test from "node:test";

import { tocFiles } from "./update-markdown-toc.mjs";

test("only passes Markdown files and docs directories to doctoc", () => {
  assert.deepEqual(tocFiles(["README.md", "docs", "docs/example.md", "docs/data.json"]), { readme: true, other: ["docs", "docs/example.md"] });
});
