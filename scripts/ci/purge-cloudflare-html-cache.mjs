#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { DOC_SOURCES } from "../../packages/rom-weaver-webapp/src/webapp/docs-routing.mjs";

const PURGE_BATCH_SIZE = 30;
const PURGEABLE_HOSTS = new Set([
  "rom-weaver.com",
  "beta.rom-weaver.com",
  "nightly.rom-weaver.com",
]);
const WORKFLOW_DOCUMENT_NAMES = ["apply", "create", "trim", "tools"];

const routeAliases = (slug) => [`/${slug}`, `/${slug}/`, `/${slug}.html`, `/${slug}/index.html`];

export const DOCUMENT_PURGE_PATHS = Object.freeze(
  [
    "/",
    "/index.html",
    "/404.html",
    ...WORKFLOW_DOCUMENT_NAMES.flatMap(routeAliases),
    ...DOC_SOURCES.flatMap(({ slug }) => routeAliases(slug)),
  ].filter((path, index, paths) => paths.indexOf(path) === index),
);

export const documentPurgeUrls = (host) => {
  if (!PURGEABLE_HOSTS.has(host))
    throw new Error(`refusing to purge an unknown Cloudflare host: ${host || "(missing)"}`);
  return DOCUMENT_PURGE_PATHS.map((pathname) => `https://${host}${pathname}`);
};

const batches = (items) => {
  const result = [];
  for (let index = 0; index < items.length; index += PURGE_BATCH_SIZE) {
    result.push(items.slice(index, index + PURGE_BATCH_SIZE));
  }
  return result;
};

export async function purgeDocumentCache({ zoneId, token, host, fetchImpl = globalThis.fetch }) {
  if (!zoneId) return { status: "skipped", urlCount: 0, requestCount: 0 };
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required to purge the document cache");

  const urls = documentPurgeUrls(host);
  const api = `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const chunks = batches(urls);
  for (const files of chunks) {
    const response = await fetchImpl(api, {
      method: "POST",
      headers,
      body: JSON.stringify({ files }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status !== 200 || !body.success) {
      throw new Error(
        `Cloudflare document cache purge failed with HTTP ${response.status}\n${JSON.stringify(body, null, 2)}`,
      );
    }
  }
  return { status: "purged", urlCount: urls.length, requestCount: chunks.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await purgeDocumentCache({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      host: process.env.CLOUDFLARE_HOST,
    });
    if (result.status === "skipped")
      process.stdout.write("::notice::CLOUDFLARE_ZONE_ID not set; skipping document cache purge\n");
    else
      process.stdout.write(
        `purged ${result.urlCount} document URLs in ${result.requestCount} request(s)\n`,
      );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
