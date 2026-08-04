import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_PURGE_PATHS,
  documentPurgeUrls,
  purgeDocumentCache,
} from "./purge-cloudflare-html-cache.mjs";

test("purges every generated document alias in Cloudflare-sized batches", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { status: 200, json: async () => ({ success: true }) };
  };

  const result = await purgeDocumentCache({
    zoneId: "zone",
    token: "token",
    host: "rom-weaver.com",
    fetchImpl,
  });

  assert.equal(result.status, "purged");
  assert.equal(result.urlCount, DOCUMENT_PURGE_PATHS.length);
  assert.equal(result.requestCount, requests.length);
  assert.ok(requests.length > 1);
  assert.deepEqual(
    requests.flatMap(({ options }) => JSON.parse(options.body).files),
    documentPurgeUrls("rom-weaver.com"),
  );
  assert.ok(requests.every(({ options }) => JSON.parse(options.body).files.length <= 30));
});

test("does not purge when the zone secret is not configured", async () => {
  const result = await purgeDocumentCache({
    token: "token",
    host: "rom-weaver.com",
    fetchImpl: async () => {
      throw new Error("not called");
    },
  });
  assert.deepEqual(result, { status: "skipped", urlCount: 0, requestCount: 0 });
});

test("rejects hosts outside the production channel zone", () => {
  assert.throws(() => documentPurgeUrls("rom-weaver-preview.pages.dev"), /unknown Cloudflare host/);
});
