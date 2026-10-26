#!/usr/bin/env node

// Read-only traffic reports. Prints JSON for one source:
//   node scripts/analytics-report.mjs <gsc|bing|cloudflare|github> [--days N]
//
// `--days N` covers N days ago through today (UTC, today still partial) and applies to
// gsc and cloudflare only; bing and github return their fixed history windows.
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

const SOURCES = ["gsc", "bing", "cloudflare", "github"];
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

export async function searchConsoleReport({ env, days, fetchImpl = globalThis.fetch, now, lookup = lookupSecret }) {
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
  const { start, end } = dateRange(days, now);
  const query = (dimensions, rowLimit = 25) =>
    getJson(
      fetchImpl,
      "Search Console",
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: start, endDate: end, dimensions, rowLimit }),
      },
    );
  const [byDate, byQuery, byPage] = await Promise.all([query(["date"], days + 1), query(["query"]), query(["page"])]);
  return { start, end, byDate: byDate.rows ?? [], byQuery: byQuery.rows ?? [], byPage: byPage.rows ?? [] };
}

export async function bingReport({ env, fetchImpl = globalThis.fetch, lookup = lookupSecret }) {
  const [apiKey, siteUrl] = resolveSettings(
    env,
    lookup,
    { name: "BING_API_KEY", pass: "bing-api-key" },
    { name: "BING_SITE_URL", fallback: "https://rom-weaver.com/" },
  );
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

export async function cloudflareReport({ env, days, fetchImpl = globalThis.fetch, now, lookup = lookupSecret }) {
  const [token, zoneId] = resolveSettings(
    env,
    lookup,
    { name: "CLOUDFLARE_API_TOKEN", pass: "cloudflare-token" },
    { name: "CLOUDFLARE_ZONE_ID", pass: "cloudflare-zone-id" },
  );
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
