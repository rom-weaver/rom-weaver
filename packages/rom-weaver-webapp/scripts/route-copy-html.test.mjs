import assert from "node:assert/strict";
import test from "node:test";
import { rootRelativeAnchors } from "./vite-config/route-copy-html.mjs";

test("roots bare and nested anchor hrefs", () => {
  assert.equal(
    rootRelativeAnchors('<a class="nav-row" href="compress-files">x</a><a href="docs/apply-rom-patches#a">y</a>'),
    '<a class="nav-row" href="/compress-files">x</a><a href="/docs/apply-rom-patches#a">y</a>',
  );
});

test("leaves rooted, fragment, query, and scheme hrefs alone", () => {
  const html =
    '<a href="/docs">a</a><a href="#top">b</a><a href="?x=1">c</a><a href="https://a.test/">d</a><a href="mailto:a@b.test">e</a>';
  assert.equal(rootRelativeAnchors(html), html);
});

test("leaves non-anchor URLs to <base>", () => {
  const html = '<link rel="stylesheet" href="assets/a.css"><script src="assets/a.js"></script>';
  assert.equal(rootRelativeAnchors(html), html);
});
