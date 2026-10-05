#!/usr/bin/env node

import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MARKDOWN_ROUTES } from "../../packages/rom-weaver-webapp/functions/markdown-routes.js";

const DOMAINS = new Set(["rom-weaver.com", "beta.rom-weaver.com", "nightly.rom-weaver.com"]);

export function pageUrls(domain) {
  if (!DOMAINS.has(domain)) throw new Error(`Refusing to purge unsupported domain: ${domain}`);
  return [...new Set(MARKDOWN_ROUTES.flatMap(({ path, markdownPath }) => [path, markdownPath]))].map(
    (path) => `https://${domain}${path}`,
  );
}

export async function purgePagesCache({ zoneId, token, domain, fetchImpl = globalThis.fetch, sleep = setTimeout }) {
  if (!zoneId) return "skipped";
  const files = pageUrls(domain);
  // URL purges MUST omit header variants: Vary purges clear every version for the URL.
  // https://developers.cloudflare.com/cache/concepts/vary/#purge-behavior
  for (let offset = 0; offset < files.length; offset += 100) {
    // Stay below the Free plan's 800 URLs/second, including concurrent channel deploys.
    // https://developers.cloudflare.com/cache/how-to/purge-cache/#single-file-purge-limits
    if (offset > 0) await sleep(1000);
    const body = JSON.stringify({ files: files.slice(offset, offset + 100) });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers?.get("Retry-After"));
        await response.body?.cancel().catch(() => undefined);
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : 1000 * (attempt + 1),
        );
        continue;
      }
      const result = await response.json();
      if (!response.ok || !result.success)
        throw new Error(`Cloudflare page purge returned HTTP ${response.status}\n${JSON.stringify(result)}`);
      break;
    }
  }
  return `purged ${files.length} page URLs for ${domain}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await purgePagesCache({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      domain: process.env.DEPLOYMENT_DOMAIN,
    });
    process.stdout.write(
      result === "skipped" ? "::notice::CLOUDFLARE_ZONE_ID not set; skipping page cache purge\n" : `${result}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
