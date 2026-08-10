import assert from "node:assert/strict";
import test from "node:test";

import noSoftLineBreaks from "./markdownlint-no-soft-line-breaks.mjs";

const lintTokens = (tokens) => {
  const errors = [];
  noSoftLineBreaks.function(
    { parsers: { markdownit: { tokens } } },
    (error) => errors.push(error),
  );
  return errors;
};

test("reports prose soft breaks", () => {
  const errors = lintTokens([
    {
      children: [
        { type: "text", lineNumber: 1, line: "First line" },
        { type: "softbreak", lineNumber: 1, line: "First line" },
        { type: "text", lineNumber: 2, line: "second line." },
      ],
    },
  ]);

  assert.deepEqual(errors, [
    {
      lineNumber: 1,
      detail: "Join the prose or use an intentional hard break.",
      context: "First line",
    },
  ]);
});

test("allows structural and intentional hard breaks", () => {
  const errors = lintTokens([
    { type: "heading_open" },
    {
      children: [
        { type: "text", lineNumber: 3, line: "First line  " },
        { type: "hardbreak", lineNumber: 3, line: "First line  " },
        { type: "text", lineNumber: 4, line: "second line." },
      ],
    },
    { type: "fence" },
  ]);

  assert.deepEqual(errors, []);
});

test("allows structural line breaks inside raw HTML containers", () => {
  const errors = lintTokens([
    {
      content: '<picture>\n  <source srcset="dark.webp">\n</picture>',
      children: [
        { type: "text", lineNumber: 1, line: "<picture>" },
        { type: "softbreak", lineNumber: 1, line: "<picture>" },
        { type: "text", lineNumber: 2, line: '  <source srcset="dark.webp">' },
        { type: "softbreak", lineNumber: 2, line: '  <source srcset="dark.webp">' },
        { type: "text", lineNumber: 3, line: "</picture>" },
      ],
    },
  ]);

  assert.deepEqual(errors, []);
});
