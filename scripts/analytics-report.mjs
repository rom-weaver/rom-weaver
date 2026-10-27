#!/usr/bin/env node

// Read-only traffic reports. Prints JSON for one source; every result starts with
// `{source, args, start, end, fetchedAt}`:
//   node scripts/analytics-report.mjs <gsc|bing|cloudflare|github> [options]
//   node scripts/analytics-report.mjs gsc-inspect <url...>
//   node scripts/analytics-report.mjs bing-urlinfo <url...>
//
// Dates (gsc, cloudflare): `--days N` covers N days ago through today (UTC, today still
// partial); `--start YYYY-MM-DD --end YYYY-MM-DD` override it (a lone `--start` ends today).
// bing and github return fixed history windows and reject --days/--start/--end.
//
// gsc options: --page URL, --query TEXT (exact match), --page-contains TEXT,
//   --query-contains TEXT, --dims a,b (only that dimension set instead of the defaults
//   date, query, page, page+query, date+page), --fresh (include not-yet-final data; the
//   output is marked provisional), --compare START:END (same query for a second range plus
//   per-page and per-query deltas, current minus compare).
// bing options: --page URL (GetPageQueryStats), --query TEXT (GetQueryPageStats).
// cloudflare options: --host HOSTNAME (top referrers and HTML responses for that host,
//   one query per UTC day because adaptive datasets cap the queryable range).
// gsc --summary prints a compact table to stderr; JSON stays on stdout.
//
// Examples:
//   # Queries that reached one page over the last 28 days
//   node scripts/analytics-report.mjs gsc --page https://rom-weaver.com/docs/ --dims query
//   # Compare two weeks for a page (clicks, impressions, CTR, position deltas)
//   node scripts/analytics-report.mjs gsc --page https://rom-weaver.com/docs/ \
//     --start 2026-02-10 --end 2026-02-16 --compare 2026-02-03:2026-02-09 --summary
//   # Is a URL indexed? Coverage, last crawl, canonicals, robots and fetch state
//   node scripts/analytics-report.mjs gsc-inspect https://rom-weaver.com/docs/
//   # Bing crawl issues and crawl stats
//   node scripts/analytics-report.mjs bing | jq '{crawlIssues, crawlStats}'
//
// The gsc scope stays `webmasters.readonly`; Google lists it (or `webmasters`) as sufficient
// for urlInspection.index.inspect, so no wider scope is needed.
//
// Each setting comes from its environment variable first. Secrets then fall back to the
// `pass` entry `<prefix>/<entry>` (prefix `rom-weaver`, or ANALYTICS_PASS_PREFIX), and
// GITHUB_TOKEN to `gh auth token`. Site settings default to this project's public values.
//   gsc         GSC_SERVICE_ACCOUNT_FILE (key JSON path) or pass entry `gsc-service-account`
//               (the key JSON); GSC_SITE (`sc-domain:example.com` or a URL-prefix property)
//   bing        BING_API_KEY (`bing-api-key`), BING_SITE_URL
//   cloudflare  CLOUDFLARE_API_TOKEN (`cloudflare-token`, Zone Analytics: Read),
//               CLOUDFLARE_ZONE_ID (`cloudflare-zone-id`)
//   github      GITHUB_TOKEN (repo access), GITHUB_REPOSITORY (`owner/name`)

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SOURCES = ["gsc", "bing", "cloudflare", "github", "gsc-inspect", "bing-urlinfo"];
const URL_SOURCES = ["gsc-inspect", "bing-urlinfo"];
const DEFAULT_DAYS = 28;

const DEFAULT_PASS_PREFIX = "rom-weaver";

