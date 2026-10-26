import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import test from "node:test";
import {
  bingReport,
  cloudflareReport,
  dateRange,
  githubReport,
  parseArgs,
  serviceAccountAssertion,
} from "./analytics-report.mjs";

test("parses the source and day window, rejecting bad input", () => {
  assert.deepEqual(parseArgs(["github"]), { source: "github", days: 28 });
  assert.deepEqual(parseArgs(["gsc", "--days", "7"]), { source: "gsc", days: 7 });
  assert.throws(() => parseArgs(["nope"]), /Usage/);
  assert.throws(() => parseArgs(["gsc", "--days", "0"]), /--days/);
  assert.throws(() => parseArgs(["gsc", "--bogus"]), /Unknown argument/);
});

test("computes an inclusive UTC date window", () => {
  assert.deepEqual(dateRange(7, new Date("2026-01-10T12:00:00Z")), { start: "2026-01-03", end: "2026-01-10" });
});

test("signs a read-only service-account assertion that verifies against the public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = {
    client_email: "reader@example.invalid",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const [head, body, signature] = serviceAccountAssertion(key, 1000).split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.iss, key.client_email);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/webmasters.readonly");
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, signature, "base64url"));
});

test("reports name the missing environment variables", async () => {
  await assert.rejects(bingReport({ env: {} }), /BING_API_KEY, BING_SITE_URL/);
  await assert.rejects(cloudflareReport({ env: {}, days: 7 }), /CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID/);
  await assert.rejects(githubReport({ env: {} }), /GITHUB_TOKEN, GITHUB_REPOSITORY/);
});

test("cloudflare report sends a bearer token and returns daily groups", async () => {
  const requests = [];
  const result = await cloudflareReport({
    env: { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ZONE_ID: "zone" },
    days: 7,
    now: new Date("2026-01-10T00:00:00Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ data: { viewer: { zones: [{ httpRequests1dGroups: [{ sum: { requests: 3 } }] }] } } });
    },
  });
  assert.equal(requests[0].options.headers.Authorization, "Bearer token");
  assert.deepEqual(JSON.parse(requests[0].options.body).variables, {
    zone: "zone",
    start: "2026-01-03",
    end: "2026-01-10",
  });
  assert.equal(result.days[0].sum.requests, 3);
});

test("cloudflare report surfaces GraphQL errors and HTTP failures without echoing the token", async () => {
  const env = { CLOUDFLARE_API_TOKEN: "secret-token", CLOUDFLARE_ZONE_ID: "zone" };
  await assert.rejects(
    cloudflareReport({ env, days: 7, fetchImpl: async () => Response.json({ errors: [{ message: "denied" }] }) }),
    /denied/,
  );
  await assert.rejects(
    cloudflareReport({ env, days: 7, fetchImpl: async () => new Response("{}", { status: 403 }) }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes("secret-token"),
  );
});

test("github report totals release asset downloads per tag", async () => {
  const result = await githubReport({
    env: { GITHUB_TOKEN: "token", GITHUB_REPOSITORY: "owner/name" },
    fetchImpl: async (url) =>
      Response.json(
        url.includes("releases")
          ? [{ tag_name: "v1", assets: [{ download_count: 2 }, { download_count: 3 }] }]
          : { count: 1 },
      ),
  });
  assert.deepEqual(result.downloads, [{ tag: "v1", assets: 5 }]);
});

test("bing report unwraps the response envelope", async () => {
  const result = await bingReport({
    env: { BING_API_KEY: "key", BING_SITE_URL: "https://example.invalid/" },
    fetchImpl: async () => Response.json({ d: [{ Clicks: 1 }] }),
  });
  assert.deepEqual(result.traffic, [{ Clicks: 1 }]);
});
