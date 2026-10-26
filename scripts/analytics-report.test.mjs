import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bingReport,
  bingUrlInfoReport,
  buildCloudflareHostQuery,
  buildGscBody,
  cloudflareReport,
  computeDeltas,
  dateRange,
  formatSummary,
  githubReport,
  lookupSecret,
  markUnreportedDays,
  parseArgs,
  parseBingDates,
  resolveRange,
  run,
  searchConsoleInspectReport,
  searchConsoleReport,
  serviceAccountAssertion,
} from "./analytics-report.mjs";

test("parses the source and day window, rejecting bad input", () => {
  assert.equal(parseArgs(["github"]).days, 28);
  assert.equal(parseArgs(["gsc", "--days", "7"]).days, 7);
  assert.deepEqual(parseArgs(["gsc", "--days", "7"]).args, { days: 7 });
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

function withKeyFile(callback) {
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
  const env = { GSC_SERVICE_ACCOUNT_FILE: keyFile, GSC_SITE: "sc-domain:example.invalid" };
  return callback(env).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("parses the new flags into args and options", () => {
  const parsed = parseArgs([
    "gsc",
    "--start",
    "2026-02-10",
    "--end",
    "2026-02-16",
    "--page",
    "https://example.invalid/a",
    "--query-contains",
    "rom",
    "--dims",
    "query,page",
    "--fresh",
    "--compare",
    "2026-02-03:2026-02-09",
    "--summary",
  ]);
  assert.equal(parsed.start, "2026-02-10");
  assert.deepEqual(parsed.dims, ["query", "page"]);
  assert.deepEqual(parsed.compare, { start: "2026-02-03", end: "2026-02-09" });
  assert.equal(parsed.fresh, true);
  assert.equal(parsed.summary, true);
  assert.equal(parsed.args.queryContains, "rom");
  assert.deepEqual(parseArgs(["gsc-inspect", "https://example.invalid/a", "https://example.invalid/b"]).urls.length, 2);
  assert.equal(parseArgs(["cloudflare", "--host", "example.invalid"]).host, "example.invalid");
});

test("rejects bad or inapplicable arguments with clear errors", () => {
  assert.throws(() => parseArgs(["bing", "--days", "7"]), /--days does not apply to bing/);
  assert.throws(() => parseArgs(["github", "--start", "2026-01-01"]), /does not apply to github/);
  assert.throws(() => parseArgs(["cloudflare", "--page", "x"]), /--page does not apply to cloudflare/);
  assert.throws(() => parseArgs(["gsc", "--start", "2026-13-01"]), /--start must be a real date/);
  assert.throws(() => parseArgs(["gsc", "--start", "2026-02-02", "--end", "2026-02-01"]), /not be after/);
  assert.throws(() => parseArgs(["gsc", "--compare", "2026-02-01"]), /--compare must be START:END/);
  assert.throws(() => parseArgs(["gsc", "--dims", "query,bogus"]), /unknown dimension "bogus"/);
  assert.throws(() => parseArgs(["gsc", "--page"]), /--page requires a value/);
  assert.throws(() => parseArgs(["gsc-inspect"]), /needs at least one URL/);
  assert.throws(() => parseArgs(["gsc", "stray"]), /Unknown argument/);
});

test("explicit dates override --days", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  assert.deepEqual(resolveRange({ days: 7, start: "2026-01-01", end: "2026-01-02" }, now), {
    start: "2026-01-01",
    end: "2026-01-02",
  });
  assert.deepEqual(resolveRange({ days: 7, end: "2026-01-08" }, now), { start: "2026-01-01", end: "2026-01-08" });
  assert.deepEqual(resolveRange({ days: 7 }, now), { start: "2026-01-03", end: "2026-01-10" });
});

test("builds GSC filter bodies with web type and optional fresh data", () => {
  const body = buildGscBody({
    start: "2026-01-01",
    end: "2026-01-07",
    dimensions: ["query"],
    page: "https://example.invalid/a",
    queryContains: "rom",
    fresh: true,
  });
  assert.equal(body.type, "web");
  assert.equal(body.dataState, "all");
  assert.deepEqual(body.dimensionFilterGroups, [
    {
      groupType: "and",
      filters: [
        { dimension: "page", operator: "equals", expression: "https://example.invalid/a" },
        { dimension: "query", operator: "contains", expression: "rom" },
      ],
    },
  ]);
  const plain = buildGscBody({ start: "a", end: "b", dimensions: ["date"] });
  assert.equal("dimensionFilterGroups" in plain, false);
  assert.equal("dataState" in plain, false);
});

test("search console report runs the default dimension sets and sends no filter by default", async () => {
  const bodies = [];
  const result = await withKeyFile((env) =>
    searchConsoleReport({
      env,
      days: 90,
      fetchImpl: async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "access" });
        bodies.push(JSON.parse(options.body));
        return Response.json({ rows: [] });
      },
    }),
  );
  assert.deepEqual(Object.keys(result.reports), ["date", "query", "page", "page,query", "date,page"]);
  assert.equal(result.provisional, false);
  assert.ok(bodies.every((body) => body.rowLimit === 25_000 && body.startRow === 0 && body.type === "web"));
});