// Reads a secret from `pass` (or `gh auth token`); undefined when unavailable or locked.
export function lookupSecret({ pass, gh }, env) {
  const [command, args] = gh
    ? ["gh", ["auth", "token"]]
    : ["pass", ["show", `${env.ANALYTICS_PASS_PREFIX ?? DEFAULT_PASS_PREFIX}/${pass}`]];
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

// Each setting is `{ name, pass?, gh?, fallback? }`: the environment variable wins, then the
// secret lookup, then the public default.
function resolveSettings(env, lookup, ...settings) {
  const values = settings.map((setting) => env[setting.name] || lookup(setting, env) || setting.fallback);
  const missing = settings.filter((_, index) => !values[index]).map(describeSetting);
  if (missing.length > 0) throw new Error(`Missing setting(s): ${missing.join(", ")}`);
  return values;
}

function describeSetting({ name, pass, gh }) {
  if (pass) return `${name} (or pass entry ${pass})`;
  return gh ? `${name} (or a logged-in gh)` : name;
}

const DATE_SOURCES = ["gsc", "cloudflare"];
const GSC_DIMENSIONS = ["date", "query", "page", "country", "device", "searchAppearance"];
const DEFAULT_GSC_DIMS = [["date"], ["query"], ["page"], ["page", "query"], ["date", "page"]];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// `value: false` flags take no argument. Sources not listed get a clear "does not apply" error.
const FLAGS = {
  "--days": { key: "days", value: true, sources: DATE_SOURCES },
  "--start": { key: "start", value: true, sources: DATE_SOURCES },
  "--end": { key: "end", value: true, sources: DATE_SOURCES },
  "--summary": { key: "summary", value: false, sources: ["gsc"] },
  "--fresh": { key: "fresh", value: false, sources: ["gsc"] },
  "--page": { key: "page", value: true, sources: ["gsc", "bing"] },
  "--query": { key: "query", value: true, sources: ["gsc", "bing"] },
  "--page-contains": { key: "pageContains", value: true, sources: ["gsc"] },
  "--query-contains": { key: "queryContains", value: true, sources: ["gsc"] },
  "--dims": { key: "dims", value: true, sources: ["gsc"] },
  "--compare": { key: "compare", value: true, sources: ["gsc"] },
  "--host": { key: "host", value: true, sources: ["cloudflare"] },
};

function checkDate(value, flag) {
  if (!DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${flag} must be a real date as YYYY-MM-DD`);
  }
  return value;
}

export function parseCompare(value) {
  const [start, end, ...extra] = value.split(":");
  if (!start || !end || extra.length > 0) throw new Error("--compare must be START:END (YYYY-MM-DD:YYYY-MM-DD)");
  const range = { start: checkDate(start, "--compare start"), end: checkDate(end, "--compare end") };
  if (range.start > range.end) throw new Error("--compare start must not be after its end");
  return range;
}

export function parseArgs(argv) {
  const [source, ...rest] = argv;
  if (!SOURCES.includes(source)) {
    throw new Error(`Usage: analytics-report.mjs <${SOURCES.join("|")}> [options] (see the script header)`);
  }
  const given = {};
  const urls = [];
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const spec = FLAGS[flag];
    if (!spec) {
      if (URL_SOURCES.includes(source) && !flag.startsWith("--")) {
        urls.push(flag);
        continue;
      }
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (!spec.sources.includes(source)) {
      const reason = ["--days", "--start", "--end"].includes(flag) && ["bing", "github"].includes(source)
        ? " (it reports a fixed history window)"
        : "";
      throw new Error(`${flag} does not apply to ${source}${reason}`);
    }
    if (!spec.value) {
      given[spec.key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    given[spec.key] = value;
    index += 1;
  }
  if (URL_SOURCES.includes(source) && urls.length === 0) throw new Error(`${source} needs at least one URL`);
  const days = given.days === undefined ? DEFAULT_DAYS : Number(given.days);
  if (!Number.isInteger(days) || days < 1 || days > 480) throw new Error("--days must be an integer from 1 to 480");
  if (given.start !== undefined) checkDate(given.start, "--start");
  if (given.end !== undefined) checkDate(given.end, "--end");
  if (given.start && given.end && given.start > given.end) throw new Error("--start must not be after --end");
  // Deltas come from the single `page` and `query` sets, so any other --dims would compare nothing.
  if (given.compare !== undefined && given.dims !== undefined && !["page", "query"].includes(given.dims.trim())) {
    throw new Error("--compare needs the default dimension sets, --dims page, or --dims query");
  }
  const options = {
    source,
    days,
    start: given.start,
    end: given.end,
    urls,
    page: given.page,
    query: given.query,
    pageContains: given.pageContains,
    queryContains: given.queryContains,
    fresh: Boolean(given.fresh),
    summary: Boolean(given.summary),
    host: given.host,
    compare: given.compare === undefined ? undefined : parseCompare(given.compare),
    dims: given.dims === undefined ? undefined : parseDims(given.dims),
  };
  const args = { ...given };
  if (given.days !== undefined) args.days = days;
  if (urls.length > 0) args.urls = urls;
  return { ...options, args };
}

function parseDims(value) {
  const dims = value.split(",").map((dim) => dim.trim());
  const bad = dims.find((dim) => !GSC_DIMENSIONS.includes(dim));
  if (bad !== undefined) throw new Error(`--dims: unknown dimension "${bad}" (use ${GSC_DIMENSIONS.join(", ")})`);
  if (new Set(dims).size !== dims.length) throw new Error("--dims must not repeat a dimension");
  return dims;
}

export function dateRange(days, now = new Date()) {
  const day = (date) => date.toISOString().slice(0, 10);
  return { start: day(new Date(now.getTime() - days * 86_400_000)), end: day(now) };
}

// An explicit --start/--end wins over --days; a lone --start ends today, a lone --end
// starts `days` before it.
export function resolveRange({ days = DEFAULT_DAYS, start, end }, now = new Date()) {
  const base = end ? new Date(`${end}T00:00:00Z`) : now;
  const fallback = dateRange(days, base);
  const range = { start: start ?? fallback.start, end: end ?? fallback.end };
  if (range.start > range.end) throw new Error(`--start ${range.start} is after the range end ${range.end}`);
  return range;
}

export function eachDay({ start, end }) {
  const days = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
}

export function serviceAccountAssertion(key, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url")}`;
}

async function getJson(fetchImpl, label, url, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return body;
}

const GSC_ROW_LIMIT = 25_000;
const GSC_METRICS = ["clicks", "impressions", "ctr", "position"];

export function buildGscBody({ start, end, dimensions, page, query, pageContains, queryContains, fresh }) {
  const filters = [
    page && { dimension: "page", operator: "equals", expression: page },
    pageContains && { dimension: "page", operator: "contains", expression: pageContains },
    query && { dimension: "query", operator: "equals", expression: query },
    queryContains && { dimension: "query", operator: "contains", expression: queryContains },
  ].filter(Boolean);
  return {
    startDate: start,
    endDate: end,
    type: "web",
    dimensions,
    ...(filters.length > 0 && { dimensionFilterGroups: [{ groupType: "and", filters }] }),
    ...(fresh && { dataState: "all" }),
  };
}

// Compares rows keyed by their first dimension; `delta` is current minus compare. A key missing
// from one range counts as zero for the additive metrics and has no position delta.
export function computeDeltas(currentRows, compareRows) {
  const key = (row) => row.keys[0];
  const current = new Map(currentRows.map((row) => [key(row), row]));
  const compare = new Map(compareRows.map((row) => [key(row), row]));
  return [...new Set([...current.keys(), ...compare.keys()])]
    .map((name) => {
      const now = current.get(name);
      const before = compare.get(name);
      const delta = {};
      for (const metric of GSC_METRICS) {
        const missing = metric === "position" && (!now || !before);
        delta[metric] = missing ? null : (now?.[metric] ?? 0) - (before?.[metric] ?? 0);
      }
      return { key: name, current: now ?? null, compare: before ?? null, delta };
    })
    .sort((a, b) => Math.abs(b.delta.clicks) - Math.abs(a.delta.clicks) || a.key.localeCompare(b.key));
}

async function gscAccessToken({ env, fetchImpl, lookup }) {
  const [site] = resolveSettings(env, lookup, { name: "GSC_SITE", fallback: "sc-domain:rom-weaver.com" });
  const keyJson = env.GSC_SERVICE_ACCOUNT_FILE
    ? readFileSync(env.GSC_SERVICE_ACCOUNT_FILE, "utf8")
    : lookup({ pass: "gsc-service-account" }, env);
  if (!keyJson) throw new Error("Missing setting(s): GSC_SERVICE_ACCOUNT_FILE (or pass entry gsc-service-account)");
  const key = JSON.parse(keyJson);
  const grant = await getJson(fetchImpl, "Google token endpoint", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(key),
    }),
  });
  return { site, accessToken: grant.access_token };
}

