#!/usr/bin/env node

// Read-only traffic reports. Prints JSON for one source:
//   node scripts/analytics-report.mjs <gsc|bing|cloudflare|github> [--days N]
//
// Credentials come from the environment only:
//   gsc         GSC_SERVICE_ACCOUNT_FILE (service-account key JSON path), GSC_SITE
//               (`sc-domain:example.com` or a URL-prefix property)
//   bing        BING_API_KEY, BING_SITE_URL
//   cloudflare  CLOUDFLARE_API_TOKEN (Zone Analytics: Read), CLOUDFLARE_ZONE_ID
//   github      GITHUB_TOKEN (repo access), GITHUB_REPOSITORY (`owner/name`)

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SOURCES = ["gsc", "bing", "cloudflare", "github"];
const DEFAULT_DAYS = 28;

function requireEnv(env, ...names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  return names.map((name) => env[name]);
}

export function parseArgs(argv) {
  const [source, ...rest] = argv;
  if (!SOURCES.includes(source)) throw new Error(`Usage: analytics-report.mjs <${SOURCES.join("|")}> [--days N]`);
  let days = DEFAULT_DAYS;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--days") throw new Error(`Unknown argument: ${rest[index]}`);
    days = Number(rest[index + 1]);
    index += 1;
    if (!Number.isInteger(days) || days < 1 || days > 480) throw new Error("--days must be an integer from 1 to 480");
  }
  return { source, days };
}

export function dateRange(days, now = new Date()) {
  const day = (date) => date.toISOString().slice(0, 10);
  return { start: day(new Date(now.getTime() - days * 86_400_000)), end: day(now) };
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

export async function searchConsoleReport({ env, days, fetchImpl = globalThis.fetch, now }) {
  const [keyFile, site] = requireEnv(env, "GSC_SERVICE_ACCOUNT_FILE", "GSC_SITE");
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  const grant = await getJson(fetchImpl, "Google token endpoint", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(key),
    }),
  });
  const { start, end } = dateRange(days, now);
  const query = (dimensions) =>
    getJson(
      fetchImpl,
      "Search Console",
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: start, endDate: end, dimensions, rowLimit: 25 }),
      },
    );
  const [byDate, byQuery, byPage] = await Promise.all([query(["date"]), query(["query"]), query(["page"])]);
  return { start, end, byDate: byDate.rows ?? [], byQuery: byQuery.rows ?? [], byPage: byPage.rows ?? [] };
}

export async function bingReport({ env, fetchImpl = globalThis.fetch }) {
  const [apiKey, siteUrl] = requireEnv(env, "BING_API_KEY", "BING_SITE_URL");
  const call = (method) =>
    getJson(
      fetchImpl,
      `Bing Webmaster ${method}`,
      `https://ssl.bing.com/webmaster/api.svc/json/${method}?${new URLSearchParams({ apikey: apiKey, siteUrl })}`,
    ).then((body) => body.d ?? []);
  const [traffic, queries, pages] = await Promise.all([
    call("GetRankAndTrafficStats"),
    call("GetQueryStats"),
    call("GetPageStats"),
  ]);
  return { traffic, queries, pages };
}

export async function cloudflareReport({ env, days, fetchImpl = globalThis.fetch, now }) {
  const [token, zoneId] = requireEnv(env, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID");
  const { start, end } = dateRange(days, now);
  const body = await getJson(fetchImpl, "Cloudflare GraphQL", "https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query($zone: String!, $start: Date!, $end: Date!) {
        viewer { zones(filter: { zoneTag: $zone }) {
          httpRequests1dGroups(limit: 500, orderBy: [date_ASC], filter: { date_geq: $start, date_leq: $end }) {
            dimensions { date }
            sum { requests pageViews bytes }
            uniq { uniques }
          }
        } }
      }`,
      variables: { zone: zoneId, start, end },
    }),
  });
  if (body.errors?.length) throw new Error(`Cloudflare GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  return { start, end, days: body.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [] };
}

export async function githubReport({ env, fetchImpl = globalThis.fetch }) {
  const [token, repository] = requireEnv(env, "GITHUB_TOKEN", "GITHUB_REPOSITORY");
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

const REPORTS = { gsc: searchConsoleReport, bing: bingReport, cloudflare: cloudflareReport, github: githubReport };

export async function run(argv, env) {
  const { source, days } = parseArgs(argv);
  return REPORTS[source]({ env, days });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await run(process.argv.slice(2), process.env), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
