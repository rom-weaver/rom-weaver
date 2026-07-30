import assert from "node:assert/strict";
import test from "node:test";

import { tocFiles } from "./update-markdown-toc.mjs";

const withHeadings = () => true;

test("only passes Markdown files and docs directories to doctoc", () => {
  assert.deepEqual(tocFiles(["README.md", "docs", "docs/example.md", "docs/data.json"], undefined, withHeadings), { readme: true, other: ["docs", "docs/example.md"] });
});

test("skips a Markdown file with no level-2 heading to build a contents list from", () => {
  const headings = (file) => file !== "docs/index.md";
  assert.deepEqual(tocFiles(["docs/index.md", "docs/guide.md"], () => false, headings), { readme: false, other: ["docs/guide.md"] });
});

test("still walks a directory, whose files doctoc filters itself", () => {
  assert.deepEqual(tocFiles(["docs"], () => true, () => false), { readme: false, other: ["docs"] });
});