const googleHeaders = (accessToken) => ({ Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" });

export async function searchConsoleReport({ env, fetchImpl = globalThis.fetch, now, lookup = lookupSecret, ...options }) {
  const { site, accessToken } = await gscAccessToken({ env, fetchImpl, lookup });
  const range = resolveRange(options, now);
  const dimensionSets = options.dims ? [options.dims] : DEFAULT_GSC_DIMS;
  // Pages through every row of one query, 25000 at a time.
  const query = async (dimensions, window) => {
    const rows = [];
    for (let startRow = 0; ; startRow += GSC_ROW_LIMIT) {
      const body = { ...buildGscBody({ ...options, ...window, dimensions }), rowLimit: GSC_ROW_LIMIT, startRow };
      const page = await getJson(
        fetchImpl,
        "Search Console",
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
        { method: "POST", headers: googleHeaders(accessToken), body: JSON.stringify(body) },
      );
      rows.push(...(page.rows ?? []));
      if ((page.rows ?? []).length < GSC_ROW_LIMIT) return rows;
    }
  };
  const collect = async (window) =>
    Object.fromEntries(
      await Promise.all(dimensionSets.map(async (dimensions) => [dimensions.join(","), await query(dimensions, window)])),
    );
  const reports = await collect(range);
  const result = { ...range, site, provisional: Boolean(options.fresh), reports };
  if (options.compare) {
    const compareReports = await collect(options.compare);
    result.compare = { ...options.compare, reports: compareReports };
    result.deltas = {};
    for (const dimension of ["page", "query"]) {
      if (reports[dimension]) result.deltas[dimension] = computeDeltas(reports[dimension], compareReports[dimension]);
    }
  }
  return result;
}

export async function searchConsoleInspectReport({ env, urls, fetchImpl = globalThis.fetch, lookup = lookupSecret }) {
  const { site, accessToken } = await gscAccessToken({ env, fetchImpl, lookup });
  const inspections = [];
  for (const url of urls) {
    const body = await getJson(
      fetchImpl,
      "Search Console URL inspection",
      "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
      {
        method: "POST",
        headers: googleHeaders(accessToken),
        body: JSON.stringify({ inspectionUrl: url, siteUrl: site }),
      },
    );
    const index = body.inspectionResult?.indexStatusResult ?? {};
    inspections.push({
      url,
      verdict: index.verdict,
      coverageState: index.coverageState,
      lastCrawlTime: index.lastCrawlTime,
      googleCanonical: index.googleCanonical,
      userCanonical: index.userCanonical,
      robotsTxtState: index.robotsTxtState,
      indexingState: index.indexingState,
      pageFetchState: index.pageFetchState,
    });
  }
  return { site, inspections };
}

const BING_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

// Bing returns dates as `/Date(1700000000000)/` (optionally with a zone offset); rewrites them
// to ISO `YYYY-MM-DD` throughout a response.
export function parseBingDates(value) {
  if (typeof value === "string") {
    const match = BING_DATE.exec(value);
    return match ? new Date(Number(match[1])).toISOString().slice(0, 10) : value;
  }
  if (Array.isArray(value)) return value.map(parseBingDates);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseBingDates(item)]));
  }
  return value;
}

