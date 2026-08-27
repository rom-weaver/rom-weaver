import { expect, test } from "vitest";
import { routeDocumentCandidates } from "../../src/webapp/pwa/route-documents.ts";

test("maps a guide route onto the documents the build wrote for it", () => {
  expect(routeDocumentCandidates("/docs/apply-rom-patches")).toEqual([
    "docs/apply-rom-patches/index.html",
    "docs/apply-rom-patches.html",
  ]);
});

test("ignores a trailing slash so both spellings of a route resolve alike", () => {
  expect(routeDocumentCandidates("/docs/cli/")).toEqual(routeDocumentCandidates("/docs/cli"));
});

test("keeps a request that already names its document", () => {
  expect(routeDocumentCandidates("/docs/cli/index.html")).toEqual(["docs/cli/index.html"]);
  expect(routeDocumentCandidates("/create.html")).toEqual(["create.html", "create/index.html"]);
});

test("declines the site root, which is precached under its own name", () => {
  expect(routeDocumentCandidates("/")).toEqual([]);
  expect(routeDocumentCandidates("")).toEqual([]);
});

test("emits keys the precache manifest can match, without a leading slash", () => {
  for (const candidate of routeDocumentCandidates("/ppf-undo")) {
    expect(candidate.startsWith("/")).toBe(false);
  }
});
