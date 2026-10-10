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

test("reports line breaks inside code spans", () => {
  const errors = lintTokens([
    {
      lineNumber: 5,
      content: "Prose first.\nRun `rom-weaver <command>\n--help` or ``a\nb``.",
      children: [],
    },
  ]);

  assert.deepEqual(errors, [
    {
      lineNumber: 6,
      detail: "Join the code span onto one line.",
      context: "Run `rom-weaver <command>",
    },
    {
      lineNumber: 7,
      detail: "Join the code span onto one line.",
      context: "--help` or ``a",
    },
  ]);
});

test("ignores backticks inside autolinks and inline HTML", () => {
  const errors = lintTokens([
    {
      lineNumber: 3,
      content: 'See <a title="`x\ny`">z</a> and <https://e.com/`a> then `b\nc` end.',
      children: [],
    },
  ]);

  assert.deepEqual(errors, [
    {
      lineNumber: 4,
      detail: "Join the code span onto one line.",
      context: 'y`">z</a> and <https://e.com/`a> then `b',
    },
  ]);
});

test("matches markdown-it for comments, processing instructions, declarations, and CDATA", () => {
  const errors = lintTokens([
    {
      lineNumber: 1,
      content: "A <?php `x\ny` ?> <!DOCTYPE `x\ny`> <![CDATA[ `x\ny` ]]> <!-- `x\ny` --> end.",
      children: [],
    },
    { lineNumber: 7, content: "B <!--> `p\nq` -->", children: [] },
    { lineNumber: 9, content: "C <![CDATA[ ` ]]> `r\ns` end.", children: [] },
  ]);

  assert.deepEqual(
    errors.map(({ lineNumber, context }) => ({ lineNumber, context })),
    [
      { lineNumber: 7, context: "B <!--> `p" },
      { lineNumber: 9, context: "C <![CDATA[ ` ]]> `r" },
    ],
  );
});

test("allows one-line code spans, escaped backticks, and unmatched backticks", () => {
  const errors = lintTokens([
    {
      lineNumber: 1,
      content: "Use `code` and ``a ` b``.\nAn escaped \\` stays prose,\nand a lone ` never opens a span.",
      children: [],
    },
    { type: "fence", lineNumber: 4, content: "`one\ntwo`\n" },
  ]);

  assert.deepEqual(errors, []);
});
