import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bingReport,
  cloudflareReport,
  dateRange,
  githubReport,
  lookupSecret,
  parseArgs,
  searchConsoleReport,
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

const noSecrets = () => undefined;

test("reports name each missing setting and its pass entry", async () => {
  await assert.rejects(bingReport({ env: {}, lookup: noSecrets }), /BING_API_KEY \(or pass entry bing-api-key\)/);
  await assert.rejects(
    cloudflareReport({ env: {}, days: 7, lookup: noSecrets }),
    /CLOUDFLARE_API_TOKEN \(or pass entry cloudflare-token\), CLOUDFLARE_ZONE_ID \(or pass entry cloudflare-zone-id\)/,
  );
  await assert.rejects(githubReport({ env: {}, lookup: noSecrets }), /GITHUB_TOKEN \(or a logged-in gh\)/);
  await assert.rejects(searchConsoleReport({ env: {}, days: 7, lookup: noSecrets }), /gsc-service-account/);
});

test("falls back to pass entries under the default or a custom prefix", async () => {
  assert.equal(lookupSecret({ pass: "x" }, { ANALYTICS_PASS_PREFIX: "definitely/not/a/real/prefix" }), undefined);
  const requested = [];
  const lookup = (setting) => {
    requested.push(setting.pass);
    return `secret-${setting.pass}`;
  };
  let auth;
  await cloudflareReport({
    env: {},
    days: 7,
    lookup,
    fetchImpl: async (url, options) => {
      auth = options.headers.Authorization;
      return Response.json({ data: { viewer: { zones: [] } } });
    },
  });
  assert.deepEqual(requested, ["cloudflare-token", "cloudflare-zone-id"]);
  assert.equal(auth, "Bearer secret-cloudflare-token");
});

test("environment variables take precedence over the secret lookup", async () => {
  const result = await bingReport({
    env: { BING_API_KEY: "env-key", BING_SITE_URL: "https://example.invalid/" },
    lookup: () => assert.fail("lookup must not run"),
    fetchImpl: async () => Response.json({ d: [] }),
  });
  assert.deepEqual(result.traffic, []);
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

test("search console report asks for every day of the window but caps query and page rows", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "analytics-report-"));
  const keyFile = join(dir, "key.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      client_email: "reader@example.invalid",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  const limits = {};
  try {
    await searchConsoleReport({
      env: { GSC_SERVICE_ACCOUNT_FILE: keyFile, GSC_SITE: "sc-domain:example.invalid" },
      days: 90,
      fetchImpl: async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "access" });
        const { dimensions, rowLimit } = JSON.parse(options.body);
        limits[dimensions[0]] = rowLimit;
        return Response.json({ rows: [] });
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(limits, { date: 91, query: 25, page: 25 });
});