test("search console report pages through rows and honours --dims, --fresh", async () => {
  const starts = [];
  const full = Array.from({ length: 25_000 }, (_, index) => ({ keys: [`d${index}`], clicks: 1 }));
  const result = await withKeyFile((env) =>
    searchConsoleReport({
      env,
      dims: ["date"],
      fresh: true,
      fetchImpl: async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "access" });
        const body = JSON.parse(options.body);
        starts.push([body.startRow, body.dataState]);
        return Response.json({ rows: body.startRow === 0 ? full : [{ keys: ["last"], clicks: 2 }] });
      },
    }),
  );
  assert.deepEqual(starts, [
    [0, "all"],
    [25_000, "all"],
  ]);
  assert.deepEqual(Object.keys(result.reports), ["date"]);
  assert.equal(result.reports.date.length, 25_001);
  assert.equal(result.provisional, true);
});

test("computes per-key deltas between two ranges", () => {
  const row = (key, clicks, impressions, ctr, position) => ({ keys: [key], clicks, impressions, ctr, position });
  const deltas = computeDeltas(
    [row("/a", 10, 100, 0.1, 3), row("/new", 2, 10, 0.2, 5)],
    [row("/a", 4, 80, 0.05, 4), row("/gone", 6, 60, 0.1, 2)],
  );
  assert.deepEqual(
    deltas.map((entry) => entry.key),
    ["/a", "/gone", "/new"],
  );
  assert.deepEqual(deltas[0].delta, { clicks: 6, impressions: 20, ctr: 0.05, position: -1 });
  assert.deepEqual(deltas[1].delta, { clicks: -6, impressions: -60, ctr: -0.1, position: null });
  assert.equal(deltas[2].compare, null);
});

test("search console compare fetches both ranges and reports page and query deltas", async () => {
  const windows = [];
  const result = await withKeyFile((env) =>
    searchConsoleReport({
      env,
      start: "2026-02-10",
      end: "2026-02-16",
      compare: { start: "2026-02-03", end: "2026-02-09" },
      fetchImpl: async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "access" });
        const body = JSON.parse(options.body);
        windows.push(body.startDate);
        const clicks = body.startDate === "2026-02-10" ? 5 : 2;
        return Response.json({ rows: [{ keys: ["k"], clicks, impressions: 10, ctr: 0.5, position: 2 }] });
      },
    }),
  );
  assert.ok(windows.includes("2026-02-03") && windows.includes("2026-02-10"));
  assert.equal(result.deltas.page[0].delta.clicks, 3);
  assert.equal(result.deltas.query[0].delta.clicks, 3);
  assert.match(formatSummary({ source: "gsc", ...result }), /page deltas vs 2026-02-03\.\.2026-02-09/);
});

test("gsc-inspect posts each URL and keeps the index status fields", async () => {
  const posted = [];
  const result = await withKeyFile((env) =>
    searchConsoleInspectReport({
      env,
      urls: ["https://example.invalid/a"],
      fetchImpl: async (url, options) => {
        if (url.includes("oauth2")) return Response.json({ access_token: "access" });
        posted.push({ url, body: JSON.parse(options.body) });
        return Response.json({
          inspectionResult: { indexStatusResult: { coverageState: "Submitted and indexed", googleCanonical: "c" } },
        });
      },
    }),
  );
  assert.equal(posted[0].url, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
  assert.deepEqual(posted[0].body, { inspectionUrl: "https://example.invalid/a", siteUrl: "sc-domain:example.invalid" });
  assert.equal(result.inspections[0].coverageState, "Submitted and indexed");
  assert.equal(result.inspections[0].googleCanonical, "c");
});

test("parses Bing /Date(ms)/ values into ISO dates", () => {
  assert.equal(parseBingDates("/Date(1767225600000)/"), "2026-01-01");
  assert.equal(parseBingDates("/Date(1767225600000-0700)/"), "2026-01-01");
  assert.deepEqual(parseBingDates({ rows: [{ Date: "/Date(0)/", Query: "x" }] }), {
    rows: [{ Date: "1970-01-01", Query: "x" }],
  });
});

test("flags trailing 0/0 Bing days after a busy day as unreported", () => {
  const day = (Date, Clicks, Impressions) => ({ Date, Clicks, Impressions });
  const flagged = markUnreportedDays([day("2026-01-01", 1, 50), day("2026-01-02", 0, 0), day("2026-01-03", 0, 0)]);
  assert.deepEqual(
    flagged.traffic.map((row) => row.unreported),
    [undefined, true, true],
  );
  assert.equal(flagged.warnings.length, 1);
  const quiet = markUnreportedDays([day("2026-01-01", 0, 5), day("2026-01-02", 0, 0)]);
  assert.equal(quiet.warnings.length, 0);
  assert.equal(quiet.traffic[1].unreported, undefined);
  assert.equal(markUnreportedDays([day("2026-01-01", 0, 0), day("2026-01-02", 3, 40)]).warnings.length, 0);
});

test("bing report requests crawl, quota and page methods and exposes warnings", async () => {
  const methods = [];
  const result = await bingReport({
    env: { BING_API_KEY: "key", BING_SITE_URL: "https://example.invalid/" },
    page: "https://example.invalid/a",
    fetchImpl: async (url) => {
      const method = new URL(url).pathname.split("/").at(-1);
      methods.push(method);
      if (method === "GetRankAndTrafficStats") {
        return Response.json({
          d: [
            { Date: "/Date(1767225600000)/", Clicks: 2, Impressions: 30 },
            { Date: "/Date(1767312000000)/", Clicks: 0, Impressions: 0 },
          ],
        });
      }
      return Response.json({ d: [] });
    },
  });
  for (const method of ["GetCrawlStats", "GetCrawlIssues", "GetUrlSubmissionQuota", "GetPageQueryStats"]) {
    assert.ok(methods.includes(method), method);
  }
  assert.equal(methods.includes("GetQueryPageStats"), false);
  assert.equal(result.traffic[1].unreported, true);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual([result.start, result.end], ["2026-01-01", "2026-01-02"]);
});

test("bing-urlinfo calls GetUrlInfo per URL", async () => {
  const urls = [];
  const result = await bingUrlInfoReport({
    env: { BING_API_KEY: "key", BING_SITE_URL: "https://example.invalid/" },
    urls: ["https://example.invalid/a"],
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return Response.json({ d: { HttpCode: 200 } });
    },
  });
  assert.equal(urls[0].pathname.split("/").at(-1), "GetUrlInfo");
  assert.equal(urls[0].searchParams.get("url"), "https://example.invalid/a");
  assert.equal(result.urlInfo[0].info.HttpCode, 200);
});