const UNREPORTED_AFTER_IMPRESSIONS = 20;

// Bing publishes 0/0 for days it has not processed yet. A run of 0/0 days at the end of the
// series that follows a day with more than 20 impressions is flagged `unreported: true`.
export function markUnreportedDays(traffic) {
  const rows = [...traffic].sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
  let first = rows.length;
  while (first > 0 && rows[first - 1].Clicks === 0 && rows[first - 1].Impressions === 0) first -= 1;
  const flagged = first > 0 && first < rows.length && rows[first - 1].Impressions > UNREPORTED_AFTER_IMPRESSIONS;
  const marked = rows.map((row, index) => (flagged && index >= first ? { ...row, unreported: true } : row));
  const warnings = flagged
    ? [
        `Bing reports 0 clicks and 0 impressions for ${rows.length - first} trailing day(s) (from ${rows[first].Date}) after a day with ${rows[first - 1].Impressions} impressions; treat them as not yet reported, not as zero traffic.`,
      ]
    : [];
  return { traffic: marked, warnings };
}

export async function bingReport({ env, page, query, fetchImpl = globalThis.fetch, lookup = lookupSecret }) {
  const [apiKey, siteUrl] = resolveBingSettings(env, lookup);
  const call = (method, extra = {}) => bingCall(fetchImpl, apiKey, method, { siteUrl, ...extra });
  const [traffic, queries, pages, crawlStats, crawlIssues, urlSubmissionQuota, pageQueries, queryPages] =
    await Promise.all([
      call("GetRankAndTrafficStats"),
      call("GetQueryStats"),
      call("GetPageStats"),
      call("GetCrawlStats"),
      call("GetCrawlIssues"),
      call("GetUrlSubmissionQuota"),
      page ? call("GetPageQueryStats", { page }) : undefined,
      query ? call("GetQueryPageStats", { query }) : undefined,
    ]);
  const checked = markUnreportedDays(traffic);
  const dates = checked.traffic.map((row) => row.Date).filter(Boolean);
  const result = {
    start: dates[0] ?? null,
    end: dates.at(-1) ?? null,
    warnings: checked.warnings,
    traffic: checked.traffic,
    queries,
    pages,
    crawlStats,
    crawlIssues,
    urlSubmissionQuota,
  };
  if (page) result.pageQueries = pageQueries;
  if (query) result.queryPages = queryPages;
  return result;
}

