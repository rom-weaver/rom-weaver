import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";

async function negotiate(
  accept,
  {
    method = "GET",
    path = "/",
    headers = {},
    assetStatus = 200,
    assetType = "text/markdown; charset=utf-8",
    assetRobots = "noindex",
    htmlStatus = 200,
  } = {},
) {
  const calls = [];
  const request = new Request(`https://rom-weaver.com${path}`, {
    method,
    headers: { Accept: accept, ...headers },
  });
  const response = await onRequest({
    request,
    env: {
      ASSETS: {
        fetch: async (asset) => {
          calls.push(asset.url);
          return new Response(method === "HEAD" ? null : "# Markdown", {
            status: assetStatus,
            headers: {
              "Content-Type": assetType,
              "Cross-Origin-Embedder-Policy": "require-corp",
              "X-Robots-Tag": assetRobots,
            },
          });
        },
      },
    },
    next: async () => {
      calls.push("next");
      return new Response("<html>Browser</html>", {
        status: htmlStatus,
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
          Vary: "Accept-Encoding",
          "Cross-Origin-Embedder-Policy": "require-corp",
        },
      });
    },
  });
  return { response, calls };
}

test("explicit Markdown preference selects the static file and keeps isolation", async () => {
  const { response, calls } = await negotiate("text/markdown, text/html;q=0.5");
  assert.deepEqual(calls, ["https://rom-weaver.com/index.md"]);
  assert.equal(await response.text(), "# Markdown");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
  assert.match(response.headers.get("Cache-Control"), /s-maxage=3600/);
});

test("HTML and wildcard preferences retain HTML with a separate cache variant", async () => {
  for (const accept of [
    "text/html",
    "*/*",
    "text/markdown;q=0",
    "text/markdown;q=0.1, */*",
    "text/markdown;q=oops",
    "text/markdown;q=0.5, text/html",
    "",
  ]) {
    const { response, calls } = await negotiate(accept);
    assert.deepEqual(calls, ["next"], accept);
    assert.match(await response.text(), /Browser/);
    assert.equal(response.headers.get("Vary"), "Accept-Encoding, Accept");
  }
});

test("HEAD selects Markdown headers without a body", async () => {
  const { response } = await negotiate("text/markdown", { method: "HEAD" });
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("missing or fallback Markdown assets preserve ordinary serving", async () => {
  for (const options of [{ assetStatus: 404 }, { assetType: "text/html" }]) {
    const { response, calls } = await negotiate("text/markdown", options);
    assert.equal(calls.at(-1), "next");
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
  }
});

test("other routes and methods bypass negotiation", async () => {
  for (const options of [{ path: "/mcp" }, { path: "/docs/unknown" }, { method: "POST" }]) {
    const { calls } = await negotiate("text/markdown", options);
    assert.deepEqual(calls, ["next"]);
  }
});

test("workflow HTML pages advertise their Markdown alternate", async () => {
  const { response } = await negotiate("text/html", { path: "/file-checksum" });
  assert.equal(response.headers.get("Link"), '</file-checksum.md>; rel="alternate"; type="text/markdown"');
  for (const options of [{ path: "/" }, { path: "/file-checksum", htmlStatus: 404 }, { path: "/docs/get-started" }]) {
    const { response: other } = await negotiate("text/html", options);
    assert.equal(other.headers.get("Link"), null, JSON.stringify(options));
  }
  const { response: markdown } = await negotiate("text/markdown", { path: "/file-checksum" });
  assert.equal(markdown.headers.get("Link"), null);
});

test("unsuccessful HTML responses are never cached", async () => {
  const { response } = await negotiate("text/html", { htmlStatus: 404 });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("query variants stay uncached so deployment URL purges cover cached pages", async () => {
  const { response } = await negotiate("text/markdown", { path: "/?bundle=example" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("query variants of a page name the clean URL as canonical", async () => {
  const { response } = await negotiate("text/html", { path: "/weave-rom-patches?guide=weave" });
  assert.deepEqual(response.headers.get("Link").split(", "), [
    '</weave-rom-patches.md>; rel="alternate"; type="text/markdown"',
    '<https://rom-weaver.com/weave-rom-patches>; rel="canonical"',
  ]);
  const { response: home } = await negotiate("text/html", { path: "/?bundle=example" });
  assert.equal(home.headers.get("Link"), '<https://rom-weaver.com/>; rel="canonical"');
  for (const options of [{ path: "/weave-rom-patches" }, { path: "/weave-rom-patches?guide=weave", htmlStatus: 404 }]) {
    const { response: clean } = await negotiate("text/html", options);
    assert.ok(!(clean.headers.get("Link") ?? "").includes("canonical"), JSON.stringify(options));
  }
});

test("Markdown negotiated at a page URL does not inherit the .md file's noindex", async () => {
  const { response } = await negotiate("text/markdown", { path: "/docs/get-started" });
  assert.equal(response.headers.get("X-Robots-Tag"), null);
  const { response: staging } = await negotiate("text/markdown", { assetRobots: "noindex, nofollow" });
  assert.equal(staging.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("trailing-slash canonical routes redirect 301 to the extensionless URL and keep query strings", async () => {
  for (const [path, location] of [
    ["/docs/", "/docs"],
    ["/docs/create-bundles/", "/docs/create-bundles"],
    ["/apply-rom-patches/", "/apply-rom-patches"],
    ["/apply-rom-patches/?guide=apply", "/apply-rom-patches?guide=apply"],
  ]) {
    const { response, calls } = await negotiate("text/html", { path });
    assert.deepEqual(calls, [], path);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("Location"), location, path);
    assert.equal(response.headers.get("Vary"), "X-Rom-Weaver-Precache", path);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=0, must-revalidate", path);
  }
  const { response: head } = await negotiate("text/html", { method: "HEAD", path: "/file-checksum/" });
  assert.equal(head.status, 301);
  assert.equal(head.headers.get("Location"), "/file-checksum");
  assert.equal(await head.text(), "");
});

test("offline precache directory fetches pass through without redirecting", async () => {
  const { response, calls } = await negotiate("*/*", {
    headers: { "X-Rom-Weaver-Precache": "1" },
    path: "/docs/create-bundles/",
  });
  assert.deepEqual(calls, ["next"]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
  assert.equal(response.headers.get("Vary"), "Accept-Encoding, X-Rom-Weaver-Precache");
});

test("unknown or unsafe trailing-slash paths never redirect", async () => {
  for (const path of ["/unknown/", "//evil.com/", "/docs/unknown/"]) {
    const { response, calls } = await negotiate("text/html", { path });
    assert.deepEqual(calls, ["next"], path);
    assert.equal(response.status, 200, path);
  }
});
