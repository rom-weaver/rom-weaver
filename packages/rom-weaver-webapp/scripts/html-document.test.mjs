import assert from "node:assert/strict";
import { test } from "node:test";
import { countVisibleWords, hasDescriptiveHeading } from "./html-document.mjs";
import { minifyInlineScripts } from "./minify-inline-scripts.mjs";
import { minifyDocumentHead } from "./vite-config/minify-document-inline-scripts.mjs";

test("word counts exclude script and style bodies with browser-valid end tags", () => {
  assert.equal(
    countVisibleWords(
      "<body>real words<script>hidden source</script ignored> visible<style>hidden styles</style ignored></body>",
    ),
    3,
  );
  assert.equal(countVisibleWords("<body><!-- hidden words --><p>one&nbsp;two</p></body>"), 2);
  assert.equal(countVisibleWords("<body><script>hidden</script></body>"), 0);
});

test("heading checks decode entities and parse nested markup and uppercase tags", () => {
  assert.equal(hasDescriptiveHeading('<h1><span title="a > b">ROM&#32;Weaver</span></h1>', "ROM Weaver"), false);
  assert.equal(hasDescriptiveHeading("<H1>Patch &amp; verify</H1 ignored>", "ROM Weaver"), true);
  assert.equal(hasDescriptiveHeading('<script>"<h1>fake</h1>"</script><h1>Patch</h1>', "ROM Weaver"), true);
  assert.equal(hasDescriptiveHeading("<h1> </h1>", "ROM Weaver"), false);
  assert.equal(hasDescriptiveHeading("<h1>Patch</h1><h1>Verify</h1>", "ROM Weaver"), false);
});

test("head spacing preserves raw text and body bytes with noncanonical end tags", () => {
  const raw =
    '<SCRIPT data-note="a > b">window.text = "a>  <b";</SCRIPT ignored><STYLE>p { content: "a>  <b"; }</STYLE >';
  const body = "<body>  <pre> a\n b </pre></body>";
  assert.equal(
    minifyDocumentHead(`<HEAD data-note="a > b"> \n ${raw} \n <meta charset="UTF-8"> \n </HEAD >${body}`),
    `<HEAD data-note="a > b">${raw}<meta charset="UTF-8"></HEAD >${body}`,
  );
});

test("inline minification uses parsed attributes and preserves source tags", () => {
  const html = '<SCRIPT data-note="a > b" TYPE=module>window.a = 1; // note\n</SCRIPT ignored><body> x </body>';
  assert.equal(
    minifyInlineScripts(html),
    '<SCRIPT data-note="a > b" TYPE=module>window.a=1;</SCRIPT ignored><body> x </body>',
  );
  for (const script of [
    "<script type='application/ld+json'>{\"a\": 1}</script>",
    '<script type=application/json>{"a": 1}</script>',
    "<script src> fallback </script>",
    '<script data-src="x">window.a = 1;</script>',
  ]) {
    const expected = script.includes("data-src") ? script.replace("window.a = 1;", "window.a=1;") : script;
    assert.equal(minifyInlineScripts(script), expected);
  }
  const fake = "<!-- <script>const = ;</script> --><textarea><script>const = ;</script></textarea>";
  assert.equal(minifyInlineScripts(fake), fake);
});
