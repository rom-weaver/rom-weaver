import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MARKDOWN_ROUTES } from "../../packages/rom-weaver-webapp/functions/markdown-routes.js";
import { pageUrls, purgePagesCache } from "./purge-cloudflare-pages-cache.mjs";

test("purges every published HTML and markdown URL, without assets or header variants", async () => {
  const requests = [];
  const waits = [];
  const result = await purgePagesCache({
    zoneId: "zone",
    token: "token",
    domain: "rom-weaver.com",
    sleep: async (ms) => waits.push(ms),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ success: true });
    },
  });
  const files = requests.flatMap(({ options }) => JSON.parse(options.body).files);
  assert.deepEqual(files, pageUrls("rom-weaver.com"));
  assert.ok(result.startsWith("purged"));
  assert.ok(files.includes("https://rom-weaver.com/index.md"));
  for (const { path, markdownPath } of MARKDOWN_ROUTES) {
    assert.ok(files.includes(`https://rom-weaver.com${path}`));
    assert.ok(files.includes(`https://rom-weaver.com${markdownPath}`));
  }
  for (const { url, options } of requests) {
    assert.equal(url, "https://api.cloudflare.com/client/v4/zones/zone/purge_cache");
    assert.equal(options.headers.Authorization, "Bearer token");
    assert.deepEqual(Object.keys(JSON.parse(options.body)), ["files"]);
    assert.ok(JSON.parse(options.body).files.length <= 100);
  }
  assert.equal(waits.length, requests.length - 1);
  assert.ok(files.every((url) => typeof url === "string" && !url.includes("/assets/")));
});

test("only supported custom domains can be purged, and absent zone skips API", async () => {
  for (const domain of ["beta.rom-weaver.com", "nightly.rom-weaver.com"])
    assert.ok(pageUrls(domain).every((url) => url.startsWith(`https://${domain}/`)));
  assert.throws(() => pageUrls("pr-1.rom-weaver-preview.pages.dev"), /unsupported domain/);
  assert.equal(await purgePagesCache({ fetchImpl: () => assert.fail("unexpected fetch") }), "skipped");
});

test("retries rate limiting with Retry-After and limits transient failures", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(
    purgePagesCache({
      zoneId: "zone",
      domain: "rom-weaver.com",
      sleep: async (ms) => waits.push(ms),
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          { success: false, errors: [{ message: "rate limited" }] },
          { status: 429, headers: { "Retry-After": "2" } },
        );
      },
    }),
    /HTTP 429[\s\S]*rate limited/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test("fails without retrying permanent purge errors", async () => {
  await assert.rejects(
    purgePagesCache({
      zoneId: "zone",
      domain: "rom-weaver.com",
      sleep: () => assert.fail("unexpected sleep"),
      fetchImpl: async () =>
        Response.json({ success: false, errors: [{ message: "permission denied" }] }, { status: 403 }),
    }),
    /HTTP 403[\s\S]*permission denied/,
  );
  await assert.rejects(
    purgePagesCache({
      zoneId: "zone",
      domain: "rom-weaver.com",
      fetchImpl: async () => Response.json({ success: false }),
    }),
    /HTTP 200/,
  );
});

test("deployment purges only successful custom-domain uploads", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(
    workflow,
    /name: Purge negotiated page cache after custom-domain deployment\n\s+if: steps.freshness.outputs.fresh == 'true' && \(success\(\) && matrix.target.channel != 'preview' && steps.pages.outputs.url != ''\)/,
  );
  assert.match(workflow, /DEPLOYMENT_DOMAIN: \$\{\{ matrix.target.env \}\}/);
});
