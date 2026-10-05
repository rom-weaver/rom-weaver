import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";

async function negotiate(
  accept,
  { method = "GET", path = "/", assetStatus = 200, assetType = "text/markdown; charset=utf-8", htmlStatus = 200 } = {},
) {
  const calls = [];
  const request = new Request(`https://rom-weaver.com${path}`, { method, headers: { Accept: accept } });
  const response = await onRequest({
    request,
    env: {
      ASSETS: {
        fetch: async (asset) => {
          calls.push(asset.url);
          return new Response(method === "HEAD" ? null : "# Markdown", {
            status: assetStatus,
            headers: { "Content-Type": assetType, "Cross-Origin-Embedder-Policy": "require-corp" },
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

test("unsuccessful HTML responses are never cached", async () => {
  const { response } = await negotiate("text/html", { htmlStatus: 404 });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("query variants stay uncached so deployment URL purges cover cached pages", async () => {
  const { response } = await negotiate("text/markdown", { path: "/?bundle=example" });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