function resolveBingSettings(env, lookup) {
  return resolveSettings(
    env,
    lookup,
    { name: "BING_API_KEY", pass: "bing-api-key" },
    { name: "BING_SITE_URL", fallback: "https://rom-weaver.com/" },
  );
}

function bingCall(fetchImpl, apiKey, method, params) {
  return getJson(
    fetchImpl,
    `Bing Webmaster ${method}`,
    `https://ssl.bing.com/webmaster/api.svc/json/${method}?${new URLSearchParams({ ...params, apikey: apiKey })}`,
  ).then((body) => parseBingDates(body.d ?? []));
}

export async function bingUrlInfoReport({ env, urls, fetchImpl = globalThis.fetch, lookup = lookupSecret }) {
  const [apiKey, siteUrl] = resolveBingSettings(env, lookup);
  const urlInfo = [];
  for (const url of urls) urlInfo.push({ url, info: await bingCall(fetchImpl, apiKey, "GetUrlInfo", { siteUrl, url }) });
  return { siteUrl, urlInfo };
}

const CLOUDFLARE_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
// Adaptive datasets keep at least 31 days on every plan.
const CLOUDFLARE_ADAPTIVE_MAX_DAYS = 31;

// One UTC day of top referrers and HTML responses for one host. The field names come from
// Cloudflare's published GraphQL schema (httpRequestsAdaptiveGroups).
export function buildCloudflareHostQuery({ zoneId, host, day, referrers = true }) {
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
  const filter = `datetime_geq: $start, datetime_lt: $end, clientRequestHTTPHost: $host`;
  const referrerField = referrers
    ? `referrers: httpRequestsAdaptiveGroups(limit: 100, orderBy: [count_DESC], filter: { ${filter} }) {
          count
          dimensions { date clientRefererHost }
        }`
    : "";
  return {
    query: `query($zone: String!, $start: Time!, $end: Time!, $host: String!) {
      viewer { zones(filter: { zoneTag: $zone }) {
        ${referrerField}
        html: httpRequestsAdaptiveGroups(limit: 1, filter: { ${filter}, edgeResponseContentTypeName: "html" }) {
          count
        }
      } }
    }`,
    variables: { zone: zoneId, start: `${day}T00:00:00Z`, end: next.replace(".000Z", "Z"), host },
  };
}

