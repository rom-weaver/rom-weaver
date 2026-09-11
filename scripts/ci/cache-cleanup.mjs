#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MEBIBYTE = 1024 * 1024;
const HASH_SUFFIX = /-[0-9a-f]{8,64}$/i;

const cacheFamily = (key) => {
  if (typeof key !== "string") return null;

  // Cleanup MUST preserve the Rust environment hash used by the restore key.
  // https://github.com/Swatinem/rust-cache/blob/v2/src/config.ts
  if (key.startsWith("v0-rust-")) {
    const match = /^(v0-rust-.+-[0-9a-f]{8,64})-[0-9a-f]{8,64}$/i.exec(key);
    return match?.[1] ?? null;
  }

  // These Actions cache steps explicitly restore from the same prefix.
  if (
    key.startsWith("ccache-") ||
    key.startsWith("semver-checks-") ||
    key.startsWith("identify-brotli-")
  ) {
    const family = key.replace(HASH_SUFFIX, "");
    return family === key ? null : family;
  }

  return null;
};

export function supersededCaches(caches) {
  const families = new Map();

  for (const cache of caches) {
    const family = cacheFamily(cache.key);
    if (!family || !cache.ref || !cache.version || !cache.id || !cache.created_at) continue;

    const created = Date.parse(cache.created_at);
    if (Number.isNaN(created)) continue;

    const scope = `${cache.ref}\u0000${cache.version}\u0000${family}`;
    const members = families.get(scope) ?? [];
    members.push({ ...cache, created });
    families.set(scope, members);
  }

  return [...families.values()].flatMap((members) =>
    members
      .sort((left, right) => right.created - left.created || Number(right.id) - Number(left.id))
      .slice(1)
      .map(({ created: _created, ...cache }) => cache),
  );
}

function pullNumber(ref) {
  return /^refs\/pull\/(\d+)\/merge$/.exec(ref ?? "")?.[1] ?? null;
}

function nextLink(link) {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

function mebibytes(bytes) {
  return Math.floor((bytes ?? 0) / MEBIBYTE);
}

function apiUrl(path, apiBase) {
  return new URL(path, apiBase).toString();
}

function createApi({ token, repo, apiBase, fetchImpl }) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "rom-weaver-cache-cleanup",
    "x-github-api-version": "2022-11-28",
  };

  async function request(path, { method = "GET", allow404 = false } = {}) {
    const response = await fetchImpl(apiUrl(path, apiBase), { method, headers });
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      throw new Error(
        `cache-cleanup: ${method} ${path} failed with ${response.status}: ${await response.text()}`,
      );
    }
    return response.status === 204 ? null : response.json();
  }

  async function caches() {
    const entries = [];
    let next = `/repos/${repo}/actions/caches?per_page=100`;
    while (next) {
      const response = await fetchImpl(apiUrl(next, apiBase), { headers });
      if (!response.ok) {
        throw new Error(
          `cache-cleanup: GET ${next} failed with ${response.status}: ${await response.text()}`,
        );
      }
      const body = await response.json();
      if (!Array.isArray(body.actions_caches)) {
        throw new Error("cache-cleanup: cache list response did not include actions_caches");
      }
      entries.push(...body.actions_caches);
      next = nextLink(response.headers.get("link"));
    }
    return entries;
  }

  return { caches, request };
}

function writeSummary(summaryFile, { before, after, closed, superseded, reclaimed }) {
  if (!summaryFile) return;
  appendFileSync(
    summaryFile,
    [
      "### Actions cache cleanup",
      "",
      "| | MB |",
      "|---|---:|",
      `| before | ${mebibytes(before)} |`,
      `| after | ${mebibytes(after)} |`,
      `| reclaimed | ${mebibytes(reclaimed)} |`,
      "| limit | 10240 |",
      "",
      `Deleted **${closed}** cache entries for closed pull requests and **${superseded}** compatible superseded entries.`,
      "",
    ].join("\n"),
  );
}

export async function cleanupCaches({
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY,
  apiBase = process.env.GITHUB_API_URL || "https://api.github.com",
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
  fetchImpl = globalThis.fetch,
  logger = process.stdout,
} = {}) {
  if (!token) throw new Error("cache-cleanup: GH_TOKEN or GITHUB_TOKEN is required");
  if (!repo) throw new Error("cache-cleanup: GH_REPO or GITHUB_REPOSITORY is required");

  const api = createApi({ token, repo, apiBase, fetchImpl });
  const before = (await api.request(`/repos/${repo}/actions/cache/usage`)).active_caches_size_in_bytes;
  const caches = await api.caches();
  const pullStates = new Map();
  const closedIds = new Set();

  for (const cache of caches) {
    const number = pullNumber(cache.ref);
    if (!number || pullStates.has(number)) continue;
    try {
      const pull = await api.request(`/repos/${repo}/pulls/${number}`, { allow404: true });
      pullStates.set(number, pull?.state ?? "unknown");
    } catch (error) {
      pullStates.set(number, "unknown");
      logger.write(`::warning::could not read pull request #${number}; preserving its caches: ${error.message}\n`);
    }
  }

  for (const cache of caches) {
    const number = pullNumber(cache.ref);
    if (number && pullStates.get(number) === "closed") {
      closedIds.add(cache.id);
    }
  }

  const superseded = supersededCaches(caches).filter((cache) => {
    const number = pullNumber(cache.ref);
    return !closedIds.has(cache.id) && (!number || pullStates.get(number) === "open");
  });
  const deletions = [
    ...caches.filter((cache) => closedIds.has(cache.id)).map((cache) => ({ cache, reason: "closed pull request" })),
    ...superseded.map((cache) => ({ cache, reason: "superseded generation" })),
  ];

  let closed = 0;
  let supersededCount = 0;
  let reclaimed = 0;
  for (const { cache, reason } of deletions) {
    try {
      await api.request(`/repos/${repo}/actions/caches/${cache.id}`, { method: "DELETE" });
      reclaimed += cache.size_in_bytes ?? 0;
      if (reason === "closed pull request") closed += 1;
      else supersededCount += 1;
      logger.write(`deleted cache ${cache.id} (${reason}, ${mebibytes(cache.size_in_bytes)} MB)\n`);
    } catch (error) {
      logger.write(`::warning::could not delete cache ${cache.id}: ${error.message}\n`);
    }
  }

  const after = (await api.request(`/repos/${repo}/actions/cache/usage`)).active_caches_size_in_bytes;
  writeSummary(summaryFile, { before, after, closed, superseded: supersededCount, reclaimed });
  if (after > 9 * 1024 * 1024 * 1024) {
    logger.write(`::warning::Actions cache is at ${mebibytes(after)} MB of 10240 MB after cleanup.\n`);
  }
  return { after, before, closed, reclaimed, superseded: supersededCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await cleanupCaches();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
