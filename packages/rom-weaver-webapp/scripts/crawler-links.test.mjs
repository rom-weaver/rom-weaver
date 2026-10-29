import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findCrawlerBrokenLinks, internalHrefs, pageUrlPath } from "./crawler-links.mjs";

const withDist = (files, run) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "crawler-links-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
      fs.writeFileSync(path.join(dist, name), body);
    }
    run(dist);
  } finally {
    fs.rmSync(dist, { force: true, recursive: true });
  }
};

const page = (links, head = "") =>
  `<!doctype html><head>${head}</head><body>${links.map((href) => `<a href="${href}">x</a>`).join("")}</body>`;

test("maps built files to the clean URL they are served at", () => {
  assert.equal(pageUrlPath("/d", "/d/index.html"), "/");
  assert.equal(pageUrlPath("/d", "/d/apply-patches.html"), "/apply-patches");
  assert.equal(pageUrlPath("/d", "/d/docs/guide/index.html"), "/docs/guide/");
  assert.equal(pageUrlPath("/d", "/d/apply-patches/index.html"), "/apply-patches/");
});

test("skips external, hash-only, and scheme links", () => {
  assert.deepEqual(internalHrefs(page(["https://a.test/x", "//a.test/x", "#top", "mailto:a@b.test", "/ok", "bare"])), [
    "/ok",
    "bare",
  ]);
});

test("flags a bare slug on a nested page even when <base href> would fix it", () => {
  withDist(
    {
      "apply-patches.html": page([]),
      "docs/guide.html": page(["apply-patches", "/apply-patches"], '<base href="/" />'),
      "index.html": page([]),
    },
    (dist) => {
      assert.deepEqual(findCrawlerBrokenLinks(dist), [
        { href: "apply-patches", page: "/docs/guide", pathname: "/docs/apply-patches" },
      ]);
    },
  );
});

test("accepts root links, directory indexes, and bare slugs on root pages", () => {
  withDist(
    {
      "apply-patches.html": page(["docs/guide", "/docs/guide#a", "/"]),
      "docs/guide/index.html": page(["/apply-patches"]),
      "index.html": page(["apply-patches"]),
    },
    (dist) => assert.deepEqual(findCrawlerBrokenLinks(dist), []),
  );
});

test("allowed paths are served by functions, not files", () => {
  withDist({ "index.html": page(["/docs/x.md"]) }, (dist) => {
    assert.equal(findCrawlerBrokenLinks(dist).length, 1);
    assert.deepEqual(findCrawlerBrokenLinks(dist, { allowed: ["/docs/x.md"] }), []);
  });
});

test("a malformed percent escape is a broken link, not a crash", () => {
  withDist({ "index.html": page(["/apply-patches%E0%A4%A"]) }, (dist) => {
    assert.equal(findCrawlerBrokenLinks(dist).length, 1);
  });
});

test("paths the host redirects are not broken", () => {
  withDist(
    {
      _redirects: "# legacy\n/docs/formats /docs/work-with-archives 301\n",
      "index.html": page(["/docs/formats", "/gone"]),
    },
    (dist) =>
      assert.deepEqual(
        findCrawlerBrokenLinks(dist).map((link) => link.pathname),
        ["/gone"],
      ),
  );
});

test("flags a bare slug on a directory-index copy that only its <base> would fix", () => {
  withDist(
    {
      "apply-patches/index.html": page(["compress"], '<base href="../" />'),
      "compress.html": page([]),
      "index.html": page([]),
    },
    (dist) => {
      assert.deepEqual(findCrawlerBrokenLinks(dist), [
        { href: "compress", page: "/apply-patches/", pathname: "/apply-patches/compress" },
      ]);
    },
  );
});