export async function cloudflareReport({ env, fetchImpl = globalThis.fetch, now, lookup = lookupSecret, ...options }) {
  const [token, zoneId] = resolveSettings(
    env,
    lookup,
    { name: "CLOUDFLARE_API_TOKEN", pass: "cloudflare-token" },
    { name: "CLOUDFLARE_ZONE_ID", pass: "cloudflare-zone-id" },
  );
  const range = resolveRange(options, now);
  const graphql = async (payload) => {
    const body = await getJson(fetchImpl, "Cloudflare GraphQL", CLOUDFLARE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (body.errors?.length) throw new Error(`Cloudflare GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data?.viewer?.zones?.[0];
  };
  const totals = await graphql({
    query: `query($zone: String!, $start: Date!, $end: Date!) {
        viewer { zones(filter: { zoneTag: $zone }) {
          httpRequests1dGroups(limit: 500, orderBy: [date_ASC], filter: { date_geq: $start, date_leq: $end }) {
            dimensions { date }
            sum { requests pageViews bytes }
            uniq { uniques }
          }
        } }
      }`,
    variables: { zone: zoneId, start: range.start, end: range.end },
  });
  const result = { ...range, days: totals?.httpRequests1dGroups ?? [] };
  if (!options.host) return result;
  const dates = eachDay(range);
  if (dates.length > CLOUDFLARE_ADAPTIVE_MAX_DAYS) {
    throw new Error(`--host reads adaptive data, which is kept ${CLOUDFLARE_ADAPTIVE_MAX_DAYS} days; narrow the range`);
  }
  const hostDays = [];
  // Lower plans deny clientRefererHost; fall back to HTML counts only rather than failing.
  let referrers = true;
  for (const day of dates) {
    let zone;
    try {
      zone = await graphql(buildCloudflareHostQuery({ zoneId, host: options.host, day, referrers }));
    } catch (error) {
      if (!referrers || !/does not have access to the field/i.test(error.message)) throw error;
      referrers = false;
      zone = await graphql(buildCloudflareHostQuery({ zoneId, host: options.host, day, referrers }));
    }
    hostDays.push({
      date: day,
      ...(referrers
        ? { referrers: (zone?.referrers ?? []).map((group) => ({ referrer: group.dimensions.clientRefererHost, requests: group.count })) }
        : {}),
      htmlResponses: zone?.html?.[0]?.count ?? 0,
    });
  }
  result.host = {
    host: options.host,
    note: "httpRequestsAdaptiveGroups is sampled and range-limited, so it is queried once per UTC day; counts are estimates.",
    ...(referrers ? {} : { warning: "This zone's plan does not expose clientRefererHost, so referrers are omitted." }),
    days: hostDays,
  };
  return result;
}

export async function githubReport({ env, fetchImpl = globalThis.fetch, lookup = lookupSecret }) {
  const [token, repository] = resolveSettings(
    env,
    lookup,
    { name: "GITHUB_TOKEN", gh: true },
    { name: "GITHUB_REPOSITORY", fallback: "rom-weaver/rom-weaver" },
  );
  const call = (path) =>
    getJson(fetchImpl, `GitHub ${path}`, `https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  const [views, clones, referrers, paths, releases] = await Promise.all([
    call("traffic/views"),
    call("traffic/clones"),
    call("traffic/popular/referrers"),
    call("traffic/popular/paths"),
    call("releases?per_page=20"),
  ]);
  return {
    views,
    clones,
    referrers,
    paths,
    downloads: releases.map((release) => ({
      tag: release.tag_name,
      assets: release.assets.reduce((total, asset) => total + asset.download_count, 0),
    })),
  };
}

const REPORTS = {
  gsc: searchConsoleReport,
  "gsc-inspect": searchConsoleInspectReport,
  bing: bingReport,
  "bing-urlinfo": bingUrlInfoReport,
  cloudflare: cloudflareReport,
  github: githubReport,
};

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const signed = (value, format = (n) => String(Math.round(n * 100) / 100)) =>
  value === null ? "n/a" : `${value > 0 ? "+" : ""}${format(value)}`;
const TOP_ROWS = 10;

// Compact text table of the top pages (and compare deltas) for stderr.
export function formatSummary(result) {
  const lines = [`${result.source} ${result.start} to ${result.end}${result.provisional ? " (provisional)" : ""}`];
  const pages = [...(result.reports?.page ?? [])].sort((a, b) => b.clicks - a.clicks).slice(0, TOP_ROWS);
  if (pages.length > 0) {
    lines.push("clicks  impr  ctr  pos  page");
    for (const row of pages) {
      lines.push(`${row.clicks}  ${row.impressions}  ${percent(row.ctr)}  ${row.position.toFixed(1)}  ${row.keys[0]}`);
    }
  }
  for (const [dimension, deltas] of Object.entries(result.deltas ?? {})) {
    lines.push(`${dimension} deltas vs ${result.compare.start}..${result.compare.end} (clicks, impr, ctr, pos)`);
    for (const row of deltas.slice(0, TOP_ROWS)) {
      const { clicks, impressions, ctr, position } = row.delta;
      lines.push(
        `${signed(clicks)}  ${signed(impressions)}  ${signed(ctr, (n) => `${(n * 100).toFixed(1)}pt`)}  ${signed(position, (n) => n.toFixed(1))}  ${row.key}`,
      );
    }
  }
  return lines.join("\n");
}

export async function run(argv, env, { now = new Date(), ...deps } = {}) {
  const options = parseArgs(argv);
  const { source, args } = options;
  const { start = null, end = null, ...rest } = await REPORTS[source]({ ...options, env, now, ...deps });
  return { source, args, start, end, fetchedAt: now.toISOString(), ...rest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    const result = await run(argv, process.env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (argv.includes("--summary")) process.stderr.write(`${formatSummary(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