test("builds one-day cloudflare host queries", () => {
  const { query, variables } = buildCloudflareHostQuery({ zoneId: "z", host: "example.invalid", day: "2026-01-09" });
  assert.match(query, /httpRequestsAdaptiveGroups/);
  assert.match(query, /clientRequestHTTPHost: \$host/);
  assert.match(query, /dimensions \{ date clientRefererHost \}/);
  assert.match(query, /edgeResponseContentTypeName: "html"/);
  assert.deepEqual(variables, {
    zone: "z",
    start: "2026-01-09T00:00:00Z",
    end: "2026-01-10T00:00:00Z",
    host: "example.invalid",
  });
});

test("cloudflare --host queries each day and rejects ranges beyond adaptive retention", async () => {
  const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ZONE_ID: "zone" };
  const queries = [];
  const result = await cloudflareReport({
    env,
    host: "example.invalid",
    start: "2026-01-01",
    end: "2026-01-03",
    fetchImpl: async (url, options) => {
      const { query, variables } = JSON.parse(options.body);
      queries.push(variables.start);
      if (!query.includes("httpRequestsAdaptiveGroups")) return Response.json({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } } });
      return Response.json({
        data: {
          viewer: {
            zones: [{ referrers: [{ count: 4, dimensions: { clientRefererHost: "google.com" } }], html: [{ count: 3 }] }],
          },
        },
      });
    },
  });
  assert.deepEqual(queries, ["2026-01-01", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z"]);
  assert.deepEqual(result.host.days[0], {
    date: "2026-01-01",
    referrers: [{ referrer: "google.com", requests: 4 }],
    htmlResponses: 3,
  });
  assert.match(result.host.note, /once per UTC day/);
  await assert.rejects(
    cloudflareReport({
      env,
      host: "example.invalid",
      start: "2026-01-01",
      end: "2026-03-01",
      fetchImpl: async () => Response.json({ data: { viewer: { zones: [] } } }),
    }),
    /narrow the range/,
  );
});

test("cloudflare --host drops referrers when the zone plan denies the field", async () => {
  const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ZONE_ID: "zone" };
  const result = await cloudflareReport({
    env,
    host: "example.invalid",
    start: "2026-01-01",
    end: "2026-01-02",
    fetchImpl: async (url, options) => {
      const { query } = JSON.parse(options.body);
      if (!query.includes("httpRequestsAdaptiveGroups")) return Response.json({ data: { viewer: { zones: [{ httpRequests1dGroups: [] }] } } });
      if (query.includes("clientRefererHost")) {
        return Response.json({ errors: [{ message: "zone 'z' does not have access to the field 'clientrefererhost'" }] });
      }
      return Response.json({ data: { viewer: { zones: [{ html: [{ count: 5 }] }] } } });
    },
  });
  assert.deepEqual(result.host.days, [
    { date: "2026-01-01", htmlResponses: 5 },
    { date: "2026-01-02", htmlResponses: 5 },
  ]);
  assert.match(result.host.warning, /referrers are omitted/);
});

test("run wraps every result in the source, args and date envelope", async () => {
  const result = await run(["github"], { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/n" }, {
    now: new Date("2026-01-10T00:00:00Z"),
    fetchImpl: async (url) => Response.json(url.includes("releases") ? [] : {}),
  });
  assert.deepEqual(
    { source: result.source, args: result.args, start: result.start, end: result.end, fetchedAt: result.fetchedAt },
    { source: "github", args: {}, start: null, end: null, fetchedAt: "2026-01-10T00:00:00.000Z" },
  );
});
